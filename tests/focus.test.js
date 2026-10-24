/**
 * RecallLab — Focus Mode tests (contracts §4.5, §5.2; design §4.2).
 *
 * `node:test` has no DOM, so Focus Mode is driven in a real Chromium through
 * the globally installed Playwright.
 *
 * The harness is built under the OS temp directory:
 *   - `public/js/focus.js` and `public/js/gestures.js` are COPIED verbatim
 *     (the code under test is the shipped code);
 *   - `store.js` is a STUB that implements the store contract (contracts §4.2)
 *     with the COMP3421 seed shape, because the real `store.js` is owned by
 *     another agent and talks to the API over the network.
 *
 * Everything asserted here therefore exercises the real `focus.js` and the
 * real `gestures.js` against a stubbed store.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PUBLIC = path.join(REPO, 'public');

/* ---------------------------------------------------------------------------
 * Stub store — the contract from contracts §4.2
 * ------------------------------------------------------------------------ */

const STUB_STORE = `
const NODES = new Map();
const CHILDREN = new Map();
const ROOT = '__root__';

const RAW = [
  { id: 'f-big-picture', parentId: null, kind: 'folder', title: '01 The Big Picture', body: '', answer: '', position: 0 },
  { id: 'f-front-end', parentId: null, kind: 'folder', title: '02 Front-End', body: '', answer: '', position: 1 },
  { id: 'f-back-end', parentId: null, kind: 'folder', title: '03 Back-End', body: '', answer: '', position: 2 },
  { id: 'c-journey', parentId: null, kind: 'card', title: 'Personal Site Architecture', body: 'How the personal site is put together.', answer: 'Static pages behind one router.', position: 3 },

  { id: 'c-client-server', parentId: 'f-big-picture', kind: 'card', title: 'Client–Server Model', body: 'Who talks to whom, and over what.', answer: 'The browser speaks HTTP to a server.', position: 0 },
  { id: 'c-request', parentId: 'f-big-picture', kind: 'card', title: 'One Request End to End', body: 'Follow a single request.', answer: 'DNS, TCP, TLS, HTTP, route, response.', position: 1 },
  { id: 'c-stack', parentId: 'f-big-picture', kind: 'card', title: 'The Stack Layer by Layer', body: 'What each layer does.', answer: '', position: 2 },

  { id: 'c-html', parentId: 'f-front-end', kind: 'card', title: 'HTML', body: 'The structure of a document.', answer: 'The element tree the browser builds.', position: 0 },
  { id: 'c-css', parentId: 'f-front-end', kind: 'card', title: 'CSS', body: 'How a document is painted.', answer: 'Cascade, specificity, layout, paint.', position: 1 },
  { id: 'c-js', parentId: 'f-front-end', kind: 'card', title: 'JavaScript', body: 'Behaviour in the page.', answer: 'The event loop and the DOM.', position: 2 },
  { id: 'c-devtools', parentId: 'f-front-end', kind: 'card', title: 'DevTools', body: 'Inspecting the running page.', answer: 'Elements, console, network, performance.', position: 3 },

  { id: 'c-http', parentId: 'f-back-end', kind: 'card', title: 'HTTP', body: 'The request/response protocol.', answer: 'Stateless verbs over a request/response cycle.', position: 0 },
  { id: 'f-part-i', parentId: 'f-back-end', kind: 'folder', title: 'Part I — Node.js Runtime', body: '', answer: '', position: 1 },
  { id: 'f-part-ii', parentId: 'f-back-end', kind: 'folder', title: 'Part II — Express, REST, CRUD', body: '', answer: '', position: 2 },

  { id: 'c-event-loop', parentId: 'f-part-i', kind: 'card', title: 'The Event Loop', body: 'How Node schedules work.', answer: 'Call stack, timers, then the microtask queue.', position: 0 },
  { id: 'c-middleware', parentId: 'f-part-ii', kind: 'card', title: 'Middleware', body: 'Functions in the request pipeline.', answer: 'They run in order and may end the response.', position: 0 },
];

for (const raw of RAW) {
  NODES.set(raw.id, {
    ...raw,
    createdAt: '2026-10-24T08:00:00.000Z',
    updatedAt: '2026-10-24T08:00:00.000Z',
  });
}
for (const raw of RAW) {
  const key = raw.parentId ?? ROOT;
  if (!CHILDREN.has(key)) CHILDREN.set(key, []);
  CHILDREN.get(key).push(raw.id);
}
for (const [key, ids] of CHILDREN) {
  ids.sort((a, b) => {
    const na = NODES.get(a);
    const nb = NODES.get(b);
    if (na.kind !== nb.kind) return na.kind === 'folder' ? -1 : 1;
    return na.position - nb.position;
  });
}

let currentFolderId = null;
let focusId = null;
let mode = 'file';
const subscribers = new Set();

function notify() {
  for (const fn of Array.from(subscribers)) fn();
}

export const store = {
  getTree() { return Array.from(NODES.values()); },
  getLevel() { return store.getChildren(currentFolderId); },
  getNode(id) { return NODES.get(id); },
  getChildren(parentId) {
    const key = parentId ?? ROOT;
    return (CHILDREN.get(key) || []).map((id) => NODES.get(id));
  },
  getMode() { return mode; },
  isEditMode() { return false; },
  getFocusId() { return focusId; },
  getCurrentFolderId() { return currentFolderId; },
  async loadTree() { return store.getTree(); },
  async loadLevel(parentId) { currentFolderId = parentId ?? null; return store.getLevel(); },
  async createNode({ parentId, kind, title, body = '', answer = '' }) {
    const id = 'n-' + Math.random().toString(36).slice(2, 10);
    const key = parentId ?? ROOT;
    const siblings = store.getChildren(parentId);
    const node = {
      id, parentId: parentId ?? null, kind, title, body, answer,
      position: siblings.length,
      createdAt: '2026-10-24T08:00:00.000Z', updatedAt: '2026-10-24T08:00:00.000Z',
    };
    NODES.set(id, node);
    if (!CHILDREN.has(key)) CHILDREN.set(key, []);
    CHILDREN.get(key).push(id);
    notify();
    return node;
  },
  async updateNode(id, patch) {
    const node = NODES.get(id);
    if (!node) return undefined;
    Object.assign(node, patch);
    notify();
    return node;
  },
  async deleteNode(id) {
    NODES.delete(id);
    notify();
  },
  async moveNode(id, parentId) {
    const node = NODES.get(id);
    if (!node) return undefined;
    for (const ids of CHILDREN.values()) {
      const i = ids.indexOf(id);
      if (i >= 0) ids.splice(i, 1);
    }
    node.parentId = parentId ?? null;
    const key = parentId ?? ROOT;
    if (!CHILDREN.has(key)) CHILDREN.set(key, []);
    CHILDREN.get(key).push(id);
    notify();
    return node;
  },
  async reorderLevel(parentId, orderedIds) {
    const key = parentId ?? ROOT;
    if (!CHILDREN.has(key)) CHILDREN.set(key, []);
    CHILDREN.set(key, orderedIds.slice());
    notify();
    return store.getChildren(parentId);
  },
  subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
};
`;

const HARNESS_PAGE = `<!doctype html>
<html lang="en" data-register="browse">
<head>
<meta charset="utf-8">
<title>RecallLab — focus harness</title>
<style>
  /* The two registers, copied from visual-system §8 so stage.css resolves
     without the real tokens.css (owned by another agent). */
  :root {
    --canvas: #FAFAFA; --surface: #FFFFFF; --surface-hover: #F4F4F5;
    --surface-sunken: #F4F4F5; --hairline: #E4E4E7; --hairline-strong: #D4D4D8;
    --ink: #18181B; --ink-2: #52525B; --ink-3: #A1A1AA; --ink-inverse: #FAFAFA;
    --accent: #E8A33D; --accent-dim: #B87C2A;
    --e0: none;
    --e1: 0 1px 2px rgba(24,24,27,.06), 0 1px 1px rgba(24,24,27,.04);
    --e2: 0 4px 12px rgba(24,24,27,.08), 0 1px 3px rgba(24,24,27,.05);
    --e3: 0 12px 32px rgba(24,24,27,.12), 0 2px 8px rgba(24,24,27,.06);
    --t-hover: 120ms; --t-focus-ring: 160ms; --t-flip: 320ms; --t-move: 320ms; --t-mode: 420ms;
    --hold-ms: 450; --drag-threshold-px: 56; --flick-velocity: .35;
    --t-stage-title: 26px; --t-title: 17px; --t-tile: 15px; --t-body: 16px;
    --t-body-sm: 14px; --t-preview: 13px; --t-label: 12px; --t-mono: 13px;
  }
  [data-register="stage"] {
    --canvas: #0B0B0C; --surface: #17171A; --surface-hover: #1F1F23;
    --surface-sunken: #17171A; --hairline: #27272A; --hairline-strong: #3F3F46;
    --ink: #FAFAFA; --ink-2: #D4D4D8; --ink-3: #A1A1AA; --ink-inverse: #0B0B0C;
    --e1: 0 1px 2px rgba(0,0,0,.35);
    --e2: 0 4px 14px rgba(0,0,0,.45);
    --e3: 0 16px 40px rgba(0,0,0,.55);
  }
  html, body { margin: 0; height: 100%; }
</style>
<link rel="stylesheet" href="/stage.css">
</head>
<body>
  <div id="app">
    <main id="main">
      <header id="toolbar"><nav id="breadcrumb"></nav><div id="toolbar-actions"></div></header>
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
      const focusMod = await import('/focus.js');
      const storeMod = await import('/store.js');
      window.__focus = focusMod.focus;
      window.__store = storeMod.store;
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
};

async function buildHarness() {
  harness.dir = await mkdtemp(path.join(tmpdir(), 'recalllab-focus-'));
  await copyFile(path.join(PUBLIC, 'js', 'focus.js'), path.join(harness.dir, 'focus.js'));
  await copyFile(path.join(PUBLIC, 'js', 'gestures.js'), path.join(harness.dir, 'gestures.js'));
  await copyFile(path.join(PUBLIC, 'styles', 'stage.css'), path.join(harness.dir, 'stage.css'));
  await writeFile(path.join(harness.dir, 'store.js'), STUB_STORE, 'utf8');
  await writeFile(path.join(harness.dir, 'index.html'), HARNESS_PAGE, 'utf8');
}

function startServer() {
  return new Promise((resolve) => {
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.join(harness.dir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
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
  const context = await harness.browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  harness.contexts.push(context);
  harness.page = await context.newPage();
  harness.page.on('pageerror', (err) => harness.pageErrors.push(String(err)));
  harness.page.on('console', (msg) => {
    if (msg.type() === 'error') harness.pageErrors.push(msg.text());
  });
  await harness.page.goto(`http://127.0.0.1:${harness.port}/index.html`);
  await harness.page.evaluate(() => window.__ready);
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

/** A page with its own viewport, for the geometry cases. */
async function openPage(width, height) {
  const context = await harness.browser.newContext({ viewport: { width, height } });
  harness.contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (err) => harness.pageErrors.push(String(err)));
  await page.goto(`http://127.0.0.1:${harness.port}/index.html`);
  await page.evaluate(() => window.__ready);
  return page;
}

const skip = () => (playwright ? false : 'Playwright is not installed');

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

async function enterFocus(page, nodeId) {
  await page.evaluate((id) => window.__focus.enter(id), nodeId);
  await page.waitForSelector('.stage-card[data-depth="0"]');
}

async function focusId(page) {
  return page.evaluate(() => window.__focus.getFocusedId());
}

async function stackSnapshot(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.stage-card'));
    return {
      count: cards.length,
      depths: cards.map((c) => c.dataset.depth),
      focusedCount: document.querySelectorAll('.stage-card[data-depth="0"]').length,
      titles: cards.map((c) => c.querySelector('.stage-card-title').textContent),
      ids: cards.map((c) => c.dataset.id),
      stagePresent: Boolean(document.querySelector('.stage#stage')),
      stackPresent: Boolean(document.querySelector('.stage-stack')),
      pipsPresent: Boolean(document.querySelector('.stage-pips')),
      register: document.documentElement.getAttribute('data-register'),
    };
  });
}

/* ---------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------ */

test('the stage renders one focused card plus up to three stack layers', { skip: skip() }, async () => {
  const page = harness.page;
  const target = await page.evaluate(() => {
    const first = window.__store.getChildren(null)[0];
    return { id: first.id, levelSize: window.__store.getChildren(null).length };
  });

  await enterFocus(page, target.id);
  let snapshot = await stackSnapshot(page);

  assert.equal(snapshot.stagePresent, true, 'the .stage element is mounted');
  assert.equal(snapshot.stackPresent, true, 'the .stage-stack element is mounted');
  assert.equal(snapshot.pipsPresent, true, 'the .stage-pips element is mounted');
  assert.equal(snapshot.register, 'stage', 'the focus register is switched on');
  assert.equal(snapshot.focusedCount, 1, 'exactly one focused card');
  assert.equal(snapshot.count, Math.min(4, target.levelSize), 'focus + three siblings');
  assert.deepEqual(snapshot.depths, ['0', '1', '2', '3']);

  // Descend into the focused folder: the level now has three children, so the
  // stack shrinks to three layers.
  await page.click('.stage-card[data-depth="0"]');
  await page.waitForFunction(() => document.querySelectorAll('.stage-card').length === 3);

  snapshot = await stackSnapshot(page);
  assert.equal(snapshot.focusedCount, 1);
  assert.deepEqual(snapshot.depths, ['0', '1', '2']);
});

test('a level with fewer than four siblings shows fewer layers', { skip: skip() }, async () => {
  const page = harness.page;
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    window.__focus.enter(folder.id);
  });
  await page.click('.stage-card[data-depth="0"]');
  await page.waitForFunction(() => document.querySelectorAll('.stage-card').length === 3);

  const snapshot = await stackSnapshot(page);
  assert.equal(snapshot.count, 3, 'focus + two siblings');
  assert.deepEqual(snapshot.depths, ['0', '1', '2']);
});

test('clicking the focused card toggles the reveal', { skip: skip() }, async () => {
  const page = harness.page;
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    const card = window.__store.getChildren(folder.id).find((n) => n.answer);
    window.__focus.enter(card.id);
  });

  const isFlipped = () =>
    page.evaluate(() =>
      document.querySelector('.stage-card[data-depth="0"]').classList.contains('is-flipped'),
    );

  assert.equal(await isFlipped(), false, 'the front face is shown first');
  await page.click('.stage-card[data-depth="0"]');
  assert.equal(await isFlipped(), true, 'the first click flips the card');
  await page.click('.stage-card[data-depth="0"]');
  assert.equal(await isFlipped(), false, 'the second click flips it back');
});

test('a card with an empty answer does not flip and says so', { skip: skip() }, async () => {
  const page = harness.page;
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    const card = window.__store.getChildren(folder.id).find((n) => !n.answer);
    window.__focus.enter(card.id);
  });

  await page.click('.stage-card[data-depth="0"]');

  const state = await page.evaluate(() => {
    const el = document.querySelector('.stage-card[data-depth="0"]');
    const note = el.querySelector('.stage-card-no-answer');
    return {
      flipped: el.classList.contains('is-flipped'),
      noteText: note ? note.textContent : null,
      noteHidden: note ? note.hidden : null,
    };
  });

  assert.equal(state.flipped, false, 'a card with no answer does not flip');
  assert.equal(state.noteText, 'No answer recorded');
  assert.equal(state.noteHidden, false, 'the note is visible');
});

test('descending into a folder swaps the level', { skip: skip() }, async () => {
  const page = harness.page;
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    window.__focus.enter(folder.id);
  });

  const before = await page.evaluate(() => ({
    focused: window.__focus.getFocusedId(),
    title: document.querySelector('.stage-card[data-depth="0"] .stage-card-title').textContent,
  }));
  assert.equal(before.title, '01 The Big Picture');

  await page.click('.stage-card[data-depth="0"]');
  await page.waitForFunction(
    () => document.querySelector('.stage-card[data-depth="0"] .stage-card-title').textContent !== '01 The Big Picture',
  );

  const after = await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    const focusedId = window.__focus.getFocusedId();
    const focused = window.__store.getNode(focusedId);
    return {
      focusedId,
      parentOfFocused: focused.parentId,
      folderId: folder.id,
      title: document.querySelector('.stage-card[data-depth="0"] .stage-card-title').textContent,
    };
  });

  assert.equal(after.parentOfFocused, after.folderId, 'the stage is now inside the folder');
  assert.equal(after.title, 'Client–Server Model', 'focus moved to the first child');

  // Esc ascends one level, with the parent folder focused.
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.querySelector('.stage-card[data-depth="0"] .stage-card-title').textContent === '01 The Big Picture',
  );
  const ascended = await page.evaluate(() => window.__focus.getFocusedId());
  assert.equal(ascended, 'f-big-picture', 'the parent folder is focused again');
});

test('dragging the focused card away advances the stack and records nothing', { skip: skip() }, async () => {
  const page = harness.page;
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    const card = window.__store.getChildren(folder.id).find((n) => n.answer);
    window.__focus.enter(card.id);
  });

  const before = await focusId(page);
  const box = await page.locator('.stage-card[data-depth="0"]').boundingBox();

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((id) => window.__focus.getFocusedId() !== id, before);

  const after = await focusId(page);
  assert.notEqual(after, before, 'the focus advanced to the next sibling');

  const stored = await page.evaluate(() => {
    const node = window.__store.getNode(window.__focus.getFocusedId());
    return {
      title: node.title,
      keys: Object.keys(node).sort(),
      localStorage: Object.keys(window.localStorage),
    };
  });
  assert.deepEqual(
    stored.keys,
    ['answer', 'body', 'createdAt', 'id', 'kind', 'parentId', 'position', 'title', 'updatedAt'],
    'the node gained no review data, no counters, no timestamps',
  );
  assert.deepEqual(stored.localStorage, [], 'nothing was written to storage');
});

test('a 450ms hold lifts the card into a floating window above the focused card', { skip: skip() }, async () => {
  const page = await openPage(1280, 1100);
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    const card = window.__store.getChildren(folder.id).find((n) => n.answer);
    window.__focus.enter(card.id);
  });

  const box = await page.locator('.stage-card[data-depth="0"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  await page.mouse.down();
  await page.waitForTimeout(700); // > HOLD_MS
  await page.mouse.up();
  await page.waitForSelector('.pip');
  await page.waitForTimeout(700); // let the lift and the rise settle

  const geometry = await page.evaluate(() => {
    const pip = document.querySelector('.pip');
    const focused = document.querySelector('.stage-card[data-depth="0"]');
    const p = pip.getBoundingClientRect();
    const f = focused.getBoundingClientRect();
    return {
      pipCount: document.querySelectorAll('.pip').length,
      pip: { x: p.x, y: p.y, width: p.width, height: p.height },
      focused: { x: f.x, y: f.y, width: f.width, height: f.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      expectedWidth: Math.min(440, Math.max(320, window.innerWidth * 0.34)),
      expectedHeight: Math.min(
        300,
        Math.max(220, Math.min(440, Math.max(320, window.innerWidth * 0.34)) * 0.68),
      ),
      gap: f.y - (p.y + p.height),
      insideViewport:
        p.x >= 16 - 0.5 &&
        p.y >= 16 - 0.5 &&
        p.x + p.width <= window.innerWidth - 16 + 0.5 &&
        p.y + p.height <= window.innerHeight - 16 + 0.5,
      floatingIds: window.__focus.getFloatingWindows().map((w) => w.id),
    };
  });

  assert.equal(geometry.pipCount, 1, 'exactly one floating window');
  assert.ok(
    Math.abs(geometry.pip.width - geometry.expectedWidth) < 1,
    `pip width ${geometry.pip.width} ≈ ${geometry.expectedWidth}`,
  );
  assert.ok(
    Math.abs(geometry.pip.height - geometry.expectedHeight) < 1,
    `pip height ${geometry.pip.height} ≈ ${geometry.expectedHeight}`,
  );
  assert.ok(geometry.gap >= 0, 'the window is above the focused card');
  assert.ok(Math.abs(geometry.gap - 16) < 3, `the dock gap is 16px, got ${geometry.gap}`);
  assert.ok(geometry.insideViewport, 'the window is clamped inside the viewport');
  assert.equal(geometry.floatingIds.length, 1);
});

test('a floating window flips below the card when it would overflow the viewport top', { skip: skip() }, async () => {
  const page = await openPage(1280, 560);
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    const card = window.__store.getChildren(folder.id).find((n) => n.answer);
    window.__focus.enter(card.id);
  });

  const box = await page.locator('.stage-card[data-depth="0"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForSelector('.pip');
  await page.waitForTimeout(700);

  const geometry = await page.evaluate(() => {
    const p = document.querySelector('.pip').getBoundingClientRect();
    const f = document.querySelector('.stage-card[data-depth="0"]').getBoundingClientRect();
    return {
      pipTop: p.y,
      pipBottom: p.y + p.height,
      cardTop: f.y,
      cardBottom: f.y + f.height,
      viewportHeight: window.innerHeight,
      insideViewport: p.y >= 16 - 0.5 && p.y + p.height <= window.innerHeight - 16 + 0.5,
    };
  });

  assert.ok(
    geometry.pipTop > geometry.cardTop,
    'the window docked below the focused card instead of overflowing the top',
  );
  assert.ok(geometry.insideViewport, 'the window is still clamped inside the viewport');
});

test('a floating window can be dragged by its header and stays where it is dropped', { skip: skip() }, async () => {
  const page = harness.page;
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    const card = window.__store.getChildren(folder.id).find((n) => n.answer);
    window.__focus.enter(card.id);
  });

  const box = await page.locator('.stage-card[data-depth="0"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForSelector('.pip');
  await page.waitForTimeout(700);

  const header = await page.locator('.pip-header').boundingBox();
  const before = await page.evaluate(() => window.__focus.getFloatingWindows()[0]);

  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + header.width / 2 + 90, header.y + header.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);

  const after = await page.evaluate(() => window.__focus.getFloatingWindows()[0]);
  assert.ok(
    Math.abs(after.x - (before.x + 90)) < 3 && Math.abs(after.y - (before.y + 40)) < 3,
    `the window moved 1:1 (${JSON.stringify(before)} → ${JSON.stringify(after)})`,
  );
});

test('Esc closes the top floating window, then ascends, then exits', { skip: skip() }, async () => {
  const page = harness.page;
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    const card = window.__store.getChildren(folder.id).find((n) => n.answer);
    window.__focus.enter(card.id);
  });

  const box = await page.locator('.stage-card[data-depth="0"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForSelector('.pip');
  await page.waitForTimeout(600);

  // 1. Esc closes the topmost floating window.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.pip').length === 0);
  assert.equal(await page.evaluate(() => window.__focus.isActive()), true, 'still in Focus Mode');

  // 2. Esc descends one level.
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    window.__focus.enter(folder.id);
  });
  await page.click('.stage-card[data-depth="0"]');
  await page.waitForFunction(
    () => document.querySelector('.stage-card[data-depth="0"] .stage-card-title').textContent !== '01 The Big Picture',
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.querySelector('.stage-card[data-depth="0"] .stage-card-title').textContent === '01 The Big Picture',
  );

  // 3. Esc exits Focus Mode.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__focus.isActive() === false);
  assert.equal(await page.evaluate(() => document.querySelector('.stage')), null, 'the stage is unmounted');
  assert.equal(
    await page.evaluate(() => document.documentElement.getAttribute('data-register')),
    'browse',
    'the browse register is restored',
  );
});

test('the keyboard moves the focus between siblings and reveals with Enter', { skip: skip() }, async () => {
  const page = harness.page;
  await page.evaluate(() => {
    const folder = window.__store.getChildren(null).find((n) => n.kind === 'folder');
    const card = window.__store.getChildren(folder.id).find((n) => n.answer);
    window.__focus.enter(card.id);
  });

  const before = await focusId(page);
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction((id) => window.__focus.getFocusedId() !== id, before);
  assert.notEqual(await focusId(page), before, 'ArrowDown moves to the next sibling');

  await page.keyboard.press('ArrowUp');
  await page.waitForFunction((id) => window.__focus.getFocusedId() === id, before);

  await page.keyboard.press('Enter');
  const flipped = await page.evaluate(() =>
    document.querySelector('.stage-card[data-depth="0"]').classList.contains('is-flipped'),
  );
  assert.equal(flipped, true, 'Enter reveals the answer');
});

test('no page errors were raised during the run', { skip: skip() }, async () => {
  assert.deepEqual(harness.pageErrors, [], 'the stage raised no uncaught errors');
});
