# Design System: RecallLab

> Companion to [`2026-10-24-recalllab-design.md`](./2026-10-24-recalllab-design.md).
> This document is the **visual and motion contract** for RecallLab. Where it and the design spec
> disagree, the design spec wins and this file must be amended in the same change.
> Every value here is load-bearing: changing one is a design change, not a preference.

---

## 1. Visual Theme & Atmosphere

**A cold, instrumented file system that turns into a stage.**

RecallLab has two registers and they are deliberately, visibly different:

- **Browse** is a file system. Pale, flat, dense, quiet — a grid of tiles under a spine, where the
  only thing that should catch the eye is the thing you are about to open.
- **Focus** is a stage. Near-black, empty, one object lit at a time, everything else pushed back into
  the dark. The screen stops being a window onto data and becomes the object of attention.

The transition between them is the product's central gesture, and it is worth spending motion budget
on. Nothing else in the interface is allowed to be dramatic.

| Axis | Value | Reading |
|---|---|---|
| **Density** | 5 — *Daily App Balanced* | Enough tiles to feel like a folder, few enough to scan in one pass. Not an art gallery, not a cockpit. |
| **Variance** | 4 — *Predictable Symmetric* | A file system is predictable by definition. The grid is uniform; hierarchy comes from position, scale, and shadow, never from surprise. |
| **Motion** | 8 — *Cinematic Choreography* | Motion is the primary carrier of meaning here. Cards are thrown, caught, lifted, and docked. Timing is the difference between "animated" and "smooth". |

**Atmosphere in one line:** the quiet of a well-organised desk, and then the hush of a single lamp
turned on in a dark room.

**Anti-goal.** This is emphatically not a "study app" aesthetic. No rounded-pill buttons in candy
colours, no progress rings, no streak counters, no achievement badges, no gradient hero, no mascot.
The product earns its delight from physicality and precision, not from decoration.

---

## 2. Colour Palette & Roles

One neutral family (Zinc) is used at two lightnesses. There is exactly **one accent**, and it is
warm.

### 2.1 Browse register — light

| Token | Hex | Role |
|---|---|---|
| `--canvas` | `#FAFAFA` | Application background, the sheet the tiles sit on |
| `--surface` | `#FFFFFF` | Tile fill, input fill, panel fill |
| `--surface-hover` | `#F4F4F5` | Tile hover, pressed state, inactive chip |
| `--surface-sunken` | `#F4F4F5` | Spine background, inset wells |
| `--hairline` | `#E4E4E7` | 1px tile borders, dividers, input borders |
| `--hairline-strong` | `#D4D4D8` | Focused input border, active divider |
| `--ink` | `#18181B` | Primary text; **primary CTA fill** |
| `--ink-2` | `#52525B` | Secondary text, card body preview, metadata |
| `--ink-3` | `#A1A1AA` | Placeholder text, inactive icons, disabled labels |
| `--ink-inverse` | `#FAFAFA` | Text on `--ink` fill |

### 2.2 Focus register — dark

| Token | Hex | Role |
|---|---|---|
| `--canvas` | `#0B0B0C` | Stage background. **Never `#000000`.** |
| `--surface` | `#17171A` | Focused card fill, floating window fill |
| `--surface-hover` | `#1F1F23` | Floating window header hover |
| `--hairline` | `#27272A` | Card border, floating window border |
| `--ink` | `#FAFAFA` | Focused card title, revealed answer |
| `--ink-2` | `#D4D4D8` | Card body on stage |
| `--ink-3` | `#A1A1AA` | Unrevealed answer, secondary stage metadata |
| `--ink-inverse` | `#0B0B0C` | Text on `--ink` fill |

### 2.3 The single accent

| Token | Hex | Role |
|---|---|---|
| `--accent` | `#E8A33D` | Focus rings, active mode indicator, the focused card's edge marker, the "unsaved" pulse |
| `--accent-dim` | `#B87C2A` | Accent on a light surface where a ring needs lower prominence |

**Rules for the accent:**

- It appears on **rings, edges, dots, and indicators** — never as a large filled area on a light
  surface, and **never as body text on a light surface** (contrast against `#FFFFFF` is 2.0:1, which
  fails). On the dark stage it reaches 8:1 and may carry text.
- The **primary CTA is `--ink`**, not the accent: a near-black fill with `--ink-inverse` text. A dark
  button on a pale field reads as "press this"; an amber button reads as "notification".
- Because the accent is the only warm hue in a cold system, **any warm pixel on screen means
  "attention is here"**. That is a load-bearing signal; do not spend it on decoration.
- Exactly one accent on screen at a time in browse mode (the active mode indicator). In focus mode,
  the accent marks the focused card's leading edge only.

**Forbidden:** purple, neon, any glow, any gradient fill, any multi-colour status system. The system
has no "success green" or "warning red" — a card is either in the tree or it is not.

---

## 3. Typography Rules

### 3.1 Families

| Role | Stack | Notes |
|---|---|---|
| Display / titles | `Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | Self-hosted latin-subset woff2, ≤ 40KB, `font-display: swap`, preloaded |
| Body | `Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | Same family as display |
| CJK | `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif` | **System stack only. Never a webfont.** |
| Mono | `"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace` | Paths, counts, positions, timestamps, IDs |

**Why no CJK webfont.** A reasonable Chinese webfont subset is 5–15MB. RecallLab has a hard
performance budget (§10 of the design spec) and a Lighthouse target of ≥ 95. The system CJK stack
costs zero bytes and renders correctly on the platforms this will be judged on. Latin typography —
which carries the hierarchy, the numbers, and the mono path display — is self-hosted and deliberate.

**Banned:** `Inter` (generic, ubiquitous, no character); all generic serifs (`Times New Roman`,
`Georgia`, `Garamond`, `Palatino`); and serif of any kind in this interface — RecallLab is a software
UI, and a serif would put it in the reading-mood category it explicitly is not.

### 3.2 Scale

| Token | Size / line-height | Weight | Tracking | Use |
|---|---|---|---|---|
| `--t-stage-title` | 26px / 1.3 | 600 | -0.02em | Focused card title on stage |
| `--t-title` | 17px / 1.35 | 600 | -0.01em | Spine node, breadcrumb current segment |
| `--t-tile` | 15px / 1.4 | 500 | 0 | Tile title |
| `--t-body` | 16px / 1.6 | 400 | 0 | Card body on stage |
| `--t-body-sm` | 14px / 1.55 | 400 | 0 | Card body in browse mode, secondary panel text |
| `--t-preview` | 13px / 1.45 | 400 | 0 | Tile body preview (single line, ellipsis) |
| `--t-label` | 12px / 1.3 | 500 | 0.04em, uppercase | Field labels, section captions |
| `--t-mono` | 13px / 1.4 | 400 | 0 | Paths, counts, IDs |

Body copy is capped at **65 characters per line**. Paragraph measure on the stage is capped at
`62ch` regardless of card width.

### 3.3 Rules

- Hierarchy comes from **weight, size, and colour**, never from size alone. Nothing in this product
  is huge.
- The mono face is not decoration — it is the file-system voice. It appears exactly where a file
  system would show a path, a count, or an identifier.
- Numerals in tables, counts, and positions are always mono and always tabular-figure aligned
  (`font-variant-numeric: tabular-nums`), so numbers do not jitter when they change.

---

## 4. Component Stylings

### 4.1 Tiles (the file page)

The file page's only content type. A tile is a folder or a card.

- **Shape:** 14px radius, `--surface` fill, 1px `--hairline` border, 16px internal padding.
- **Elevation:** `--e0` at rest; `--e1` on hover (a 1px lift — `translateY(-1px)` plus the shadow
  step); `--e2` while dragged.
- **Content:** 20px kind icon (inline SVG, `--ink-3` at rest / `--ink-2` on hover), title
  (`--t-tile`, two lines, ellipsis), and for cards a one-line body preview (`--t-preview`,
  `--ink-2`, ellipsis).
- **Icons:** folders and cards are visually distinct — a folder is a filled outline, a card is a
  ruled sheet. **Never** emoji. The distinction must survive a greyscale screenshot.
- **Grid:** `repeat(auto-fill, minmax(220px, 1fr))`, 16px gap, 24px padding, max-width 1400px centred.

### 4.2 Buttons

- **Primary:** `--ink` fill, `--ink-inverse` text, 10px radius, 8px/14px padding, `--t-body-sm`.
  Tactile press feedback: `translateY(1px)` on `:active`, no outer glow, no scale bounce.
- **Secondary / ghost:** transparent fill, 1px `--hairline-strong` border, `--ink` text.
- **Icon button:** 32×32 (44×44 on coarse pointers), transparent fill, `--ink-2` icon, `--surface-hover`
  fill on hover.
- **Forbidden:** neon glow, gradient fill, pill shape on anything except a status dot, a shadow that
  scales on hover.

### 4.3 Inputs

- Label above, 12px uppercase `--ink-2`. Helper text optional, below.
- Fill `--surface`, 1px `--hairline` border, 10px radius, 8px/12px padding.
- `:focus-visible` → 2px `--accent` ring at 2px offset. The accent is used here because it is a ring.
- Error: 1px `#B42318` border, message below in the same red, 13px. This is the **only** place a
  second colour may appear, and only as a functional error signal.
- Placeholder `--ink-3`. Placeholder is never the only label.

### 4.4 Spine

- Width 240px, collapsible to 0. `--surface-sunken` background, `--hairline` right border.
- Indentation 14px per level. Each row: 16px kind icon (14px), title (`--t-title`), chevron for
  folders with children.
- Current path: `--ink` text, `--accent` 2px left bar. Hover: `--surface-hover` row fill.
- Depth is clipped visually past 4 levels with a "…" affordance rather than an unbounded indent.

### 4.5 Breadcrumb bar

- 48px tall, `--canvas` background, `--hairline` bottom border.
- Segments separated by `›` in `--ink-3`. Non-final segments are `--ink-2` and clickable; the final
  segment is `--ink` and is not a link.
- Long paths truncate from the **left** (the root is the informative end), keeping the current
  segment always visible.

### 4.6 The focused card (stage)

- `width: min(720px, 100vw - 96px)`, `min-height: 320px`, 20px radius, `--surface` fill,
  `--hairline` border, `--e3` shadow.
- **Leading-edge marker:** a 3px `--accent` bar on the card's left edge, full height, 6px radius.
  This is the only place the accent appears in focus mode.
- Title `--t-stage-title`, body `--t-body`, answer `--t-ink-3` until revealed then `--ink`.
- The answer block is separated by a 1px `--hairline` rule, not by whitespace alone.
- Empty answer → a 13px `--ink-3` line, "No answer recorded".

### 4.7 Floating window (PiP)

- `width: min(440px, max(320px, 100vw × 0.34))`, `height: min(300px, max(220px, width × 0.68))`.
- 16px radius, `--surface` fill, `--hairline` border, `--e3` shadow.
- A 32px header strip with a grab affordance and the card's title (13px, `--ink-2`); the body area
  shows the card's face.
- **Default dock:** horizontally centred over the focused card, **above** it, 16px gap. If that
  overflows the viewport top, it docks below instead. Always clamped 16px inside the viewport.
- Draggable by the header only. Dragging is 1:1 and runs no transition.

### 4.8 Stack layers

| Layer | Offset Y | Scale | Shadow |
|---|---|---|---|
| Focus (0) | 0 | 1.000 | `--e3` |
| 1 | 12px | 0.975 | `--e2` |
| 2 | 24px | 0.950 | `--e1` |
| 3 | 36px | 0.925 | `--e0` |
| 4+ | hidden | — | — |

### 4.9 Shadow ladder

| Token | Light value | Dark value |
|---|---|---|
| `--e0` | none | none |
| `--e1` | `0 1px 2px rgba(24,24,27,.06), 0 1px 1px rgba(24,24,27,.04)` | `0 1px 2px rgba(0,0,0,.35)` |
| `--e2` | `0 4px 12px rgba(24,24,27,.08), 0 1px 3px rgba(24,24,27,.05)` | `0 4px 14px rgba(0,0,0,.45)` |
| `--e3` | `0 12px 32px rgba(24,24,27,.12), 0 2px 8px rgba(24,24,27,.06)` | `0 16px 40px rgba(0,0,0,.55)` |

Shadows are tinted toward the surface hue, never pure black on a light surface.

### 4.10 Loading, empty, error

- **Loading:** skeleton blocks matching the exact dimensions of the tiles they replace, with a 1.4s
  shimmer sweep. **Never** a circular spinner.
- **Empty:** a composed, illustrated state — the tile grid's own footprint drawn as faint outlines,
  one line of copy, and a single primary action ("New card"). Not the words "No data".
- **Error:** inline and specific. A failed mutation surfaces at the field that failed; a failed
  fetch surfaces as a banner that names the operation and offers a retry. Never a console-only
  failure.
- **Database unreachable** (the paused-Supabase case): a full-width banner naming the cause and the
  fix — "The database is paused. Resume the project in Supabase." — because this is a real,
  expected state of the deployment (§9.2–9.3 of the design spec), not an edge case.

---

## 5. Layout Principles

- **Two registers, one system.** The same token names map to different values in light and dark
  (`--canvas`, `--surface`, `--ink`, `--hairline`). Components never hard-code a colour; they read
  tokens, so the register swap is one attribute on a root element.
- **CSS Grid over Flexbox arithmetic.** No `calc()` percentage hacks. The tile grid is
  `repeat(auto-fill, minmax(220px, 1fr))`; the stage is a centred grid cell.
- **Contain width.** Content regions are capped at 1400px and centred. The stage breaks the cap
  deliberately (it is a single object, not a layout).
- **No overlapping elements.** Every element occupies its own clean zone. The floating window is the
  one deliberate exception — it is a layered overlay, it is draggable, and it never covers the
  focused card's title or answer.
- **The page body never scrolls.** The file page scrolls its grid region (`overflow-y: auto` inside a
  fixed-height shell); focus mode does not scroll at all. `min-height: 100dvh`, never `100vh`.
- **Responsive:** below 768px the spine collapses to a drawer, the tile grid drops to a single
  column, and focus mode switches to the degraded touch behaviour (tap-only). Below 480px the stage
  card goes edge-to-edge with 16px insets.

---

## 6. Motion & Interaction

Motion carries the product's meaning. A card that is thrown must look thrown. A card that is lifted
must look lifted. Nothing moves on a curve that does not correspond to a physical event.

### 6.1 Timing constants

| Constant | Value | Applies to |
|---|---|---|
| `--t-hover` | 120ms `ease-out` | Hover, press, chip states |
| `--t-focus-ring` | 160ms `ease-out` | Focus ring appearance |
| `--t-flip` | 320ms `cubic-bezier(.22,1,.36,1)` | Card flip (reveal answer) |
| `--t-move` | spring — stiffness 110, damping 22, mass 1 | Stack rise, PiP enter/exit, mode transitions |
| `--t-mode` | 420ms `cubic-bezier(.22,1,.36,1)` | File page ⇄ stage transition |
| `--hold-ms` | 450 | Hold duration that lifts a card into a floating window |
| `--drag-threshold-px` | 56 | Displacement that classifies a gesture as a drag |
| `--hold-slop-px` | 8 | Maximum movement during the 450ms hold |
| `--flick-velocity` | 0.35 px/ms | Release velocity that classifies a throw |

### 6.2 Physics

- **Springs, not durations, for anything that follows a gesture.** A spring has no fixed end time, so
  it absorbs velocity variation naturally: a hard throw and a gentle nudge both settle correctly.
- **Velocity is inherited.** When a card is released, the gesture's velocity seeds the spring that
  settles the next card into focus. This is the single most important rule for the product feeling
  alive rather than mechanical.
- **Critically damped by default** (damping ratio ≈ 0.88). No overshoot on layout transitions; a
  single small overshoot is acceptable on the PiP lift, where the physical read of "picked up" wants
  it.
- **Dragging runs no transition at all.** Position is written from pointer coordinates every frame.
  A transition active during a drag produces lag, and lag is the exact opposite of silk.

### 6.3 Performance rules

- Animate **only** `transform` and `opacity`. `width`, `height`, `top`, `left`, `margin`, and
  `box-shadow` are never animated during an interaction.
- Promote to a compositor layer only while animating; remove `will-change` afterwards so it does not
  hold memory.
- `contain: layout paint` on tiles and cards.
- A grain/noise filter, if ever added, lives on a fixed pseudo-element and is never animated.
- The page must hold 60fps during a drag on a mid-range laptop. If it does not, the cause is a
  layout read in the pointer handler — not a missing optimisation.

### 6.4 Perpetual motion — deliberately minimal

The standard design-system playbook puts an ambient loop on every active component. **RecallLab does
not.** A looping glow inside a focus stage competes for the attention the stage exists to concentrate,
and on a recall task that competition is a correctness problem, not an aesthetic one.

Exactly two perpetual animations exist:

| Where | Animation | Duration |
|---|---|---|
| Skeleton loading blocks | Shimmer sweep | 1.4s loop |
| "Unsaved changes" dot | Opacity pulse | 2s loop |

Everything else is event-driven and settles.

### 6.5 Staggered reveals

Lists are not mounted instantly. When a level loads, its tiles fade and rise in sequence, staggered
**24ms apart, capped at 8 tiles** (the remainder appear together). The cap prevents a 60-tile level
from taking longer to become usable than the network took to deliver it.

### 6.6 Reduced motion

`prefers-reduced-motion: reduce` replaces every spring, flip, and mode transition with a **120ms
opacity cross-fade**. The gestures keep working — hold still lifts the card, drag still advances —
but nothing travels, bounces, or inherits velocity.

---

## 7. Anti-Patterns (Banned)

### Colour
- No pure black (`#000000`) — use `#0B0B0C`.
- No neon, no glow, no outer shadow bloom.
- No purple/blue neon accent, no gradient fills, no gradient text.
- No second accent colour. No green "success" / red "danger" system — a card is either in the tree or
  it is not. (The single functional error red in §4.3 is the only exception.)
- No warm/cool grey drift: one neutral family, two lightnesses.

### Type
- No `Inter`.
- No generic serifs (`Times New Roman`, `Georgia`, `Garamond`, `Palatino`) — and no serif at all in
  this interface.
- No self-hosted CJK webfont.
- No text below 12px. No body text longer than 65 characters per line.

### Layout
- No overlapping elements. The floating window is the only layered overlay, and it never covers the
  focused card's content.
- No flexbox percentage math, no `calc()` layout hacks.
- No `100vh` — use `100dvh`.
- No horizontal scroll on any viewport.
- No unbounded indentation in the spine.

### Motion
- No animated `width` / `height` / `top` / `left` / `box-shadow` during interaction.
- No transition active during a drag.
- No linear easing.
- No ambient loop animation outside the two listed in §6.4.
- No bounce, no squash-and-stretch, no confetti.

### Content
- No emoji anywhere — inline SVG icons only.
- No generic placeholder names ("John Doe", "Acme", "Nexus", "Folder 1", "Card 1"). The seed tree
  contains real COMP3421 course structure.
- No fake round numbers ("99.99%", "50% success rate") — there are no statistics in this product.
- No AI-copywriting clichés: "Elevate", "Seamless", "Unleash", "Next-Gen", "Dive in", "Unlock".
- No filler UI text: no "Scroll to explore", no bouncing chevrons, no "Click here to continue".
- No emoji-as-icon, no decorative illustrations in the file page.

### Pattern-level bans, and their scope

Some of the standard playbook's bans target marketing pages rather than software. This product is
software, so:

- **Hero section rules do not apply.** RecallLab has no landing page, no hero, no CTA block. Its
  first screen is the root level of the tree. A home screen with a greeting, a feature pitch, and a
  "Get started" button is exactly the thing this product must not have.
- **The "no 3-column equal card grid" ban applies to feature rows, not to the file grid.** The tiled
  grid of folders and cards is a functional grid modelled on a file manager; it is uniform by design
  and by intent.
- **Inline image typography does not apply.** RecallLab ships no raster images in v1; every visual
  element is type, border, shadow, or inline SVG. There are no photos to place between words.

---

## 8. Quick reference

```css
:root {                       /* browse register */
  --canvas: #FAFAFA;
  --surface: #FFFFFF;
  --surface-hover: #F4F4F5;
  --surface-sunken: #F4F4F5;
  --hairline: #E4E4E7;
  --hairline-strong: #D4D4D8;
  --ink: #18181B;
  --ink-2: #52525B;
  --ink-3: #A1A1AA;
  --ink-inverse: #FAFAFA;
  --accent: #E8A33D;
  --accent-dim: #B87C2A;

  --e0: none;
  --e1: 0 1px 2px rgba(24,24,27,.06), 0 1px 1px rgba(24,24,27,.04);
  --e2: 0 4px 12px rgba(24,24,27,.08), 0 1px 3px rgba(24,24,27,.05);
  --e3: 0 12px 32px rgba(24,24,27,.12), 0 2px 8px rgba(24,24,27,.06);

  --t-hover: 120ms;  --t-focus-ring: 160ms;
  --t-flip: 320ms;   --t-move: 320ms;   --t-mode: 420ms;
  --hold-ms: 450;    --drag-threshold-px: 56;   --flick-velocity: .35;
}

[data-register="stage"] {    /* focus register */
  --canvas: #0B0B0C;
  --surface: #17171A;
  --surface-hover: #1F1F23;
  --hairline: #27272A;
  --ink: #FAFAFA;
  --ink-2: #D4D4D8;
  --ink-3: #A1A1AA;
  --e1: 0 1px 2px rgba(0,0,0,.35);
  --e2: 0 4px 14px rgba(0,0,0,.45);
  --e3: 0 16px 40px rgba(0,0,0,.55);
}
```
