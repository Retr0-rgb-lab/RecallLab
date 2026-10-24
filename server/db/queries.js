/**
 * server/db/queries.js — every SQL statement in RecallLab.
 *
 * Rules that hold for this whole file (build contracts §2.1, §3.3):
 *   - All statements are parameterised. No user input is ever interpolated
 *     into SQL text. The only strings ever spliced into a statement are
 *     column names taken from a hard-coded whitelist and generated `$n`
 *     placeholders.
 *   - The ancestor chain is walked in JavaScript with a bounded loop, never
 *     with a `WITH RECURSIVE` CTE, because pg-mem does not support it.
 *   - Timestamps are set in the application (`new Date().toISOString()`).
 *   - UUIDs are generated in the application (`crypto.randomUUID()`).
 */

import { randomUUID } from 'node:crypto';
import { query as defaultQuery } from './client.js';

/**
 * The default executor. An executor is anything with a
 * `query(text, params) -> Promise<rows>` method: the pool-backed gateway, or
 * the transaction handle handed out by `withTransaction`.
 */
const defaultExec = { query: defaultQuery };

/** Hard bound on any tree walk, so a corrupted cycle cannot hang a request. */
export const MAX_TREE_HOPS = 64;

const UPDATABLE_COLUMNS = new Set(['title', 'body', 'answer', 'parent_id', 'position']);

/* ------------------------------------------------------------------ */
/* Row → node                                                          */
/* ------------------------------------------------------------------ */

/** Postgres returns timestamps as Date objects, pg-mem as strings. */
function toIsoString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/**
 * Map a database row onto the node shape of build contracts §3.2.
 * @param {object} row
 */
export function toNode(row) {
  return {
    id: row.id,
    parentId: row.parent_id === undefined ? null : row.parent_id,
    kind: row.kind,
    title: row.title,
    body: row.body ?? '',
    answer: row.answer ?? '',
    position: Number(row.position),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * Level ordering is server-enforced (build contracts §3.2): folders first,
 * then cards, each group by `position` ascending.
 * @param {object[]} nodes
 */
export function sortLevel(nodes) {
  return [...nodes].sort((a, b) => {
    const rankA = a.kind === 'folder' ? 0 : 1;
    const rankB = b.kind === 'folder' ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    if (a.position !== b.position) return a.position - b.position;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/**
 * Children of a level. `parentId === null` is the root level.
 * @param {string|null} parentId
 * @param {{query: Function}} [exec] transaction handle, defaults to the pool
 * @returns {Promise<object[]>}
 */
export async function listChildren(parentId, exec = defaultExec) {
  const rows =
    parentId === null || parentId === undefined
      ? await exec.query(
          'select * from nodes where parent_id is null order by position, created_at',
          [],
        )
      : await exec.query(
          'select * from nodes where parent_id = $1 order by position, created_at',
          [parentId],
        );
  return sortLevel(rows.map(toNode));
}

/**
 * One node, or `null` when it does not exist.
 * @param {string} id
 * @param {{query: Function}} [exec]
 * @returns {Promise<object|null>}
 */
export async function getNode(id, exec = defaultExec) {
  const rows = await exec.query('select * from nodes where id = $1', [id]);
  return rows.length ? toNode(rows[0]) : null;
}

/**
 * Every node in the tree, flat. One query — the spine needs it all anyway.
 * @param {{query: Function}} [exec]
 * @returns {Promise<object[]>}
 */
export async function getTree(exec = defaultExec) {
  const rows = await exec.query('select * from nodes order by position, created_at', []);
  return rows.map(toNode);
}

/**
 * The ancestor chain of a node: root first, the node itself excluded.
 *
 * Walked in JavaScript with a bounded loop rather than a recursive CTE,
 * because pg-mem does not support `WITH RECURSIVE` reliably.
 *
 * @param {string} id
 * @param {{query: Function}} [exec]
 * @returns {Promise<object[]|null>} `null` when the node does not exist.
 */
export async function getAncestors(id, exec = defaultExec) {
  const node = await getNode(id, exec);
  if (!node) return null;

  const chain = [];
  let parentId = node.parentId;
  let hops = 0;
  while (parentId !== null && parentId !== undefined && hops < MAX_TREE_HOPS) {
    const parent = await getNode(parentId, exec);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parent.parentId;
    hops += 1;
  }
  return chain;
}

/**
 * All descendant ids of a node, breadth-first.
 * @param {string} id
 * @param {{query: Function}} [exec]
 * @returns {Promise<string[]>}
 */
export async function collectDescendantIds(id, exec = defaultExec) {
  const collected = [];
  let frontier = [id];
  let hops = 0;

  while (frontier.length && hops < MAX_TREE_HOPS) {
    const level = [];
    for (const parentId of frontier) {
      const rows = await exec.query('select id from nodes where parent_id = $1', [parentId]);
      for (const row of rows) {
        if (!collected.includes(row.id)) {
          collected.push(row.id);
          level.push(row.id);
        }
      }
    }
    frontier = level;
    hops += 1;
  }
  return collected;
}

/**
 * How many nodes live below this one (used for the delete confirmation).
 * @param {string} id
 * @param {{query: Function}} [exec]
 * @returns {Promise<number>}
 */
export async function countDescendants(id, exec = defaultExec) {
  const ids = await collectDescendantIds(id, exec);
  return ids.length;
}

/**
 * Find a sibling whose title matches `title` (trimmed, case-insensitive).
 * @param {string|null} parentId
 * @param {string} title
 * @param {string|null} [excludeId] node to ignore (when renaming a node)
 * @param {{query: Function}} [exec]
 * @returns {Promise<object|null>} the conflicting sibling, if any
 */
export async function findSiblingByTitle(parentId, title, excludeId = null, exec = defaultExec) {
  const rows =
    parentId === null || parentId === undefined
      ? await exec.query('select id, title from nodes where parent_id is null', [])
      : await exec.query('select id, title from nodes where parent_id = $1', [parentId]);

  const wanted = String(title).trim().toLowerCase();
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    if (String(row.title).trim().toLowerCase() === wanted) return toNode(row);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * The next free position in a level (positions are contiguous from 0).
 * @param {string|null} parentId
 * @param {{query: Function}} [exec]
 * @returns {Promise<number>}
 */
export async function nextPosition(parentId, exec = defaultExec) {
  const rows =
    parentId === null || parentId === undefined
      ? await exec.query(
          'select coalesce(max(position), -1) as max_position from nodes where parent_id is null',
          [],
        )
      : await exec.query(
          'select coalesce(max(position), -1) as max_position from nodes where parent_id = $1',
          [parentId],
        );
  return Number(rows[0]?.max_position ?? -1) + 1;
}

/**
 * Insert a node with a known id.
 *
 * All INSERT statements live here; `createNode` and the seed script both go
 * through this function.
 *
 * @param {object} node
 * @param {string} node.id
 * @param {string|null} node.parentId
 * @param {'folder'|'card'} node.kind
 * @param {string} node.title
 * @param {string} [node.body]
 * @param {string} [node.answer]
 * @param {number} node.position
 * @param {string} [node.createdAt]
 * @param {string} [node.updatedAt]
 * @param {{query: Function}} [exec]
 * @returns {Promise<object>} the created node
 */
export async function insertNode(node, exec = defaultExec) {
  const now = new Date().toISOString();
  const rows = await exec.query(
    `insert into nodes
       (id, parent_id, kind, title, body, answer, position, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      node.id,
      node.parentId ?? null,
      node.kind,
      node.title,
      node.body ?? '',
      node.answer ?? '',
      node.position,
      node.createdAt ?? now,
      node.updatedAt ?? now,
    ],
  );
  return toNode(rows[0]);
}

/**
 * Insert a node.
 * @param {object} node
 * @param {string|null} node.parentId
 * @param {'folder'|'card'} node.kind
 * @param {string} node.title already trimmed by the caller
 * @param {string} [node.body]
 * @param {string} [node.answer]
 * @param {number|null} [node.position] `null` appends to the level
 * @param {{query: Function}} [exec]
 * @returns {Promise<object>} the created node
 */
export async function createNode(node, exec = defaultExec) {
  const id = randomUUID();
  const position =
    node.position === null || node.position === undefined
      ? await nextPosition(node.parentId ?? null, exec)
      : node.position;

  return insertNode(
    {
      id,
      parentId: node.parentId ?? null,
      kind: node.kind,
      title: node.title,
      body: node.body ?? '',
      answer: node.answer ?? '',
      position,
    },
    exec,
  );
}

/**
 * Update the mutable fields of a node. Column names come from a whitelist,
 * values are always bound parameters.
 * @param {string} id
 * @param {{title?: string, body?: string, answer?: string, parent_id?: string|null, position?: number}} patch
 * @param {{query: Function}} [exec]
 * @returns {Promise<object|null>}
 */
export async function updateNode(id, patch, exec = defaultExec) {
  const sets = [];
  const params = [];

  for (const [column, value] of Object.entries(patch ?? {})) {
    if (!UPDATABLE_COLUMNS.has(column)) continue;
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }

  if (!sets.length) return getNode(id, exec);

  params.push(new Date().toISOString());
  sets.push(`updated_at = $${params.length}`);

  params.push(id);
  const rows = await exec.query(
    `update nodes set ${sets.join(', ')} where id = $${params.length} returning *`,
    params,
  );
  return rows.length ? toNode(rows[0]) : null;
}

/**
 * Delete a set of nodes. Callers delete children before parents so the
 * `ON DELETE CASCADE` safety net finds nothing left to remove.
 * @param {string[]} ids
 * @param {{query: Function}} [exec]
 * @returns {Promise<string[]>} the ids that were removed
 */
export async function deleteNodesByIds(ids, exec = defaultExec) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
  const rows = await exec.query(
    `delete from nodes where id in (${placeholders}) returning id`,
    ids,
  );
  return rows.map((row) => row.id);
}

/**
 * Rewrite the positions of a level so they are contiguous from 0.
 * @param {string|null} parentId
 * @param {{query: Function}} [exec]
 * @returns {Promise<object[]>} the rewritten level
 */
export async function renumberLevel(parentId, exec = defaultExec) {
  const level = await listChildren(parentId, exec);
  const now = new Date().toISOString();
  for (const [index, node] of level.entries()) {
    if (node.position === index) continue;
    await exec.query('update nodes set position = $1, updated_at = $2 where id = $3', [
      index,
      now,
      node.id,
    ]);
  }
  return listChildren(parentId, exec);
}

/**
 * Replace the order of a level.
 *
 * `orderedIds` lists the ids in the order the client wants. Ids that the
 * client did not mention keep their relative order and follow. The final
 * order is then grouped folders-first / cards-second, matching the level
 * ordering the server returns everywhere else (build contracts §3.2).
 *
 * @param {string|null} parentId
 * @param {string[]} orderedIds
 * @param {{query: Function}} [exec]
 * @returns {Promise<object[]>} the rewritten level
 */
export async function reorderLevel(parentId, orderedIds, exec = defaultExec) {
  const level = await listChildren(parentId, exec);
  const byId = new Map(level.map((node) => [node.id, node]));

  const requested = [];
  for (const id of orderedIds) {
    if (!byId.has(id)) continue; // validated by the caller
    if (!requested.includes(id)) requested.push(id);
  }
  for (const node of level) {
    if (!requested.includes(node.id)) requested.push(node.id);
  }

  const folders = requested.filter((id) => byId.get(id).kind === 'folder');
  const cards = requested.filter((id) => byId.get(id).kind === 'card');
  const finalOrder = [...folders, ...cards];

  const now = new Date().toISOString();
  for (const [index, id] of finalOrder.entries()) {
    const node = byId.get(id);
    if (node.position === index) continue;
    await exec.query('update nodes set position = $1, updated_at = $2 where id = $3', [
      index,
      now,
      id,
    ]);
  }

  return listChildren(parentId, exec);
}
