/**
 * RecallLab — Edit Mode tests (contracts §4.7 and §5.3; design §4.3).
 *
 * `node:test` has no DOM, so Edit Mode is driven in a real Chromium through
 * the globally installed Playwright.
 *
 * The harness is built under the OS temp directory:
 *   - `public/js/edit.js` is COPIED verbatim (the code under test is the
 *     shipped code);
 *   - `public/js/store.js` does not exist yet — it belongs to another agent —
 *     so a STUB implements the store contract (contracts §4.2) and talks to a
 *     fake `/api` served by the harness over real HTTP. Every mutating
 *     request it makes is recorded, so the tests can assert that a move is
 *     ONE PUT and that a reorder is ONE POST;
 *   - `public/js/focus.js` and `public/js/gestures.js` are copied verbatim so
 *     Edit Mode can be exercised over Focus Mode;
 *   - the page itself stands in for `filepage.js`: it renders the level as
 *     tiles with the DOM hooks of contracts §5.1 and §5.3.
 *
 * Everything asserted here therefore exercises the real `edit.js` against a
 * stubbed store. See the report for what that does and does not prove.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, copyFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

/* ---------------------------------------------------------------------------
 * The seed tree — the shape of the COMP3421 course material
 * ------------------------------------------------------------------------ */

const SEED = [
  { id: 'f-big-picture', parentId: null, kind: 'folder', title: '01 The Big Picture' },
  { id: 'f-front-end', parentId: null, kind: 'folder', title: '02 Front-End' },
  { id: 'f-back-end', parentId: null, kind: 'folder', title: '03 Back-End' },
  { id: 'c-journey', parentId: null, kind: 'card', title: 'Personal Site Architecture', body: 'How the personal site is put together.', answer: 'Static pages behind one router.' },

  { id: 'c-client-server', parentId: 'f-big-picture', kind: 'card', title: 'Client–Server Model', body: 'Who talks to whom.', answer: 'The browser speaks HTTP to a server.' },
  { id: 'c-request', parentId: 'f-big-picture', kind: 'card', title: 'One Request End to End', body: 'Follow a single request.', answer: 'DNS, TCP, TLS, HTTP, route, response.' },

  { id: 'c-html', parentId: 'f-front-end', kind: 'card', title: 'HTML', body: 'The structure of a document.', answer: 'The element tree the browser builds.' },
  { id: 'c-css', parentId: 'f-front-end', kind: 'card', title: 'CSS', body: 'How a document is painted.', answer: 'Cascade, specificity, layout, paint.' },

  { id: 'c-http', parentId: 'f-back-end', kind: 'card', title: 'HTTP', body: 'The request/response protocol.', answer: 'Stateless verbs over a request/response cycle.' },
  { id: 'f-part-i', parentId: 'f-back-end', kind: 'folder', title: 'Part I — Node.js Runtime' },
  { id: 'f-part-ii', parentId: 'f-back-end', kind: 'folder', title: 'Part II — Express' },

  { id: 'c-event-loop', parentId: 'f-part-i', kind: 'card', title: 'The Event Loop', body: 'How Node schedules work.', answer: 'Call stack, timers, then the microtask queue.' },

  { id: 'c-middleware', parentId: 'f-part-ii', kind: 'card', title: 'Middleware', body: 'Functions in the request pipeline.', answer: 'They run in order.' },
  { id: 'c-express', parentId: 'f-part-ii', kind: 'card', title: 'Express', body: 'The Node web framework.', answer: 'Routing, middleware, requests.' },
  { id: 'c-rest', parentId: 'f-part-ii', kind: 'card', title: 'REST', body: 'The resource style.', answer: 'Resources, verbs, representations.' },
  { id: 'f-part-iii', parentId: 'f-part-ii', kind: 'folder', title: 'Part III — Databases' },
  { id: 'c-sql', parentId: 'f-part-iii', kind: 'card', title: 'SQL', body: 'Talking to a relational store.', answer: 'Tables, rows, queries.' },
];

/* ---------------------------------------------------------------------------
 * The fake API — the same rules the real server enforces (contracts §3)
 * ------------------------------------------------------------------------ */

function createApi() {
  const nodes = new Map();
  const requests = [];

  function reset() {
    nodes.clear();
    requests.length = 0;
    for (const raw of SEED) {
      const siblings = [...nodes.values()].filter((n) => n.parentId === raw.parentId);
      nodes.set(raw.id, {
        id: raw.id,
        parentId: raw.parentId ?? null,
        kind: raw.kind,
        title: raw.title,
        body: raw.body ?? '',
        answer: raw.answer ?? '',
        position: siblings.length,
        createdAt: '2026-10-24T08:00:00.000Z',
        updatedAt: '2026-10-24T08:00:00.000Z',
      });
    }
  }

  const level = (parentId) =>
    [...nodes.values()]
      .filter((node) => (node.parentId ?? null) === (parentId ?? null))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
        return a.position - b.position;
      });

  const descendants = (id) => {
    const found = [];
    const frontier = [id];
    while (frontier.length) {
      const current = frontier.shift();
      for (const node of nodes.values()) {
        if (node.parentId === current && !found.includes(node.id)) {
          found.push(node.id);
          frontier.push(node.id);
        }
      }
    }
    return found;
  };

  reset();

  return {
    reset,
    nodes,
    level,
    descendants,
    requests,
    handle(method, pathname, body, query) {
      requests.push({ method, pathname, query: query ?? null, body: body ?? null });
      if (method === 'GET' && pathname === '/api/tree') {
        return { status: 200, payload: { nodes: [...nodes.values()] } };
      }
      if (method === 'GET' && pathname === '/api/nodes') {
        const parent = query?.get('parent') ?? 'root';
        return { status: 200, payload: { nodes: level(parent === 'root' ? null : parent) } };
      }
      if (method === 'GET' && pathname.endsWith('/path')) {
        const id = pathname.slice('/api/nodes/'.length, -'/path'.length);
        const path = [];
        let current = nodes.get(id);
        while (current && current.parentId) {
          current = nodes.get(current.parentId);
          if (current) path.unshift(current);
        }
        return { status: 200, payload: { path } };
      }
      if (method === 'POST' && pathname === '/api/nodes') {
        const parentId = body.parentId ?? null;
        const node = {
          id: `n-${Math.random().toString(36).slice(2, 10)}`,
          parentId,
          kind: body.kind,
          title: String(body.title ?? '').trim(),
          body: body.kind === 'folder' ? '' : (body.body ?? ''),
          answer: body.kind === 'folder' ? '' : (body.answer ?? ''),
          position: level(parentId).length,
          createdAt: '2026-10-24T09:00:00.000Z',
          updatedAt: '2026-10-24T09:00:00.000Z',
        };
        nodes.set(node.id, node);
        return { status: 201, payload: { node } };
      }
      if (method === 'PUT' && pathname.startsWith('/api/nodes/')) {
        const id = pathname.slice('/api/nodes/'.length);
        const node = nodes.get(id);
        if (!node) return { status: 404, payload: { error: { code: 'not_found', message: 'No node with that id.' } } };
        if (body.title !== undefined) node.title = String(body.title).trim();
        if (body.body !== undefined) node.body = body.body;
        if (body.answer !== undefined) node.answer = body.answer;
        if (body.parentId !== undefined && (body.parentId ?? null) !== node.parentId) {
          const target = body.parentId ?? null;
          if (target === id || descendants(id).includes(target)) {
            return { status: 409, payload: { error: { code: 'invalid_move', message: 'A folder cannot be moved into itself.' } } };
          }
          node.position = level(target).length;
          node.parentId = target;
        }
        node.updatedAt = '2026-10-24T09:30:00.000Z';
        return { status: 200, payload: { node } };
      }
      if (method === 'DELETE' && pathname.startsWith('/api/nodes/')) {
        const id = pathname.slice('/api/nodes/'.length);
        if (!nodes.has(id)) return { status: 404, payload: { error: { code: 'not_found', message: 'No node with that id.' } } };
        for (const descendant of descendants(id).reverse()) nodes.delete(descendant);
        nodes.delete(id);
        return { status: 204, payload: null };
      }
      if (method === 'POST' && pathname === '/api/nodes/reorder') {
        const parentId = body.parentId ?? null;
        const current = level(parentId);
        const byId = new Map(current.map((node) => [node.id, node]));
        const requested = [];
        for (const id of body.orderedIds ?? []) {
          if (!byId.has(id)) {
            return { status: 400, payload: { error: { code: 'invalid_request', message: 'orderedIds must only contain nodes of the given level.' } } };
          }
          if (!requested.includes(id)) requested.push(id);
        }
        for (const node of current) if (!requested.includes(node.id)) requested.push(node.id);
        const folders = requested.filter((id) => byId.get(id).kind === 'folder');
        const cards = requested.filter((id) => byId.get(id).kind === 'card');
        [...folders, ...cards].forEach((id, index) => {
          byId.get(id).position = index;
        });
        return { status: 200, payload: { nodes: level(parentId) } };
      }
      return { status: 404, payload: { error: { code: 'not_found', message: 'No such endpoint.' } } };
    },
  };
}

/* ---------------------------------------------------------------------------
 * The stub store — contracts §4.2, backed by the fake API over HTTP
 * ------------------------------------------------------------------------ */

const STUB_STORE = `
const NODES = new Map();
const subscribers = new Set();
let currentFolderId = null;
let mode = 'file';
let focusId = null;

window.__requests = [];

function record(method, url, body) {
  window.__requests.push({ method, url, body: body ?? null });
}

async function request(method, url, body) {
  const options = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) options.body = JSON.stringify(body);
  record(method, url, body);
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload?.error?.message || ('Request failed: ' + response.status));
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  if (response.status === 204) return undefined;
  return response.json();
}

function notify() {
  for (const fn of Array.from(subscribers)) fn();
}

function sortLevel(list) {
  return list.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.position - b.position;
  });
}

function childrenOf(parentId) {
  const key = parentId ?? null;
  return sortLevel([...NODES.values()].filter((node) => (node.parentId ?? null) === key));
}

export const store = {
  getTree() { return [...NODES.values()]; },
  getLevel() { return childrenOf(currentFolderId); },
  getNode(id) { return NODES.get(id); },
  getChildren(parentId) { return childrenOf(parentId); },
  getMode() { return mode; },
  isEditMode() { return false; },
  getFocusId() { return focusId; },
  getCurrentFolderId() { return currentFolderId; },

  async loadTree() {
    const payload = await request('GET', '/api/tree');
    NODES.clear();
    for (const node of payload.nodes) NODES.set(node.id, node);
    notify();
    return store.getTree();
  },

  async loadLevel(parentId) {
    currentFolderId = parentId ?? null;
    const payload = await request('GET', '/api/nodes?parent=' + encodeURIComponent(currentFolderId ?? 'root'));
    for (const node of payload.nodes) NODES.set(node.id, node);
    notify();
    return childrenOf(currentFolderId);
  },

  async createNode({ parentId, kind, title, body = '', answer = '' }) {
    const payload = await request('POST', '/api/nodes', { parentId: parentId ?? null, kind, title, body, answer });
    NODES.set(payload.node.id, payload.node);
    notify();
    return payload.node;
  },

  async updateNode(id, patch) {
    const payload = await request('PUT', '/api/nodes/' + id, patch);
    NODES.set(payload.node.id, payload.node);
    notify();
    return payload.node;
  },

  async deleteNode(id) {
    await request('DELETE', '/api/nodes/' + id);
    const doomed = [id];
    const frontier = [id];
    while (frontier.length) {
      const current = frontier.shift();
      for (const node of NODES.values()) {
        if ((node.parentId ?? null) === current && !doomed.includes(node.id)) {
          doomed.push(node.id);
          frontier.push(node.id);
        }
      }
    }
    for (const nodeId of doomed) NODES.delete(nodeId);
    notify();
  },

  async moveNode(id, parentId) {
    const payload = await request('PUT', '/api/nodes/' + id, { parentId: parentId ?? null });
    NODES.set(payload.node.id, payload.node);
    notify();
    return payload.node;
  },

  async reorderLevel(parentId, orderedIds) {
    const payload = await request('POST', '/api/nodes/reorder', { parentId: parentId ?? null, orderedIds });
    for (const node of payload.nodes) NODES.set(node.id, node);
    notify();
    return payload.nodes;
  },

  subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
};
`;

/* ---------------------------------------------------------------------------
 * The harness page — a stand-in for filepage.js
 * ------------------------------------------------------------------------ */

const HARNESS_PAGE = `<!doctype html>
<html lang="en" data-register="browse">
<head>
<meta charset="utf-8">
<title>RecallLab — edit harness</title>
<link rel="stylesheet" href="/stub/base.css">
<link rel="stylesheet" href="/stub/tokens.css">
<link rel="stylesheet" href="/stub/layout.css">
<link rel="stylesheet" href="/stub/stage.css">
<link rel="stylesheet" href="/stub/edit.css">
<style>
  /* Harness-only affordances that the real owners will bring with their own
     stylesheets: the tile delete control and the spine rows. */
  .tile-delete {
    position: absolute; top: 8px; right: 8px;
    width: 24px; height: 24px; padding: 0;
    border: 1px solid var(--hairline); border-radius: 8px;
    background: var(--surface); color: var(--ink-3);
    font-size: 13px; line-height: 1;
  }
  .tile-delete:hover { background: var(--surface-hover); color: var(--ink-2); }
  .spine-row { border: 1px solid transparent; }
</style>
</head>
<body>
  <div id="app">
    <aside id="spine" aria-label="Outline">
      <div id="spine-tree"></div>
    </aside>
    <main id="main">
      <header id="toolbar">
        <nav id="breadcrumb"></nav>
        <div id="toolbar-actions">
          <button type="button" class="btn btn-ghost" data-action="toggle-edit" id="toggle-edit">Edit</button>
          <button type="button" class="btn btn-primary" id="action-create">+ New</button>
        </div>
      </header>
      <div id="content">
        <ul id="grid" class="grid"></ul>
        <div id="stage-root"></div>
      </div>
    </main>
  </div>
  <script type="module">
    window.__errors = [];
    window.addEventListener('error', (ev) => window.__errors.push(String(ev.message)));
    window.__ready = (async () => {
      const storeMod = await import('/stub/store.js');
      const editMod = await import('/stub/edit.js');
      const focusMod = await import('/stub/focus.js');
      const store = storeMod.store;
      window.__store = store;
      window.__edit = editMod.edit;
      window.__focus = focusMod.focus;

      const FOLDER_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h4l1.5 2h7.5A1.5 1.5 0 0 1 18 7.5v7A1.5 1.5 0 0 1 16.5 16h-13A1.5 1.5 0 0 1 2 14.5z"/></svg>';
      const CARD_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="2.5" width="14" height="15" rx="1.5"/><path d="M6 7h8M6 10.5h8M6 14h5"/></svg>';

      function tile(node) {
        const li = document.createElement('li');
        li.className = 'tile';
        li.dataset.id = node.id;
        li.dataset.kind = node.kind;
        li.tabIndex = 0;
        li.setAttribute('role', 'button');

        const icon = document.createElement('div');
        icon.className = 'tile-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = node.kind === 'folder' ? FOLDER_SVG : CARD_SVG;

        const title = document.createElement('div');
        title.className = 'tile-title';
        title.dataset.edit = 'title';
        title.textContent = node.title;

        const preview = document.createElement('div');
        preview.className = 'tile-preview';
        preview.textContent = (node.body || '').split('\\n')[0];

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'tile-delete';
        del.dataset.action = 'delete';
        del.setAttribute('aria-label', 'Delete ' + node.title);
        del.textContent = '×';

        li.append(icon, title, preview, del);
        li.addEventListener('click', async () => {
          if (node.kind === 'folder') {
            await store.loadLevel(node.id);
            render();
          }
        });
        return li;
      }

      function renderSpine() {
        const host = document.getElementById('spine-tree');
        host.textContent = '';
        const depthOf = (node) => {
          let depth = 0;
          let current = node;
          while (current && current.parentId) {
            current = store.getNode(current.parentId);
            depth += 1;
          }
          return depth;
        };
        for (const node of store.getTree()) {
          const row = document.createElement('div');
          row.className = 'spine-row';
          row.dataset.id = node.id;
          row.dataset.kind = node.kind;
          row.style.setProperty('--depth', String(depthOf(node)));
          row.textContent = node.title;
          host.appendChild(row);
        }
      }

      function render() {
        const grid = document.getElementById('grid');
        grid.textContent = '';
        for (const node of store.getLevel()) grid.appendChild(tile(node));
        renderSpine();
      }

      store.subscribe(render);
      window.__goto = async (folderId) => {
        await store.loadLevel(folderId ?? null);
        render();
      };
      window.__render = render;

      await store.loadTree();
      await store.loadLevel(null);
      render();
      return true;
    })();
  </script>
</body>
</html>
`;

/* ---------------------------------------------------------------------------
 * The integration page — the REAL client modules
 * ------------------------------------------------------------------------
 * `api.js`, `store.js` and `filepage.js` are the modules another agent owns;
 * they are copied verbatim next to `edit.js` and talk to the same fake API.
 * The page mounts the real file page over the DOM registry of contracts §5.
 * -------------------------------------------------------------------------- */

const INTEGRATION_PAGE = `<!doctype html>
<html lang="en" data-register="browse">
<head>
<meta charset="utf-8">
<title>RecallLab — edit integration harness</title>
<link rel="stylesheet" href="/real/base.css">
<link rel="stylesheet" href="/real/tokens.css">
<link rel="stylesheet" href="/real/layout.css">
<link rel="stylesheet" href="/real/stage.css">
<link rel="stylesheet" href="/real/edit.css">
</head>
<body>
  <div id="app">
    <aside id="spine" aria-label="Outline">
      <div id="spine-tree"></div>
    </aside>
    <main id="main">
      <header id="toolbar">
        <nav id="breadcrumb" aria-label="Breadcrumb"></nav>
        <div id="toolbar-actions">
          <button type="button" class="btn btn-primary" id="action-create">New</button>
        </div>
      </header>
      <div id="content">
        <ul id="grid" class="grid"></ul>
        <div id="stage-root"></div>
      </div>
    </main>
  </div>
  <script type="module">
    window.__errors = [];
    window.addEventListener('error', (ev) => window.__errors.push(String(ev.message)));
    window.__ready = (async () => {
      const { store } = await import('/real/store.js');
      const { mountFilePage } = await import('/real/filepage.js');
      const { edit } = await import('/real/edit.js');
      window.__store = store;
      window.__edit = edit;

      /* main.js owns the router; the file page asks for navigation through
         this event, and the harness only records it. */
      window.__navigations = [];
      window.addEventListener('recalllab:navigate', (ev) => {
        window.__navigations.push(ev.detail);
      });

      const grid = document.getElementById('grid');
      store.subscribe(() => mountFilePage(grid));

      window.__goto = async (folderId) => {
        /* The router owns the current folder; the harness plays its part. */
        store.setView({ folderId: folderId ?? null });
        await store.loadLevel(folderId ?? null);
        mountFilePage(grid);
      };

      await store.loadTree();
      await store.loadLevel(null);
      mountFilePage(grid);
      return true;
    })();
  </script>
</body>
</html>
`;

/* ---------------------------------------------------------------------------
 * Harness
 * ------------------------------------------------------------------------ */

function loadPlaywright() {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const require = createRequire(path.join(globalRoot, 'noop.js'));
  return require('playwright');
}

let playwright = null;
try {
  playwright = loadPlaywright();
} catch {
  playwright = null;
}

const harness = {
  dir: null,
  server: null,
  port: 0,
  browser: null,
  page: null,
  pageErrors: [],
  contexts: [],
  api: createApi(),
};

async function buildHarness() {
  harness.dir = await mkdtemp(path.join(tmpdir(), 'recalllab-edit-'));

  /* Two roots, because `focus.js` imports `./store.js`: the stub harness must
     see the stub store, the integration harness the real one. */
  const stub = path.join(harness.dir, 'stub');
  const real = path.join(harness.dir, 'real');
  await mkdir(stub, { recursive: true });
  await mkdir(real, { recursive: true });

  /* The stub harness: the code under test plus the modules it is exercised
     with, against a stub store. */
  await copyFile(path.join(PUBLIC, 'js', 'edit.js'), path.join(stub, 'edit.js'));
  await copyFile(path.join(PUBLIC, 'js', 'focus.js'), path.join(stub, 'focus.js'));
  await copyFile(path.join(PUBLIC, 'js', 'gestures.js'), path.join(stub, 'gestures.js'));
  await writeFile(path.join(stub, 'store.js'), STUB_STORE, 'utf8');

  /* The integration harness: the code under test plus the REAL client
     modules of the other agents. */
  await copyFile(path.join(PUBLIC, 'js', 'edit.js'), path.join(real, 'edit.js'));
  for (const module of ['api.js', 'store.js', 'filepage.js']) {
    await copyFile(path.join(PUBLIC, 'js', module), path.join(real, module));
  }

  for (const root of [stub, real]) {
    for (const sheet of ['base.css', 'tokens.css', 'layout.css', 'stage.css', 'edit.css']) {
      await copyFile(path.join(PUBLIC, 'styles', sheet), path.join(root, sheet));
    }
  }

  await writeFile(path.join(stub, 'index.html'), HARNESS_PAGE, 'utf8');
  await writeFile(path.join(real, 'integration.html'), INTEGRATION_PAGE, 'utf8');
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function startServer() {
  return new Promise((resolve) => {
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
    };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;

      if (pathname.startsWith('/api/')) {
        const body = await readBody(req);
        const result = harness.api.handle(req.method, pathname, body, url.searchParams);
        if (result.status === 204) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result.payload));
        return;
      }

      /* The request log of the fake API, for the tests that drive the real
         client modules (which do not record their own requests). */
      if (pathname === '/__requests') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(harness.api.requests));
        return;
      }

      const root = pathname.startsWith('/real/') ? 'real' : 'stub';
      const relative = pathname.replace(/^\/(stub|real)\//, '/');
      const file = path.join(
        harness.dir,
        root,
        path.normalize(relative === '/' ? '/index.html' : relative).replace(/^(\.\.[/\\])+/, ''),
      );
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      harness.server = server;
      harness.port = server.address().port;
      resolve();
    });
  });
}

before(async () => {
  if (!playwright) return;
  await buildHarness();
  await startServer();
  harness.browser = await playwright.chromium.launch();
  const context = await harness.browser.newContext({ viewport: { width: 1280, height: 900 } });
  harness.contexts.push(context);
  harness.page = await context.newPage();
  harness.page.setDefaultTimeout(6000);
  harness.page.on('pageerror', (err) => harness.pageErrors.push(String(err)));
  harness.page.on('console', (msg) => {
    if (msg.type() === 'error') harness.pageErrors.push(msg.text());
  });
});

after(async () => {
  if (harness.browser) await harness.browser.close();
  for (const context of harness.contexts) {
    try {
      await context.close();
    } catch {
      /* already closed */
    }
  }
  if (harness.server) await new Promise((resolve) => harness.server.close(resolve));
  if (harness.dir) await rm(harness.dir, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!playwright) return;
  harness.api.reset();
  await harness.page.goto(`http://127.0.0.1:${harness.port}/stub/index.html`);
  await harness.page.evaluate(() => window.__ready);
  await harness.page.evaluate(() => {
    window.__requests = [];
  });
});

const skip = () => (playwright ? false : 'Playwright is not installed');

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

async function requests(page) {
  return page.evaluate(() => window.__requests);
}

async function mutations(page) {
  return (await requests(page)).filter((entry) => entry.method !== 'GET');
}

async function enableEdit(page) {
  await page.evaluate(() => window.__edit.setActive(true));
  await page.waitForSelector('[data-edit="title"] input');
}

async function disableEdit(page) {
  await page.evaluate(() => window.__edit.setActive(false));
}

function titleInput(page, nodeId) {
  return page.locator(`.tile[data-id="${nodeId}"] [data-edit="title"] input`);
}

/** Type a value into a field and let it blur. */
async function fillAndBlur(locator, value) {
  await locator.click();
  await locator.fill(value);
  await locator.evaluate((el) => el.blur());
  await locator.page().waitForTimeout(80);
}
/** Drag the tile at `source` onto the element at `target`. */
async function dragOnto(page, source, target, ratio = 0.5) {
  const from = await page.locator(source).boundingBox();
  const to = await page.locator(target).boundingBox();
  assert.ok(from && to, `both ${source} and ${target} must be on screen`);

  /* The press starts in the tile's padding, clear of the mounted editor. */
  const startX = from.x + from.width / 2;
  const startY = from.y + 8;
  const endX = to.x + to.width * ratio;
  const endY = to.y + to.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  /* Cross the 56px drag threshold first, then travel to the target. */
  await page.mouse.move(startX + 70, startY + 20, { steps: 6 });
  await page.mouse.move(endX, endY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/* ---------------------------------------------------------------------------
 * The live exercise — the whole Edit Mode flow over the file page
 * ------------------------------------------------------------------------ */

const SHOT_DIR = process.env.RL_EDIT_SHOT_DIR || '';

async function shoot(page, name) {
  if (!SHOT_DIR) return null;
  /* Let the entrance cross-fade finish so the shot shows the settled state. */
  await page.waitForTimeout(260);
  const file = path.join(SHOT_DIR, name);
  await page.screenshot({ path: file });
  return file;
}

test('live exercise: create, rename, edit, delete, move and reorder over the file page', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);
  const shots = [];

  /* --- create a folder and a card in the level on screen --- */
  await page.click('#action-create');
  await page.click('.edit-menu-item[data-create-kind="folder"]');
  await page.fill('#edit-create-title', '04 Review');
  await page.click('.edit-popover [data-create-submit]');
  await page.waitForFunction(() => window.__store.getLevel().some((node) => node.title === '04 Review'));

  await page.click('#action-create');
  await page.click('.edit-menu-item[data-create-kind="card"]');
  await page.fill('#edit-create-title', 'A New Card');
  await page.click('.edit-popover [data-create-submit]');
  await page.waitForFunction(() => window.__store.getLevel().some((node) => node.title === 'A New Card'));
  shots.push(await shoot(page, '01-edit-file-page.png'));

  /* --- rename a card --- */
  await fillAndBlur(titleInput(page, 'c-journey'), 'Personal Site Architecture v2');
  const renamed = await page.evaluate(() => window.__store.getNode('c-journey').title);
  assert.equal(renamed, 'Personal Site Architecture v2');

  /* --- the empty title is refused with an inline error --- */
  await fillAndBlur(titleInput(page, 'c-journey'), '   ');
  await page.waitForTimeout(260);
  const error = await page.evaluate(() => {
    const hook = document.querySelector('.tile[data-id="c-journey"] [data-edit="title"]');
    const message = hook.querySelector('.edit-error');
    const input = hook.querySelector('input');
    return {
      message: message ? message.textContent : null,
      border: input ? getComputedStyle(input).borderTopColor : null,
      size: input ? getComputedStyle(input).fontSize : null,
      label: hook.querySelector('.edit-label')?.textContent,
    };
  });
  assert.equal(error.message, 'Title cannot be empty');
  assert.equal(error.border, 'rgb(180, 35, 24)', 'the field carries the one permitted error colour');
  assert.equal(error.label, 'Title');
  shots.push(await shoot(page, '05-empty-title-error.png'));
  await fillAndBlur(titleInput(page, 'c-journey'), 'Personal Site Architecture v2');

  /* --- edit the body and the answer of the focused card --- */
  await page.evaluate(() => window.__focus.enter('c-journey'));
  await page.waitForSelector('.stage-card[data-depth="0"]');
  await page.waitForSelector('.stage-card[data-depth="0"] [data-edit="body"] textarea');
  await fillAndBlur(
    page.locator('.stage-card[data-depth="0"] [data-edit="body"] textarea'),
    'How the personal site is put together.\nOne paragraph per idea.',
  );
  await fillAndBlur(
    page.locator('.stage-card[data-depth="0"] [data-edit="answer"] textarea'),
    'Static pages behind one router.\nThe router decides what to serve.',
  );
  const edited = await page.evaluate(() => ({
    body: window.__store.getNode('c-journey').body,
    answer: window.__store.getNode('c-journey').answer,
  }));
  assert.equal(edited.body, 'How the personal site is put together.\nOne paragraph per idea.');
  assert.equal(edited.answer, 'Static pages behind one router.\nThe router decides what to serve.');
  shots.push(await shoot(page, '02-edit-focus-card.png'));
  await page.evaluate(() => window.__focus.exit());

  /* --- move a card onto a folder --- */
  await page.evaluate(() => window.__goto(null));
  await page.waitForSelector('.tile[data-id="c-journey"]');

  /* The drag itself: no transition may be active while the pointer moves. */
  const from = await page.locator('.tile[data-id="c-journey"]').boundingBox();
  const to = await page.locator('.tile[data-id="f-front-end"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 70, from.y + 30, { steps: 6 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.waitForTimeout(150);
  const dragState = await page.evaluate(() => {
    const dragged = document.querySelector('.tile.dragging');
    const target = document.querySelector('.edit-drop-target');
    return {
      dragging: Boolean(dragged),
      transition: dragged ? getComputedStyle(dragged).transitionDuration : null,
      dropTarget: target ? target.dataset.id : null,
    };
  });
  assert.equal(dragState.dragging, true, 'the dragged tile carries the dragging state');
  assert.equal(dragState.transition, '0s', 'no transition is active during the drag');
  assert.equal(dragState.dropTarget, 'f-front-end', 'the folder under the pointer is the drop target');
  shots.push(await shoot(page, '04-drag-drop-target.png'));
  await page.mouse.up();
  await page.waitForTimeout(150);

  const moved = await page.evaluate(() => window.__store.getNode('c-journey').parentId);
  assert.equal(moved, 'f-front-end');

  /* --- reorder two siblings --- */
  await page.evaluate(() => window.__goto('f-front-end'));
  await page.waitForSelector('.tile[data-id="c-journey"]');
  await dragOnto(page, '.tile[data-id="c-journey"]', '.tile[data-id="c-html"]', 0.25);
  const order = await page.evaluate(() =>
    window.__store.getChildren('f-front-end').map((node) => node.id),
  );
  assert.deepEqual(order, ['c-journey', 'c-html', 'c-css']);

  /* --- delete a folder, with the descendant count in the confirmation --- */
  await page.evaluate(() => window.__goto('f-back-end'));
  await page.waitForSelector('.tile[data-id="f-part-ii"]');
  await page.click('.tile[data-id="f-part-ii"] [data-action="delete"]');
  await page.waitForSelector('.edit-dialog');
  const message = await page.evaluate(() => document.querySelector('.edit-dialog-message').textContent);
  assert.equal(message, 'Delete "Part II — Express" and 5 items inside it?');
  shots.push(await shoot(page, '03-delete-confirmation.png'));
  await page.click('.edit-dialog [data-dialog-action="confirm"]');
  await page.waitForFunction(() => !window.__store.getNode('f-part-ii'));

  const sent = await mutations(page);
  const summary = {
    put: sent.filter((entry) => entry.method === 'PUT').map((entry) => `${entry.url} ${JSON.stringify(entry.body)}`),
    post: sent.filter((entry) => entry.method === 'POST').map((entry) => `${entry.url} ${JSON.stringify(entry.body)}`),
    delete: sent.filter((entry) => entry.method === 'DELETE').map((entry) => entry.url),
  };
  console.log('LIVE MUTATIONS', JSON.stringify(summary, null, 2));
  console.log('LIVE SCREENSHOTS', JSON.stringify(shots));
});

/* ---------------------------------------------------------------------------
 * The integration test — edit.js against the REAL store.js and filepage.js
 * ------------------------------------------------------------------------ */

test('integration: Edit Mode drives the real store and the real file page', { skip: skip() }, async () => {
  const page = harness.page;
  await page.goto(`http://127.0.0.1:${harness.port}/real/integration.html`);
  await page.evaluate(() => window.__ready);

  /* The real file page renders the hooks of contracts §5.3. */
  const rendered = await page.evaluate(() => ({
    tiles: document.querySelectorAll('#grid .tile').length,
    cards: document.querySelectorAll('#grid .tile[data-kind="card"]').length,
    titleHooks: document.querySelectorAll('#grid [data-edit="title"]').length,
    bodyHooks: document.querySelectorAll('#grid [data-edit="body"]').length,
    answerHooks: document.querySelectorAll('#grid [data-edit="answer"]').length,
    deletes: document.querySelectorAll('#grid [data-action="delete"]').length,
  }));
  assert.ok(rendered.tiles > 0, 'the real file page rendered the level');
  assert.equal(rendered.titleHooks, rendered.tiles, 'every tile carries a title hook');
  assert.equal(rendered.bodyHooks, rendered.cards, 'every card carries a body hook');
  assert.equal(rendered.answerHooks, rendered.cards, 'every card carries an answer hook');
  assert.equal(rendered.deletes, rendered.tiles, 'every tile carries a delete control');

  /* Edit Mode switches the store's flag, and the owners follow it. */
  await page.evaluate(() => window.__edit.setActive(true));
  await page.waitForSelector('#grid [data-edit="title"] input');

  const on = await page.evaluate(() => ({
    storeEdit: window.__store.isEditMode(),
    inputs: document.querySelectorAll('#grid [data-edit="title"] input').length,
    deletesVisible: [...document.querySelectorAll('#grid [data-action="delete"]')].every(
      (el) => el.offsetParent !== null || getComputedStyle(el).display !== 'none',
    ),
    /* the answer of a card is hidden by the owner until an editor takes it */
    answerVisible: (() => {
      const hook = document.querySelector('#grid [data-edit="answer"]');
      const input = hook?.querySelector('textarea');
      if (!input) return null;
      const box = input.getBoundingClientRect();
      return box.height > 0;
    })(),
    editingField: document.querySelectorAll('#grid .is-editing-field').length,
  }));
  assert.equal(on.storeEdit, true, 'the store knows Edit Mode is on');
  assert.equal(on.inputs, rendered.tiles, 'every title hook became an input');
  assert.equal(on.deletesVisible, true, 'the owners showed their delete controls');
  assert.equal(on.answerVisible, true, 'the hidden answer hook was revealed for editing');
  assert.ok(on.editingField > 0, 'the hooks carry the class the owner looks for');

  /* --- rename --- */
  await fillAndBlur(page.locator('#grid .tile[data-id="c-journey"] [data-edit="title"] input'), 'Renamed by the real store');
  let sent = await page.evaluate(async () => (await fetch('/__requests')).json());
  let puts = sent.filter((entry) => entry.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].pathname, '/api/nodes/c-journey');
  assert.deepEqual(puts[0].body, { title: 'Renamed by the real store' });
  assert.equal(
    await page.evaluate(() => window.__store.getNode('c-journey').title),
    'Renamed by the real store',
  );

  /* --- move --- */
  await dragOnto(page, '#grid .tile[data-id="c-journey"]', '#grid .tile[data-id="f-front-end"]', 0.5);
  sent = await page.evaluate(async () => (await fetch('/__requests')).json());
  puts = sent.filter((entry) => entry.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[1].body, { parentId: 'f-front-end' });
  assert.equal(
    await page.evaluate(() => window.__store.getNode('c-journey').parentId),
    'f-front-end',
  );

  /* --- reorder --- */
  await page.evaluate(() => window.__goto('f-front-end'));
  await page.waitForSelector('#grid .tile[data-id="c-journey"]');
  await dragOnto(page, '#grid .tile[data-id="c-journey"]', '#grid .tile[data-id="c-html"]', 0.25);
  sent = await page.evaluate(async () => (await fetch('/__requests')).json());
  const posts = sent.filter((entry) => entry.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].pathname, '/api/nodes/reorder');
  assert.deepEqual(posts[0].body, {
    parentId: 'f-front-end',
    orderedIds: ['c-journey', 'c-html', 'c-css'],
  });

  /* --- delete a folder, with the cascade count --- */
  await page.evaluate(() => window.__goto('f-back-end'));
  await page.waitForSelector('#grid .tile[data-id="f-part-ii"]');
  await page.click('#grid .tile[data-id="f-part-ii"] [data-action="delete"]');
  await page.waitForSelector('.edit-dialog');
  const message = await page.evaluate(() => document.querySelector('.edit-dialog-message').textContent);
  assert.equal(message, 'Delete "Part II — Express" and 5 items inside it?');
  await page.click('.edit-dialog [data-dialog-action="confirm"]');
  await page.waitForFunction(() => !window.__store.getNode('f-part-ii'));
  sent = await page.evaluate(async () => (await fetch('/__requests')).json());
  const deletes = sent.filter((entry) => entry.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].pathname, '/api/nodes/f-part-ii');

  /* Leaving Edit Mode puts the read-only text back. */
  await page.evaluate(() => window.__edit.setActive(false));
  const off = await page.evaluate(() => {
    const tile = document.querySelector('#grid .tile');
    return {
      storeEdit: window.__store.isEditMode(),
      inputs: document.querySelectorAll('#grid [data-edit="title"] input').length,
      rendered: tile ? tile.querySelector('.tile-title').textContent : null,
      stored: tile ? window.__store.getNode(tile.dataset.id).title : null,
    };
  });
  assert.equal(off.storeEdit, false);
  assert.equal(off.inputs, 0);
  assert.equal(off.rendered, off.stored, 'the read-only title is back');
});

/* ---------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------ */

test('entering and leaving Edit Mode toggles the editable state on the hooks', { skip: skip() }, async () => {
  const page = harness.page;

  const before = await page.evaluate(() => ({
    active: window.__edit.isActive(),
    hooks: document.querySelectorAll('[data-edit="title"]').length,
    inputs: document.querySelectorAll('[data-edit="title"] input').length,
  }));
  assert.equal(before.active, false);
  assert.ok(before.hooks > 0, 'the file page renders the title hooks');
  assert.equal(before.inputs, 0, 'no field is editable outside Edit Mode');

  await enableEdit(page);

  const during = await page.evaluate(() => ({
    active: window.__edit.isActive(),
    hooks: document.querySelectorAll('[data-edit="title"]').length,
    inputs: document.querySelectorAll('[data-edit="title"] input').length,
    textareas: document.querySelectorAll('[data-edit="body"] textarea, [data-edit="answer"] textarea').length,
    mode: document.documentElement.getAttribute('data-edit-mode'),
  }));
  assert.equal(during.active, true);
  assert.equal(during.inputs, during.hooks, 'every title hook became a text input');
  assert.equal(during.mode, 'on');

  await disableEdit(page);

  const after = await page.evaluate(() => ({
    active: window.__edit.isActive(),
    inputs: document.querySelectorAll('[data-edit="title"] input').length,
    rendered: document.querySelector('.tile[data-id="c-journey"] .tile-title').textContent,
  }));
  assert.equal(after.active, false);
  assert.equal(after.inputs, 0, 'the inputs are gone when Edit Mode ends');
  assert.equal(after.rendered, 'Personal Site Architecture', 'the read-only title is back');
});

test('editing a title and blurring saves it and the new value renders', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);

  await fillAndBlur(titleInput(page, 'c-journey'), 'Personal Site Architecture v2');

  const sent = await mutations(page);
  assert.equal(sent.length, 1, 'exactly one mutation');
  assert.equal(sent[0].method, 'PUT');
  assert.equal(sent[0].url, '/api/nodes/c-journey');
  assert.deepEqual(sent[0].body, { title: 'Personal Site Architecture v2' });

  const rendered = await page.evaluate(() => ({
    stored: window.__store.getNode('c-journey').title,
    input: document.querySelector('.tile[data-id="c-journey"] [data-edit="title"] input').value,
  }));
  assert.equal(rendered.stored, 'Personal Site Architecture v2');
  assert.equal(rendered.input, 'Personal Site Architecture v2');
});

test('an empty title is rejected on blur and shows the inline error', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);

  await fillAndBlur(titleInput(page, 'c-journey'), '   ');

  const state = await page.evaluate(() => {
    const hook = document.querySelector('.tile[data-id="c-journey"] [data-edit="title"]');
    const error = hook.querySelector('.edit-error');
    const input = hook.querySelector('input');
    return {
      message: error ? error.textContent : null,
      invalid: input ? input.getAttribute('aria-invalid') : null,
      describedBy: input ? input.getAttribute('aria-describedby') : null,
      stored: window.__store.getNode('c-journey').title,
    };
  });

  assert.equal(state.message, 'Title cannot be empty');
  assert.equal(state.invalid, 'true');
  assert.ok(state.describedBy, 'the field points at its error message');
  assert.equal(state.stored, 'Personal Site Architecture', 'the title was not saved');
  assert.equal((await mutations(page)).length, 0, 'nothing was sent to the server');
});

test('Escape leaves an inline editor without saving', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);

  const input = titleInput(page, 'c-journey');
  await input.click();
  await input.fill('Discarded Title');
  await input.press('Escape');
  await page.waitForTimeout(80);

  const state = await page.evaluate(() => ({
    inputs: document.querySelectorAll('.tile[data-id="c-journey"] [data-edit="title"] input').length,
    rendered: document.querySelector('.tile[data-id="c-journey"] .tile-title').textContent,
    stored: window.__store.getNode('c-journey').title,
  }));

  assert.equal(state.inputs, 0, 'the editor is closed');
  assert.equal(state.rendered, 'Personal Site Architecture');
  assert.equal(state.stored, 'Personal Site Architecture');
  assert.equal((await mutations(page)).length, 0, 'nothing was sent to the server');
});

test('the delete confirmation for a folder states the descendant count and confirming deletes it', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);
  /* f-part-ii lives inside f-back-end: open that level first. */
  await page.evaluate(() => window.__goto('f-back-end'));
  await page.waitForSelector('.tile[data-id="f-part-ii"]');

  const expected = await page.evaluate(() => {
    const descendants = window.__store
      .getTree()
      .filter((node) => {
        let current = node;
        while (current && current.parentId) {
          if (current.parentId === 'f-part-ii') return true;
          current = window.__store.getNode(current.parentId);
        }
        return false;
      });
    return descendants.length;
  });
  assert.equal(expected, 5, 'the folder holds five descendants');

  await page.click('.tile[data-id="f-part-ii"] [data-action="delete"]');
  await page.waitForSelector('.edit-dialog');

  const dialog = await page.evaluate(() => ({
    message: document.querySelector('.edit-dialog-message').textContent,
    text: document.querySelector('.edit-dialog').textContent,
    role: document.querySelector('.edit-dialog').getAttribute('role'),
    modal: document.querySelector('.edit-dialog').getAttribute('aria-modal'),
  }));
  assert.equal(dialog.message, 'Delete "Part II — Express" and 5 items inside it?');
  assert.match(dialog.text, /Part II — Express/);
  assert.equal(dialog.role, 'alertdialog');
  assert.equal(dialog.modal, 'true');

  await page.click('.edit-dialog [data-dialog-action="confirm"]');
  await page.waitForFunction(() => !window.__store.getNode('f-part-ii'));

  const sent = await mutations(page);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'DELETE');
  assert.equal(sent[0].url, '/api/nodes/f-part-ii');

  const gone = await page.evaluate(() => ({
    folder: window.__store.getNode('f-part-ii'),
    child: window.__store.getNode('c-middleware'),
    grandchild: window.__store.getNode('c-sql'),
  }));
  assert.equal(gone.folder, undefined, 'the folder is out of the store');
  assert.equal(gone.child, undefined, 'its children are out of the store too');
  assert.equal(gone.grandchild, undefined, 'the whole subtree is out of the store');
});

test('cancelling the confirmation does not delete anything', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);
  await page.evaluate(() => window.__goto('f-back-end'));
  await page.waitForSelector('.tile[data-id="f-part-ii"]');

  await page.click('.tile[data-id="f-part-ii"] [data-action="delete"]');
  await page.waitForSelector('.edit-dialog');
  await page.click('.edit-dialog [data-dialog-action="cancel"]');
  await page.waitForTimeout(80);

  assert.equal((await mutations(page)).length, 0, 'no request was sent');
  assert.equal(await page.evaluate(() => Boolean(window.__store.getNode('f-part-ii'))), true);
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('.edit-dialog'))), false);
});

test('a move onto a folder tile issues a single PUT with the new parentId', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);

  await dragOnto(page, '.tile[data-id="c-journey"]', '.tile[data-id="f-front-end"]', 0.5);

  const sent = await mutations(page);
  assert.equal(sent.length, 1, 'exactly one mutation');
  assert.equal(sent[0].method, 'PUT');
  assert.equal(sent[0].url, '/api/nodes/c-journey');
  assert.deepEqual(sent[0].body, { parentId: 'f-front-end' });

  const moved = await page.evaluate(() => ({
    parentId: window.__store.getNode('c-journey').parentId,
    inFolder: window.__store.getChildren('f-front-end').some((node) => node.id === 'c-journey'),
  }));
  assert.equal(moved.parentId, 'f-front-end');
  assert.equal(moved.inFolder, true);
});

test('dropping a folder into its own descendant is rejected with a toast and issues no request', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);

  /* f-part-ii lives inside f-back-end: dropping the folder on it would move a
     folder into its own descendant. */
  await dragOnto(page, '.tile[data-id="f-back-end"]', '.spine-row[data-id="f-part-ii"]', 0.5);

  const toast = await page.evaluate(() => {
    const el = document.querySelector('.edit-toast');
    return el ? el.textContent : null;
  });
  assert.equal(toast, 'Cannot move a folder into itself');

  assert.equal((await mutations(page)).length, 0, 'no request was sent');
  const unchanged = await page.evaluate(() => window.__store.getNode('f-back-end').parentId);
  assert.equal(unchanged, null, 'the folder stayed where it was');
});

test('a reorder issues one POST to /api/nodes/reorder with {parentId, orderedIds}', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);
  await page.evaluate(() => window.__goto('f-part-ii'));
  await page.waitForSelector('.tile[data-id="c-rest"]');

  await dragOnto(page, '.tile[data-id="c-rest"]', '.tile[data-id="c-middleware"]', 0.25);

  const sent = await mutations(page);
  assert.equal(sent.length, 1, 'exactly one mutation');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, '/api/nodes/reorder');
  assert.deepEqual(sent[0].body, {
    parentId: 'f-part-ii',
    orderedIds: ['f-part-iii', 'c-rest', 'c-middleware', 'c-express'],
  });

  const order = await page.evaluate(() =>
    window.__store.getChildren('f-part-ii').map((node) => node.id),
  );
  assert.deepEqual(order, ['f-part-iii', 'c-rest', 'c-middleware', 'c-express']);
});

test('a body edit keeps its newlines and is saved as one PUT', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);
  await page.evaluate(() => window.__focus.enter('c-journey'));
  await page.waitForSelector('.stage-card[data-depth="0"]');
  await page.evaluate(() => window.__edit.setActive(true));
  await page.waitForSelector('.stage-card[data-depth="0"] [data-edit="body"] textarea');

  const body = 'First line.\nSecond line.\n\nFourth line.';
  await fillAndBlur(
    page.locator('.stage-card[data-depth="0"] [data-edit="body"] textarea'),
    body,
  );

  const sent = await mutations(page);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'PUT');
  assert.deepEqual(sent[0].body, { body });
});

test('Edit Mode over Focus Mode makes the focused card fields editable in place', { skip: skip() }, async () => {
  const page = harness.page;
  await page.evaluate(() => window.__focus.enter('c-journey'));
  await page.waitForSelector('.stage-card[data-depth="0"]');

  await enableEdit(page);

  const fields = await page.evaluate(() => {
    const card = document.querySelector('.stage-card[data-depth="0"]');
    const title = card.querySelector('[data-edit="title"] input');
    const body = card.querySelector('[data-edit="body"] textarea');
    const answer = card.querySelector('[data-edit="answer"] textarea');
    const box = answer ? answer.getBoundingClientRect() : null;
    return {
      title: title ? title.tagName : null,
      titleValue: title ? title.value : null,
      body: body ? body.tagName : null,
      bodyValue: body ? body.value : null,
      answer: answer ? answer.tagName : null,
      answerValue: answer ? answer.value : null,
      editing: card.classList.contains('is-editing'),
      answerVisible: Boolean(box && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight + 1),
    };
  });

  assert.equal(fields.title, 'INPUT');
  assert.equal(fields.titleValue, 'Personal Site Architecture');
  assert.equal(fields.body, 'TEXTAREA');
  assert.equal(fields.bodyValue, 'How the personal site is put together.');
  assert.equal(fields.answer, 'TEXTAREA');
  assert.equal(fields.answerValue, 'Static pages behind one router.');
  assert.equal(fields.editing, true, 'the focused card is in its editing state');
  assert.equal(fields.answerVisible, true, 'the answer is editable in place, not hidden behind the flip');
});

test('no uncaught error was raised while Edit Mode was exercised', { skip: skip() }, async () => {
  /* The harness does not serve /fonts, so the 404s of the webfont are the
     only expected noise; a script error is not. */
  const scriptErrors = harness.pageErrors.filter((entry) => !entry.startsWith('Failed to load resource'));
  assert.deepEqual(scriptErrors, [], 'the page raised no script error');
});

test('the create control makes a folder and a card in the level on screen', { skip: skip() }, async () => {
  const page = harness.page;
  await enableEdit(page);

  await page.click('#action-create');
  await page.waitForSelector('.edit-popover');
  await page.click('.edit-menu-item[data-create-kind="folder"]');
  await page.waitForSelector('.edit-popover-form:not([hidden])');
  await page.fill('#edit-create-title', '04 Review');
  await page.click('.edit-popover [data-create-submit]');
  await page.waitForFunction(() =>
    window.__store.getLevel().some((node) => node.title === '04 Review'),
  );

  await page.click('#action-create');
  await page.waitForSelector('.edit-popover');
  await page.click('.edit-menu-item[data-create-kind="card"]');
  await page.fill('#edit-create-title', 'A New Card');
  await page.click('.edit-popover [data-create-submit]');
  await page.waitForFunction(() => window.__store.getLevel().some((node) => node.title === 'A New Card'));

  const sent = await mutations(page);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, '/api/nodes');
  assert.equal(sent[0].body.kind, 'folder');
  assert.equal(sent[0].body.title, '04 Review');
  assert.equal(sent[0].body.parentId, null);
  assert.equal(sent[1].method, 'POST');
  assert.equal(sent[1].body.kind, 'card');
  assert.equal(sent[1].body.title, 'A New Card');
});
