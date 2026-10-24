# RecallLab

RecallLab is a spatial recall reader for structured course material. The material is a tree of
folders and cards; a card carries a prompt on its face and an answer on its back. You browse the
tree like a file system, then drop into **Focus Mode**, where the screen narrows to one card at a
time and the tree itself becomes the navigation. The hierarchy is the retrieval cue: instead of
shuffling a deck, you move through a structure you can see, and deciding what to drag away, pull
out, or drill into is the act of deciding what you actually remember.

Three functions make up the product:

- **Hierarchical browsing** — the file page: a spine showing the whole tree, a breadcrumb, and a
  tiled grid of the current level.
- **Focus Mode** — a stage with one card in the light and its siblings stacked behind it.
- **Tree editing** — Edit Mode: create, rename, move, reorder, and delete any node in the tree.

---

## Features

### File page (browse)

- **Spine** — the whole tree, indented, with the current path highlighted.
- **Breadcrumb** — the path to the current level; every ancestor segment is clickable.
- **Tiled grid** — the children of the current level. Folders sort before cards, then by position.
  Each tile shows a kind icon (inline SVG), the title, and a one-line preview of a card's body.
- Clicking a folder navigates down (`pushState` to `/f/<id>`); clicking a card opens it in Focus
  Mode; browser back and forward restore the previous level.

### Focus Mode

- **Reveal** — click the focused card and it flips to show the answer. Click again to flip back.
- **Drag to advance** — drag the card more than 56px and it leaves with the velocity of the
  gesture; the next sibling rises into focus. Release below the threshold and the card springs
  back.
- **Hold to float** — press and hold 450ms and the card lifts out of the stack into a draggable
  floating window; focus moves to the next sibling.
- **Drill down** — focusing a folder and activating it descends into that folder. `Esc` ascends.
- Keyboard: `↑`/`↓` move between siblings, `Enter`/`Space` flips the card, `Esc` closes a floating
  window, then ascends a level, then exits Focus Mode.

Focus Mode records nothing. There is no score, no review history, and no scheduling.

### Edit Mode

An overlay over the file page or over Focus Mode, toggled with the **Edit** button in the toolbar
next to the breadcrumb.

- Create a folder or a card in the level on screen.
- Rename any node; edit a card's body and answer inline.
- Delete — a hard delete, behind a confirmation that names the node and counts its descendants.
  Deleting a folder removes its whole subtree in one transaction.
- Move a node into another folder by dropping it on a folder tile.
- Reorder a level by dragging a tile to a new index.

The server enforces the invariants: a non-empty title, folders carry no body or answer, cards have
no children, a node cannot be moved into itself or its own descendant, and sibling titles are
unique (trimmed, case-insensitive).

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Front end | Vanilla HTML, CSS, ES modules | No framework, no bundler, no build step. `public/js/*.js` load as `<script type="module">` |
| Server | Node.js ≥ 20, Express 5 | One app in `server/app.js`. The root `server.js` is the Vercel entry point |
| Database | PostgreSQL through the `pg` driver | `server/db/client.js` is the only module that talks to the database |
| Hosting | Vercel | One serverless function for the API; `public/**` is served from the CDN |
| Database hosting | Supabase (free tier) | Used strictly as Postgres. The browser never talks to Supabase — only the server does |
| Development fallback | pg-mem | An in-memory Postgres, used only when `DATABASE_URL` is unset |

---

## Prerequisites

- **Node.js ≥ 20** (`engines` in `package.json`; developed and verified on v22.22.2) and npm.
- **A Supabase project** — the free tier is enough — for the connection string.
- **The Vercel CLI**, for deployment only: `npm i -g vercel`. On this machine it is already
  installed at `C:\Users\Lenovo\AppData\Roaming\npm\vercel`, which WSL sees at
  `/mnt/c/Users/Lenovo/AppData/Roaming/npm/vercel`.
- **curl**, for the smoke test.

---

## Setup

```bash
npm install
cp .env.example .env      # optional — only to point at a real database
npm start                 # http://localhost:3000
```

| Command | What it runs |
|---|---|
| `npm start` | `node server/index.js` — the local server |
| `npm run dev` | `node --watch server/index.js` — the same, restarting on change |
| `npm run seed` | `node server/db/seed.js` — applies the COMP3421 tree to `DATABASE_URL` |
| `npm test` | `node --test` — the test suite |

### Local development

There are two ways to run the app, and they differ in what they do with the database.

**Without `DATABASE_URL` (the default).** The app boots on pg-mem, an in-memory Postgres, and
seeds the COMP3421 tree automatically at boot — 26 nodes, the real course structure rather than
"Folder 1 / Card 1". The data is discarded when the process exits and the next boot starts from a
fresh copy. No external service, no configuration.

**With `DATABASE_URL`.** The app boots on real Postgres through `pg`. **Postgres mode does not
seed itself.** Run `npm run seed` once against that database, or the tree is empty. The `nodes`
table comes from `server/db/schema.sql`, which is written to be idempotent (`create table if not
exists`) and is applied by the server on first connect, so the table is created on boot even
against a fresh database. `scripts/deploy.sh` applies it too, before seeding.

**`vercel dev` is the preferred way to run the app locally.** It serves the app the way production
does — with the rewrite rule and the cron route in place — instead of the bare Express app.
`npm start` is the zero-dependency fallback. (`vercel dev` has not been run for this README; there
are no Vercel credentials on the development machine.)

A first boot can take tens of seconds when `node_modules` sits on a Windows-mounted drive under
WSL: the module loader is I/O-bound there. It is not a hang — wait for
`[recalllab] listening on http://localhost:3000`.

### Environment variables

Copy `.env.example` to `.env` (it is git-ignored) or export the variables:

```bash
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
CRON_SECRET=
PORT=3000
```

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | Server only | The Postgres connection string. Never bundled into client code, never exposed to the browser |
| `CRON_SECRET` | Server only | Authenticates cron calls to `GET /api/health` |
| `PORT` | Server only | The port of the local server. Defaults to 3000 |

**`DATABASE_URL` must be the pooler URL — transaction mode, port 6543 — for a serverless
deployment.** Every function instance opens its own connection, and the pooler is what keeps the
connection count inside Supabase's limit. `server/db/client.js` configures the pool with `max: 1`
per instance for the same reason.

The **direct URL (port 5432) is the documented fallback**: if a deployed query fails with a
prepared-statement error, switch `DATABASE_URL` to the direct connection and raise `max` to 2.
That is a fallback, not the default.

When `DATABASE_URL` is unset the app falls back to pg-mem and auto-seeds at boot. When it is set,
the app does **not** seed: run `npm run seed` yourself.

**`CRON_SECRET`** — when it is set, `GET /api/health` requires `Authorization: Bearer <CRON_SECRET>`
and answers `401` without it. Vercel sends that header automatically for cron invocations. When it
is unset, `/api/health` accepts unauthenticated requests, which is a development convenience only.

---

## Deployment

```bash
vercel login
vercel link                                   # first time only: pick the project
vercel env add DATABASE_URL production        # paste the pooler URL
vercel env add CRON_SECRET production         # optional, recommended
vercel --prod
```

`bash scripts/deploy.sh` does all of that in one run — preflight, the schema check, the seed, the
production environment variables, and `vercel --prod`. It is idempotent, and every step can be
skipped with a flag (`--skip-schema`, `--skip-seed`, `--skip-env`, `--skip-deploy`,
`--skip-preflight`); the flags are documented in the script's own header.

**The cron.** `vercel.json` declares:

```json
{ "crons": [{ "path": "/api/health", "schedule": "0 3 * * *" }] }
```

That is `/api/health` once a day at 03:00 UTC. On the Hobby plan a cron job runs at most once per
day; an hourly schedule is rejected with *"Hobby accounts are limited to daily cron jobs."*

**The seed must be run by hand against the hosted database.** Nothing in the deployment runs it:
the app only answers requests, and `vercel.json` has no build step that applies the seed. From a
machine that has the connection string:

```bash
DATABASE_URL='postgresql://...' npm run seed
```

The seed is idempotent: the root node has a fixed id and acts as a marker, so re-running it never
duplicates the tree. A redeploy therefore never duplicates the content.

### Keep-alive

**Supabase's free tier pauses a project after 7 days of low database activity.** A paused project
returns errors on every connection until it is resumed by hand in the Supabase dashboard; a paused
project stays restorable for a year. The realistic failure this creates is not hypothetical: the
app is deployed and working, nobody touches it for three weeks, and the grader opens the URL to a
database error.

The mitigation is the daily Vercel cron. It calls `GET /api/health`, and that endpoint runs a real
`select 1` against the database on every request — no caching, no short-circuit. That is genuine
database activity, and it is what keeps the free project out of the paused state.

**This is a mitigation, not a guarantee.** The cron can fail — a deployment error, a suspended
Vercel account, a platform outage — and Supabase can still pause a project. The backstop is the
dashboard: if the app returns a database error, resume the project at
<https://supabase.com/dashboard>. Do that before the demo, not during it.

---

## Testing

```bash
npm test
```

`npm test` runs `node --test` with **no path argument**; the runner discovers the `tests/*.test.js`
files. Do not run `node --test tests/` — on Node v22.22.2 that is read as a module path and fails
with `Cannot find module '.../tests'`.

`bash scripts/verify.sh` runs the test suite and then boots the app on a free port and drives it
over HTTP, asserting:

- `GET /api/health` returns `ok: true` and `db: "up"`
- `GET /api/tree` returns a non-empty tree
- `GET /api/nodes` returns the root level, and `GET /api/nodes?parent=root` returns the same level
- `POST /api/nodes` creates a card (`201`) and returns a `Location` header
- `PUT /api/nodes/:id` updates it (`200`)
- `DELETE /api/nodes/:id` removes it (`204`, and it is gone afterwards)
- `GET /f/<uuid>` returns the SPA shell as HTML, not JSON
- `GET /api/nonexistent` returns a JSON `404`, not the shell

It prints a PASS/FAIL line per assertion, kills the server on exit — including on Ctrl-C — and
exits non-zero if anything failed.

---

## API reference

Base path `/api`. Request and response bodies are `application/json`. `DELETE` returns `204` with
an empty body.

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/api/nodes` | The children of `?parent=<uuid>`; omit it or pass `parent=root` for the root level | `200` `{ "nodes": Node[] }` |
| `GET` | `/api/nodes/:id` | One node | `200` `{ "node": Node }` |
| `GET` | `/api/nodes/:id/path` | The ancestor chain, root first, excluding the node itself | `200` `{ "path": Node[] }` |
| `GET` | `/api/tree` | The whole tree, flat | `200` `{ "nodes": Node[] }` |
| `POST` | `/api/nodes` | Create a node — `{ parentId, kind, title, body?, answer? }` | `201` + `Location: /api/nodes/<id>` + `{ "node": Node }` |
| `PUT` | `/api/nodes/:id` | Update fields and/or move — `{ title?, body?, answer?, parentId? }` | `200` `{ "node": Node }` |
| `DELETE` | `/api/nodes/:id` | Hard delete; a folder takes its whole subtree with it | `204` |
| `POST` | `/api/nodes/reorder` | Replace the order of a level — `{ parentId, orderedIds }` | `200` `{ "nodes": Node[] }` |
| `GET` | `/api/health` | Liveness and a real database check | `200` `{ "ok": true, "db": "up", "mode": "postgres" \| "memory" }` |

A node:

```jsonc
{
  "id": "0f0c1f2e-…",          // uuid, generated server-side
  "parentId": "uuid" | null,   // null = the root level
  "kind": "folder" | "card",
  "title": "string",
  "body": "string",            // the prompt; always "" for a folder
  "answer": "string",          // the answer; always "" for a folder
  "position": 0,               // contiguous from 0 within the level
  "createdAt": "2026-10-24T08:00:00.000Z",
  "updatedAt": "2026-10-24T08:00:00.000Z"
}
```

Errors use one shape:

```jsonc
{ "error": { "code": "not_found", "message": "No node with that id." } }
```

| Code | HTTP | Condition |
|---|---|---|
| `invalid_request` | 400 | Malformed body or query |
| `not_found` | 404 | No node with that id, or an unknown endpoint |
| `invalid_move` | 409 | A move into the node itself or into its own descendant |
| `duplicate_title` | 409 | A sibling with the same title already exists |
| `validation_failed` | 422 | Empty title; a folder with a body or an answer; a child under a card |
| `internal_error` | 500 | Anything unexpected — logged server-side, generic message to the client |

---

## Project layout

```
RecallLab/
├── package.json
├── package-lock.json
├── server.js                     Vercel entry point — exports the Express app
├── vercel.json                   The SPA rewrite and the keep-alive cron
├── .env.example
├── README.md
├── docs/
│   ├── Lecture_01_Overview.pptx
│   ├── specs/
│   │   ├── 2026-10-24-recalllab-design.md        the product
│   │   ├── 2026-10-24-recalllab-contracts.md     the build interface
│   │   └── 2026-10-24-recalllab-visual-system.md the visual system
│   └── submissions/               the course outline deliverable
├── public/                       served by the Vercel CDN
│   ├── index.html                the SPA shell
│   ├── styles/
│   │   ├── tokens.css            the design tokens
│   │   ├── base.css
│   │   ├── layout.css            spine, breadcrumb, grid
│   │   ├── stage.css             Focus Mode
│   │   └── edit.css              Edit Mode
│   ├── js/
│   │   ├── main.js               the router and the bootstrap
│   │   ├── api.js                the only module that calls fetch
│   │   ├── store.js              the client-side tree cache
│   │   ├── filepage.js           spine, breadcrumb, grid
│   │   ├── focus.js              the stage and the PiP state machine
│   │   ├── gestures.js           the pointer state machine
│   │   └── edit.js               Edit Mode
│   └── fonts/                    four self-hosted latin-subset woff2 files
├── server/
│   ├── index.js                  the local entry — calls app.listen()
│   ├── app.js                    builds and exports the Express app
│   ├── shell.js                  reads public/index.html at module load
│   ├── db/
│   │   ├── client.js             the only query gateway (pg, or pg-mem)
│   │   ├── queries.js            every SQL statement
│   │   ├── schema.sql            the nodes table
│   │   └── seed.js               the COMP3421 tree
│   └── routes/
│       └── nodes.js              the REST API
├── scripts/
│   ├── deploy.sh                 the deployment run
│   └── verify.sh                 the test suite and the smoke test
└── tests/
    ├── api.test.js
    ├── edit.test.js
    ├── focus.test.js
    └── gestures.test.js
```

---

## Troubleshooting

**The styles or scripts 404 in production but work locally.** Vercel ignores `express.static()`.
The middleware in `server/app.js` exists for local development and for a conventional Node host
(Render, Fly); in production, static assets must live in `public/**`, which Vercel serves from its
CDN. The Express catch-all that returns the SPA shell for every non-API path is kept as well, so
the app still runs on a host that does not serve `public/**` itself.

**Every request fails with a database error.** The Supabase project is probably paused — resume it
in the Supabase dashboard. See *Keep-alive* above.

**`/api/health` answers `401`.** `CRON_SECRET` is set, so the endpoint needs
`Authorization: Bearer <CRON_SECRET>`. Add the header, or unset the variable for local work.

**The tree is empty in production.** Postgres mode does not auto-seed. Run
`DATABASE_URL='…' npm run seed` against the hosted database. The `nodes` table is created
automatically on boot (`server/db/schema.sql` is idempotent), so only the seed is ever missing.

**`/api/health` reports `"mode":"memory"`.** `DATABASE_URL` did not reach the deployment. Check
`vercel env ls` and redeploy. In this mode the data lives in memory and is discarded on every
cold start.

**The deploy is rejected with "Hobby accounts are limited to daily cron jobs."** The schedule in
`vercel.json` is `0 3 * * *`, which is daily. An hourly schedule is not allowed on the Hobby plan.

**Free-tier limits worth remembering.** Vercel Hobby: 100 deployments per day, and cron at most
once per day. Supabase free tier: a project with low activity for 7 days is paused, and a paused
project is restorable for a year.

**`node --test tests/` fails with "Cannot find module".** Use `npm test`, which runs `node --test`
with no path argument.

**The server takes a long time to start.** Under WSL, with the repository on a Windows drive, the
module loader is I/O-bound and the boot can take tens of seconds. It is not a hang.

**The page says the SPA shell is missing.** `server/shell.js` could not read `public/index.html`
and fell back to an inline page. Check that `public/index.html` exists.

---

## Design notes

- [`docs/specs/2026-10-24-recalllab-design.md`](docs/specs/2026-10-24-recalllab-design.md) — the
  product: the tree model, the three modes, the interaction contract, the data model, the
  deployment architecture, and the verification plan.
- [`docs/specs/2026-10-24-recalllab-contracts.md`](docs/specs/2026-10-24-recalllab-contracts.md) —
  the build interface: the REST contract, the client module contracts, the DOM registry, and the
  rules the database layer has to keep.
- [`docs/specs/2026-10-24-recalllab-visual-system.md`](docs/specs/2026-10-24-recalllab-visual-system.md)
  — the visual system: the two registers (browse and focus), the tokens, the components, and the
  motion constants.

Where the code and the specifications disagree, the code is what runs and the specification needs
an amendment.
