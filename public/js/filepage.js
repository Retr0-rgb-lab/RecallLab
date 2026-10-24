/**
 * RecallLab — the file page (build contracts §4.4, §5.1, §5.3).
 *
 * The file page is the spine, the breadcrumb and the tiled grid of the current
 * level. It renders from `store.js` and never mutates the tree: the create and
 * delete controls are *hooks* that `edit.js` binds (contracts §5.3 — "edit.js
 * turns those hooks into real inputs; it does not create the hooks").
 *
 * Navigation: this module must not import `main.js` (that would be a circular
 * import — `main.js` mounts the file page). It asks for navigation by
 * dispatching a `recalllab:navigate` CustomEvent on `window`; `main.js` listens
 * for it and calls `router.navigate(path)`.
 *
 * Safety: every piece of user-authored text (titles, bodies, answers) is set
 * with `textContent`. Nothing is ever interpolated into `innerHTML`, which is
 * also the XSS defence (design spec §7.4).
 *
 * Source of truth:
 *   docs/specs/2026-10-24-recalllab-contracts.md  §4.4, §5, §5.1, §5.3, §9
 *   docs/specs/2026-10-24-recalllab-visual-system.md  §4.1, §4.4, §4.5, §4.10
 *   public/styles/layout.css                    the class names used below
 */

import { store } from './store.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** How many breadcrumb segments stay visible before the "…" marker. */
const MAX_CRUMB_SEGMENTS = 4;

/** How many skeleton tiles stand in for a level that is still loading. */
const SKELETON_TILES = 6;

/* ---------------------------------------------------------------------------
 * Icons — inline SVG, never emoji (visual system §4.1). The folder is a filled
 * outline and the card is a ruled sheet, so the distinction survives a
 * greyscale screenshot.
 * ------------------------------------------------------------------------ */

const ICON_PATHS = {
  folder: [
    'M3.5 7.25c0-.69.56-1.25 1.25-1.25h4.09c.4 0 .78.19 1.02.51l.92 1.24c.24.32.61.51 1.02.51h6.95c.69 0 1.25.56 1.25 1.25v8.24c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25z',
  ],
  card: ['M6.5 3.5h7.9l4.1 4.1v12.9h-12z', 'M14.4 3.5v4.1h4.1', 'M9 12h6.5', 'M9 15.5h6.5', 'M9 19h3.5'],
  chevron: ['M9.5 5.5 16 12l-6.5 6.5'],
  trash: ['M4.5 7h15', 'M9.5 7V5.5h5V7', 'M6.5 7l1 12.5h9L17.5 7', 'M10 10.5v6', 'M14 10.5v6'],
};

/**
 * Build one inline SVG icon.
 * @param {'folder'|'card'|'chevron'|'trash'} name
 * @returns {SVGSVGElement}
 */
function svgIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const d of ICON_PATHS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  return svg;
}

/* ---------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------ */

const dom = {
  /** The #grid container the file page is mounted into. */
  grid: null,
  /** The level currently painted into the grid: 'tiles' | 'skeleton' | 'empty'. */
  gridMode: null,
  /** id -> tile element, so a re-render updates tiles instead of replacing them. */
  tiles: new Map(),
  /** The inline error banner, when one is showing. */
  banner: null,
  /** The banner's message and action, kept for updates in place. */
  bannerMessage: null,
  bannerAction: null,
  /** Whether the delegated listeners are installed. */
  wired: false,
};

/* ---------------------------------------------------------------------------
 * Navigation
 * ------------------------------------------------------------------------ */

/**
 * Ask the router to navigate. `main.js` owns `location`; this module asks.
 * @param {string} path
 */
function navigate(path) {
  window.dispatchEvent(new CustomEvent('recalllab:navigate', { detail: { path } }));
}

/** The URL of a folder's level. */
function folderUrl(id) {
  return `/f/${encodeURIComponent(id)}`;
}

/** The URL that opens a node in Focus Mode. */
function focusUrl(node) {
  const parent = node.parentId ? folderUrl(node.parentId) : '/';
  return `${parent}?focus=${encodeURIComponent(node.id)}`;
}

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

/** The first line of a body, for the one-line tile preview. */
function firstLine(text) {
  if (!text) return '';
  const line = String(text).split(/\r?\n/).find((entry) => entry.trim() !== '');
  return line ? line.trim() : '';
}

/**
 * A hook that `edit.js` has turned into a real editor must not be
 * overwritten: `edit.js` keeps the hook element and mounts the input inside
 * it (marking it `is-editing-field`), so writing to it would throw the
 * editor away mid-edit.
 */
function isEditingHook(el) {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el.isContentEditable === true ||
    el.classList.contains('is-editing-field')
  );
}

/**
 * Show or hide the delete control.
 *
 * `hidden` alone is not enough: `layout.css` gives `.btn` an explicit
 * `display: inline-flex`, and an author rule beats the user agent's
 * `[hidden] { display: none }`. The inline `display` is what actually hides
 * it; `hidden` is kept in step so the element also leaves the accessibility
 * tree.
 *
 * @param {HTMLElement} el
 * @param {boolean} visible
 */
function setVisible(el, visible) {
  el.hidden = !visible;
  el.style.display = visible ? '' : 'none';
}

/* ---------------------------------------------------------------------------
 * Tiles
 * ------------------------------------------------------------------------ */

/**
 * Build a tile for a node (contracts §5.1).
 * @param {object} node
 * @returns {HTMLLIElement}
 */
function createTile(node) {
  const li = document.createElement('li');
  li.className = 'tile';
  li.dataset.id = node.id;
  li.dataset.kind = node.kind;
  li.tabIndex = 0;
  li.setAttribute('role', 'button');

  const icon = document.createElement('div');
  icon.className = 'tile-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.appendChild(svgIcon(node.kind === 'folder' ? 'folder' : 'card'));

  const title = document.createElement('div');
  title.className = 'tile-title';
  const titleHook = document.createElement('span');
  titleHook.dataset.edit = 'title';
  titleHook.textContent = node.title;
  title.appendChild(titleHook);

  const preview = document.createElement('div');
  preview.className = 'tile-preview';
  if (node.kind === 'card') {
    const bodyHook = document.createElement('span');
    bodyHook.dataset.edit = 'body';
    bodyHook.textContent = firstLine(node.body);
    preview.appendChild(bodyHook);
  }

  li.append(icon, title, preview);

  if (node.kind === 'card') {
    // The answer is not shown on the file page, but `edit.js` needs the hook.
    // It stays hidden until the editor takes it over.
    const answer = document.createElement('span');
    answer.className = 'tile-answer';
    answer.hidden = true;
    const answerHook = document.createElement('span');
    answerHook.dataset.edit = 'answer';
    answerHook.textContent = node.answer ?? '';
    answer.appendChild(answerHook);
    li.appendChild(answer);
  }

  // The delete control (contracts §5.3). `edit.js` binds it and owns the
  // confirmation; it only shows while Edit Mode is open.
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-icon';
  remove.dataset.action = 'delete';
  remove.setAttribute('aria-label', `Delete ${node.title}`);
  remove.appendChild(svgIcon('trash'));
  setVisible(remove, store.isEditMode());
  li.appendChild(remove);

  return li;
}

/**
 * Refresh a tile in place — never replace it, so an editor `edit.js` has
 * mounted inside it survives a re-render.
 * @param {HTMLLIElement} tile
 * @param {object} node
 */
function updateTile(tile, node) {
  tile.dataset.kind = node.kind;

  const titleHook = tile.querySelector('[data-edit="title"]');
  if (titleHook && !isEditingHook(titleHook)) titleHook.textContent = node.title;

  const bodyHook = tile.querySelector('[data-edit="body"]');
  if (bodyHook && !isEditingHook(bodyHook)) bodyHook.textContent = firstLine(node.body);

  const answerHook = tile.querySelector('[data-edit="answer"]');
  if (answerHook && !isEditingHook(answerHook)) answerHook.textContent = node.answer ?? '';

  const remove = tile.querySelector('[data-action="delete"]');
  if (remove) {
    setVisible(remove, store.isEditMode());
    remove.setAttribute('aria-label', `Delete ${node.title}`);
  }
}

/**
 * Paint the level into the grid, reusing the tiles that are already there.
 * @param {object[]} level
 */
function renderTiles(level) {
  const grid = dom.grid;
  if (!grid) return;

  if (dom.gridMode !== 'tiles') {
    grid.replaceChildren();
    dom.tiles.clear();
    dom.gridMode = 'tiles';
  }

  const seen = new Set();
  let index = 0;

  for (const node of level) {
    seen.add(node.id);

    let tile = dom.tiles.get(node.id);
    if (!tile || !tile.isConnected) {
      tile = createTile(node);
      dom.tiles.set(node.id, tile);
    } else {
      updateTile(tile, node);
    }

    const at = grid.children[index];
    if (at !== tile) grid.insertBefore(tile, at ?? null);
    index += 1;
  }

  for (const [id, el] of [...dom.tiles]) {
    if (seen.has(id)) continue;
    el.remove();
    dom.tiles.delete(id);
  }
}

/**
 * The loading state: skeleton blocks with the exact dimensions of the tiles
 * they replace (visual system §4.10).
 */
function renderSkeleton() {
  const grid = dom.grid;
  if (!grid) return;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < SKELETON_TILES; i += 1) {
    const li = document.createElement('li');
    li.className = 'tile tile--skeleton';
    li.setAttribute('aria-hidden', 'true');

    const icon = document.createElement('div');
    icon.className = 'skeleton skeleton--icon';

    const line = document.createElement('div');
    line.className = 'skeleton skeleton--line';

    const short = document.createElement('div');
    short.className = 'skeleton skeleton--line-short';

    li.append(icon, line, short);
    frag.appendChild(li);
  }

  grid.replaceChildren(frag);
  dom.tiles.clear();
  dom.gridMode = 'skeleton';
}

/**
 * The empty state: the grid's own footprint drawn as faint outlines plus one
 * line of copy (visual system §4.10).
 */
function renderEmpty() {
  const grid = dom.grid;
  if (!grid) return;

  const li = document.createElement('li');
  li.className = 'empty-state';
  li.style.gridColumn = '1 / -1';

  const footprint = document.createElement('div');
  footprint.className = 'empty-footprint';
  for (let i = 0; i < 3; i += 1) {
    const outline = document.createElement('div');
    outline.className = 'empty-tile';
    footprint.appendChild(outline);
  }

  const message = document.createElement('p');
  message.className = 'empty-message';
  message.textContent = 'This level is empty. Create a folder or a card to fill it.';

  li.append(footprint, message);
  grid.replaceChildren(li);
  dom.tiles.clear();
  dom.gridMode = 'empty';
}

/**
 * The inline banner: a failure names itself and offers a retry, a notice is
 * neutral (visual system §4.10).
 */
function renderBanner() {
  const grid = dom.grid;
  if (!grid) return;

  const error = store.getError();
  const notice = store.getNotice();

  if (!error && !notice) {
    dom.banner?.remove();
    dom.banner = null;
    dom.bannerMessage = null;
    dom.bannerAction = null;
    return;
  }

  if (!dom.banner) {
    const banner = document.createElement('div');
    banner.className = 'banner';

    const message = document.createElement('div');
    message.className = 'banner-message';

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn btn-secondary banner-action';
    action.addEventListener('click', () => {
      void store.loadLevel(store.getCurrentFolderId());
    });

    banner.append(message, action);
    grid.parentElement?.insertBefore(banner, grid);

    dom.banner = banner;
    dom.bannerMessage = message;
    dom.bannerAction = action;
  }

  if (error) {
    dom.banner.className = 'banner banner--error';
    dom.bannerMessage.textContent = describeError(error);
    dom.bannerAction.textContent = 'Retry';
    setVisible(dom.bannerAction, true);
    return;
  }

  dom.banner.className = 'banner banner--notice';
  dom.bannerMessage.textContent = notice;
  setVisible(dom.bannerAction, false);
}

/**
 * Name the failure in plain words.
 * @param {Error} error
 * @returns {string}
 */
function describeError(error) {
  const code = error?.code ? ` (${error.code})` : '';
  const message = error?.message || 'The request failed.';
  return `Could not load this level${code}. ${message}`;
}

/* ---------------------------------------------------------------------------
 * Spine
 * ------------------------------------------------------------------------ */

/**
 * Paint the whole tree into the spine, with the current path marked.
 */
function renderSpine(folderId = store.getCurrentFolderId()) {
  const container = document.getElementById('spine-tree');
  if (!container) return;

  const tree = store.getTree();
  const currentPath = new Set(store.getPathOf(folderId).map((node) => node.id));
  const currentFolderId = folderId;

  const parentsWithChildren = new Set();
  for (const node of tree) {
    if (node.parentId) parentsWithChildren.add(node.parentId);
  }

  const depthById = new Map();
  const frag = document.createDocumentFragment();

  for (const node of tree) {
    const depth = node.parentId ? (depthById.get(node.parentId) ?? 0) + 1 : 0;
    depthById.set(node.id, depth);

    const row = document.createElement('div');
    row.className = 'spine-row';
    row.dataset.id = node.id;
    row.dataset.kind = node.kind;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.style.setProperty('--depth', String(depth));

    if (depth > 4) row.classList.add('is-clipped');
    if (currentPath.has(node.id)) row.classList.add('is-current');
    if (node.id === currentFolderId) row.setAttribute('aria-current', 'page');

    const icon = document.createElement('span');
    icon.className = 'spine-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(svgIcon(node.kind === 'folder' ? 'folder' : 'card'));

    const label = document.createElement('span');
    label.className = 'spine-label';
    label.textContent = node.title;

    row.append(icon, label);

    if (node.kind === 'folder' && parentsWithChildren.has(node.id)) {
      const chevron = document.createElement('span');
      chevron.className = 'spine-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.appendChild(svgIcon('chevron'));
      row.appendChild(chevron);
    }

    frag.appendChild(row);
  }

  container.replaceChildren(frag);
}

/* ---------------------------------------------------------------------------
 * Breadcrumb
 * ------------------------------------------------------------------------ */

/**
 * Paint the path of the current level. The "›" separator is generated by
 * `layout.css` (`.crumb + .crumb::before`), so no separator element is
 * rendered here.
 */
function renderBreadcrumb(folderId = store.getCurrentFolderId()) {
  const nav = document.getElementById('breadcrumb');
  if (!nav) return;

  const path = store.getPathOf(folderId);
  const frag = document.createDocumentFragment();

  const truncated = path.length > MAX_CRUMB_SEGMENTS;
  const segments = truncated ? path.slice(-(MAX_CRUMB_SEGMENTS - 1)) : path;

  if (truncated) {
    const more = document.createElement('span');
    more.className = 'crumb-more';
    more.textContent = '…';
    more.setAttribute('aria-hidden', 'true');
    frag.appendChild(more);
  }

  segments.forEach((node, index) => {
    const isLast = index === segments.length - 1;

    if (isLast) {
      const current = document.createElement('span');
      // It carries BOTH classes: `.crumb-current` styles it as the current
      // segment, and `.crumb` is what the sibling separator
      // (`.crumb + .crumb::before`) and the `.crumb[aria-current="page"]`
      // rule both match on. Without `.crumb` the current segment gets no
      // separator and sits flush against its predecessor.
      current.className = 'crumb crumb-current';
      current.setAttribute('aria-current', 'page');
      current.textContent = node.title;
      frag.appendChild(current);
      return;
    }

    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = 'crumb';
    crumb.dataset.id = node.id;
    crumb.textContent = node.title;
    frag.appendChild(crumb);
  });

  nav.replaceChildren(frag);
}

/* ---------------------------------------------------------------------------
 * Interaction
 * ------------------------------------------------------------------------ */

/**
 * Open whatever a tile points at: a folder navigates down, a card opens in
 * Focus Mode.
 * @param {HTMLElement} tile
 */
function activateTile(tile) {
  const node = store.getNode(tile.dataset.id);
  if (!node) return;

  if (node.kind === 'folder') {
    navigate(folderUrl(node.id));
    return;
  }

  navigate(focusUrl(node));
}

/**
 * Open a spine row: a folder shows its level, a card opens in Focus Mode.
 * @param {HTMLElement} row
 */
function activateSpineRow(row) {
  const node = store.getNode(row.dataset.id);
  if (!node) return;

  if (node.kind === 'folder') {
    navigate(folderUrl(node.id));
    return;
  }

  navigate(focusUrl(node));
}

function onGridClick(ev) {
  // The delete control belongs to `edit.js`; it must not also open the tile.
  if (ev.target.closest('[data-action="delete"]')) return;

  const tile = ev.target.closest('.tile');
  if (!tile || tile.classList.contains('tile--skeleton')) return;

  activateTile(tile);
}

function onGridKeydown(ev) {
  if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;

  const tile = ev.target.closest('.tile');
  if (!tile || tile.classList.contains('tile--skeleton')) return;

  ev.preventDefault();
  activateTile(tile);
}

function onSpineClick(ev) {
  const row = ev.target.closest('.spine-row');
  if (!row) return;
  activateSpineRow(row);
}

function onSpineKeydown(ev) {
  if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;

  const row = ev.target.closest('.spine-row');
  if (!row) return;

  ev.preventDefault();
  activateSpineRow(row);
}

function onBreadcrumbClick(ev) {
  const crumb = ev.target.closest('.crumb');
  if (!crumb) return;
  navigate(folderUrl(crumb.dataset.id));
}

/* ---------------------------------------------------------------------------
 * Public API (contracts §4.4)
 * ------------------------------------------------------------------------ */

/**
 * Mount the file page into `root` (the #grid container) and paint it.
 * @param {HTMLElement} root
 */
export function mountFilePage(root) {
  if (!root) return;

  dom.grid = root;

  if (!dom.wired) {
    root.addEventListener('click', onGridClick);
    root.addEventListener('keydown', onGridKeydown);

    document.getElementById('spine-tree')?.addEventListener('click', onSpineClick);
    document.getElementById('spine-tree')?.addEventListener('keydown', onSpineKeydown);
    document.getElementById('breadcrumb')?.addEventListener('click', onBreadcrumbClick);

    dom.wired = true;
  }

  renderBanner();
  renderSpine();
  renderBreadcrumb();

  const level = store.getLevel();
  const status = store.getStatus();

  // A level that has not been fetched yet shows the skeleton; the tree cache
  // can already supply its children, but they are not what the server said
  // about that level, so the view waits for the level request.
  if (!store.hasLevel(store.getCurrentFolderId())) {
    if (status === 'error') {
      // The banner already names the failure; the grid stays empty.
      if (dom.gridMode !== 'empty') {
        root.replaceChildren();
        dom.tiles.clear();
        dom.gridMode = 'empty';
      }
      return;
    }

    renderSkeleton();
    return;
  }

  if (level.length === 0) {
    renderEmpty();
    return;
  }

  renderTiles(level);
}

/**
 * Tear the file page down: the grid, the spine and the breadcrumb go empty.
 */
export function unmountFilePage() {
  if (dom.grid) {
    dom.grid.replaceChildren();
    dom.tiles.clear();
    dom.gridMode = null;
  }

  dom.banner?.remove();
  dom.banner = null;

  /* The spine and the breadcrumb are NOT cleared here. Focus Mode needs them
     to keep showing the level that is on stage (design §4.2.7), and the file
     page re-renders them when it is mounted again. */
}

/**
 * Re-render the spine and the breadcrumb for a given level.
 *
 * Focus Mode calls this with the level that is on stage, which is one level
 * deeper than the file page's own level once the user descends. The path
 * indicator therefore stays in step with the tree as the user moves through
 * it, instead of pointing at the folder the stage was entered from.
 *
 * @param {string|null} folderId the folder whose path to show; null = root
 */
export function renderChrome(folderId = null) {
  renderSpine(folderId);
  renderBreadcrumb(folderId);
}
