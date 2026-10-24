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
import { mountFilePage, unmountFilePage, renderChrome } from './filepage.js';
import { focus } from './focus.js';

/* ---------------------------------------------------------------------------
 * Lazy Edit Mode module
 * ------------------------------------------------------------------------ */

let editModule = null;
let editModulePromise = null;

/**
 * Import `edit.js` on demand. It is loaded lazily because a static import of
 * a module that does not exist yet would stop the whole application from
 * booting, and because Edit Mode is not needed to browse the tree.
 *
 * The in-flight promise is shared, so a second caller that arrives while the
 * module is still loading waits for the SAME load instead of concluding that
 * the module is unavailable and taking the fallback path.
 * @returns {Promise<{setActive: Function, isActive: Function}|null>}
 */
async function loadEditModule() {
  if (editModule) return editModule;
  if (editModulePromise) return editModulePromise;

  editModulePromise = import('./edit.js')
    .then((mod) => {
      editModule = mod?.edit ?? null;
      if (!editModule) {
        console.warn('[main] edit.js does not export an `edit` object; Edit Mode stays off.');
      }
      return editModule;
    })
    .catch((err) => {
      console.warn(
        `[main] edit.js could not be loaded (${err?.message ?? err}); Edit Mode stays off.`,
      );
      return null;
    })
    .finally(() => {
      editModulePromise = null;
    });

  return editModulePromise;
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
  app: null,
  grid: null,
  actions: null,
  live: null,
  focusButton: null,
  editButton: null,
  createButton: null,
  spineButton: null,
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

  const spineButton = buildSpineToggle();

  actions.replaceChildren(spineButton, focusButton, editButton, createButton);

  dom.focusButton = focusButton;
  dom.editButton = editButton;
  dom.createButton = createButton;
  dom.spineButton = spineButton;
}

/* ---------------------------------------------------------------------------
   The spine — the collapsible outline (contracts §8, visual system §4.4)
   ------------------------------------------------------------------------ */

/** Below this width the spine is a drawer instead of a column (layout.css §10). */
const SPINE_DRAWER_QUERY = '(max-width: 767px)';

/**
 * The spine toggle.
 *
 * It lives with the other toolbar actions, on the right of the toolbar: below
 * 768px the spine is a drawer that covers the left of the screen, and the
 * toggle has to stay reachable in that register too.
 *
 * @returns {HTMLButtonElement}
 */
function buildSpineToggle() {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'action-spine';
  button.className = 'btn btn-icon';
  button.setAttribute('aria-controls', 'spine');
  button.addEventListener('click', onSpineClick);
  button.appendChild(spineIcon());
  return button;
}

/**
 * The "toggle the outline" glyph: a panel with its left column marked.
 * @returns {SVGSVGElement}
 */
function spineIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const panel = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  panel.setAttribute('x', '3.5');
  panel.setAttribute('y', '4.5');
  panel.setAttribute('width', '17');
  panel.setAttribute('height', '15');
  panel.setAttribute('rx', '2.5');

  const column = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  column.setAttribute('d', 'M9.5 4.5v15');

  svg.append(panel, column);
  return svg;
}

/** @returns {boolean} whether the spine is collapsed right now. */
function spineIsCollapsed() {
  return dom.app?.getAttribute('data-spine') === 'collapsed';
}

/**
 * Set the spine state on `#app`.
 *
 * `layout.css` reads the same attribute in both registers: above 768px
 * `collapsed` shrinks the column to 0 and `expanded` keeps it; below 768px
 * `expanded` slides the drawer in and `collapsed` leaves it closed. One
 * attribute, both registers — the state never fights the responsive rule.
 *
 * @param {boolean} collapsed
 */
function setSpineCollapsed(collapsed) {
  if (!dom.app) return;

  dom.app.setAttribute('data-spine', collapsed ? 'collapsed' : 'expanded');

  const spine = document.getElementById('spine');
  if (spine) {
    /* A collapsed spine is clipped to nothing, but its rows are still
       focusable — they must leave the tab order with it. */
    if (collapsed) spine.setAttribute('inert', '');
    else spine.removeAttribute('inert');
  }

  if (dom.spineButton) {
    const label = collapsed ? 'Show the outline' : 'Hide the outline';
    dom.spineButton.setAttribute('aria-expanded', String(!collapsed));
    dom.spineButton.setAttribute('aria-label', label);
    dom.spineButton.title = label;
  }
}

function onSpineClick() {
  setSpineCollapsed(!spineIsCollapsed());
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
  // `edit.js` owns the create control (contracts §4.7): it opens a create menu
  // from a delegated, capture-phase document listener. That listener only acts
  // while Edit Mode is on — and while Edit Mode is on it stops the click before
  // it can ever reach this listener. So this listener only ever runs with Edit
  // Mode OFF.
  //
  // The button is visible and primary, so it must not be dead: switch Edit Mode
  // on — the URL stays the single source of truth — and then hand the click to
  // edit.js, which opens the create menu.
  //
  // A click that arrives while the module is still loading joins the in-flight
  // load. Only the click that actually started the load hands over, so a
  // double-click cannot open the menu twice.
  const joined = editModulePromise !== null;

  const mod = await loadEditModule();

  if (!mod) {
    // edit.js never arrived: create a folder directly so the control is never
    // dead.
    try {
      await store.createNode({
        parentId: store.getCurrentFolderId(),
        kind: 'folder',
        title: 'New folder',
      });
    } catch (err) {
      store.reportError(err);
    }
    return;
  }

  if (!store.isEditMode()) {
    mod.setActive(true);
    const target = new URL(window.location.href);
    target.searchParams.set('edit', '1');
    router.navigate(`${target.pathname}${target.search}`);
  }

  // The click that triggered the import has already been dispatched, and
  // edit.js only acts once Edit Mode is on — so hand it over. Wait one frame
  // first so the navigation has finished re-rendering the toolbar.
  if (!joined) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    dom.createButton?.click();
  }
}

/* ---------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------ */

/** Paint the current mode. */
function render() {
  const mode = store.getMode();

  if (mode === 'focus') {
    // The stage covers the viewport, so the tile grid is torn down. It is
    // rebuilt when Focus Mode is left.
    unmountFilePage();
    // The spine and the breadcrumb stay in step with the level that is on
    // stage, rather than pointing at the level the stage was entered from
    // (design §4.2.7).
    renderChrome(focus.getLevelId());
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
    const node = store.getNode(focus.getFocusedId());
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

/* ---------------------------------------------------------------------------
   Keyboard — the `E` shortcut (design §4.2.8)
   ------------------------------------------------------------------------ */

/**
 * Is this element a field the user is typing into?
 *
 * A keystroke that belongs to a field must never be read as a shortcut, so
 * the `E` shortcut is ignored while an input, a textarea, a select or a
 * contenteditable element has the focus.
 *
 * @param {EventTarget|null} el
 * @returns {boolean}
 */
function isTypingTarget(el) {
  if (!el || typeof el !== 'object') return false;
  const node = /** @type {HTMLElement} */ (el);
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return node.isContentEditable === true;
}

/**
 * `E` toggles Edit Mode (design §4.2.8).
 *
 * On the stage it is the only way in — the stage covers the toolbar — and on
 * the file page it mirrors the Edit button. It goes through the same URL
 * change, so the address bar always states the mode.
 *
 * @param {KeyboardEvent} ev
 */
function onShortcutKeyDown(ev) {
  if (ev.defaultPrevented) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key !== 'e' && ev.key !== 'E') return;
  if (isTypingTarget(document.activeElement)) return;
  if (isTypingTarget(ev.target)) return;

  ev.preventDefault();
  onEditClick();
}

async function boot() {
  dom.app = document.getElementById('app');
  dom.grid = document.getElementById('grid');
  dom.actions = document.getElementById('toolbar-actions');
  dom.live = document.getElementById('stage-live');

  buildToolbar();

  /* The stage owns the focus. This mirrors it into the path indicator and
     the live region, so both follow the card the user is on: without it the
     breadcrumb and the announcement only ever described the state the stage
     was entered with (design §4.2.7 and §11). */
  focus.subscribe(() => {
    renderChrome(focus.getLevelId());
    announce();
  });

  /* The spine starts the way the layout wants it: a column on a wide screen,
     a closed drawer on a narrow one. */
  setSpineCollapsed(window.matchMedia(SPINE_DRAWER_QUERY).matches);

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

  // `E` toggles Edit Mode, in both registers (design §4.2.8).
  document.addEventListener('keydown', onShortcutKeyDown);

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
