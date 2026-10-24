# RecallLab — Design Specification

> **Status** — Draft for build. Every constraint below was agreed with the project owner before writing.
> **Date** — 2026-10-24
> **Owner** — Pelec (hzihao872-arch)
> **Course** — COMP3421 Web Application Design and Development, PolyU
> **Companion document** — [`2026-10-24-recalllab-visual-system.md`](./2026-10-24-recalllab-visual-system.md) (visual system)

---

## 0. How to read this document

This is the design of RecallLab, a course final project. It is a **specification**, not a report:
nothing in it is "done" until the corresponding artifact exists and the check in §13 passes.

Section order is dependency order. §3 defines the product model, §4 the interaction contract, §5–§7 the
implementation shape, §8–§11 the quality bar, §12 the schedule. If a later section contradicts an
earlier one, the earlier one wins and the document must be amended (see §0.3).

### 0.1 Decision ledger

The numbers are stable. Cite them in code review, issues, and the outline submission.

| # | Decision | Outcome | Why |
|---|---|---|---|
| D-01 | RecallLab **is** the COMP3421 final project | — | The course's outline submission describes "your project"; the repo holds the design |
| D-02 | Single user, manual authoring, no AI | — | Removes LLM pipeline, auth, multi-tenancy; spends the budget on the taught stack |
| D-03 | Focus Mode is spatial only — no scoring, no records, no SRS | — | `Recall` is carried by the interaction, not by data |
| D-04 | Edit Mode offers full structural operations | — | Course rubric requires CRUD; partial CRUD loses points |
| D-05 | Supabase Postgres via `pg`; Vercel for the app | — | Postgres is named on the rubric slide; Vercel is free and zero-config for Express |
| D-06 | Vanilla HTML/CSS/JS, no build step; SPA with History API | — | Course teaches HTML→CSS→JS→fetch→SPA, no framework week; no build step keeps deploy trivial |
| D-07 | Two-register cold-neutral visual system, one accent | — | Reads as a file system in browse mode and a stage in focus mode |
| D-08 | Minimal spine + breadcrumb + tiled grid | — | Finder-like without the noise |
| D-09 | Reuse Soit's PiP state machine | — | Mechanism already proven; only the content model changes (tree instead of inquiry tree) |

### 0.2 Naming

Early notes call the focus mode "Flash mode". The product calls it **Focus Mode**. Reason: a flashcard
impression promises grading and recall scheduling, and D-03 deliberately excludes both. The name must
not promise what the system does not do.

### 0.3 Change control

Any change to D-01…D-09, to a value in §4, §5, or §8, is recorded in this table with date, reason, and
the affected sections, before downstream work proceeds.

| Date | Change | Reason | Affected |
|---|---|---|---|
| 2026-10-24 | Initial specification | — | — |

---

## 1. Context

### 1.1 What RecallLab is

RecallLab is a **spatial recall reader for structured course material**. Material is organised as a
tree of folders and cards. A card carries a prompt on its face and an answer on its back. The user
browses the tree like a file system, then drops into **Focus Mode**, where the screen narrows to one
card at a time and the tree itself becomes the navigation.

The distinctive claim is not "it stores flashcards". It is: **the hierarchy is the retrieval cue**.
Instead of shuffling a deck, you move through a structure you can see, and the act of moving — dragging
a card away, pulling one out into a floating window, drilling into a folder — is the act of deciding
what you actually remember.

### 1.2 Course alignment

Lecture 01 is a tour of the whole course. RecallLab is built on the stack that tour describes, and the
project is graded on covering that stack. Mapping:

| Course topic (Lecture 01 slides) | Where RecallLab exercises it |
|---|---|
| Client–Server Model (5), One Request End to End (6), The Stack Layer by Layer (7) | Every screen: browser → Express → Postgres is the app's own request path |
| HTML (9), CSS (10), JavaScript (11), DevTools (12) | Entire front end; no framework |
| HTTP (14), URLs (15) | REST contract in §6; History API routing in §7.2 |
| Node.js (16), Express · REST · CRUD (17) | The back end; CRUD is the node tree |
| Advanced Integration (18) | Deferred — out of v1 scope, see §2.3 |
| Performance & Optimization (19) | §10; Week 13 rubric |
| Simple Personal Website Architecture (21), Large-Scale Deployment (22), Five Layers (23), Scale Each Piece Independently (24) | §9 deployment architecture |
| Week by Week (26), By the End of Week 13 (27), Key Takeaways (28) | §12 milestone plan |

### 1.3 The submission pipeline

RecallLab produces a required course artifact: the **initial project outline**, submitted as a PDF.

| Requirement | Value |
|---|---|
| Group info | 1–2 members (name + student ID each) |
| Project title | The topic of the project |
| Abstract | What the project does — half a page |
| File format | PDF |
| Copies | Every member submits a copy individually |
| File name | `name_studentID_outline.pdf` (e.g. `Bob_24062567d_outline.pdf`) |

The abstract is written **from §1.1, §3, and §4 of this document** once the design is frozen. The
deliverable is produced after this spec, not before it.

**Produced 2026-10-24** — `docs/submissions/Huang_Haoran_24101322D_outline.pdf`, one A4 page, with the
regenerable HTML source beside it. Final title: *RecallLab — A Spatial Recall Reader for Hierarchical
Course Material*.

---

## 2. Scope

### 2.1 In scope (v1)

1. A tree of **folders** and **cards** stored in Postgres.
2. A **file page**: minimal spine, breadcrumb, tiled grid of the current level.
3. **Focus Mode**: one card at a time, reveal the answer, drag away to advance, hold to pull out into a
   floating window, drill into folders.
4. **Edit Mode**: rename, edit body and answer, create, delete, move across folders, reorder within a
   level — reachable from both the file page and Focus Mode.
5. A REST API over Express, a Postgres-backed store, and a deployed public URL.
6. Seed content: the COMP3421 course structure (§5.4).

### 2.2 Explicit non-goals

These are rejected on purpose. Do not add them without amending D-01…D-09.

| Non-goal | Reason |
|---|---|
| Accounts, login, multi-user, sharing | D-02. The course does not require it; it costs weeks. |
| AI generation, LLM calls, prompt contracts | D-02. Not a taught topic; adds a third-party failure mode to a graded demo. |
| Spaced repetition, SRS scheduling, review stats, self-grading | D-03. Focus Mode is spatial; adding scoring changes the product's identity. |
| Rich text / Markdown rendering of card bodies | Plain text with line breaks only. Adds a parser, a sanitizer, and an XSS surface for no rubric gain. |
| Search, multi-select, list/column view switching, tag system | Not needed by the single-user recall loop. Deferred to §2.3. |
| Trash / soft delete / undo history | Deletion is a hard delete with a confirmation step (§4.3.4). |
| Mobile-optimised Focus Mode | Touch devices get a degraded, tap-only Focus Mode (§4.2.8); the drag choreography is a mouse affordance. |
| Offline mode / PWA / service worker | The graded requirement is a live public URL with a real database. |
| Docker, CI/CD pipelines beyond a scheduled keep-alive | §9.3 only needs one cron. |

### 2.3 Later candidates (not v1, recorded so they are not re-litigated)

- Supabase Realtime for multi-user co-editing (would replace D-02).
- Full-text search over card bodies and answers.
- Import from PPTX/Markdown into the tree (would require D-02 to be revisited).
- Export the tree to Markdown for version control.

---

## 3. Product model

### 3.1 The tree

The whole data model is one tree. Every node has a parent, except root nodes whose parent is `null`.

```
COMP3421
├── 01 The Big Picture
│   ├── The Client–Server Model        (card)
│   ├── One Request, End to End        (card)
│   └── The Stack, Layer by Layer      (card)
├── 02 Front-End
│   ├── HTML — Structure & Elements     (card)
│   ├── CSS — Presentation & Layout     (card)
│   ├── JavaScript — Behaviour          (card)
│   └── DevTools — Your Microscope      (card)
├── 03 Back-End
│   ├── HTTP — The Language of the Web  (card)
│   ├── URLs — The Address of Everything (card)
│   ├── Part I — Node.js Runtime        (folder)
│   ├── Part II — Express · REST · CRUD & Data
│   ├── Part III — Advanced Integration
│   └── Part IV — Performance & Optimization
├── 04 The Journey
│   └── …
└── 05 Wrap-Up
    └── …
```

Depth is unbounded in the schema. The seed tree is three levels deep (root → section → topic/card).
**UI rule**: the file page shows exactly one level at a time; the spine shows the full path.

### 3.2 Node kinds

| Kind | `title` | `body` | `answer` | Children |
|---|---|---|---|---|
| `folder` | required | must be empty | must be empty | allowed |
| `card` | required | the prompt / content | the answer | forbidden |

A card's `body` is the face of the card; its `answer` is the back. A card may have an empty answer
(a title-only prompt is legitimate), but a card with an empty title is rejected (§6.3).

### 3.3 The three modes

| Mode | Purpose | Can be entered from | Layout |
|---|---|---|---|
| **File** (browse) | See and traverse the tree | Cold start; leaving Focus Mode | Spine + breadcrumb + tiled grid |
| **Focus** | Recall one node at a time | File page, any level | Stage: one focused card, dark backdrop |
| **Edit** | Mutate the tree | File page **or** Focus Mode | Overlay on whichever mode is active |

Focus and Edit are **not** separate pages. Focus is a presentation state of the current level; Edit is
an overlay that can be layered on top of either. This is what makes "edit while focused" (§4.3)
possible without a second screen.

### 3.4 Mode state machine

```
                 click folder          click card
        ┌────────────────────────┐   ┌──────────────┐
        ▼                        │   ▼              │
   ┌─────────┐   enter Focus   ┌───────────┐      │
   │  File   │ ──────────────► │   Focus   │──────┘
   │  page   │ ◄────────────── │   stage   │
   └─────────┘   Esc / back    └───────────┘
        ▲                             │
        │        E / Edit toggle      │ E / Edit toggle
        └─────────────────────────────┴──────┐
                                              ▼
                                     ┌───────────┐
                                     │   Edit    │  (overlay)
                                     │  overlay  │
                                     └───────────┘
```

Entering Focus Mode deepens the visible level: focusing a **folder** and activating it descends into
that folder (§4.2.7). The spine and breadcrumb always reflect the level currently on stage.

---

## 4. Interaction specification

Every number in this section is a contract. Changing one requires a §0.3 entry.

### 4.1 File page

**Layout** (left → right):

| Region | Width | Content |
|---|---|---|
| Spine | 240px, collapsible to 0 | The whole tree, indented, current path highlighted, each node's kind shown by icon |
| Main | fluid, max 1400px centred | Breadcrumb bar, then the tiled grid of the current level's children |
| Breadcrumb bar | 48px | `COMP3421 › 03 Back-End › Part II — Express · REST · CRUD & Data` + Flash entry + Edit toggle |

**Grid.** Children are laid out as tiles in a CSS Grid with `repeat(auto-fill, minmax(220px, 1fr))`,
gap 16px. Within a level, **folders sort before cards**, then by `position` (§5.3). Each tile shows:

- kind icon (folder / card), 20px, inline SVG, never emoji
- title, 15px, up to two lines, ellipsis
- for cards, a one-line preview of `body` in `Ink Secondary`, 13px, single line

**Opening.** Cold start shows the **root level** (§3.1), not a dashboard and not a welcome screen.
`/` → file page at root.

**Interaction.**

| Action | Result |
|---|---|
| Click folder tile | Navigate down: `pushState` to `/f/:id`, grid replaces with that level |
| Click card tile | Open the card in Focus Mode on that level: `pushState` to `/f/:parentId?focus=:id` |
| Click breadcrumb segment | Navigate to that ancestor's level |
| Click spine node | Navigate to that node's level |
| Browser back / forward | Restore the previous level (History API, §7.2) |
| Double-click a tile | Same as single click — no double-click semantics anywhere in the product |

There is no context menu in v1. Every action is either a click on a tile or a mode toggle.

### 4.2 Focus Mode

#### 4.2.1 Stage layout

Focus Mode replaces the file page with a **stage**: dark backdrop (`#0B0B0C`), one focused card centred
horizontally, everything else suppressed.

- Focused card: `width: min(720px, 100vw - 96px)`, content-driven height, `min-height: 320px`.
- Card corner radius 20px, surface `#17171A`, hairline border `#27272A`.
- Title 26px, `Ink` (`#FAFAFA`); body 16px `#D4D4D8`; answer 16px `#A1A1AA` until revealed, then `#FAFAFA`.
- **Only one node is on stage at a time.** The rest of the level is a stack behind it (§4.2.2).

#### 4.2.2 The stack

The current level's siblings are stacked behind the focused card, receding downward:

| Layer | Offset Y | Scale | Shadow |
|---|---|---|---|
| Focus (0) | 0 | 1.000 | e3 |
| 1 | 12px | 0.975 | e2 |
| 2 | 24px | 0.950 | e1 |
| 3 | 36px | 0.925 | e0 |
| 4+ | hidden | — | — |

Maximum four visible layers including the focus. The stack is purely visual; it does not scroll.

#### 4.2.3 Reveal (the flashcard effect)

Clicking the focused card **flips it** to show the answer. Single click, no button, no hover
affordance required — the card itself is the affordance.

- Flip duration 320ms, `transform: rotateY` about the horizontal axis through the card centre.
- The front face and back face are two stacked layers; the back is `rotateY(180deg)` at rest so the
  flip reads as one continuous object rather than two pages swapping.
- Clicking again flips back. State is not persisted (§4.2.9).
- If the card has an empty `answer`, clicking does nothing and the card shows a muted
  "No answer recorded" line in `Ink Muted`, 13px.

#### 4.2.4 Drag away (advance)

Press and drag the focused card away. Once the pointer travels **56px** from the press origin, the
gesture is classified as a drag (not a click) and the **dominant axis** decides the intent:

| Dominant axis | Intent | Result |
|---|---|---|
| Up or down | Advance / retreat in the stack | The card is thrown out with the gesture's velocity; the next sibling rises into focus |
| Left or right | Dismiss / retrieve | The card leaves the stage sideways; the next sibling rises into focus |

On release the card continues away with **the velocity it was thrown at** (§8.4) and the next sibling
rises into focus with a FLIP transition. Nothing is recorded. The dismissed card is still in the tree
and is still reachable by navigating to it again.

If the pointer is released **before** 56px, the card springs back to focus and nothing advances. This
is the same 56px threshold as Soit's drag navigation, for the same reason: below it, the gesture is
ambiguous between "click" and "drag", and a click is far more common.

#### 4.2.5 Float out (floating window)

Press and **hold** the focused card for **450ms** without moving more than 8px. The card lifts out of
the stack and becomes a **floating window**; focus moves to the next sibling, which rises into place.

- On lift, the card animates from its stage position to its floating position (FLIP + spring, §8.4).
- **Floating window geometry:**
  - width `min(440px, max(320px, 100vw × 0.34))`
  - height `min(300px, max(220px, width × 0.68))`
  - corner radius 16px, surface `#17171A`, border `#27272A`, shadow e3
- **Default docking:** horizontally centred over the focused card, sitting **above** it with a 16px gap.
  If that position would overflow the top of the viewport, the window docks **below** the focused card
  instead. Either way it is clamped to stay inside the viewport with a 16px margin.
- The floating window is **draggable** by its header. Dragging is 1:1 with the pointer and runs no
  transition. When released it stays where it was dropped (it is not snapped back).
- Clicking a floating window brings it to the front and expands it back into the focus position,
  returning focus to it.
- Multiple floating windows may exist at once; they stack in the order they were pulled out, and the
  most recently pulled is on top.
- `Esc` closes the topmost floating window (it returns to the stack at its original position); a
  second `Esc` exits Focus Mode.

**Distinguishing the two gestures.** Hold 450ms → float. Move 56px → advance. Both can be produced by
one gesture: a long press that then moves beyond the threshold lifts the card out first, and the
subsequent movement drags the floating window rather than advancing. The state machine in §4.2.6
resolves this.

#### 4.2.6 The PiP state machine

This is Soit's FSM, retargeted from inquiry cards to tree nodes. It is the one part of the product
that must be implemented exactly as written.

```
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
    ┌───────┐   press + move > 8px    ┌───────────┐   │
    │ idle  │ ──────────────────────► │ dragging  │   │
    └───────┘                         └───────────┘   │
        ▲                                │      │     │
        │      release, no velocity     │      │ hold ≥ 450ms
        │      and < 56px              │      ▼     │
        └──────────────────────────────┴─────────────┘
                                    release with
                                    velocity, or
                                    move > 56px
                                            │
                                            ▼
                                    ┌───────────────┐
                                    │ advance/      │
                                    │ dismiss       │
                                    └───────────────┘

    ┌───────┐   hold ≥ 450ms   ┌───────┐   click    ┌───────┐
    │ idle  │ ──────────────► │  pip  │ ─────────► │ focus │
    └───────┘                 └───────┘            └───────┘
                                    │  drag          ▲
                                    ▼                │ expand
                              (stays floating)        │
```

Rules that the implementation must satisfy:

1. During `dragging`, **no transition runs** on the card. Position is driven directly from pointer
   coordinates. Any transition here produces lag and destroys the "silk" feel.
2. `dragging → pip` happens at 450ms of hold **only if** the pointer has not moved more than 8px.
3. `dragging → advance` happens on release when displacement exceeded 56px, or when the release
   velocity exceeded the flick threshold. The velocity threshold is **0.35px/ms**.
4. `pip → focus` on click restores the card to the focus position and returns focus to it.
5. A card in `pip` state is *not* part of the stack and does not participate in ↑/↓ navigation.

#### 4.2.7 Descend into a folder

When the focused node is a **folder**, clicking it **descends**: the stage swaps to that folder's
level, the spine and breadcrumb update, and the focus moves to that folder's first child. This is the
"逐层下钻" behaviour — the tree is navigated by focusing, not by opening a dialog.

Pressing `Esc` ascends one level: back to the parent folder, with the parent folder focused. `Esc` on
a floating window closes the window first (§4.2.5).

#### 4.2.8 Keyboard and touch

| Key | Action |
|---|---|
| `↑` / `↓` | Move focus to the previous / next sibling in the stack |
| `Enter` / `Space` | Flip the focused card (reveal answer) |
| `Esc` | Close top floating window → ascend a level → exit Focus Mode (in that order) |
| `E` | Toggle Edit Mode |

**Touch.** Focus Mode on a touch device degrades to tap-only: tap to reveal, tap to descend, and the
drag/hold gestures are unavailable. A dismiss button appears in the card's corner on coarse pointers
(`@media (pointer: coarse)`). The reason for not porting the drag choreography to touch: the gesture's
meaning depends on velocity and hold duration, neither of which a finger produces reliably, and a
misread gesture is more disruptive than a missing one.

#### 4.2.9 What Focus Mode does not do

- It does not score, track, or record anything. There is no `seen_count`, no `last_seen_at`, no
  review history table. (D-03)
- It does not randomise or shuffle. Order is the tree's order.
- It does not persist the revealed state. Leaving Focus Mode and returning shows the front face.

### 4.3 Edit Mode

Edit Mode is an overlay. The underlying mode stays visible and interactive in read-only form; the
editable affordances appear on top.

#### 4.3.1 Editable fields

| Target | Field | Control |
|---|---|---|
| Folder | title | Inline text input on the tile / focused card |
| Card | title | Inline text input |
| Card | body | Inline textarea, plain text, newlines preserved |
| Card | answer | Inline textarea, plain text, newlines preserved |

Empty title is rejected on blur with an inline error ("Title cannot be empty"). Empty body and empty
answer are allowed.

#### 4.3.2 Structural operations

| Operation | Where | Behaviour |
|---|---|---|
| Create folder | File page, current level | `+` in the breadcrumb bar creates a folder in the level currently displayed |
| Create card | File page, current level | `+` in the breadcrumb bar creates a card in the level currently displayed |
| Rename | Any | Inline edit of the title |
| Edit body / answer | Any | Inline edit |
| Delete | Any | Confirmation dialog (§4.3.4) |
| Move to another folder | File page | Drag a tile onto a folder tile |
| Reorder within a level | File page | Drag a tile to a new index among its siblings |

#### 4.3.3 Move across folders

Dragging a tile onto a folder tile in the file page moves the node into that folder. This is the same
gesture vocabulary as Focus Mode's drag, so the muscle memory transfers.

Rules:
- A node cannot be dropped into itself or into its own descendant. The drop is rejected with a toast
  ("Cannot move a folder into itself").
- The move is a single `PUT /api/nodes/:id` with the new `parentId` (§6.2) — one request, one
  transaction. The server rejects an invalid move with `409`.
- Reordering within a level uses `POST /api/nodes/reorder` (§6.2) so that the whole order is applied
  atomically rather than as N `PUT`s.

#### 4.3.4 Delete semantics

- Delete is a **hard delete**. There is no trash and no undo (D-02, §2.2).
- Deleting a folder **cascades** to its entire subtree. The server does this in one transaction.
- Every delete is preceded by a confirmation dialog that names the node and, for a folder, states the
  number of descendants that will also be deleted: *"Delete "Part II — Express" and 6 items inside it?"*
- The API returns `204` on success and the client removes the subtree from the local tree.

### 4.4 Global rules

- Nothing is destructive without a confirmation dialog (delete only).
- Nothing moves the pointer's meaning: a drag is always a drag, on every surface.
- All mode transitions animate (§8.4). Nothing appears or disappears instantly except on first paint.
- The product never scrolls the page body. The file page scrolls the grid region; Focus Mode does not
  scroll at all.

---

## 5. Data model

### 5.1 Schema

One table. A node's kind is a discriminator column; the tree structure is an adjacency list.

```sql
create extension if not exists "pgcrypto";

create table nodes (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references nodes(id) on delete cascade,
  kind        text    not null check (kind in ('folder', 'card')),
  title       text    not null check (length(btrim(title)) > 0),
  body        text    not null default '',
  answer      text    not null default '',
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index nodes_parent_position_idx on nodes (parent_id, position);
create index nodes_parent_idx on nodes (parent_id);
```

`parent_id is null` means "top level". The seed has a single root; the schema permits a forest, which
costs nothing and avoids a special case.

### 5.2 Queries

| Need | Query |
|---|---|
| Children of a level | `select * from nodes where parent_id = $1 order by position, created_at` |
| Root level | `select * from nodes where parent_id is null order by position, created_at` |
| One node | `select * from nodes where id = $1` |
| Ancestor chain (breadcrumb) | recursive CTE over `parent_id` |
| Whole tree (spine) | one query, `select id, parent_id, kind, title, position from nodes order by position` — the tree is small enough to fetch whole; the spine needs it all anyway |

The spine fetches the entire tree in one request and caches it client-side for the session. Deeper
levels are fetched per level. There is no N+1 pattern anywhere.

### 5.3 Ordering

`position` is a non-negative integer, unique within a level, contiguous from 0. Reordering rewrites the
whole level's positions in one transaction. The client never computes positions.

Ordering within a level is always **folders first, then cards**, each group by `position`. The server
applies this ordering when it returns a level, so the client renders whatever order it receives.

### 5.4 Seed content

The seed reproduces the COMP3421 course structure from Lecture 01, so that a fresh deployment shows a
real, meaningful tree rather than "Folder 1 / Card 1".

```
COMP3421
├── 01 The Big Picture            (3 cards: Client–Server Model, One Request End to End, The Stack Layer by Layer)
├── 02 Front-End                  (4 cards: HTML, CSS, JavaScript, DevTools)
├── 03 Back-End                   (2 cards + 4 folders: HTTP, URLs, Part I–IV)
│   ├── Part I — Node.js Runtime
│   ├── Part II — Express · REST · CRUD & Data
│   ├── Part III — Advanced Integration
│   └── Part IV — Performance & Optimization
├── 04 The Journey                (4 cards: Personal Site Architecture, Large-Scale Deployment, Five Layers, Scale Each Piece Independently)
└── 05 Wrap-Up                    (3 cards: Week by Week, By the End of Week 13, Key Takeaways)
```

The card-level content (prompts and answers) is authored in the outline deliverable (§1.3) and applied
as a seed script. Seeds are applied **once**, guarded by a marker row, so a redeploy never duplicates
the tree.

---

## 6. Back end

### 6.1 Stack and the hard rule

```
Browser (vanilla JS)
        │  fetch()  — application/json
        ▼
Express  (Node.js, one Vercel Function)
        │  pg  — parameterized queries
        ▼
Supabase Postgres
```

**The rule that cannot be broken: the browser never talks to Supabase.** Supabase's headline feature
is an auto-generated REST API ("no backend code needed for CRUD"). Using it would put the browser
directly on the database and remove the Express layer from the data path — losing the back-end and
database-integration rubric items at once, and losing the ability to enforce the invariants in §6.3.

Consequently:

- `DATABASE_URL` is a **server-side environment variable**. It is never bundled into client code.
- The client uses `supabase-js` **nowhere**. The database is reached through `pg` only.
- Supabase Auth and Row Level Security are **off**. The project is a plain Postgres database.
- The service-role key is not used by the application.

### 6.2 REST contract

Base path `/api`. All requests and responses are `application/json` except `DELETE` (`204`, no body).

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/api/nodes?parent=<uuid\|root>` | Children of a level | `200` `{ "nodes": [...] }` |
| `GET` | `/api/nodes/:id` | One node | `200` `{ "node": {...} }` |
| `GET` | `/api/nodes/:id/path` | Ancestor chain, root-first | `200` `{ "path": [...] }` |
| `GET` | `/api/tree` | Whole tree (spine) | `200` `{ "nodes": [...] }` |
| `POST` | `/api/nodes` | Create | `201` + `Location` header + `{ "node": {...} }` |
| `PUT` | `/api/nodes/:id` | Update fields and/or move | `200` `{ "node": {...} }` |
| `DELETE` | `/api/nodes/:id` | Hard delete + cascade | `204` |
| `POST` | `/api/nodes/reorder` | Replace a level's order | `200` `{ "nodes": [...] }` |
| `GET` | `/api/health` | Liveness + DB check | `200` `{ "ok": true, "db": "up" }` |

Payloads:

```jsonc
// POST /api/nodes
{ "parentId": "uuid|null", "kind": "folder|card", "title": "…", "body": "", "answer": "" }

// PUT /api/nodes/:id   (any subset)
{ "title": "…", "body": "…", "answer": "…", "parentId": "uuid|null" }

// POST /api/nodes/reorder
{ "parentId": "uuid|null", "orderedIds": ["uuid", "uuid", "…"] }
```

### 6.3 Validation and error model

Errors are returned as `{ "error": { "code": "…", "message": "…" } }`.

| Code | HTTP | When |
|---|---|---|
| `invalid_request` | 400 | Malformed body or query |
| `not_found` | 404 | No such node |
| `invalid_move` | 409 | Move into self or own descendant |
| `duplicate_title` | 409 | Sibling with the same title already exists |
| `validation_failed` | 422 | Empty title; `body`/`answer` set on a folder; card with children |
| `internal_error` | 500 | Anything unexpected |

Server-enforced invariants (the client is never trusted):

1. `title` is non-empty after trimming.
2. A folder has empty `body` and `answer`.
3. A card has no children — creating a child under a card is `422`.
4. `parent_id` must reference a **folder** or be null.
5. A node cannot be moved into itself or its own descendant.
6. Sibling titles are unique (case-insensitive, trimmed) — matches how a file system behaves and how
   the spine reads.

### 6.4 Connection management

Serverless functions open and close connections constantly. The configuration that avoids exhausting
Supabase's connection limit:

```js
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,   // pooled URL, transaction mode (port 6543)
  ssl: { rejectUnauthorized: false },
  max: 1,                                        // one connection per function instance
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});
```

- Use the **pooler** URL (transaction mode, port 6543) for serverless. The direct URL (port 5432)
  counts each function instance against Supabase's connection limit.
- Transaction-mode pooling does not support session-level features. RecallLab uses none — no
  `LISTEN`, no temp tables, no session `SET`.
- If a deployed query fails with a prepared-statement error, switch `DATABASE_URL` to the direct URL
  and raise `max` to 2. This is the documented fallback, not a design change.

### 6.5 Health endpoint

`GET /api/health` runs `select 1` and returns `200 {"ok":true,"db":"up"}`. It is the endpoint the
keep-alive cron calls (§9.3), so it must touch the database on every request — no caching, no
short-circuit.

---

## 7. Front end

### 7.1 No build step

The front end is plain HTML, CSS, and ES modules served as static files. There is no bundler, no
transpiler, no `node_modules` in the browser, and no framework. This is a deliberate constraint, not a
simplification of convenience:

- The course teaches HTML, CSS, ES6+, the DOM, events, and `fetch` — and no framework. Using one
  would mean self-teaching a tool the rubric never mentions, plus a build pipeline, plus a dependency
  surface, before a single requirement is met.
- The deployment is trivial: static files in `public/**`, one Express function, one Postgres.

```
public/
├── index.html
├── styles/
│   ├── tokens.css        ← design tokens (§8)
│   ├── layout.css        ← spine, breadcrumb, grid
│   ├── stage.css         ← focus mode
│   └── edit.css          ← edit mode
├── js/
│   ├── main.js           ← router + bootstrap
│   ├── api.js            ← fetch wrappers
│   ├── store.js          ← client tree cache
│   ├── filepage.js       ← spine, breadcrumb, grid
│   ├── focus.js          ← stage, stack, flip
│   ├── gestures.js       ← pointer FSM (§4.2.6)
│   └── edit.js           ← edit mode
└── fonts/                ← self-hosted Geist (latin subset)
```

### 7.2 Routing

History API, one route table. The URL is the single source of truth for navigation state.

| URL | State |
|---|---|
| `/` | File page, root level |
| `/f/:folderId` | File page at that folder's level |
| `/f/:folderId?focus=:nodeId` | Focus Mode, focused on that node within that folder |
| `/f/:folderId?focus=:nodeId&edit=1` | Edit Mode overlay on Focus Mode |
| `/f/:folderId?edit=1` | Edit Mode overlay on the file page |

- `pushState` on navigation, `popstate` on back/forward.
- On cold start, the server serves `index.html` for any non-asset path (rewrite rule), and the client
  router resolves the state from the URL. A deep link to a folder opens that folder.
- The `focus` and `edit` parameters are **not** written to the URL unless the state is meaningful:
  Focus Mode always writes `focus`; Edit Mode writes `edit=1` only while it is open.

### 7.3 Client state

| Store | Contents | Lifetime |
|---|---|---|
| `tree` | Whole tree (id, parentId, kind, title, position) | Session, refreshed on mutation |
| `level` | Full records of the current level's nodes | Session, derived from `tree` + level fetch |
| `stage` | Focused node, stack order, floating windows, flip state | Session, ephemeral |
| `mode` | `file` \| `focus`, plus `edit` boolean | Session, mirrored to the URL |

There is no client-side persistence layer, no localStorage cache of content, and no offline queue. The
database is the only store of record. This keeps "your data finally persists" literally true.

### 7.4 Rendering

Plain DOM. `render()` rebuilds a region's children from state; regions are small (a level is at most a
few dozen tiles). No virtual DOM, no diffing library, no `innerHTML` with interpolated user data —
card bodies and answers are set via `textContent`, which is also the XSS defence for user-authored
content.

---

## 8. Design system

Full specification in
[`2026-10-24-recalllab-visual-system.md`](./2026-10-24-recalllab-visual-system.md). The load-bearing
values, repeated here because the interaction spec depends on them:

### 8.1 Colour

| Role | Token | Light (file page) | Dark (stage) |
|---|---|---|---|
| Canvas | `--canvas` | `#FAFAFA` | `#0B0B0C` |
| Surface | `--surface` | `#FFFFFF` | `#17171A` |
| Surface hover | `--surface-hover` | `#F4F4F5` | `#1F1F23` |
| Hairline | `--hairline` | `#E4E4E7` | `#27272A` |
| Ink primary | `--ink` | `#18181B` | `#FAFAFA` |
| Ink secondary | `--ink-2` | `#52525B` | `#A1A1AA` |
| Ink muted | `--ink-3` | `#A1A1AA` | `#71717A` |
| Accent | `--accent` | `#E8A33D` | `#E8A33D` |

One accent, used **only** for focus rings, active indicators, and the focused card's marker.
Never for body text on a light surface (contrast 2.0:1 against `#FFFFFF`); on the dark stage the
accent reaches 8:1 and may carry text.

### 8.2 Type

| Role | Stack |
|---|---|
| Display / titles | `Geist`, system fallback |
| Body | `Geist`, system fallback |
| CJK | `PingFang SC`, `Hiragino Sans GB`, `Microsoft YaHei`, `Noto Sans SC` — **system stack, never webfont** |
| Mono (paths, counts, positions) | `Geist Mono`, `ui-monospace` fallback |

`Geist` is self-hosted as a latin-subset woff2 (≤ 40KB) with `font-display: swap`. Self-hosting CJK
webfonts costs 5–15MB and would erase the Week 13 performance budget (§10).

### 8.3 Shadow ladder

| Token | Value (light) |
|---|---|
| `--e0` | none |
| `--e1` | `0 1px 2px rgba(24,24,27,.06), 0 1px 1px rgba(24,24,27,.04)` |
| `--e2` | `0 4px 12px rgba(24,24,27,.08), 0 1px 3px rgba(24,24,27,.05)` |
| `--e3` | `0 12px 32px rgba(24,24,27,.12), 0 2px 8px rgba(24,24,27,.06)` |

On the dark stage the same ladder uses `rgba(0,0,0,.35)` → `rgba(0,0,0,.55)`.

### 8.4 Motion

| Constant | Value | Applies to |
|---|---|---|
| `--t-hover` | 120ms `ease-out` | hover, press |
| `--t-focus-ring` | 160ms `ease-out` | focus ring |
| `--t-flip` | 320ms `cubic-bezier(.22,1,.36,1)` | card flip |
| `--t-move` | spring, stiffness 110, damping 22, mass 1 | stack rise, PiP enter/exit |
| `--hold-ms` | 450 | PiP hold threshold |
| `--drag-threshold-px` | 56 | drag classification |
| `--flick-velocity` | 0.35 px/ms | flick classification |

Motion rules:

1. **Transform and opacity only.** `width`, `height`, `top`, `left`, `margin`, `box-shadow` are never
   animated during an interaction.
2. **During a drag, no transition is active.** The card's transform is written directly from pointer
   coordinates.
3. **Velocity is inherited.** A thrown card leaves with the velocity of the gesture; the spring that
   settles the next card into focus is initialised with that velocity. This is the difference between
   "animated" and "smooth".
4. `prefers-reduced-motion: reduce` replaces every spring and flip with a 120ms opacity cross-fade.
5. Exactly two perpetual animations exist in the product: the skeleton shimmer during load, and a 2s
   pulse on the unsaved-changes dot. No component has an ambient loop animation, because a looping
   glow inside a focus stage competes with the user's attention — which is the one thing the stage
   exists to concentrate.

---

## 9. Deployment and operations

### 9.1 Application — Vercel

The Express app is deployed as **one Vercel Function** with Fluid compute (automatic scale to zero,
automatic scale up).

**Static assets live in `public/`, not behind `express.static()`.** Vercel explicitly ignores
`express.static()`; assets in `public/**` are served by the CDN with default headers. A front end
that works locally and 404s in production is the single most likely failure of this deployment, so it
is called out here.

`vercel.json`:

```json
{
  "rewrites": [{ "source": "/((?!api/).*)", "destination": "/index.html" }],
  "crons": [{ "path": "/api/health", "schedule": "0 3 * * *" }]
}
```

The rewrite sends every non-API path to `index.html` so the client router can resolve deep links
(§7.2). API paths are excluded so they reach Express.

**Hobby plan limits that matter** (Vercel, last updated 2026-09-16): 100 deployments/day,
100 builds/hour, 100 cron jobs/project, functions capped at 300s / 2GB / 1vCPU, 1000 environment
variables per environment (64KB total for Node runtimes). A course project is far inside all of them.

**Cron limitation:** Hobby cron jobs run **once per day at most**. A `0 * * * *` expression fails the
deployment with *"Hobby accounts are limited to daily cron jobs."* The keep-alive uses `0 3 * * *`
(daily, ±59 minutes of scheduling precision — irrelevant for this purpose).

### 9.2 Database — Supabase

A free Supabase project provides the Postgres database. It is used strictly as Postgres (§6.1).

**The free plan pauses inactive projects.** Per Supabase's documentation, a Free plan project is
paused when it shows low activity over a 7-day period; while paused, the API returns errors and the
project must be resumed manually from the dashboard (restorable for 1 year). Roughly a few database
requests per day over the previous week is enough to keep it alive.

The realistic failure this creates: the app is deployed and working, the owner stops touching it for
three weeks, and the grader opens the URL to a broken app. This is not a hypothetical — it is the
default behaviour of the free tier.

### 9.3 Keep-alive

A daily Vercel cron calls `GET /api/health`, which runs `select 1` against the database (§6.5). That
is real database activity, and it keeps the Supabase project out of the paused state.

Configuration:

```json
{ "crons": [{ "path": "/api/health", "schedule": "0 3 * * *" }] }
```

```js
// If CRON_SECRET is set, Vercel sends it as: Authorization: Bearer <CRON_SECRET>
if (process.env.CRON_SECRET) {
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (req.headers.authorization !== expected) return res.status(401).end();
}
```

**This is a mitigation, not a guarantee.** The cron can fail (deployment error, suspended account,
platform outage). Therefore the README also states: *if the app returns a database error, resume the
project in the Supabase dashboard.* Both mechanisms are in place; the README is the backstop.

### 9.4 Portability to Render / Fly

The course slide reads "static on Netlify/Vercel, servers on Render/Fly", naming Vercel for static
hosting and Render/Fly for servers. Vercel Functions are a legitimate server runtime, but the
literal reading of the slide prefers a conventional host for the API.

The application is written so that this costs nothing to satisfy either reading:

- The Express app is a standard `app.listen()` server. `npm start` runs it unchanged on Render, Fly,
  or a local machine.
- The only Vercel-specific artefact is `vercel.json` (rewrites + crons). On Render or Fly, the
  rewrite becomes a catch-all route and the cron becomes a platform cron or a GitHub Actions schedule.
- `public/**` works identically on every host — `express.static()` is used **in addition** for
  local development, and Vercel serves `public/**` itself.

In the demo, the deployment story is stated plainly: the API runs as a serverless function on Vercel;
the same Express application runs unchanged on a conventional Node host.

### 9.5 Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | Server only | Pooled Supabase Postgres connection string. **Never exposed to the client.** |
| `CRON_SECRET` | Server only | Authenticates cron calls to `/api/health` |
| `NODE_ENV` | Server only | `production` on deploy |

No other secrets exist. There is no auth, so there are no user secrets.

### 9.6 Repository and CI

- Repository: `https://github.com/Retr0-rgb-lab/RecallLab`, branch `main`.
- The remote was empty at the start of this work; the first commit seeds the lecture deck, this
  specification, and the design system.
- Vercel connects to the repository and deploys on every push to `main`.
- No CI pipeline in v1 beyond Vercel's own build. Adding one is a §2.3 candidate.

---

## 10. Performance

These are the Week 13 targets, and they are the acceptance criteria for §13.

| Metric | Target | How |
|---|---|---|
| Lighthouse Performance | ≥ 95 (mobile) | No framework, no images, ≤ 80KB JS, fonts ≤ 40KB |
| Lighthouse Accessibility | ≥ 95 | §11 |
| Lighthouse Best Practices | ≥ 95 | HTTPS, no console errors, correct meta |
| LCP | < 1.5s | Largest paint element is text; `font-display: swap` |
| CLS | < 0.05 | Fixed-height stage card, reserved grid rows, fonts do not reflow layout |
| INP | < 150ms | Animation on `transform`/`opacity` only; no long tasks on input |
| First-load JS | ≤ 80KB uncompressed | ES modules, no dependencies |
| First-load CSS | ≤ 30KB uncompressed | Four small files |
| Fonts | ≤ 40KB | Latin-subset woff2, self-hosted, preloaded |
| API — level fetch | 1 query | `nodes_parent_position_idx`; no N+1 |
| API — tree fetch | 1 query | Whole tree in one request for the spine |

Additional rules:

- No client-side framework runtime, ever.
- Images: the product uses inline SVG icons only. There are no raster assets in v1, so `LCP` is a text
  paint and there is nothing to lazy-load.
- The spine's whole-tree fetch is cached in memory for the session and refreshed on mutation.
- Every animation runs on the compositor. Animating `box-shadow` or `height` during an interaction is
  a defect, not a style choice.

---

## 11. Accessibility

| Requirement | Rule |
|---|---|
| Keyboard reachability | Every tile, button, and field is reachable by keyboard. The file page's grid is a list of buttons; Focus Mode traps focus inside the stage. |
| Drag has a keyboard equivalent | ↑/↓ move the focus between siblings; `Enter`/`Space` reveal; `Esc` ascends. No function is reachable only by dragging. |
| Focus visibility | A 2px `--accent` ring with a 2px offset, always visible on `:focus-visible`. |
| Contrast | Body text ≥ 7:1, secondary ≥ 4.5:1. The accent is never used for text on a light surface. |
| `prefers-reduced-motion` | Springs and flips become 120ms opacity cross-fades; the drag still works, without velocity inheritance. |
| Live region | The stage announces the focused node's title when focus moves, via `aria-live="polite"`. |
| Semantics | Cards are `<button>` in the grid and `<article>` on stage; the grid is a `<ul>`/`<li>` list. |
| Touch targets | Interactive elements are at least 44×44px on coarse pointers. |
| Zoom | Usable at 200% zoom without horizontal scrolling of the page body. |

---

## 12. Milestones

Mapped onto the course's 13 weeks. Each milestone is verifiable by the §13 checks that apply.

| Phase | Weeks | Deliverable | Exit criterion |
|---|---|---|---|
| P0 — Foundations | 1–2 | Repo, schema, seed script, API skeleton, static shell | `/api/nodes` returns the seeded tree |
| P1 — File page | 3–4 | Spine, breadcrumb, tiled grid, History API routing | A folder can be traversed by click, breadcrumb, spine, and browser back |
| P2 — Edit mode | 5–6 | Inline editing, create, delete with cascade, move, reorder | Full CRUD over the tree, enforced by §6.3 |
| P3 — Focus mode | 7–9 | Stage, stack, flip, drag-advance, PiP FSM, descend/ascend | The §4.2.6 state machine passes its gesture test matrix |
| P4 — Integration | 10–11 | Front-end ↔ API wiring, error states, empty states, seed content | Every mutation round-trips through the API and survives a reload |
| P5 — Deploy | 12 | Vercel deployment, custom domain, HTTPS, keep-alive cron | Public URL serves the app; `/api/health` returns `db: up` |
| P6 — Quality | 13 | Performance pass, accessibility pass, README, demo script | §10 metrics met; §13 checks pass |
| P7 — Submission | — | Outline PDF (`name_studentID_outline.pdf`), demo, final report | Submitted in the required format |

Risk: P3 is the schedule risk. The gesture state machine (§4.2.6) is the only part of the product
whose correctness is not obvious from the specification. Mitigation: it is prototyped first, on a
static fixture, before any API work is attached to it.

---

## 13. Verification plan

Every hard constraint in this document has a check. A constraint without a check is an intention.

| # | Constraint | Check |
|---|---|---|
| V-01 | The browser never talks to Supabase | DevTools network panel during a full edit session: every request is same-origin `/api/*`. No `supabase.co` host appears. |
| V-02 | The tree is stored in Postgres | `select count(*) from nodes;` against the deployed database matches the client's node count. |
| V-03 | CRUD is complete | Each of create, read, update, delete, move, reorder exercised against the deployed API; each returns its specified status code. |
| V-04 | Invariants hold under direct API abuse | `curl` each §6.3 violation; each returns the specified status code and the tree is unchanged. |
| V-05 | Deleting a folder cascades | Delete a folder with known descendants; the descendants are gone and the sibling levels are untouched. |
| V-06 | Focus Mode is a single card on stage | At every level, exactly one node renders as the focus; the stack shows ≤ 4 layers. |
| V-07 | Reveal shows the answer | Click flips the card; the answer is legible; clicking again flips back. |
| V-08 | Drag below the threshold does nothing | Drag 40px and release → the card returns to focus, the stack does not advance. |
| V-09 | Drag above the threshold advances | Drag 80px and release → the card leaves with gesture velocity; the next sibling rises to focus. |
| V-10 | Hold produces a floating window | Hold 500ms → the card lifts out and docks above the focused card; focus moves to the next sibling. |
| V-11 | The floating window is draggable and stays | Drag it 200px and release → it remains at the drop position. |
| V-12 | `Esc` precedence | With a floating window open: first `Esc` closes it, second ascends a level, third exits Focus Mode. |
| V-13 | Focusing a folder descends | Activate a focused folder → the stage shows that folder's children and the breadcrumb updates. |
| V-14 | No review data exists | The schema has no review/seen column; the API response for a node contains no such field. |
| V-15 | Deep links work | Open `/f/:id?focus=:id` in a fresh tab → the app opens at that level, in that focus state. |
| V-16 | Back button equals "up" | After drilling three levels, browser back returns through the levels in reverse. |
| V-17 | Focus Mode records nothing | Interact with the stage, then query the database → row count and row contents are unchanged. |
| V-18 | The app survives a redeploy | Push a commit, wait for the deploy, reload → the tree is intact (proves the DB is not on the ephemeral filesystem). |
| V-19 | The keep-alive works | `vercel cron` logs show a daily `/api/health` invocation; Supabase shows the project active. |
| V-20 | Static assets serve in production | Every asset loads over HTTPS with 200; `express.static()` is not relied upon. |
| V-21 | Performance targets | Lighthouse on the deployed URL, mobile preset: the §10 table's thresholds are met. |
| V-22 | Keyboard parity | Complete a full review pass without a mouse: reveal, advance, descend, ascend, edit. |
| V-23 | Reduced motion | With `prefers-reduced-motion: reduce` emulated, all transitions are cross-fades and nothing breaks. |
| V-24 | XSS safety | Create a card whose body contains `<script>` and `onerror=` payloads → both render as literal text. |

---

## 14. Risks and open items

| # | Item | Impact | Handling |
|---|---|---|---|
| R-01 | Supabase free tier pauses the project | High — the graded URL appears broken | Daily keep-alive cron (§9.3) + README backstop + resume before the demo |
| R-02 | The gesture FSM is subtle | High — a broken Focus Mode sinks the project's differentiator | Prototype first on a static fixture; V-08…V-13 as the acceptance matrix |
| R-03 | The course's full project brief (lab column) has not been read | Medium — may contain requirements this spec misses | **Open.** Obtain the course overview and check this spec against it before P0 |
| R-04 | Vercel Function + `express.static()` | Medium — static assets 404 in production | Documented twice (§7.1, §9.1) and checked by V-20 |
| R-05 | P3 (Focus Mode) is 3 weeks of a 13-week course | Medium | P3 prototyped in P0/P1 slack; P6 quality work is the only thing cut first if late |
| R-06 | Group membership and student IDs unknown | Low — blocks only the outline PDF | **Resolved 2026-10-24.** Single member: Huang Haoran, 24101322D. Outline produced. |

### Open items

1. The full COMP3421 final-project brief (the "lab" column of the course overview) — to validate §2.
2. ~~Group members, student IDs, and the final project title~~ — **resolved 2026-10-24**: Huang Haoran,
   24101322D; title as recorded in §1.3.
3. Whether the course requires a particular database among the permitted set. Supabase is Postgres and
   is on the permitted list; confirm if the brief narrows it.

---

## Appendix A — Reference material

| Subject | Source |
|---|---|
| Course content and stack | `docs/Lecture_01_Overview.pptx` (29 slides, COMP3421 Lecture 01) |
| PiP state machine, drag thresholds, geometry | `Retr0-rgb-lab/Soit` — `知识库/docs/card-pip-fsm.md`, `知识库/docs/card-motion-locus.md`, `src/lib/cardDragNav.ts`, `src/lib/cardPip.ts`, `src/lib/orbitLayout.ts` |
| Express on Vercel | <https://vercel.com/docs/frameworks/backend/express> (updated 2026-08-10) |
| Vercel limits | <https://vercel.com/docs/limits> (updated 2026-09-16) |
| Vercel cron pricing and Hobby limits | <https://vercel.com/docs/cron-jobs/usage-and-pricing> (updated 2026-07-15) |
| Supabase free-plan pausing | <https://supabase.com/docs/guides/platform/free-project-pausing> |
| Repository | <https://github.com/Retr0-rgb-lab/RecallLab> |

## Appendix B — What this spec deliberately leaves open

| Question | Deferred to | Why |
|---|---|---|
| Exact card prompts and answers for every lecture | The outline deliverable | Content work, not design; depends on the outline's own requirements |
| Search implementation | §2.3 | No rubric requirement; adds query complexity |
| Touch parity for Focus Mode | §4.2.8 | Mouse-first is the correct trade for the gesture semantics |
| Import from PPTX | §2.3 | Would reopen D-02 |
