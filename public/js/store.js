/**
 * RecallLab — the client state store (build contracts §4.2).
 *
 * The single source of truth for client state. It owns every network mutation
 * and every cache update; the view modules only read from it and subscribe to
 * it.
 *
 * Import rules (contracts §4.2):
 *   - `store.js` imports `api.js` and nothing else.
 *   - `store.js` must NOT import `filepage.js`, `focus.js` or `edit.js`
 *     (those import `store.js`), so there are no circular imports here.
 *
 * Caches:
 *   - `tree`     every node, keyed by id, in the server's level order
 *                (folders first, then `position` ascending — the same rule the
 *                server applies in `server/db/queries.js` `sortLevel`).
 *   - `level`    the full records of one level, keyed by parent id. The grid
 *                renders the level exactly as the server returned it.
 *
 * Source of truth:
 *   docs/specs/2026-10-24-recalllab-contracts.md  §3.2 node shape, §4.2 store
 *   server/db/queries.js                           the ordering rule
 */

import { api } from './api.js';

/** The cache key of the root level (the server's `parent_id is null`). */
const ROOT_KEY = '__root__';

/** Bound on any tree walk, mirroring `MAX_TREE_HOPS` on the server. */
const MAX_TREE_HOPS = 64;

const levelKey = (parentId) =>
  parentId === null || parentId === undefined || parentId === '' ? ROOT_KEY : String(parentId);

/**
 * The server's level ordering: folders first, then cards; within each group
 * by `position` ascending, then by creation time. The client mirrors it so a
 * cached level and a freshly fetched level agree.
 */
function compareLevel(a, b) {
  const rankA = a.kind === 'folder' ? 0 : 1;
  const rankB = b.kind === 'folder' ? 0 : 1;
  if (rankA !== rankB) return rankA - rankB;
  if (a.position !== b.position) return a.position - b.position;
  return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
}

const state = {
  /** id -> node (full records). */
  treeById: new Map(),
  /** parent key -> Node[] (full records, server order). */
  levelCache: new Map(),
  mode: 'file',
  edit: false,
  focusId: null,
  folderId: null,
  status: 'idle', // 'idle' | 'loading' | 'error'
  error: null,
  notice: null,
  /** Number of requests in flight; the status is 'loading' while this is > 0. */
  pending: 0,
};

const subscribers = new Set();

/* ---------------------------------------------------------------------------
 * Notification
 * ------------------------------------------------------------------------ */

function notify() {
  for (const fn of [...subscribers]) {
    try {
      fn();
    } catch (err) {
      console.error('[store] a subscriber threw', err);
    }
  }
}

/** A request starts: the status stays 'loading' until the last one settles. */
function beginRequest() {
  state.pending += 1;
  state.status = 'loading';
}

/** A request settles. */
function endRequest(error) {
  state.pending = Math.max(0, state.pending - 1);
  if (state.pending > 0) return;
  state.status = error ? 'error' : 'idle';
}

/* ---------------------------------------------------------------------------
 * Derived views
 * ------------------------------------------------------------------------ */

/** Every node, flattened depth-first in the server's level order. */
function orderedTree() {
  const childrenByParent = new Map();

  for (const node of state.treeById.values()) {
    const key = levelKey(node.parentId);
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(node);
  }
  for (const list of childrenByParent.values()) list.sort(compareLevel);

  const out = [];
  const seen = new Set();

  const walk = (parentKey, depth) => {
    if (depth > MAX_TREE_HOPS) return;
    for (const node of childrenByParent.get(parentKey) ?? []) {
      if (seen.has(node.id)) continue; // a cycle must not loop forever
      seen.add(node.id);
      out.push(node);
      walk(levelKey(node.id), depth + 1);
    }
  };

  walk(ROOT_KEY, 0);
  return out;
}

/** The root-first chain of ancestors of a node, the node itself included. */
function chainOf(nodeId) {
  const chain = [];
  let current = nodeId ? state.treeById.get(nodeId) : undefined;
  let hops = 0;
  while (current && hops < MAX_TREE_HOPS) {
    chain.unshift(current);
    current = current.parentId ? state.treeById.get(current.parentId) : undefined;
    hops += 1;
  }
  return chain;
}

/** The ids of a node and everything below it. */
function subtreeIds(id) {
  const childrenByParent = new Map();
  for (const node of state.treeById.values()) {
    const key = levelKey(node.parentId);
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(node.id);
  }

  const collected = new Set();
  let frontier = [id];
  let hops = 0;
  while (frontier.length && hops < MAX_TREE_HOPS) {
    const next = [];
    for (const parentId of frontier) {
      for (const childId of childrenByParent.get(levelKey(parentId)) ?? []) {
        if (collected.has(childId)) continue;
        collected.add(childId);
        next.push(childId);
      }
    }
    frontier = next;
    hops += 1;
  }
  return collected;
}

/* ---------------------------------------------------------------------------
 * The store
 * ------------------------------------------------------------------------ */

export const store = {
  /* -- read ------------------------------------------------------------- */

  /**
   * The whole tree, flat.
   * @returns {object[]}
   */
  getTree() {
    return orderedTree();
  },

  /**
   * The children of the level currently on screen.
   * @returns {object[]}
   */
  getLevel() {
    return this.getChildren(state.folderId);
  },

  /**
   * One node.
   * @param {string} id
   * @returns {object|undefined}
   */
  getNode(id) {
    return state.treeById.get(id);
  },

  /**
   * The children of any level.
   * @param {string|null} parentId
   * @returns {object[]}
   */
  getChildren(parentId) {
    const key = levelKey(parentId);
    const cached = state.levelCache.get(key);
    if (cached) return cached;

    const children = [];
    for (const node of state.treeById.values()) {
      if (levelKey(node.parentId) === key) children.push(node);
    }
    children.sort(compareLevel);
    return children;
  },

  /**
   * The current mode.
   * @returns {'file'|'focus'}
   */
  getMode() {
    return state.mode;
  },

  /**
   * @returns {boolean}
   */
  isEditMode() {
    return state.edit;
  },

  /**
   * The focused node id, if any.
   * @returns {string|null}
   */
  getFocusId() {
    return state.focusId;
  },

  /**
   * The folder whose level is on screen (`null` = the root level).
   * @returns {string|null}
   */
  getCurrentFolderId() {
    return state.folderId;
  },

  /**
   * The path of the level on screen: the root-first ancestor chain including
   * the current folder itself. Empty at the root level.
   * @returns {object[]}
   */
  getPath() {
    return chainOf(state.folderId);
  },

  /**
   * The path of any node: the root-first ancestor chain including the node.
   * @param {string} id
   * @returns {object[]}
   */
  getPathOf(id) {
    return chainOf(id);
  },

  /**
   * Whether a level has been fetched from the API. The tree cache can supply
   * the children of any level, but only a fetched level counts as *ready* —
   * that is what tells the view to show a skeleton instead of tiles.
   * @param {string|null} parentId
   * @returns {boolean}
   */
  hasLevel(parentId) {
    return state.levelCache.has(levelKey(parentId));
  },

  /**
   * Whether the whole tree has been fetched.
   * @returns {boolean}
   */
  isTreeLoaded() {
    return state.treeById.size > 0;
  },

  /**
   * The load status of the current level.
   * @returns {'idle'|'loading'|'error'}
   */
  getStatus() {
    return state.status;
  },

  /**
   * The last error, if any.
   * @returns {Error|null}
   */
  getError() {
    return state.error;
  },

  /* -- view state (driven by the router in `main.js`) -------------------- */

  /**
   * Update the view state in one shot and notify once.
   *
   * @param {{folderId?: string|null, focusId?: string|null, mode?: 'file'|'focus', edit?: boolean}} view
   */
  setView({ folderId, focusId, mode, edit } = {}) {
    if (folderId !== undefined) state.folderId = folderId ?? null;
    if (focusId !== undefined) state.focusId = focusId ?? null;
    if (mode !== undefined) state.mode = mode;
    if (edit !== undefined) state.edit = Boolean(edit);
    notify();
  },

  /**
   * Toggle Edit Mode without changing the route.
   * @param {boolean} on
   */
  setEditMode(on) {
    state.edit = Boolean(on);
    notify();
  },

  /**
   * Record a failure that the view should surface (a banner).
   * @param {Error} error
   */
  reportError(error) {
    state.error = error ?? null;
    if (error && state.pending === 0) state.status = 'error';
    notify();
  },

  /**
   * Clear the recorded failure.
   */
  clearError() {
    state.error = null;
    if (state.status === 'error') state.status = 'idle';
    notify();
  },

  /**
   * Record a notice the view should surface (a neutral banner).
   * @param {string|null} message
   */
  reportNotice(message) {
    state.notice = message ? String(message) : null;
    notify();
  },

  /**
   * Clear the recorded notice.
   */
  clearNotice() {
    state.notice = null;
    notify();
  },

  /**
   * The last notice, if any.
   * @returns {string|null}
   */
  getNotice() {
    return state.notice;
  },

  /* -- mutate ----------------------------------------------------------- */

  /**
   * Load the whole tree (the spine reads it in one request).
   * @returns {Promise<object[]>}
   */
  async loadTree() {
    state.error = null;
    beginRequest();
    notify();

    let failure = null;
    try {
      const nodes = await api.getTree();
      state.treeById = new Map(nodes.map((node) => [node.id, node]));
    } catch (err) {
      state.error = err;
      failure = err;
    }

    endRequest(failure);
    notify();
    return orderedTree();
  },

  /**
   * Load one level.
   * @param {string|null} parentId `null` for the root level
   * @returns {Promise<object[]>}
   */
  async loadLevel(parentId) {
    state.error = null;
    beginRequest();
    notify();

    let nodes = [];
    let failure = null;
    try {
      nodes = await api.listChildren(parentId);
      state.levelCache.set(levelKey(parentId), nodes);
      for (const node of nodes) state.treeById.set(node.id, node);
    } catch (err) {
      state.error = err;
      failure = err;
    }

    endRequest(failure);
    notify();
    return nodes;
  },

  /**
   * Create a node. It lands in the level cache and in the tree cache.
   * @param {{parentId?: string|null, kind: 'folder'|'card', title: string, body?: string, answer?: string}} input
   * @returns {Promise<object>} the created node
   */
  async createNode({ parentId = null, kind, title, body = '', answer = '' }) {
    const node = await api.create({ parentId, kind, title, body, answer });

    state.treeById.set(node.id, node);

    const key = levelKey(parentId);
    const level = state.levelCache.get(key);
    if (level) {
      const next = level.filter((entry) => entry.id !== node.id);
      next.push(node);
      next.sort(compareLevel);
      state.levelCache.set(key, next);
    }

    notify();
    return node;
  },

  /**
   * Update a node's fields.
   * @param {string} id
   * @param {{title?: string, body?: string, answer?: string}} patch
   * @returns {Promise<object>} the updated node
   */
  async updateNode(id, patch) {
    const node = await api.update(id, patch);

    state.treeById.set(node.id, node);

    for (const [key, level] of state.levelCache) {
      if (!level.some((entry) => entry.id === node.id)) continue;
      state.levelCache.set(
        key,
        level.map((entry) => (entry.id === node.id ? node : entry)),
      );
    }

    notify();
    return node;
  },

  /**
   * Hard-delete a node. The node and its descendants leave both caches.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleteNode(id) {
    await api.remove(id);

    const removed = subtreeIds(id);
    removed.add(id);

    for (const removedId of removed) state.treeById.delete(removedId);

    for (const [key, level] of state.levelCache) {
      state.levelCache.set(key, level.filter((entry) => !removed.has(entry.id)));
    }

    if (state.focusId && removed.has(state.focusId)) state.focusId = null;

    notify();
  },

  /**
   * Move a node into another folder.
   * @param {string} id
   * @param {string|null} parentId
   * @returns {Promise<object>} the moved node
   */
  async moveNode(id, parentId) {
    // The parent before the move — the server renumbers the source level.
    const previousParentId = state.treeById.get(id)?.parentId ?? null;
    const node = await api.update(id, { parentId: parentId ?? null });

    state.treeById.set(node.id, node);

    const targetKey = levelKey(parentId);
    const targetLevel = state.levelCache.get(targetKey);
    if (targetLevel) {
      const next = targetLevel.filter((entry) => entry.id !== node.id);
      next.push(node);
      next.sort(compareLevel);
      state.levelCache.set(targetKey, next);
    }

    // The source level is now missing the node; the server keeps it contiguous.
    const sourceKey = levelKey(previousParentId);
    const sourceLevel = state.levelCache.get(sourceKey);
    if (sourceLevel && sourceKey !== targetKey) {
      state.levelCache.set(
        sourceKey,
        sourceLevel.filter((entry) => entry.id !== node.id),
      );
    }

    notify();
    return node;
  },

  /**
   * Replace the order of a level.
   * @param {string|null} parentId
   * @param {string[]} orderedIds
   * @returns {Promise<object[]>} the rewritten level
   */
  async reorderLevel(parentId, orderedIds) {
    const nodes = await api.reorder(parentId, orderedIds);

    state.levelCache.set(levelKey(parentId), nodes);
    for (const node of nodes) state.treeById.set(node.id, node);

    notify();
    return nodes;
  },

  /* -- notify ----------------------------------------------------------- */

  /**
   * Subscribe to every state change.
   * @param {() => void} fn
   * @returns {() => void} the unsubscribe function
   */
  subscribe(fn) {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  },
};

export default store;
