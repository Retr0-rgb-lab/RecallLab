# RecallLab — Build Contracts

> **Status** — Authoritative. 2026-10-24.
> **Purpose** — This file is the *interface* between parallel build agents. The design spec
> ([`2026-10-24-recalllab-design.md`](./2026-10-24-recalllab-design.md)) defines **what** to build and
> **why**; this file defines **exactly how the pieces fit together**, so that agents with disjoint file
> ownership can work in parallel without integration surprises.
> **Rule** — If this file and the design spec disagree, the design spec wins and this file must be
> amended in the same change. If this file and an agent's own judgment disagree, this file wins unless
> the agent raises the conflict first.

---

## 1. Repository layout and file ownership

**Every file below has exactly one owner. No agent may create or modify a file it does not own.**
Unlisted files (root config, this document) are owned by the integrator.

```
RecallLab/
├── package.json                    [integrator]
├── server.js                       [integrator]  ← Vercel entry (see §2.2)
├── vercel.json                     [integrator]
├── .gitignore                      [integrator]
├── .env.example                    [integrator]
├── README.md                       [agent-docs]
├── scripts/
│   ├── deploy.sh                   [agent-docs]
│   └── verify.sh                   [agent-docs]
├── server/                         [agent-api]  ← exclusive subtree
│   ├── index.js
│   ├── app.js
│   ├── shell.js
│   ├── db/
│   │   ├── client.js
│   │   ├── schema.sql
│   │   ├── queries.js
│   │   └── seed.js
│   └── routes/
│       └── nodes.js
├── public/                         ← shared root, per-file ownership below
│   ├── index.html                  [agent-file]
│   ├── styles/
│   │   ├── base.css                [agent-design]
│   │   ├── tokens.css              [agent-design]
│   │   ├── layout.css              [agent-design]
│   │   ├── stage.css               [agent-focus]
│   │   └── edit.css                [agent-edit]
│   ├── js/
│   │   ├── api.js                  [agent-file]
│   │   ├── store.js                [agent-file]
│   │   ├── main.js                 [agent-file]
│   │   ├── filepage.js             [agent-file]
│   │   ├── focus.js                [agent-focus]
│   │   ├── gestures.js             [agent-focus]
│   │   └── edit.js                 [agent-edit]
│   └── fonts/                      [agent-design]
│       ├── geist-latin-{400,500,600}.woff2
│       └── geist-mono-latin-400.woff2
└── tests/                          ← shared dir, per-file ownership
    ├── api.test.js                 [agent-api]
    ├── gestures.test.js            [agent-focus]
    ├── focus.test.js               [agent-focus]
    └── edit.test.js                [agent-edit]
```

---

## 2. Runtime, scripts, dependencies

- **Node** ≥ 20 (this machine: v22.22.2). ES modules throughout (`"type": "module"` in `package.json`).
- **Root `package.json`** (integrator-owned, already written):
  - `"start": "node server/index.js"` — production entry, must `export default app` for Vercel.
  - `"dev": "node --watch server/index.js"`
  - `"seed": "node server/db/seed.js"`
  - `"test": "node --test tests/"`
- **Runtime dependencies (only these):** `express` (^5.x), `pg` (^8.x). Nothing else in `dependencies`.
- **Dev dependencies (only these):** `pg-mem` (^3.x).
  - `pg-mem` is an **in-memory Postgres for Node**. It exists so the whole app can boot and be tested
    with zero external services. It is a *development* dependency and must never be imported from
    `server/` code paths that run in production.

### 2.1 Database access rule (hard)

```
if (process.env.DATABASE_URL) -> real Postgres via `pg` (production, and any deployment)
else                          -> pg-mem adapter with the identical query surface (development only)
```

- `server/db/client.js` exports **one** function, `query(text, params) -> Promise<rows>`, plus
  `withTransaction(fn) -> Promise<result>`. The route layer only ever calls those two. It must never
  import `pg` or `pg-mem` directly.
- `pg-mem` does not support everything Postgres does. To keep both paths working, the design fixes
  these choices:
  - **UUIDs are generated in the application**, via `crypto.randomUUID()`. The schema has no
    `gen_random_uuid()` default and no `pgcrypto` extension.
  - **Timestamps are set in the application** (`new Date().toISOString()`). The schema keeps
    `default now()` on `created_at` for production hygiene, but the app always passes the value.
  - **Cascade delete is performed by the application**, not by `ON DELETE CASCADE`. The server collects
    the descendant id set and deletes it inside one transaction. The schema still declares
    `ON DELETE CASCADE` as a production safety net (the app deletes children first, so the database
    cascade then finds nothing left to remove).
  - **The ancestor path is walked in JavaScript** with a bounded loop (max 64 hops), not with a
    `WITH RECURSIVE` CTE.
  - No `pg-mem`-unsupported features: no arrays, no JSONB operators, no full-text search, no
    `generated` columns, no `ON CONFLICT ... DO UPDATE` with complex targets.

### 2.2 Vercel entry point and deployment shape (hard)

Vercel's Express framework preset only auto-detects the app at these paths:
`app.js`, `index.js`, `server.js`, `src/app.js`, `src/index.js`, `src/server.js`
(**a file named `server.js` inside `src/` — not a `server/` directory**).

Therefore:

- **Root `server.js`** is the Vercel entry point. It is the only file Vercel traces. It must be:
  ```js
  import app from './server/app.js';
  export default app;
  ```
  (a default export, or a port listener — Vercel accepts either).
- `server/index.js` is the **local** entry: it imports `./app.js` and calls `app.listen(PORT)`.
- `server/app.js` builds and exports the Express app. It must contain **no** `listen()` call.
- `server/shell.js` exports the SPA shell HTML, loaded at module load with
  `fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')`. The
  `new URL(..., import.meta.url)` form is deliberate: it is the pattern Vercel's file tracer
  understands, so the shell is guaranteed to be inside the deployed function bundle. Wrap the read in
  `try/catch` and fall back to a minimal inline HTML string that says the shell is missing — never let
  a failed read crash the process at boot.

**An explicit error-handling middleware is mandatory.** Vercel's documentation is explicit: Express
swallows errors and renders its own 500, which can stop Vercel from recycling the function and reset
its state. The last middleware in the chain must therefore be:

```js
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
});
```

**Static assets.** Files in `public/**` are served by Vercel's CDN. `express.static()` is ignored by
Vercel but must still be used for local development and for the Render/Fly deployment path.

**SPA fallback.** `vercel.json` contains a rewrite that sends every non-API path to `/index.html`:

```json
{ "source": "/((?!api(?:/|$)).*)", "destination": "/index.html" }
```

Express *also* has a catch-all that returns the shell, which is what makes the app work on
Render/Fly and in local development. The two mechanisms are belt-and-braces; neither may be removed.

**Local development should use `vercel dev`**, not `node server/index.js`, because `vercel dev`
serves the app the way production does — including cron routes and the rewrite rules.

---

## 3. REST API contract (authoritative)

Base path `/api`. Request and response bodies are `application/json; charset=utf-8`.
`DELETE` returns `204` with an empty body. All other errors return the error shape in §3.3.

### 3.1 Endpoints

| Method | Path | Query / Body | Success |
|---|---|---|---|
| `GET` | `/api/nodes` | `?parent=<uuid>` — **omitted or empty = root level** | `200` `{ "nodes": Node[] }` |
| `GET` | `/api/nodes/:id` | — | `200` `{ "node": Node }` |
| `GET` | `/api/nodes/:id/path` | — | `200` `{ "path": Node[] }` — root-first ancestor chain, **excluding** the node itself |
| `GET` | `/api/tree` | — | `200` `{ "nodes": Node[] }` — every node, flat |
| `POST` | `/api/nodes` | `{ parentId, kind, title, body?, answer? }` | `201` + `Location: /api/nodes/<id>` header + `{ "node": Node }` |
| `PUT` | `/api/nodes/:id` | `{ title?, body?, answer?, parentId? }` | `200` `{ "node": Node }` |
| `DELETE` | `/api/nodes/:id` | — | `204` |
| `POST` | `/api/nodes/reorder` | `{ parentId, orderedIds: uuid[] }` | `200` `{ "nodes": Node[] }` — the rewritten level |
| `GET` | `/api/health` | — | `200` `{ "ok": true, "db": "up", "mode": "postgres" \| "memory" }` |

`parentId` is `null` (JSON `null`) for the root level. The server also accepts the literal string
`"root"` and the query parameter `parent=root` as root, because the client uses `?parent=root`.

### 3.2 Node shape

```jsonc
{
  "id": "0f0c1f2e-...",           // uuid, generated server-side
  "parentId": "uuid" | null,      // null = root level
  "kind": "folder" | "card",
  "title": "string",              // trimmed, non-empty
  "body": "string",               // "" for folders; card prompt/content
  "answer": "string",             // "" for folders; card answer
  "position": 0,                  // integer, unique within the level, contiguous from 0
  "createdAt": "2026-10-24T08:00:00.000Z",
  "updatedAt": "2026-10-24T08:00:00.000Z"
}
```

**Level ordering (server-enforced, the client renders whatever order it receives):**
folders first, then cards; within each group by `position` ascending.

### 3.3 Error shape

```jsonc
{ "error": { "code": "invalid_move", "message": "A folder cannot be moved into itself." } }
```

| `code` | HTTP | Condition |
|---|---|---|
| `invalid_request` | 400 | Malformed JSON, missing required field, bad query |
| `not_found` | 404 | No node with that id |
| `invalid_move` | 409 | Move into self or own descendant |
| `duplicate_title` | 409 | A sibling with the same title (trimmed, case-insensitive) already exists |
| `validation_failed` | 422 | Empty title; `body`/`answer` non-empty on a folder; creating a child under a card; `parentId` pointing at a card |
| `internal_error` | 500 | Anything unexpected (logged server-side, generic message to the client) |

### 3.4 Server-enforced invariants

1. `title` is non-empty after trimming.
2. A folder has empty `body` and `answer`.
3. A card has no children. `POST /api/nodes` with a `parentId` that is a card → `422`.
4. `parentId` must reference a **folder** or be `null`.
5. A node cannot be moved into itself or into its own descendant → `409 invalid_move`.
6. Sibling titles are unique (trimmed, case-insensitive) → `409 duplicate_title`.
7. `DELETE` on a folder removes its whole subtree, in one transaction.

---

## 4. Client module contracts (authoritative)

All front-end modules are ES modules loaded with `<script type="module" src="/js/main.js">`.
No bundler, no framework, no `node_modules` in the browser.

### 4.1 `js/api.js` — owned by agent-file

```js
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export const api = {
  async listChildren(parentId) {},        // parentId: string | null
  async getNode(id) {},
  async getPath(id) {},                   // -> Node[]
  async getTree() {},                     // -> Node[]
  async create({ parentId, kind, title, body, answer }) {},
  async update(id, patch) {},
  async remove(id) {},                    // -> void
  async reorder(parentId, orderedIds) {}, // -> Node[]
  async health() {},
};
```

Every method resolves with the unwrapped payload (`Node`, `Node[]`, or `void`) and **rejects with
`ApiError`** on any non-2xx response. `api.js` is the only module that calls `fetch`.

### 4.2 `js/store.js` — owned by agent-file

Single source of truth for client state. Exports:

```js
export const store = {
  // read
  getTree(),                 // -> Node[]  (whole tree, flat)
  getLevel(),               // -> Node[]  (children of the current folder)
  getNode(id),              // -> Node | undefined
  getChildren(parentId),     // -> Node[]
  getMode(),                // -> 'file' | 'focus'
  isEditMode(),             // -> boolean
  getFocusId(),             // -> string | null
  getCurrentFolderId(),     // -> string | null  (null = root)

  // mutate (each performs the API call, updates the cache, then notifies subscribers)
  async loadTree(),
  async loadLevel(parentId),
  async createNode({ parentId, kind, title, body, answer }),
  async updateNode(id, patch),
  async deleteNode(id),
  async moveNode(id, parentId),
  async reorderLevel(parentId, orderedIds),

  // notify
  subscribe(fn),            // -> unsubscribe fn
};
```

- `store.js` **owns** all network mutation and cache updates. It imports from `api.js` only.
- After any mutation, `store` updates its caches and calls all subscribers.
- `store.js` must not import `filepage.js`, `focus.js`, or `edit.js` (those import `store.js`).
- Circular imports are forbidden.

### 4.3 `js/main.js` — owned by agent-file

Bootstrap + router entry point. Also exports, for the other modules:

```js
export const router = {
  navigate(path, { replace = false } = {}),  // pushState or replaceState + dispatch
  current(),                                 // -> { path, params, query }
};
```

Routing table (design spec §7.2):

| URL | State |
|---|---|
| `/` | File page, root level |
| `/f/:folderId` | File page at that folder |
| `/f/:folderId?focus=:nodeId` | Focus Mode on that node |
| `/f/:folderId?focus=:nodeId&edit=1` | Edit Mode overlay on Focus Mode |
| `/f/:folderId?edit=1` | Edit Mode overlay on the file page |

- `main.js` handles `popstate`, resolves the URL into state, and drives `store` + the view modules.
- `main.js` is the **only** module that writes to `location` / reads `location.pathname`.

### 4.4 `js/filepage.js` — owned by agent-file

```js
export function mountFilePage(root) {}   // root = the #grid container
export function unmountFilePage() {}
```

### 4.5 `js/focus.js` — owned by agent-focus

```js
export const focus = {
  isActive(),                    // -> boolean
  enter(nodeId),                 // focus a node within the current level; mounts the stage
  exit(),                        // leave Focus Mode, unmount the stage
  getFocusedId(),                // -> string | null
  advance(delta),                // -> move focus by delta within the level
  toggleReveal(),                // -> flip the focused card
  getFloatingWindows(),          // -> [{ id, x, y, width, height }]
  closeTopFloatingWindow(),
};
```

`focus.js` owns the **stage DOM** and the **PiP state machine** (design spec §4.2.6). It imports
`store.js` and `gestures.js`. It must **not** import `edit.js`; instead it exposes the DOM hooks that
`edit.js` needs (§5).

### 4.6 `js/gestures.js` — owned by agent-focus

A reusable pointer state machine. Exports:

```js
export const GESTURE = Object.freeze({
  HOLD_MS: 450,          // hold duration that lifts a card into a floating window
  DRAG_THRESHOLD_PX: 56,  // displacement that classifies a gesture as a drag
  HOLD_SLOP_PX: 8,       // max movement allowed during the hold
  FLICK_VELOCITY: 0.35,  // px/ms, release velocity that classifies a throw
});

export function attachCardGestures(el, handlers) {}
```

`handlers` contract:

| Callback | When | Payload |
|---|---|---|
| `onTap(el)` | pointerup with displacement < `DRAG_THRESHOLD_PX` and no hold | — |
| `onDragStart(el, ev)` | displacement crosses `DRAG_THRESHOLD_PX` | pointer event |
| `onDragMove(el, dx, dy, ev)` | every pointermove while dragging | raw deltas from the press origin |
| `onDragEnd(el, info)` | pointerup while dragging | `{ dx, dy, vx, vy, flick }` — `vx`/`vy` in px/ms |
| `onHold(el)` | held `HOLD_MS` with movement < `HOLD_SLOP_PX` | — |

Rules (design spec §4.2.6):
1. **During a drag no CSS transition may be active.** The owner must remove transitions while
   dragging (a `dragging` class that sets `transition: none`) and restore them afterwards.
2. `onHold` fires only when the pointer has moved less than `HOLD_SLOP_PX`.
3. Velocity is measured over the last ~80ms of movement, in px/ms.
4. Use Pointer Events (`pointerdown`/`pointermove`/`pointerup`/`pointercancel`) with
   `setPointerCapture`. Do **not** use mouse events.
5. `touch-action: none` on draggable elements so the browser does not steal the gesture.

### 4.7 `js/edit.js` — owned by agent-edit

```js
export const edit = {
  isActive(),                 // -> boolean
  setActive(on),             // toggle Edit Mode
  refresh(),                  // re-render inline editors after a store change
};
```

`edit.js` owns all mutation UI and imports `store.js` and `api.js`.

---

## 5. DOM registry (authoritative)

`public/index.html` (agent-file) provides exactly this structure. Other agents **mount into** the
placeholders; they must not restructure the page.

```html
<body>
  <div id="app">
    <aside id="spine" aria-label="Outline">
      <div id="spine-tree"></div>
    </aside>
    <main id="main">
      <header id="toolbar">
        <nav id="breadcrumb" aria-label="Breadcrumb"></nav>
        <div id="toolbar-actions">
          <!-- agent-file renders: Edit toggle, Focus entry -->
        </div>
      </header>
      <div id="content">
        <ul id="grid" class="grid"></ul>       <!-- file page level grid -->
        <div id="stage-root"></div>             <!-- focus mode mounts here -->
      </div>
    </main>
  </div>
</body>
```

### 5.1 Tile markup — rendered by `filepage.js`

```html
<li class="tile" data-id="<uuid>" data-kind="folder|card" tabindex="0" role="button">
  <div class="tile-icon" aria-hidden="true"><svg …></svg></div>
  <div class="tile-title">Title</div>
  <div class="tile-preview">first line of body, cards only</div>
</li>
```

### 5.2 Stage markup — rendered by `focus.js` into `#stage-root`

```html
<div class="stage" id="stage">
  <div class="stage-stack">
    <article class="stage-card" data-id="<uuid>" data-depth="0">
      <div class="stage-card-inner">
        <div class="stage-card-face stage-card-front">
          <h2 class="stage-card-title"></h2>
          <div class="stage-card-body"></div>
        </div>
        <div class="stage-card-face stage-card-back">
          <div class="stage-card-answer"></div>
        </div>
      </div>
    </article>
    <!-- deeper siblings: .stage-card with data-depth="1".."3" -->
  </div>
  <div class="stage-pips"></div>   <!-- floating windows mount here -->
</div>
```

Floating window markup:

```html
<div class="pip" data-id="<uuid>" style="transform: translate(x, y)">
  <div class="pip-header"><span class="pip-title"></span></div>
  <div class="pip-body"></div>
</div>
```

### 5.3 Edit-mode hooks — consumed by `edit.js`

`edit.js` must not need to restructure `index.html`. It targets elements by these hooks:

| Hook | Selector | Owner |
|---|---|---|
| Editable title | `[data-edit="title"]` | agent-file / agent-focus render it inside tiles and stage cards |
| Editable body | `[data-edit="body"]` | same |
| Editable answer | `[data-edit="answer"]` | same |
| Create control | `#action-create` | agent-file renders it in `#toolbar-actions` |
| Delete control | `[data-action="delete"]` | agent-file / agent-focus render it per node |

`edit.js` turns those hooks into real inputs; it does not create the hooks.

---

## 6. CSS tokens (authoritative)

`public/styles/tokens.css` (agent-design) declares exactly the custom properties in
[`2026-10-24-recalllab-visual-system.md`](./2026-10-24-recalllab-visual-system.md) §8 "Quick
reference" — both registers (`:root` for browse, `[data-register="stage"]` for focus) — plus:

- `--t-hover: 120ms`, `--t-focus-ring: 160ms`, `--t-flip: 320ms`, `--t-move: 320ms`,
  `--t-mode: 420ms`
- `--hold-ms: 450`, `--drag-threshold-px: 56`, `--flick-velocity: .35`
- `--e0`…`--e3` shadow ladder, both registers

**Type tokens are SIZES, not `font` shorthands.** A `--t-*` token must resolve to something
substitutable into `font-size`. The type scale therefore ships each step as a size plus
companions: `--t-<step>` (size), `--lh-<step>` (line-height), `--fw-<step>` (font-weight),
`--track-<step>` (letter-spacing). A `--t-*` declared as a `font` shorthand is **invalid** in
`font-size: var(--t-*)` and silently falls back — this exact collision occurred during the first
build wave and was caught by cross-file inspection. Never declare a type token as a shorthand.

`stage.css` and `edit.css` **must not redefine** these variables. They may only consume them.

Additional register switch: the root element carries `data-register="stage"` while Focus Mode is
active and `data-register="browse"` otherwise. `stage.css` may rely on this to switch surfaces.

---

## 7. Fonts

- `public/fonts/geist-latin-{400,500,600}.woff2` and `geist-mono-latin-400.woff2`.
- Latin subset only. Each file ≤ 40KB. Latin subset only; **no CJK webfont** — CJK uses the system
  stack (`PingFang SC`, `Hiragino Sans GB`, `Microsoft YaHei`, `Noto Sans SC`).
- `@font-face` with `font-display: swap`, declared in `tokens.css`.
- The CSS font stack must fall back gracefully if a woff2 is missing:
  `"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif`
  and `"Geist Mono", ui-monospace, "SFMono-Regular", Menlo, monospace`.
- If the woff2 files cannot be downloaded, keep the fallbacks and record it in the README. Do not
  block the build on it, and do not hotlink a CDN at runtime.

---

## 8. Constants (authoritative — copy these values, do not re-derive them)

| Constant | Value | Where |
|---|---|---|
| PiP hold | 450 ms | `gestures.js` |
| Drag threshold | 56 px | `gestures.js` |
| Hold slop | 8 px | `gestures.js` |
| Flick velocity | 0.35 px/ms | `gestures.js` |
| Focused card width | `min(720px, 100vw - 96px)` | `stage.css` |
| Focused card min height | 320 px | `stage.css` |
| Stack layer offsets | 0 / 12 / 24 / 36 px | `stage.css` |
| Stack layer scales | 1.000 / 0.975 / 0.950 / 0.925 | `stage.css` |
| Stack max visible layers | 4 (focus + 3) | `focus.js` |
| PiP width | `min(440px, max(320px, 100vw * 0.34))` | `focus.js` + `stage.css` |
| PiP height | `min(300px, max(220px, width * 0.68))` | `focus.js` + `stage.css` |
| PiP dock gap above focused card | 16 px | `focus.js` |
| PiP viewport clamp margin | 16 px | `focus.js` |
| Tile grid | `repeat(auto-fill, minmax(220px, 1fr))`, gap 16px | `layout.css` |
| Spine width | 240 px, collapsible to 0 | `layout.css` |
| Breadcrumb bar height | 48 px | `layout.css` |
| Content max width | 1400 px | `layout.css` |

---

## 9. Accessibility requirements (binding)

- Every tile is keyboard reachable and activatable (`tabindex="0"`, `role="button"`, Enter/Space).
- The focused stage card announces its title via an `aria-live="polite"` region.
- Focus ring: 2px `var(--accent)` at 2px offset, on `:focus-visible`.
- No function may be reachable only by dragging. Every drag gesture has a keyboard equivalent
  (arrows move focus, Enter/Space reveal, Esc ascends).
- `prefers-reduced-motion: reduce` replaces every spring/flip with a 120ms opacity cross-fade.
- All interactive elements ≥ 44×44px on coarse pointers.
- Body text ≥ 7:1 contrast; secondary text ≥ 4.5:1. The accent is never used for body text on a
  light surface.

---

## 10. Definition of done

An owner is done when:

1. Every file it owns exists, contains no `TODO`/`FIXME`/placeholder, and is committed.
2. Its unit of work is demonstrably working, not merely written. Evidence is required.
3. It has not modified a file owned by another owner. If it believes another owner's file must
   change, it reports the required change instead of making it.
4. It has reported: files changed, how to run it, what was verified, and what remains unverified.

**Never present a plan as a completed result.** A feature that is written but not exercised is not
done.
