/**
 * server/routes/nodes.js — the RecallLab REST API (build contracts §3).
 *
 * Base path is `/api`; the router is mounted by `server/app.js`.
 *
 * Every server-enforced invariant of build contracts §3.4 is implemented here:
 *   1. title is non-empty after trimming
 *   2. a folder has empty body and answer
 *   3. a card has no children
 *   4. parentId must reference a folder or be null
 *   5. a node cannot be moved into itself or into its own descendant
 *   6. sibling titles are unique (trimmed, case-insensitive)
 *   7. DELETE on a folder removes its whole subtree in one transaction
 */

import express from 'express';
import { query, withTransaction, dbMode } from '../db/client.js';
import {
  listChildren,
  getNode,
  getTree,
  getAncestors,
  findSiblingByTitle,
  createNode,
  updateNode,
  deleteNodesByIds,
  renumberLevel,
  reorderLevel,
  collectDescendantIds,
  nextPosition,
} from '../db/queries.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An error that carries the HTTP status and the error code of §3.3. */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new HttpError(400, 'invalid_request', message);
const notFound = (message) => new HttpError(404, 'not_found', message);
const invalidMove = (message) => new HttpError(409, 'invalid_move', message);
const duplicateTitle = (message) => new HttpError(409, 'duplicate_title', message);
const validationFailed = (message) => new HttpError(422, 'validation_failed', message);

/**
 * A node id that is not a uuid cannot exist. Rejecting it before the query
 * keeps a malformed id a 404 instead of a database type error (500).
 */
function assertNodeId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw notFound('No node with that id.');
  }
}

/**
 * Resolve a parent reference.
 *
 * `null`, `undefined`, `''` and the literal string `'root'` all mean the
 * root level. Anything else must be a uuid that refers to a folder.
 *
 * @param {unknown} value
 * @returns {Promise<string|null>} the parent id, or null for the root level
 */
async function resolveParent(value) {
  if (value === undefined || value === null || value === '' || value === 'root') {
    return null;
  }
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw badRequest('parentId must be null, "root", or a uuid.');
  }
  const parent = await getNode(value);
  if (!parent) throw notFound('No node with that id.');
  if (parent.kind !== 'folder') {
    throw validationFailed('A node can only live inside a folder.');
  }
  return parent.id;
}

/** Read a trimmed, non-empty title from a payload. */
function readTitle(value) {
  if (typeof value !== 'string') throw badRequest('title must be a string.');
  const title = value.trim();
  if (title === '') throw validationFailed('title must not be empty.');
  return title;
}

/** Read a text field; `null` clears it. */
function readText(value, field) {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value !== 'string') throw badRequest(`${field} must be a string.`);
  return value;
}

function requireObjectBody(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  return body;
}

export const router = express.Router();

/* ------------------------------------------------------------------ */
/* GET /api/nodes?parent=<uuid|root>                                   */
/* ------------------------------------------------------------------ */

router.get('/nodes', async (req, res) => {
  const raw = req.query.parent;
  if (Array.isArray(raw)) throw badRequest('parent must be a single value.');

  let parentId = null;
  if (raw !== undefined && raw !== null && raw !== '' && raw !== 'root') {
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
      throw badRequest('parent must be a uuid or "root".');
    }
    const parent = await getNode(raw);
    if (!parent) throw notFound('No node with that id.');
    parentId = parent.id;
  }

  const nodes = await listChildren(parentId);
  res.json({ nodes });
});

/* ------------------------------------------------------------------ */
/* GET /api/nodes/:id                                                   */
/* ------------------------------------------------------------------ */

router.get('/nodes/:id', async (req, res) => {
  assertNodeId(req.params.id);
  const node = await getNode(req.params.id);
  if (!node) throw notFound('No node with that id.');
  res.json({ node });
});

/* ------------------------------------------------------------------ */
/* GET /api/nodes/:id/path — root-first ancestors, excluding the node  */
/* ------------------------------------------------------------------ */

router.get('/nodes/:id/path', async (req, res) => {
  assertNodeId(req.params.id);
  const path = await getAncestors(req.params.id);
  if (path === null) throw notFound('No node with that id.');
  res.json({ path });
});

/* ------------------------------------------------------------------ */
/* GET /api/tree — the whole tree, flat                                */
/* ------------------------------------------------------------------ */

router.get('/tree', async (req, res) => {
  const nodes = await getTree();
  res.json({ nodes });
});

/* ------------------------------------------------------------------ */
/* POST /api/nodes                                                      */
/* ------------------------------------------------------------------ */

router.post('/nodes', async (req, res) => {
  const body = requireObjectBody(req.body);

  const kind = body.kind;
  if (kind !== 'folder' && kind !== 'card') {
    throw badRequest('kind must be "folder" or "card".');
  }

  const title = readTitle(body.title);

  let text = readText(body.body, 'body') ?? '';
  let answer = readText(body.answer, 'answer') ?? '';

  // Invariant 2 — a folder has empty body and answer.
  if (kind === 'folder') {
    if (text.trim() !== '' || answer.trim() !== '') {
      throw validationFailed('A folder must have an empty body and an empty answer.');
    }
    text = '';
    answer = '';
  }

  // Invariant 3 and 4 — the parent must be a folder (or the root level).
  const parentId = await resolveParent(body.parentId);

  // Invariant 6 — sibling titles are unique, trimmed and case-insensitive.
  const conflict = await findSiblingByTitle(parentId, title);
  if (conflict) {
    throw duplicateTitle(`A sibling named "${title}" already exists.`);
  }

  const node = await createNode({ parentId, kind, title, body: text, answer });
  res.status(201).location(`/api/nodes/${node.id}`).json({ node });
});

/* ------------------------------------------------------------------ */
/* PUT /api/nodes/:id — update fields and/or move                       */
/* ------------------------------------------------------------------ */

router.put('/nodes/:id', async (req, res) => {
  const body = requireObjectBody(req.body);
  const id = req.params.id;
  assertNodeId(id);

  const existing = await getNode(id);
  if (!existing) throw notFound('No node with that id.');

  const patch = {};

  if (body.title !== undefined) {
    patch.title = readTitle(body.title);
  }
  const newBody = readText(body.body, 'body');
  if (newBody !== undefined) patch.body = newBody;
  const newAnswer = readText(body.answer, 'answer');
  if (newAnswer !== undefined) patch.answer = newAnswer;

  // Invariant 2 — a folder keeps an empty body and an empty answer.
  if (existing.kind === 'folder') {
    if ((patch.body ?? '').trim() !== '' || (patch.answer ?? '').trim() !== '') {
      throw validationFailed('A folder must have an empty body and an empty answer.');
    }
    patch.body = '';
    patch.answer = '';
  }

  // Where does the node live after this request?
  let targetParentId = existing.parentId;
  let moving = false;
  if (body.parentId !== undefined) {
    targetParentId = await resolveParent(body.parentId);
    moving = targetParentId !== existing.parentId;
  }

  // Invariant 5 — no moving into itself or into its own descendant.
  if (moving) {
    if (targetParentId === id) {
      throw invalidMove('A folder cannot be moved into itself.');
    }
    const ancestors = await getAncestors(targetParentId);
    if (ancestors && ancestors.some((ancestor) => ancestor.id === id)) {
      throw invalidMove('A folder cannot be moved into its own descendant.');
    }
  }

  // Invariant 6 — sibling titles stay unique in the destination level.
  const conflict = await findSiblingByTitle(
    targetParentId,
    patch.title ?? existing.title,
    id,
  );
  if (conflict) {
    throw duplicateTitle(`A sibling named "${conflict.title}" already exists.`);
  }

  const node = await withTransaction(async (tx) => {
    if (Object.keys(patch).length > 0) {
      await updateNode(id, patch, tx);
    }
    if (moving) {
      const position = await nextPosition(targetParentId, tx);
      await updateNode(id, { parent_id: targetParentId, position }, tx);
      // Keep the source level contiguous.
      await renumberLevel(existing.parentId, tx);
    }
    return getNode(id, tx);
  });

  res.json({ node });
});

/* ------------------------------------------------------------------ */
/* DELETE /api/nodes/:id — the whole subtree, in one transaction        */
/* ------------------------------------------------------------------ */

router.delete('/nodes/:id', async (req, res) => {
  const id = req.params.id;
  assertNodeId(id);

  const node = await getNode(id);
  if (!node) throw notFound('No node with that id.');

  await withTransaction(async (tx) => {
    // Invariant 7 — the whole subtree goes, children first.
    const descendants = await collectDescendantIds(id, tx);
    await deleteNodesByIds([...descendants].reverse(), tx);
    await deleteNodesByIds([id], tx);
    // Keep the parent level contiguous.
    await renumberLevel(node.parentId, tx);
  });

  res.status(204).end();
});

/* ------------------------------------------------------------------ */
/* POST /api/nodes/reorder — replace the order of a level              */
/* ------------------------------------------------------------------ */

router.post('/nodes/reorder', async (req, res) => {
  const body = requireObjectBody(req.body);

  if (!Array.isArray(body.orderedIds)) {
    throw badRequest('orderedIds must be an array of uuids.');
  }
  for (const id of body.orderedIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw badRequest('orderedIds must contain uuids only.');
    }
  }
  if (new Set(body.orderedIds).size !== body.orderedIds.length) {
    throw badRequest('orderedIds must not contain the same id twice.');
  }

  const parentId = await resolveParent(body.parentId);

  const level = await listChildren(parentId);
  const levelIds = new Set(level.map((node) => node.id));
  for (const id of body.orderedIds) {
    if (!levelIds.has(id)) {
      throw badRequest('orderedIds must only contain nodes of the given level.');
    }
  }

  const nodes = await withTransaction((tx) => reorderLevel(parentId, body.orderedIds, tx));
  res.json({ nodes });
});

/* ------------------------------------------------------------------ */
/* GET /api/health                                                      */
/* ------------------------------------------------------------------ */

router.get('/health', async (req, res) => {
  // Design spec §9.3 — when CRON_SECRET is set, only the cron may call this.
  if (process.env.CRON_SECRET) {
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (req.headers.authorization !== expected) {
      res.status(401).end();
      return;
    }
  }
  // §6.5 — touch the database on every request; no caching, no short-circuit.
  await query('select 1');
  res.json({ ok: true, db: 'up', mode: dbMode() });
});

/* ------------------------------------------------------------------ */
/* Unknown /api paths                                                   */
/* ------------------------------------------------------------------ */

router.use((req, res) => {
  res.status(404).json({
    error: { code: 'not_found', message: 'No such endpoint.' },
  });
});
