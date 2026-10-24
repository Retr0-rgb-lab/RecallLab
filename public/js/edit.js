/**
 * RecallLab — Edit Mode (build contracts §4.7 and §5.3; design §4.3;
 * visual-system §4.3 inputs, §4.2 buttons, §6 motion).
 *
 * Edit Mode is an OVERLAY. The mode underneath stays visible and readable and
 * the editable affordances appear on top of it. This module owns every
 * mutation the user can perform:
 *
 *   - inline editing of a node's title, body and answer,
 *   - creating a folder or a card in the level that is on screen,
 *   - deleting a node, behind a cascade-aware confirmation,
 *   - moving a node into another folder by dragging a tile onto it,
 *   - reordering the siblings of a level by dragging a tile to a new index.
 *
 * It never renders the DOM hooks it consumes — `filepage.js` and `focus.js`
 * own those (contracts §5.3). It turns them into real inputs.
 *
 * Consumed hooks (rendered by other owners):
 *
 *   [data-edit="title"]    inline text input        (filepage.js / focus.js)
 *   [data-edit="body"]     inline textarea          (filepage.js / focus.js)
 *   [data-edit="answer"]   inline textarea          (filepage.js / focus.js)
 *   #action-create         create folder or card    (filepage.js)
 *   [data-action="delete"] delete one node          (filepage.js / focus.js)
 *
 * A hook is mapped to its node through the nearest ancestor that carries a
 * `data-id` — the `li.tile` of the file page and the `article.stage-card` of
 * the stage both do (contracts §5.1, §5.2).
 *
 * Optional convenience hook, rendered by whoever owns the toolbar:
 *
 *   [data-action="toggle-edit"]   toggles Edit Mode
 */

import { store } from './store.js';

/* ---------------------------------------------------------------------------
 * Constants (contracts §8 — copy these values, do not re-derive them)
 * ------------------------------------------------------------------------ */

/** The editable hooks of contracts §5.3. */
const HOOK_SELECTOR = '[data-edit="title"], [data-edit="body"], [data-edit="answer"]';

/** The displacement that classifies a pointer gesture as a drag (contracts §8). */
const DRAG_THRESHOLD_PX = 56;

/**
 * The middle band of a folder tile accepts a drop ("move into"); the outer
 * edges of the same tile reorder instead. Without the split, a folder could
 * never be reordered against its folder siblings.
 */
const DROP_BAND = 0.25;

/** How long a toast stays on screen. */
const TOAST_MS = 4200;

/** Hard bound for a tree walk, mirroring the server's own bound. */
const MAX_TREE_HOPS = 64;

/** The key the root level is filed under inside the client's own maps. */
const ROOT_KEY = '__root__';

const EMPTY_TITLE_MESSAGE = 'Title cannot be empty';

const FIELD_LABEL = { title: 'Title', body: 'Body', answer: 'Answer' };

const FIELD_PLACEHOLDER = {
  title: 'Untitled',
  body: 'Add a prompt…',
  answer: 'Add an answer…',
};

/* ---------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------ */

const state = {
  active: false,
  /** hook element -> editor record */
  editors: new Map(),
  /** hooks the user closed with Escape: they stay closed until clicked again */
  dismissed: new WeakSet(),
  unsubscribe: null,
  listenersBound: false,
  drag: null,
  dialog: null,
  popover: null,
  toasts: new Set(),
  fieldSeq: 0,
  pendingRefresh: false,
  suppressClick: false,
  stageObserver: null,
  observedStageCard: null,
  domObserver: null,
};

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

const qa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** The node id a hook or a control belongs to, through its nearest owner. */
function nodeIdFor(element) {
  const owner = element?.closest?.('[data-id]');
  return owner ? owner.dataset.id || null : null;
}

function nodeById(id) {
  if (!id) return undefined;
  try {
    return store.getNode(id);
  } catch {
    return undefined;
  }
}

function fieldValueOf(node, kind) {
  if (!node) return '';
  if (kind === 'title') return node.title ?? '';
  if (kind === 'body') return node.body ?? '';
  return node.answer ?? '';
}

/** Every node of the tree, flat. */
function tree() {
  try {
    return store.getTree() || [];
  } catch {
    return [];
  }
}

/**
 * How many nodes live below `nodeId` — the number the delete confirmation
 * has to state (design §4.3.4).
 */
function descendantCount(nodeId) {
  const children = new Map();
  for (const node of tree()) {
    const key = node.parentId ?? ROOT_KEY;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node.id);
  }

  let count = 0;
  let hops = 0;
  const seen = new Set();
  const frontier = [...(children.get(nodeId) || [])];
  while (frontier.length && hops < MAX_TREE_HOPS) {
    const id = frontier.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    count += 1;
    hops += 1;
    for (const child of children.get(id) || []) frontier.push(child);
  }
  return count;
}

/** Is `candidateId` a descendant of `ancestorId`? */
function isDescendant(candidateId, ancestorId) {
  if (!candidateId || !ancestorId) return false;
  const byId = new Map(tree().map((node) => [node.id, node]));
  let current = byId.get(candidateId);
  let hops = 0;
  while (current && hops < MAX_TREE_HOPS) {
    if (current.parentId === ancestorId) return true;
    current = current.parentId ? byId.get(current.parentId) : undefined;
    hops += 1;
  }
  return false;
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return 'Something went wrong.';
}

/* ---------------------------------------------------------------------------
 * The file page level — the tiles of the level that is on screen
 * ------------------------------------------------------------------------ */

/** The tiles of the file page, outermost `[data-id]` element of every tile. */
function gridTiles() {
  const all = qa('#grid [data-id]');
  return all.filter((el) => el.closest('#grid [data-id]') === el);
}

/** The tile under a pointer target, if any. */
function tileFor(target) {
  if (!target || typeof target.closest !== 'function') return null;
  return gridTiles().find((tile) => tile.contains(target)) || null;
}

/**
 * What is under the pointer, ignoring the tile that is being dragged — the
 * dragged tile follows the pointer and would always be in the way.
 */
function elementUnderPointer(x, y) {
  const drag = state.drag;
  if (!drag) return document.elementFromPoint(x, y);
  const previous = drag.tile.style.pointerEvents;
  drag.tile.style.pointerEvents = 'none';
  const found = document.elementFromPoint(x, y);
  drag.tile.style.pointerEvents = previous;
  return found;
}

/**
 * The level the user is looking at. On the file page it is the folder the
 * grid is showing; in Focus Mode it is the level the focused card belongs to.
 */
function currentLevelId() {
  const card = focusedStageCard();
  if (card) {
    const node = nodeById(card.dataset.id);
    if (node) return node.parentId ?? null;
  }
  const focusId = store.getFocusId?.() ?? null;
  if (focusId) {
    const node = nodeById(focusId);
    if (node) return node.parentId ?? null;
  }
  return store.getCurrentFolderId?.() ?? null;
}

/** The focused card of the stage, if Focus Mode is on screen. */
function focusedStageCard() {
  return document.querySelector('.stage-card[data-depth="0"]');
}

/* ---------------------------------------------------------------------------
 * Inline editors
 * ------------------------------------------------------------------------ */

function editorFor(target) {
  if (!target || typeof target.closest !== 'function') return null;
  const hook = target.closest('[data-edit]');
  if (!hook) return null;
  return state.editors.get(hook) || null;
}

function makeInput(kind, id) {
  const input = kind === 'title' ? document.createElement('input') : document.createElement('textarea');
  input.id = id;
  input.className = kind === 'title' ? 'edit-input' : 'edit-input edit-textarea';
  if (kind === 'title') input.type = 'text';
  input.setAttribute('data-edit-field', kind);
  /* The focus gesture machine ignores pointers on this attribute, so editing
     a field never drags the card it belongs to (contracts §4.6). */
  input.setAttribute('data-gesture-ignore', '');
  input.setAttribute('aria-label', FIELD_LABEL[kind]);
  input.placeholder = FIELD_PLACEHOLDER[kind];
  if (kind !== 'title') {
    input.rows = 4;
    input.spellcheck = false;
  }
  return input;
}

/**
 * Turn a hook into a real input.
 *
 * @param {Element} hook
 * @param {object} [previous] the editor record of a hook that was re-rendered
 *   by its owner; its pending value survives the re-render.
 */
function mountEditor(hook, previous) {
  const kind = hook.dataset.edit;
  const nodeId = nodeIdFor(hook);
  const node = nodeById(nodeId);
  const originalText = hook.textContent ?? '';

  hook.textContent = '';
  hook.classList.add('is-editing-field');
  state.dismissed.delete(hook);

  const id = `edit-field-${(state.fieldSeq += 1)}`;
  const label = document.createElement('label');
  label.className = 'edit-label';
  label.setAttribute('for', id);
  label.textContent = FIELD_LABEL[kind];

  const input = makeInput(kind, id);
  input.value = previous ? previous.value : fieldValueOf(node, kind);

  /* The answer of a card is not shown on the file page: the owner renders the
     hook inside a hidden container and expects the editor to reveal it. */
  const container = hook.closest('[hidden]');
  if (container) container.hidden = false;

  const record = {
    hook,
    kind,
    nodeId,
    input,
    label,
    container,
    originalText,
    value: input.value,
    dirty: Boolean(previous?.dirty),
    errorEl: null,
    errorMessage: null,
    closing: false,
  };

  input.addEventListener('input', () => {
    record.value = input.value;
    record.dirty = true;
  });
  input.addEventListener('blur', () => {
    /* The owner may have re-rendered the hook and taken the input with it.
       A detached input is never committed — the pending value is restored
       by the next refresh instead. */
    if (!input.isConnected) return;
    commitEditor(record);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (record.kind !== 'title' && !(ev.metaKey || ev.ctrlKey)) return;
    ev.preventDefault();
    ev.stopPropagation();
    input.blur();
  });

  hook.appendChild(label);
  hook.appendChild(input);

  state.editors.set(hook, record);
  if (previous?.errorMessage) showError(record, previous.errorMessage);
  return record;
}

/** Remove the editor and put the node's text back where it was. */
function unmountEditor(hook, record, { restore = true } = {}) {
  record.closing = true;
  clearError(record);
  record.input.remove();
  record.label.remove();
  hook.classList.remove('is-editing-field');
  if (record.container) {
    record.container.hidden = true;
    record.container = null;
  }
  if (restore) {
    const node = nodeById(record.nodeId);
    hook.textContent = node ? fieldValueOf(node, record.kind) : record.originalText;
  }
  state.editors.delete(hook);
}

/** Escape leaves the editor without saving. */
function closeEditor(record) {
  if (!record || record.closing) return;
  state.dismissed.add(record.hook);
  unmountEditor(record.hook, record, { restore: true });
}

function showError(record, message) {
  clearError(record);
  const error = document.createElement('p');
  error.className = 'edit-error';
  error.id = `${record.input.id}-error`;
  error.textContent = message;
  record.hook.appendChild(error);
  record.errorEl = error;
  record.errorMessage = message;
  record.input.setAttribute('aria-invalid', 'true');
  record.input.setAttribute('aria-describedby', error.id);
}

function clearError(record) {
  if (record.errorEl) record.errorEl.remove();
  record.errorEl = null;
  record.errorMessage = null;
  record.input.removeAttribute('aria-invalid');
  record.input.removeAttribute('aria-describedby');
}

/**
 * Save an edited field.
 *
 * An empty title is rejected with an inline error; an empty body or answer is
 * a legitimate value (design §4.3.1).
 */
async function commitEditor(record) {
  if (record.closing || !record.input.isConnected) return;

  const raw = record.input.value;
  const value = record.kind === 'title' ? raw.trim() : raw;

  if (record.kind === 'title' && value === '') {
    showError(record, EMPTY_TITLE_MESSAGE);
    record.input.focus();
    return;
  }

  clearError(record);
  record.value = value;

  const node = nodeById(record.nodeId);
  if (node && fieldValueOf(node, record.kind) === value) {
    record.dirty = false;
    return;
  }

  record.dirty = false;
  try {
    await store.updateNode(record.nodeId, { [record.kind]: value });
  } catch (error) {
    showError(record, errorMessage(error));
  }
}

/* ---------------------------------------------------------------------------
 * Refresh — re-render the inline editors after a store change
 * ------------------------------------------------------------------------ */

/** Is this hook one the user may edit right now? */
function isEditableContext(hook) {
  const card = hook.closest('.stage-card');
  if (card) return card === focusedStageCard();
  return true;
}

export function refresh() {
  if (!state.active) return;

  const seen = new Set();
  for (const hook of qa(HOOK_SELECTOR)) {
    if (!isEditableContext(hook)) continue;
    if (state.dismissed.has(hook)) continue;
    seen.add(hook);
    const record = state.editors.get(hook);
    if (record && record.input.isConnected && hook.contains(record.input)) continue;
    /* The owner re-rendered the hook and took the input with it. Mount a new
       one, keeping the value the user had typed. */
    const mounted = mountEditor(hook, record);
    if (record) {
      mounted.dirty = record.dirty;
      mounted.value = record.value;
      if (record.errorMessage) showError(mounted, record.errorMessage);
    }
  }

  for (const [hook, record] of Array.from(state.editors)) {
    if (seen.has(hook)) continue;
    unmountEditor(hook, record);
  }

  syncStage();
}

/** A refresh on the next frame — the owner may re-render after we do. */
function scheduleRefresh() {
  if (state.pendingRefresh) return;
  state.pendingRefresh = true;
  const run = () => {
    state.pendingRefresh = false;
    refresh();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

/**
 * Watch for hooks that appear while Edit Mode is on.
 *
 * The stage is mounted by `focus.js` without any store change, so a store
 * subscription alone would never notice a focused card that arrives after
 * Edit Mode was switched on.
 */
function observeDom() {
  if (state.domObserver || typeof MutationObserver !== 'function') return;
  state.domObserver = new MutationObserver(() => scheduleRefresh());
  state.domObserver.observe(document.body, { childList: true, subtree: true });
}

function unobserveDom() {
  state.domObserver?.disconnect();
  state.domObserver = null;
}

/* ---------------------------------------------------------------------------
 * Focus Mode — the focused card opens into a flat editing surface
 * ------------------------------------------------------------------------ */

function syncStage() {
  const card = focusedStageCard();
  if (!card) return;

  card.classList.toggle('is-editing', state.active);

  if (!state.active) {
    if (state.observedStageCard) {
      state.stageObserver?.disconnect();
      state.observedStageCard = null;
    }
    return;
  }

  if (state.observedStageCard !== card) {
    state.stageObserver?.disconnect();
    if (typeof ResizeObserver === 'function') {
      state.stageObserver = state.stageObserver || new ResizeObserver(() => syncStageHeight());
      state.stageObserver.observe(card);
    }
    state.observedStageCard = card;
  }

  syncStageHeight();
}

/** The stack is as tall as the card it holds, so the stage stays centred. */
function syncStageHeight() {
  const stack = document.querySelector('.stage-stack');
  const card = focusedStageCard();
  if (!stack || !card) return;
  const height = card.offsetHeight;
  if (height > 0) stack.style.height = `${height}px`;
}

/* ---------------------------------------------------------------------------
 * Dragging — move into a folder, or reorder among the siblings
 * ------------------------------------------------------------------------ */

function onPointerDown(ev) {
  if (!state.active) return;
  if (ev.isPrimary === false) return;
  if (ev.pointerType === 'mouse' && typeof ev.button === 'number' && ev.button !== 0) return;

  const target = ev.target;
  if (target?.closest?.('input, textarea, button, select, [contenteditable="true"]')) return;

  const tile = tileFor(target);
  if (!tile) return;

  state.drag = {
    pointerId: ev.pointerId,
    tile,
    startX: ev.clientX,
    startY: ev.clientY,
    active: false,
    drop: null,
    dropTile: null,
  };
}

function onPointerMove(ev) {
  const drag = state.drag;
  if (!drag || ev.pointerId !== drag.pointerId) return;

  const dx = ev.clientX - drag.startX;
  const dy = ev.clientY - drag.startY;

  if (!drag.active) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.active = true;
    drag.tile.classList.add('dragging');
    try {
      drag.tile.setPointerCapture(ev.pointerId);
    } catch {
      /* capture is best effort */
    }
  }

  /* No transition may be active while the pointer moves (contracts §4.6). */
  drag.tile.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  updateDropTarget(ev);
}

function onPointerUp(ev) {
  const drag = state.drag;
  if (!drag || ev.pointerId !== drag.pointerId) return;

  if (drag.active) {
    /* The click that follows a drag must not navigate anywhere. The flag is
       cleared by that click, or by a timer when no click follows. */
    state.suppressClick = true;
    setTimeout(() => {
      state.suppressClick = false;
    }, 400);
    const drop = drag.drop ? { ...drag.drop, draggedId: drag.tile.dataset.id } : null;
    clearDrag();
    if (drop) applyDrop(drop);
    return;
  }

  clearDrag();
}

function onPointerCancel(ev) {
  const drag = state.drag;
  if (!drag || ev.pointerId !== drag.pointerId) return;
  clearDrag();
}

function clearDrag() {
  const drag = state.drag;
  if (drag) {
    drag.tile.classList.remove('dragging', 'edit-drop-ready');
    drag.tile.style.transform = '';
    if (drag.dropTile) {
      drag.dropTile.classList.remove('edit-drop-target', 'edit-drop-before', 'edit-drop-after');
    }
  }
  state.drag = null;
}

/** Work out what the pointer is over and mark it. */
function updateDropTarget(ev) {
  const drag = state.drag;
  if (!drag) return;

  if (drag.dropTile) {
    drag.dropTile.classList.remove('edit-drop-target', 'edit-drop-before', 'edit-drop-after');
    drag.dropTile = null;
  }

  const under = elementUnderPointer(ev.clientX, ev.clientY);
  const tile = tileFor(under);
  const draggedNode = nodeById(drag.tile.dataset.id);

  if (!tile) {
    /* Not a tile of the level. Any other folder the pointer is over — a row
       of the outline, for instance — takes the node. */
    const owner = under?.closest?.('[data-id]');
    const ownerNode = owner ? nodeById(owner.dataset.id) : undefined;
    if (ownerNode?.kind === 'folder') {
      drag.drop = { type: 'move', targetId: ownerNode.id };
      owner.classList.add('edit-drop-target');
      drag.dropTile = owner;
      setDropReady(drag, true);
      return;
    }
    drag.drop = draggedNode ? { type: 'reorder', index: groupLength(draggedNode) } : null;
    setDropReady(drag, Boolean(drag.drop));
    return;
  }

  if (tile === drag.tile) {
    drag.drop = draggedNode ? { type: 'reorder', index: groupLength(draggedNode) } : null;
    setDropReady(drag, Boolean(drag.drop));
    return;
  }

  const rect = tile.getBoundingClientRect();
  const ratio = rect.width > 0 ? (ev.clientX - rect.left) / rect.width : 0.5;
  const targetNode = nodeById(tile.dataset.id);

  if (targetNode?.kind === 'folder' && ratio >= DROP_BAND && ratio <= 1 - DROP_BAND) {
    /* The middle of a folder tile takes the node: this is a move. */
    drag.drop = { type: 'move', targetId: targetNode.id };
    tile.classList.add('edit-drop-target');
    drag.dropTile = tile;
    setDropReady(drag, true);
    return;
  }

  drag.drop = { type: 'reorder', index: reorderIndex(draggedNode, tile, ratio) };
  tile.classList.add(ratio < 0.5 ? 'edit-drop-before' : 'edit-drop-after');
  drag.dropTile = tile;
  setDropReady(drag, true);
}

/** The dragged tile dims while a drop is resolved, so the target shows. */
function setDropReady(drag, ready) {
  drag.tile.classList.toggle('edit-drop-ready', Boolean(ready));
}

/** How many siblings of the dragged node's kind the level holds. */
function groupLength(draggedNode) {
  if (!draggedNode) return 0;
  return gridTiles().filter((tile) => nodeById(tile.dataset.id)?.kind === draggedNode.kind).length;
}

/**
 * The index the dragged node takes inside its own group when it is dropped
 * on `tile`. The server always returns folders first, then cards, so a node
 * can only move inside the group it belongs to.
 */
function reorderIndex(draggedNode, tile, ratio) {
  const group = gridTiles()
    .map((el) => el.dataset.id)
    .filter((id) => nodeById(id)?.kind === draggedNode?.kind);
  const others = group.filter((id) => id !== draggedNode?.id);

  const targetId = tile?.dataset.id;
  if (!targetId || targetId === draggedNode?.id) return others.length;

  let index = others.indexOf(targetId);
  if (index < 0) return others.length;
  if (ratio >= 0.5) index += 1;
  return index;
}

/**
 * The order the level should have after the drop: the dragged node takes the
 * computed index inside its own group, and the groups stay folders-then-cards
 * because that is how the server renders a level (contracts §3.2).
 */
function desiredOrder(draggedNode, index) {
  const byKind = { folder: [], card: [] };
  for (const tile of gridTiles()) {
    const node = nodeById(tile.dataset.id);
    if (!node) continue;
    byKind[node.kind]?.push(node.id);
  }

  const kind = draggedNode?.kind ?? 'card';
  const group = byKind[kind].filter((id) => id !== draggedNode.id);
  const at = Math.max(0, Math.min(index ?? group.length, group.length));
  byKind[kind] = [...group.slice(0, at), draggedNode.id, ...group.slice(at)];

  return [...byKind.folder, ...byKind.card];
}

async function applyDrop(drop) {
  if (drop.type === 'move') {
    await performMove(drop.draggedId, drop.targetId);
    return;
  }
  await performReorder(drop.draggedId, drop.index);
}

/**
 * Move a node into a folder. One PUT, never a delete plus a create
 * (design §4.3.3).
 */
async function performMove(draggedId, targetFolderId) {
  const draggedNode = nodeById(draggedId);
  if (!draggedNode) return;

  if (targetFolderId === draggedId || isDescendant(targetFolderId, draggedId)) {
    toast('Cannot move a folder into itself');
    return;
  }

  try {
    await store.moveNode(draggedId, targetFolderId);
  } catch (error) {
    toast(errorMessage(error));
  }
}

/** Apply the new order of a level with one POST (design §4.3.3). */
async function performReorder(draggedId, index) {
  const draggedNode = nodeById(draggedId);
  if (!draggedNode) return;

  const orderedIds = desiredOrder(draggedNode, index);
  const current = gridTiles().map((tile) => tile.dataset.id);
  if (orderedIds.join(',') === current.join(',')) return;

  try {
    await store.reorderLevel(draggedNode.parentId ?? null, orderedIds);
  } catch (error) {
    toast(errorMessage(error));
  }
}

/* ---------------------------------------------------------------------------
 * Delete — hard delete, behind a confirmation that names the node
 * ------------------------------------------------------------------------ */

function openDeleteDialog(nodeId) {
  const node = nodeById(nodeId);
  if (!node) return;

  const descendants = node.kind === 'folder' ? descendantCount(node.id) : 0;
  const message =
    node.kind === 'folder' && descendants > 0
      ? `Delete "${node.title}" and ${descendants} item${descendants === 1 ? '' : 's'} inside it?`
      : `Delete "${node.title}"?`;

  closeDialog(false);

  const backdrop = document.createElement('div');
  backdrop.className = 'edit-dialog-backdrop';

  const dialog = document.createElement('div');
  dialog.className = 'edit-dialog';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'edit-dialog-title');
  dialog.setAttribute('aria-describedby', 'edit-dialog-message');

  const eyebrow = document.createElement('p');
  eyebrow.className = 'edit-dialog-eyebrow';
  eyebrow.textContent = 'Delete';

  const title = document.createElement('h2');
  title.className = 'edit-dialog-title';
  title.id = 'edit-dialog-title';
  title.textContent = node.kind === 'folder' ? 'Delete this folder?' : 'Delete this card?';

  const body = document.createElement('p');
  body.className = 'edit-dialog-message';
  body.id = 'edit-dialog-message';
  body.textContent = message;

  const note = document.createElement('p');
  note.className = 'edit-dialog-note';
  note.textContent =
    node.kind === 'folder'
      ? 'Everything inside it is deleted too. This cannot be undone.'
      : 'This cannot be undone.';

  const actions = document.createElement('div');
  actions.className = 'edit-dialog-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-secondary';
  cancel.textContent = 'Cancel';
  cancel.dataset.dialogAction = 'cancel';

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'btn btn-primary';
  confirm.textContent = 'Delete';
  confirm.dataset.dialogAction = 'confirm';

  actions.append(cancel, confirm);
  dialog.append(eyebrow, title, body, note, actions);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  state.dialog = { backdrop, nodeId };

  cancel.addEventListener('click', () => closeDialog(false));
  confirm.addEventListener('click', () => closeDialog(true));
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) closeDialog(false);
  });

  cancel.focus();
}

async function closeDialog(confirmed) {
  const dialog = state.dialog;
  if (!dialog) return;
  state.dialog = null;
  dialog.backdrop.remove();

  if (!confirmed) return;

  try {
    await store.deleteNode(dialog.nodeId);
    /* The store removes the node from its cache; if the subtree is still
       there, the cache is resynchronised with the server. */
    await syncAfterDelete(dialog.nodeId);
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function syncAfterDelete(nodeId) {
  if (descendantCount(nodeId) > 0 && typeof store.loadTree === 'function') {
    try {
      await store.loadTree();
    } catch {
      /* the removal already happened; a failed resync is not fatal */
    }
  }
}

/* ---------------------------------------------------------------------------
 * Create — a folder or a card in the level that is on screen
 * ------------------------------------------------------------------------ */

function toggleCreateMenu(trigger) {
  if (state.popover) {
    closePopover();
    return;
  }
  openCreateMenu(trigger);
}

function openCreateMenu(trigger) {
  const popover = document.createElement('div');
  popover.className = 'edit-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Create a new item');

  const menu = document.createElement('div');
  menu.className = 'edit-popover-menu';

  for (const kind of ['folder', 'card']) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'edit-menu-item';
    item.dataset.createKind = kind;

    const name = document.createElement('span');
    name.className = 'edit-menu-title';
    name.textContent = kind === 'folder' ? 'New folder' : 'New card';

    const hint = document.createElement('span');
    hint.className = 'edit-menu-hint';
    hint.textContent =
      kind === 'folder' ? 'A level inside the current one' : 'A prompt and its answer';

    item.append(name, hint);
    item.addEventListener('click', () => openCreateForm(kind));
    menu.appendChild(item);
  }

  const form = document.createElement('form');
  form.className = 'edit-popover-form';
  form.hidden = true;

  const label = document.createElement('label');
  label.className = 'edit-label';
  label.setAttribute('for', 'edit-create-title');
  label.textContent = 'Title';

  const input = document.createElement('input');
  input.id = 'edit-create-title';
  input.className = 'edit-input';
  input.type = 'text';
  input.placeholder = 'Untitled';
  input.setAttribute('data-gesture-ignore', '');

  const error = document.createElement('p');
  error.className = 'edit-error';
  error.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'edit-popover-actions';

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-primary';
  submit.textContent = 'Create';
  submit.dataset.createSubmit = '';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-secondary';
  cancel.textContent = 'Cancel';
  cancel.dataset.createCancel = '';

  actions.append(cancel, submit);
  form.append(label, input, error, actions);

  popover.append(menu, form);
  document.body.appendChild(popover);

  state.popover = { popover, menu, form, input, error, kind: null };

  /* Anchor the popover under the control that opened it. */
  const rect = trigger?.getBoundingClientRect?.();
  if (rect) {
    const width = 280;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 260)}px`;
  }

  cancel.addEventListener('click', () => closePopover());
  submit.addEventListener('click', () => submitCreateForm());
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitCreateForm();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submitCreateForm();
    }
  });

  menu.querySelector('button')?.focus();
}

function openCreateForm(kind) {
  const popover = state.popover;
  if (!popover) return;
  popover.kind = kind;
  popover.menu.hidden = true;
  popover.form.hidden = false;
  popover.popover.querySelector('.edit-label').textContent =
    kind === 'folder' ? 'Folder title' : 'Card title';
  popover.input.value = '';
  popover.error.hidden = true;
  popover.error.textContent = '';
  popover.input.removeAttribute('aria-invalid');
  popover.input.focus();
}

async function submitCreateForm() {
  const popover = state.popover;
  if (!popover || !popover.kind) return;

  const title = popover.input.value.trim();
  if (title === '') {
    popover.error.hidden = false;
    popover.error.textContent = EMPTY_TITLE_MESSAGE;
    popover.input.setAttribute('aria-invalid', 'true');
    popover.input.focus();
    return;
  }

  const kind = popover.kind;
  const parentId = currentLevelId();
  closePopover();

  try {
    await store.createNode({ parentId, kind, title, body: '', answer: '' });
  } catch (error) {
    toast(errorMessage(error));
  }
}

function closePopover() {
  const popover = state.popover;
  if (!popover) return;
  state.popover = null;
  popover.popover.remove();
}

/* ---------------------------------------------------------------------------
 * Toast
 * ------------------------------------------------------------------------ */

function toast(message) {
  const host = document.createElement('div');
  host.className = 'edit-toast-host';
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('role', 'status');

  const el = document.createElement('p');
  el.className = 'edit-toast';
  el.textContent = message;

  host.appendChild(el);
  document.body.appendChild(host);
  state.toasts.add(host);

  const dismiss = () => {
    host.remove();
    state.toasts.delete(host);
  };
  el.addEventListener('click', dismiss);
  setTimeout(dismiss, TOAST_MS);
}

function clearToasts() {
  for (const host of state.toasts) host.remove();
  state.toasts.clear();
}

/* ---------------------------------------------------------------------------
 * Global listeners
 * ------------------------------------------------------------------------ */

function onDocumentClick(ev) {
  if (!state.active) return;

  if (state.suppressClick) {
    state.suppressClick = false;
    ev.preventDefault();
    ev.stopPropagation();
    return;
  }

  const target = ev.target;

  const del = target?.closest?.('[data-action="delete"]');
  if (del) {
    ev.preventDefault();
    ev.stopPropagation();
    openDeleteDialog(nodeIdFor(del));
    return;
  }

  const create = target?.closest?.('#action-create');
  if (create) {
    ev.preventDefault();
    ev.stopPropagation();
    toggleCreateMenu(create);
    return;
  }

  const toggle = target?.closest?.('[data-action="toggle-edit"]');
  if (toggle) {
    ev.preventDefault();
    ev.stopPropagation();
    setActive(!state.active);
    return;
  }

  const hook = target?.closest?.('[data-edit]');
  if (hook) {
    /* Editing a field never navigates. */
    ev.stopPropagation();
    if (!state.editors.has(hook) && isEditableContext(hook)) {
      const record = mountEditor(hook);
      record.input.focus();
      record.input.select?.();
    }
  }
}

function onDocumentKeyDown(ev) {
  if (!state.active) return;

  const record = editorFor(ev.target);

  if (record) {
    /* A keystroke inside an editor belongs to the editor: the owners must not
       read it as "open this tile" or "leave Focus Mode". */
    if (ev.key === 'Enter' && (record.kind === 'title' || ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      ev.stopPropagation();
      record.input.blur();
      return;
    }
    if (ev.key === ' ' || ev.key === 'Spacebar' || ev.key.startsWith('Arrow')) {
      ev.stopPropagation();
      return;
    }
  }

  if (ev.key === 'Escape') {
    if (record) {
      ev.preventDefault();
      ev.stopPropagation();
      closeEditor(record);
      return;
    }
    if (state.dialog) {
      ev.preventDefault();
      ev.stopPropagation();
      closeDialog(false);
      return;
    }
    if (state.popover) {
      ev.preventDefault();
      ev.stopPropagation();
      closePopover();
      return;
    }
    return;
  }

  if (state.dialog && ev.key === 'Tab') {
    trapFocus(ev, state.dialog.backdrop);
    return;
  }

  if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
    const target = ev.target;
    if (target?.id === 'action-create' && target.tagName !== 'BUTTON') {
      ev.preventDefault();
      toggleCreateMenu(target);
      return;
    }
    const del = target?.closest?.('[data-action="delete"]');
    if (del && del.tagName !== 'BUTTON') {
      ev.preventDefault();
      openDeleteDialog(nodeIdFor(del));
      return;
    }
  }

  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') scheduleRefresh();
}

/** Keep Tab inside the dialog while it is open. */
function trapFocus(ev, container) {
  const focusable = qa('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', container);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || !container.contains(active))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  }
}

function bindListeners() {
  if (state.listenersBound) return;
  state.listenersBound = true;
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
}

function unbindListeners() {
  if (!state.listenersBound) return;
  state.listenersBound = false;
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onDocumentKeyDown, true);
  document.removeEventListener('pointerdown', onPointerDown);
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('pointercancel', onPointerCancel);
}

/* ---------------------------------------------------------------------------
 * Public API (contracts §4.7)
 * ------------------------------------------------------------------------ */

export const edit = {
  isActive() {
    return state.active;
  },

  setActive(on) {
    const next = Boolean(on);
    if (next === state.active) return state.active;
    state.active = next;

    const root = document.documentElement;

    if (next) {
      root.setAttribute('data-edit-mode', 'on');
      bindListeners();
      observeDom();
      /* The owners read the store's flag to show their own edit affordances
         (the delete control, the state of the toolbar button). */
      if (typeof store.setEditMode === 'function') store.setEditMode(true);
      state.unsubscribe = store.subscribe(() => {
        refresh();
        scheduleRefresh();
      });
      refresh();
      return state.active;
    }

    root.removeAttribute('data-edit-mode');
    unbindListeners();
    unobserveDom();
    if (typeof store.setEditMode === 'function') store.setEditMode(false);
    if (state.unsubscribe) {
      state.unsubscribe();
      state.unsubscribe = null;
    }
    closeDialog(false);
    closePopover();
    clearToasts();
    clearDrag();
    state.suppressClick = false;
    /* A field the user closed with Escape comes back when Edit Mode does. */
    state.dismissed = new WeakSet();
    for (const [hook, record] of Array.from(state.editors)) unmountEditor(hook, record);
    state.editors.clear();
    syncStage();
    return state.active;
  },

  refresh() {
    refresh();
  },
};
