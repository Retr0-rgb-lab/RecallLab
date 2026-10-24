/**
 * RecallLab — bootstrap and router (build contracts §4.3; design §7.2, §7.3).
 *
 * `main.js` is the only module that reads or writes `location`. It resolves
 * the URL into client state, drives the store, and hands the view modules
 * their work:
 *
 *   URL                          state
 *   ---------------------------------------------------------------
 *   /                            file page, root level
 *   /f/:folderId                 file page at that folder
 *   /f/:folderId?focus=:nodeId   Focus Mode on that node
 *   ...&edit=1                   Edit Mode overlay on either of the above
 *
 * Focus Mode is entered through `focus.enter(nodeId)` and left through
 * `focus.exit()` (contracts §4.5); Edit Mode is toggled through
 * `edit.setActive(on)` (contracts §4.7). Neither of those modules is imported
 * statically here: `edit.js` is imported lazily so a missing module cannot
 * stop the application from booting.
 */

import { store } from './store.js';
import { mountFilePage, unmountFilePage } from './filepage.js';
import { focus } from './focus.js';

/* ---------------------------------------------------------------------------
 * Lazy Edit Mode module
 * ------------------------------------------------------------------------ */

let editModule = null;
let editLoadAttempted = false;

/**
 * Import `edit.js` on demand. It is loaded lazily because a static import of
 * a module that does not exist yet would stop the whole application from
 * booting, and because Edit Mode is not needed to browse the tree.
 * @returns {Promise<{setActive: Function, isActive: Function}|null>}
 */
async function loadEditModule() {
  if (editModule) return editModule;
  if (editLoadAttempted) return null;

  editLoadAttempted = true;

  try {
    const mod = await import('./edit.js');
    editModule = mod?.edit ?? null;
    if (!editModule) {
      console.warn('[main] edit.js does not export an `edit` object; Edit Mode stays off.');
    }
  } catch (err) {
    console.warn(
      `[main] edit.js could not be loaded (${err?.message ?? err}); Edit Mode stays off.`,
    );
  }

  return editModule;
}

/**
 * Turn Edit Mode on or off, mirroring the URL.
 * @param {boolean} on
 */
function syncEditMode(on) {
  if (!on) {
    editModule?.setActive(false);
    return;
  }

  void loadEditModule().then((mod) => {
    if (mod) {
      mod.setActive(true);
      return;
    }
    store.reportNotice(
      'Edit Mode is not available yet — the edit.js module has not landed.',
    );
  });
}

/* ---------------------------------------------------------------------------
 * The router
 * ------------------------------------------------------------------------ */

/**
 * Read the current URL into a route.
 * @returns {{path: string, params: {folderId?: string}, query: Record<string,string>}}
 */
function parseLocation() {
  const path = window.location.pathname;
  const params = {};
  const query = {};

  for (const [key, value] of new URLSearchParams(window.location.search)) {
    query[key] = value;
  }

  const match = /^\/f\/([^/]+)\/?$/.exec(path);
  if (match) params.folderId = decodeURIComponent(match[1]);

  return { path, params, query };
}

export const router = {
  /**
   * Go to a path.
   * @param {string} path
   * @param {{replace?: boolean}} [options]
   */
  navigate(path, { replace = false } = {}) {
    const url = new URL(path, window.location.origin);
    const href = `${url.pathname}${url.search}${url.hash}`;

    if (replace) {
      window.history.replaceState({}, '', href);
    } else {
      window.history.pushState({}, '', href);
    }

    void applyRoute();
  },

  /**
   * The current route.
   * @returns {{path: string, params: {folderId?: string}, query: Record<string,string>}}
   */
  current() {
    return parseLocation();
  },
};

/* ---------------------------------------------------------------------------
 * DOM handles
 * ------------------------------------------------------------------------ */

const dom = {
  grid: null,
  actions: null,
  live: null,
  focusButton: null,
  editButton: null,
  createButton: null,
};

/** The node id currently on stage, so `focus.enter()` is not called twice. */
let enteredFocusId = null;

/** Guards against two route resolutions racing each other. */
let routeToken = 0;

/* ---------------------------------------------------------------------------
 * Toolbar
 * ------------------------------------------------------------------------ */

/**
 * The first thing Focus Mode can show for the current level: the first card,
 * or the first node when the level holds no cards.
 * @returns {object|undefined}
 */
function focusEntryNode() {
  const level = store.getLevel();
  return level.find((node) => node.kind === 'card') ?? level[0];
}

/** The URL that opens a node in Focus Mode. */
function focusUrl(node) {
  const parent = node.parentId ? `/f/${encodeURIComponent(node.parentId)}` : '/';
  return `${parent}?focus=${encodeURIComponent(node.id)}`;
}

/** Build the toolbar controls once, so `edit.js` can bind to them. */
function buildToolbar() {
  const actions = dom.actions;
  if (!actions) return;

  const focusButton = document.createElement('button');
  focusButton.type = 'button';
  focusButton.id = 'action-focus';
  focusButton.className = 'btn btn-secondary';
  focusButton.textContent = 'Focus';
  focusButton.addEventListener('click', onFocusClick);

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.id = 'action-edit';
  editButton.className = 'btn btn-secondary';
  editButton.setAttribute('aria-pressed', 'false');
  editButton.textContent = 'Edit';
  editButton.addEventListener('click', onEditClick);

  const createButton = document.createElement('button');
  createButton.type = 'button';
  createButton.id = 'action-create';
  createButton.className = 'btn btn-primary';
  createButton.textContent = 'New';
  createButton.addEventListener('click', onCreateClick);

  actions.replaceChildren(focusButton, editButton, createButton);

  dom.focusButton = focusButton;
  dom.editButton = editButton;
  dom.createButton = createButton;
}

/** Reflect the current state in the toolbar. */
function updateToolbar() {
  if (!dom.focusButton) return;

  const inFocus = store.getMode() === 'focus';
  const editOn = store.isEditMode();

  dom.editButton.setAttribute('aria-pressed', String(editOn));
  dom.editButton.textContent = editOn ? 'Done' : 'Edit';

  dom.focusButton.textContent = inFocus ? 'Exit focus' : 'Focus';
  dom.focusButton.disabled = !inFocus && !focusEntryNode();
}

function onFocusClick() {
  if (store.getMode() === 'focus') {
    focus.exit();
    enteredFocusId = null;
    const route = router.current();
    const folderId = route.params.folderId ?? null;
    router.navigate(folderId ? `/f/${encodeURIComponent(folderId)}` : '/');
    return;
  }

  const node = focusEntryNode();
  if (!node) return;
  router.navigate(focusUrl(node));
}

function onEditClick() {
  const route = router.current();
  const target = new URL(window.location.href);

  if (store.isEditMode()) {
    target.searchParams.delete('edit');
  } else {
    target.searchParams.set('edit', '1');
  }

  router.navigate(`${target.pathname}${target.search}`);
}

async function onCreateClick() {
  // `edit.js` owns the create control (contracts §4.7): it opens a create
  // menu from a delegated listener. Until that module exists, this fallback
  // creates a folder in the level on screen through the store, so the control
  // is never dead.
  if (editModule) return;

  const mod = await loadEditModule();
  if (mod) {
    // `edit.js` binds the control when it is imported. The click that
    // triggered the import has already been dispatched, so hand it over.
    dom.createButton?.click();
    return;
  }

  try {
    await store.createNode({
      parentId: store.getCurrentFolderId(),
      kind: 'folder',
      title: 'New folder',
    });
  } catch (err) {
    store.reportError(err);
  }
}

/* ---------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------ */

/** Paint the current mode. */
function render() {
  const mode = store.getMode();

  if (mode === 'focus') {
    // The stage covers the viewport, so the file page is torn down. It is
    // rebuilt when Focus Mode is left.
    unmountFilePage();
  } else {
    mountFilePage(dom.grid);
  }

  updateToolbar();
}

/** Announce the current view in the polite live region. */
function announce() {
  const live = dom.live;
  if (!live) return;

  if (store.getMode() === 'focus') {
    const node = store.getNode(store.getFocusId());
    live.textContent = node ? `Focus mode: ${node.title}` : 'Focus mode';
    return;
  }

  const path = store.getPath();
  const current = path[path.length - 1];
  live.textContent = current ? `File page: ${current.title}` : 'File page: root level';
}

/**
 * Resolve the URL into state and drive the store.
 */
async function applyRoute() {
  const token = (routeToken += 1);

  const route = router.current();
  const folderId = route.params.folderId ?? null;
  const focusId = route.query.focus ?? null;
  const editOn = route.query.edit === '1';

  store.setView({
    folderId,
    focusId,
    mode: focusId ? 'focus' : 'file',
    edit: editOn,
  });

  await store.loadLevel(folderId);
  if (token !== routeToken) return; // a newer route won

  syncFocusStage();
  syncEditMode(editOn);
  announce();
}

/**
 * Put the stage in the state the URL asks for.
 */
function syncFocusStage() {
  const mode = store.getMode();
  const focusId = store.getFocusId();

  if (mode === 'focus' && focusId) {
    if (enteredFocusId === focusId) return;
    focus.enter(focusId);
    enteredFocusId = focusId;
    return;
  }

  if (enteredFocusId !== null) {
    focus.exit();
    enteredFocusId = null;
  }
}

/**
 * Keep the URL in step with the focus module, which changes its own state
 * when the user presses Escape or the arrow keys.
 */
function syncFocusWithModule() {
  if (!focus.isActive()) {
    if (enteredFocusId !== null) {
      enteredFocusId = null;
    }

    const route = router.current();
    if (!route.query.focus) return;

    const target = new URL(window.location.href);
    target.searchParams.delete('focus');
    router.navigate(`${target.pathname}${target.search}`, { replace: true });
    return;
  }

  const id = focus.getFocusedId();
  if (!id || id === store.getFocusId()) return;

  const node = store.getNode(id);
  const parent = node?.parentId ? `/f/${encodeURIComponent(node.parentId)}` : '/';

  store.setView({ focusId: id });

  const target = new URL(window.location.href);
  target.searchParams.set('focus', id);
  window.history.replaceState({}, '', `${parent}${target.search}`);
}

/* ---------------------------------------------------------------------------
 * Bootstrap
 * ------------------------------------------------------------------------ */

async function boot() {
  dom.grid = document.getElementById('grid');
  dom.actions = document.getElementById('toolbar-actions');
  dom.live = document.getElementById('stage-live');

  buildToolbar();

  // `filepage.js` asks for navigation through an event, so the router stays
  // the only place that touches `location`.
  window.addEventListener('recalllab:navigate', (ev) => {
    const path = ev?.detail?.path;
    if (typeof path === 'string' && path) router.navigate(path);
  });

  window.addEventListener('popstate', () => {
    void applyRoute();
  });

  // The focus module owns the keyboard while it is on stage; this listener
  // only mirrors its state into the URL, after its own handler has run.
  document.addEventListener('keydown', (ev) => {
    if (!focus.isActive()) return;
    if (!['Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) {
      return;
    }
    setTimeout(syncFocusWithModule, 0);
  });

  store.subscribe(() => {
    render();
  });

  // The tree is one request and the spine needs all of it (design §5.2).
  await store.loadTree();
  await applyRoute();

  // A small handle for automation and debugging.
  window.recallLab = { store, router };
}

void boot();
