/**
 * tests/api.test.js — the RecallLab REST API.
 *
 * node:test + node:assert. supertest is not available, so the app is started
 * with app.listen(0) and driven with the global fetch.
 *
 * The app seeds the COMP3421 tree into the in-memory development database at
 * boot, so every test works against a realistic tree and uses its own
 * uniquely named folders to stay independent.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import app from '../server/app.js';

let server;
let baseUrl;

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Perform a request and decode the JSON body (empty bodies stay null). */
async function api(path, options = {}) {
  const init = { ...options };
  if (init.body !== undefined && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
    init.headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

let counter = 0;
/** A title that cannot collide with anything else in the suite. */
function uniqueTitle(prefix) {
  counter += 1;
  return `${prefix} ${counter}`;
}

/** Create a folder at the root level and return it. */
async function makeFolder(title) {
  const result = await api('/api/nodes', {
    method: 'POST',
    body: { parentId: null, kind: 'folder', title },
  });
  assert.equal(result.status, 201, `could not create folder: ${JSON.stringify(result.body)}`);
  return result.body.node;
}

/** Create a card under a parent and return it. */
async function makeCard(parentId, title, body = 'prompt', answer = 'answer') {
  const result = await api('/api/nodes', {
    method: 'POST',
    body: { parentId, kind: 'card', title, body, answer },
  });
  assert.equal(result.status, 201, `could not create card: ${JSON.stringify(result.body)}`);
  return result.body.node;
}

const NODE_KEYS = [
  'id',
  'parentId',
  'kind',
  'title',
  'body',
  'answer',
  'position',
  'createdAt',
  'updatedAt',
];

/* ------------------------------------------------------------------ */
/* Health and tree                                                     */
/* ------------------------------------------------------------------ */

test('GET /api/health reports the database up', async () => {
  const result = await api('/api/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.db, 'up');
  assert.ok(['postgres', 'memory'].includes(result.body.mode));
});

test('GET /api/tree returns every node, flat, in the node shape', async () => {
  const result = await api('/api/tree');
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.nodes));
  assert.ok(result.body.nodes.length > 0);
  for (const node of result.body.nodes) {
    assert.deepEqual(Object.keys(node).sort(), [...NODE_KEYS].sort());
    assert.ok(['folder', 'card'].includes(node.kind));
    assert.equal(typeof node.title, 'string');
    assert.equal(typeof node.position, 'number');
    assert.match(node.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

test('GET /api/nodes lists the root level', async () => {
  const result = await api('/api/nodes');
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.nodes));
  assert.ok(result.body.nodes.length > 0);
  for (const node of result.body.nodes) {
    assert.equal(node.parentId, null);
  }
  // The seeded tree is present.
  assert.ok(result.body.nodes.some((node) => node.title === 'COMP3421'));
});

test('GET /api/nodes?parent=root is the same as the root listing', async () => {
  const plain = await api('/api/nodes');
  const root = await api('/api/nodes?parent=root');
  assert.equal(root.status, 200);
  assert.deepEqual(
    root.body.nodes.map((node) => node.id),
    plain.body.nodes.map((node) => node.id),
  );
});

test('GET /api/nodes?parent=<folder> lists the children of a folder', async () => {
  const root = await api('/api/nodes');
  const comp3421 = root.body.nodes.find((node) => node.title === 'COMP3421');
  assert.ok(comp3421, 'the seeded root folder is missing');

  const result = await api(`/api/nodes?parent=${comp3421.id}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.nodes.length, 5);
  for (const node of result.body.nodes) {
    assert.equal(node.parentId, comp3421.id);
  }
  // Folders first, then cards, each group by position ascending.
  const kinds = result.body.nodes.map((node) => node.kind);
  assert.deepEqual(kinds, kinds.slice().sort((a, b) => (a === b ? 0 : a === 'folder' ? -1 : 1)));
  const positions = result.body.nodes.map((node) => node.position);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('GET /api/nodes?parent=<unknown uuid> is a 404', async () => {
  const result = await api('/api/nodes?parent=00000000-0000-4000-8000-000000000000');
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'not_found');
});

test('GET /api/nodes/<id> returns one node, and 404 for an unknown id', async () => {
  const folder = await makeFolder(uniqueTitle('Single'));
  const found = await api(`/api/nodes/${folder.id}`);
  assert.equal(found.status, 200);
  assert.equal(found.body.node.id, folder.id);

  const missing = await api('/api/nodes/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
});

test('GET /api/nodes/<malformed id> is a 404, not a 500', async () => {
  const result = await api('/api/nodes/not-a-uuid');
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'not_found');
});

/* ------------------------------------------------------------------ */
/* Creating                                                            */
/* ------------------------------------------------------------------ */

test('POST /api/nodes creates a card and returns 201 with a Location header', async () => {
  const folder = await makeFolder(uniqueTitle('Create Card In'));
  const title = uniqueTitle('Card');

  const result = await api('/api/nodes', {
    method: 'POST',
    body: { parentId: folder.id, kind: 'card', title, body: 'the prompt', answer: 'the answer' },
  });

  assert.equal(result.status, 201);
  assert.equal(result.headers.get('location'), `/api/nodes/${result.body.node.id}`);
  assert.equal(result.body.node.kind, 'card');
  assert.equal(result.body.node.title, title);
  assert.equal(result.body.node.body, 'the prompt');
  assert.equal(result.body.node.answer, 'the answer');
  assert.equal(result.body.node.parentId, folder.id);
  assert.equal(typeof result.body.node.position, 'number');
});

test('POST /api/nodes creates a folder with an empty body and answer', async () => {
  const result = await api('/api/nodes', {
    method: 'POST',
    body: { parentId: null, kind: 'folder', title: uniqueTitle('Folder') },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.node.kind, 'folder');
  assert.equal(result.body.node.body, '');
  assert.equal(result.body.node.answer, '');
});

test('POST /api/nodes rejects an empty title with 422', async () => {
  const result = await api('/api/nodes', {
    method: 'POST',
    body: { parentId: null, kind: 'card', title: '   ' },
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'validation_failed');
});

test('POST /api/nodes rejects a duplicate sibling title with 409', async () => {
  const folder = await makeFolder(uniqueTitle('Duplicates In'));
  const title = uniqueTitle('Same Title');
  await makeCard(folder.id, title);

  const result = await api('/api/nodes', {
    method: 'POST',
    body: { parentId: folder.id, kind: 'card', title: `  ${title.toUpperCase()}  ` },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'duplicate_title');
});

test('POST /api/nodes under a card is a 422', async () => {
  const folder = await makeFolder(uniqueTitle('Card Parent'));
  const card = await makeCard(folder.id, uniqueTitle('Leaf Card'));

  const result = await api('/api/nodes', {
    method: 'POST',
    body: { parentId: card.id, kind: 'card', title: uniqueTitle('Too Deep') },
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'validation_failed');
});

test('POST /api/nodes with a body on a folder is a 422', async () => {
  const result = await api('/api/nodes', {
    method: 'POST',
    body: { parentId: null, kind: 'folder', title: uniqueTitle('Folder With Text'), body: 'nope' },
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'validation_failed');
});

test('POST /api/nodes with malformed JSON is a 400', async () => {
  const result = await api('/api/nodes', {
    method: 'POST',
    body: '{ not json',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'invalid_request');
});

/* ------------------------------------------------------------------ */
/* Updating                                                            */
/* ------------------------------------------------------------------ */

test('PUT /api/nodes/:id updates the title and the card content', async () => {
  const folder = await makeFolder(uniqueTitle('Update In'));
  const card = await makeCard(folder.id, uniqueTitle('Before'));

  const result = await api(`/api/nodes/${card.id}`, {
    method: 'PUT',
    body: { title: 'After', body: 'new prompt', answer: 'new answer' },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.node.title, 'After');
  assert.equal(result.body.node.body, 'new prompt');
  assert.equal(result.body.node.answer, 'new answer');

  const reread = await api(`/api/nodes/${card.id}`);
  assert.equal(reread.body.node.title, 'After');
});

test('PUT /api/nodes/:id with an empty title is a 422', async () => {
  const folder = await makeFolder(uniqueTitle('Update Empty In'));
  const card = await makeCard(folder.id, uniqueTitle('Keep Me'));

  const result = await api(`/api/nodes/${card.id}`, {
    method: 'PUT',
    body: { title: '  ' },
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'validation_failed');
});

test('PUT /api/nodes/:id on an unknown node is a 404', async () => {
  const result = await api('/api/nodes/00000000-0000-4000-8000-000000000000', {
    method: 'PUT',
    body: { title: 'ghost' },
  });
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'not_found');
});

/* ------------------------------------------------------------------ */
/* Moving                                                              */
/* ------------------------------------------------------------------ */

test('PUT /api/nodes/:id moves a node into another folder', async () => {
  const source = await makeFolder(uniqueTitle('Move From'));
  const target = await makeFolder(uniqueTitle('Move To'));
  const card = await makeCard(source.id, uniqueTitle('Travelling Card'));

  const result = await api(`/api/nodes/${card.id}`, {
    method: 'PUT',
    body: { parentId: target.id },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.node.parentId, target.id);

  const inTarget = await api(`/api/nodes?parent=${target.id}`);
  assert.ok(inTarget.body.nodes.some((node) => node.id === card.id));

  const inSource = await api(`/api/nodes?parent=${source.id}`);
  assert.ok(!inSource.body.nodes.some((node) => node.id === card.id));
});

test('PUT a node into itself is a 409 invalid_move', async () => {
  const folder = await makeFolder(uniqueTitle('Self Move'));

  const result = await api(`/api/nodes/${folder.id}`, {
    method: 'PUT',
    body: { parentId: folder.id },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'invalid_move');
});

test('PUT a folder into its own descendant is a 409 invalid_move', async () => {
  const parent = await makeFolder(uniqueTitle('Ancestor'));
  const child = await makeFolder(uniqueTitle('Descendant'));
  await api(`/api/nodes/${child.id}`, { method: 'PUT', body: { parentId: parent.id } });

  const result = await api(`/api/nodes/${parent.id}`, {
    method: 'PUT',
    body: { parentId: child.id },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'invalid_move');
});

/* ------------------------------------------------------------------ */
/* Reordering                                                          */
/* ------------------------------------------------------------------ */

test('POST /api/nodes/reorder replaces the order of a level', async () => {
  const folder = await makeFolder(uniqueTitle('Reorder In'));
  const first = await makeCard(folder.id, uniqueTitle('One'));
  const second = await makeCard(folder.id, uniqueTitle('Two'));
  const third = await makeCard(folder.id, uniqueTitle('Three'));

  const result = await api('/api/nodes/reorder', {
    method: 'POST',
    body: { parentId: folder.id, orderedIds: [third.id, first.id, second.id] },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.nodes.map((node) => node.id),
    [third.id, first.id, second.id],
  );
  assert.deepEqual(
    result.body.nodes.map((node) => node.position),
    [0, 1, 2],
  );

  const listed = await api(`/api/nodes?parent=${folder.id}`);
  assert.deepEqual(
    listed.body.nodes.map((node) => node.id),
    [third.id, first.id, second.id],
  );
});

test('POST /api/nodes/reorder rejects ids from another level with a 400', async () => {
  const folder = await makeFolder(uniqueTitle('Reorder Guard In'));
  const other = await makeFolder(uniqueTitle('Reorder Guard Other'));
  const stray = await makeCard(other.id, uniqueTitle('Stray'));

  const result = await api('/api/nodes/reorder', {
    method: 'POST',
    body: { parentId: folder.id, orderedIds: [stray.id] },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'invalid_request');
});

/* ------------------------------------------------------------------ */
/* Deleting                                                            */
/* ------------------------------------------------------------------ */

test('DELETE /api/nodes/:id deletes a card and returns 204', async () => {
  const folder = await makeFolder(uniqueTitle('Delete In'));
  const card = await makeCard(folder.id, uniqueTitle('Doomed'));

  const result = await api(`/api/nodes/${card.id}`, { method: 'DELETE' });
  assert.equal(result.status, 204);
  assert.equal(result.body, null);

  const gone = await api(`/api/nodes/${card.id}`);
  assert.equal(gone.status, 404);
});

test('DELETE on a folder removes the whole subtree', async () => {
  const root = await makeFolder(uniqueTitle('Cascade Root'));
  const child = await makeFolder(uniqueTitle('Cascade Child'));
  const grandchild = await makeCard(child.id, uniqueTitle('Cascade Grandchild'));
  await api(`/api/nodes/${child.id}`, { method: 'PUT', body: { parentId: root.id } });

  const before = await api('/api/tree');
  assert.ok(before.body.nodes.some((node) => node.id === grandchild.id));

  const result = await api(`/api/nodes/${root.id}`, { method: 'DELETE' });
  assert.equal(result.status, 204);

  const after = await api('/api/tree');
  const ids = after.body.nodes.map((node) => node.id);
  assert.ok(!ids.includes(root.id));
  assert.ok(!ids.includes(child.id));
  assert.ok(!ids.includes(grandchild.id));

  const gone = await api(`/api/nodes/${root.id}`);
  assert.equal(gone.status, 404);
});

/* ------------------------------------------------------------------ */
/* Path                                                                */
/* ------------------------------------------------------------------ */

test('GET /api/nodes/:id/path returns the ancestor chain, root first, without the node', async () => {
  const level1 = await makeFolder(uniqueTitle('Path Level 1'));
  const level2 = await makeFolder(uniqueTitle('Path Level 2'));
  const card = await makeCard(level2.id, uniqueTitle('Path Card'));
  await api(`/api/nodes/${level2.id}`, { method: 'PUT', body: { parentId: level1.id } });

  const result = await api(`/api/nodes/${card.id}/path`);
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.path));

  const ids = result.body.path.map((node) => node.id);
  assert.ok(!ids.includes(card.id), 'the node itself must not be in its own path');
  assert.ok(ids.includes(level1.id));
  assert.ok(ids.includes(level2.id));
  assert.ok(ids.indexOf(level1.id) < ids.indexOf(level2.id), 'the chain is root first');
});

test('GET /api/nodes/:id/path for an unknown node is a 404', async () => {
  const result = await api('/api/nodes/00000000-0000-4000-8000-000000000000/path');
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'not_found');
});
