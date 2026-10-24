/**
 * RecallLab — the API client (build contracts §4.1).
 *
 * This is the ONLY module in the client that calls `fetch`. Every method
 * resolves with the unwrapped payload (a `Node`, a `Node[]`, or `void`) and
 * rejects with an `ApiError` on any non-2xx response.
 *
 * The server's error shape is `{ error: { code, message } }` (contracts §3.3);
 * a body that does not match that shape degrades to a generic message rather
 * than throwing a parse error.
 *
 * Source of truth:
 *   docs/specs/2026-10-24-recalllab-contracts.md  §3 REST API, §4.1 api.js
 *   server/routes/nodes.js                          the real endpoints
 */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const API_BASE = '/api';

/**
 * Perform one request and unwrap it.
 *
 * @param {string} path path below `/api`
 * @param {{method?: string, body?: unknown}} [options]
 * @returns {Promise<any>} the parsed payload, or `undefined` for an empty body
 */
async function request(path, { method = 'GET', body } = {}) {
  let response;

  try {
    response = await fetch(API_BASE + path, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // A network-level failure (offline, DNS, the server is down) has no HTTP
    // status, so the status is 0 and the code names the condition.
    throw new ApiError(0, 'network_error', 'The server could not be reached.');
  }

  if (!response.ok) {
    let code = 'internal_error';
    let message = `Request failed with status ${response.status}.`;

    try {
      const payload = await response.json();
      if (payload && payload.error) {
        if (typeof payload.error.code === 'string') code = payload.error.code;
        if (typeof payload.error.message === 'string') message = payload.error.message;
      }
    } catch {
      // The error body was not the documented JSON shape; keep the defaults.
    }

    throw new ApiError(response.status, code, message);
  }

  // DELETE answers 204 with an empty body.
  if (response.status === 204) return undefined;

  const text = await response.text();
  if (!text) return undefined;

  return JSON.parse(text);
}

/** `null`, `''` and the literal `'root'` all mean the root level. */
function parentParam(parentId) {
  if (parentId === null || parentId === undefined || parentId === '' || parentId === 'root') {
    return 'root';
  }
  return String(parentId);
}

export const api = {
  /**
   * The children of one level.
   * @param {string|null} parentId `null` for the root level
   * @returns {Promise<object[]>}
   */
  async listChildren(parentId) {
    const payload = await request(`/nodes?parent=${encodeURIComponent(parentParam(parentId))}`);
    return payload?.nodes ?? [];
  },

  /**
   * One node.
   * @param {string} id
   * @returns {Promise<object>}
   */
  async getNode(id) {
    const payload = await request(`/nodes/${encodeURIComponent(id)}`);
    return payload.node;
  },

  /**
   * The root-first ancestor chain of a node, the node itself excluded.
   * @param {string} id
   * @returns {Promise<object[]>}
   */
  async getPath(id) {
    const payload = await request(`/nodes/${encodeURIComponent(id)}/path`);
    return payload?.path ?? [];
  },

  /**
   * The whole tree, flat.
   * @returns {Promise<object[]>}
   */
  async getTree() {
    const payload = await request('/tree');
    return payload?.nodes ?? [];
  },

  /**
   * Create a node.
   * @param {{parentId?: string|null, kind: 'folder'|'card', title: string, body?: string, answer?: string}} input
   * @returns {Promise<object>} the created node
   */
  async create({ parentId = null, kind, title, body = '', answer = '' }) {
    const payload = await request('/nodes', {
      method: 'POST',
      body: { parentId: parentId ?? null, kind, title, body, answer },
    });
    return payload.node;
  },

  /**
   * Update fields and/or move a node.
   * @param {string} id
   * @param {{title?: string, body?: string, answer?: string, parentId?: string|null}} patch
   * @returns {Promise<object>} the updated node
   */
  async update(id, patch) {
    const payload = await request(`/nodes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: patch ?? {},
    });
    return payload.node;
  },

  /**
   * Hard-delete a node and its subtree.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    await request(`/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return undefined;
  },

  /**
   * Replace the order of a level.
   * @param {string|null} parentId
   * @param {string[]} orderedIds
   * @returns {Promise<object[]>} the rewritten level
   */
  async reorder(parentId, orderedIds) {
    const payload = await request('/nodes/reorder', {
      method: 'POST',
      body: { parentId: parentId ?? null, orderedIds: [...(orderedIds ?? [])] },
    });
    return payload?.nodes ?? [];
  },

  /**
   * Liveness + database check.
   * @returns {Promise<{ok: boolean, db: string, mode: string}>}
   */
  async health() {
    return await request('/health');
  },
};

export default api;
