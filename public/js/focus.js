/**
 * RecallLab — Focus Mode (contracts §4.5, §5.2; design §4.2; visual-system §4.6–§4.8).
 *
 * `focus.js` owns the stage DOM inside `#stage-root` and the PiP state machine.
 * It never records anything: no review data, no counters, no storage.
 */

import { store } from './store.js';
import { attachCardGestures, GESTURE } from './gestures.js';

/* ---------------------------------------------------------------------------
 * Constants (contracts §8 — copy these values, do not re-derive them)
 * ------------------------------------------------------------------------ */

const MAX_STACK_LAYERS = 4; // focus + 3 siblings
const PIP_GAP = 16; // dock gap above the focused card
const VIEWPORT_MARGIN = 16; // clamp margin inside the viewport
const PIP_WIDTH_MIN = 320;
const PIP_WIDTH_MAX = 440;
const PIP_WIDTH_RATIO = 0.34;
const PIP_HEIGHT_MIN = 220;
const PIP_HEIGHT_MAX = 300;
const PIP_HEIGHT_RATIO = 0.68;

/** `--t-move` in the design system is this spring (stiffness 110, damping 22, mass 1). */
const SPRING = Object.freeze({ stiffness: 110, damping: 22, mass: 1 });
const REDUCED_MOTION_MS = 120;
const THROW_MARGIN = 240;

/* ---------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------ */

const state = {
  active: false,
  levelId: null, // folder whose children are on stage (null = root)
  focusedId: null,
  flipped: false,
  stage: null,
  stackEl: null,
  pipsEl: null,
  rootEl: null,
  cards: new Map(), // node id -> card element
  floatingEls: new Set(), // card elements kept alive for an in-flight gesture
  flyingEls: new Set(), // card elements thrown off the stage
  pips: [],
  pipZ: 10,
  gestureEl: null,
  gestureDetach: null,
  gestureMachine: null,
  unsubscribe: null,
  keyHandler: null,
  dragging: false,
};

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

const clamp = (value, min, max) => {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
};

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isCoarsePointer() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

const levelNodes = () => store.getChildren(state.levelId) || [];

const focusedNode = () => (state.focusedId ? store.getNode(state.focusedId) : undefined);

function viewportWidth() {
  return typeof window !== 'undefined' ? window.innerWidth : 0;
}

function viewportHeight() {
  return typeof window !== 'undefined' ? window.innerHeight : 0;
}

function pipWidth() {
  return Math.min(
    PIP_WIDTH_MAX,
    Math.max(PIP_WIDTH_MIN, viewportWidth() * PIP_WIDTH_RATIO),
  );
}

function pipHeight(width) {
  return Math.min(PIP_HEIGHT_MAX, Math.max(PIP_HEIGHT_MIN, width * PIP_HEIGHT_RATIO));
}

/* ---------------------------------------------------------------------------
 * Spring + animation loop
 * ------------------------------------------------------------------------ */

function createSpring(options = {}) {
  const { stiffness, damping, mass } = { ...SPRING, ...options };
  return {
    stiffness,
    damping,
    mass,
    restDistance: 0.5,
    restVelocity: 6,
    x: 0,
    y: 0,
    s: 1,
    vx: 0,
    vy: 0,
    vs: 0,
    targetX: 0,
    targetY: 0,
    targetS: 1,
    step(dtMs) {
      const dt = Math.min(Math.max(dtMs, 1), 34) / 1000;
      const k = this.stiffness;
      const c = this.damping;
      const m = this.mass;
      const ax = (-k * (this.x - this.targetX) - c * this.vx) / m;
      const ay = (-k * (this.y - this.targetY) - c * this.vy) / m;
      const as = (-k * (this.s - this.targetS) - c * this.vs) / m;
      this.vx += ax * dt;
      this.vy += ay * dt;
      this.vs += as * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.s += this.vs * dt;
    },
    get settled() {
      return (
        Math.abs(this.x - this.targetX) < this.restDistance &&
        Math.abs(this.y - this.targetY) < this.restDistance &&
        Math.abs(this.s - this.targetS) < 0.002 &&
        Math.abs(this.vx) < this.restVelocity &&
        Math.abs(this.vy) < this.restVelocity &&
        Math.abs(this.vs) < this.restVelocity
      );
    },
  };
}

const animations = new Set();
let rafId = null;

function animate(animation) {
  animation.lastTime = now();
  animation.finished = false;
  animations.add(animation);
  if (rafId === null) rafId = requestAnimationFrame(stepAnimations);
}

function stepAnimations(timestamp) {
  rafId = null;
  for (const animation of Array.from(animations)) {
    const dt = timestamp - animation.lastTime;
    animation.lastTime = timestamp;
    animation.spring.step(dt);
    animation.apply(animation.spring);
    if (animation.finished || animation.spring.settled) {
      animations.delete(animation);
      animation.onDone?.();
    }
  }
  if (animations.size > 0) rafId = requestAnimationFrame(stepAnimations);
}

function cancelAnimationsFor(el) {
  for (const animation of Array.from(animations)) {
    if (animation.el === el) animations.delete(animation);
  }
}

/** 120ms opacity tween — the reduced-motion substitute for every spring. */
function fade(el, from, to, duration = REDUCED_MOTION_MS, onDone) {
  const start = now();
  const step = (timestamp) => {
    const t = Math.min(1, (timestamp - start) / duration);
    el.style.opacity = String(from + (to - from) * t);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      el.style.opacity = '';
      onDone?.();
    }
  };
  requestAnimationFrame(step);
}

/* ---------------------------------------------------------------------------
 * FLIP helpers
 * ------------------------------------------------------------------------ */

function resetFlip(el) {
  el.style.setProperty('--flip-x', '0px');
  el.style.setProperty('--flip-y', '0px');
  el.style.setProperty('--flip-scale', '1');
  el.style.setProperty('--flip-rotate', '0deg');
}

/**
 * Spring an element from its current delta back to the neutral position.
 * `velocity` is in px/ms (gesture units) and is converted to px/s.
 */
function springFlip(el, { x, y, s = 1 }, velocity = { vx: 0, vy: 0 }, onDone) {
  const spring = createSpring();
  spring.x = x;
  spring.y = y;
  spring.s = s;
  spring.vx = (velocity.vx || 0) * 1000;
  spring.vy = (velocity.vy || 0) * 1000;
  el.classList.add('is-animating');
  animate({
    el,
    spring,
    apply: (sp) => {
      el.style.setProperty('--flip-x', `${sp.x}px`);
      el.style.setProperty('--flip-y', `${sp.y}px`);
      el.style.setProperty('--flip-scale', String(sp.s));
    },
    onDone: () => {
      el.classList.remove('is-animating');
      resetFlip(el);
      onDone?.();
    },
  });
}

/* ---------------------------------------------------------------------------
 * Stage + card rendering
 * ------------------------------------------------------------------------ */

function mountStage(root) {
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.id = 'stage';
  stage.setAttribute('role', 'region');
  stage.setAttribute('aria-label', 'Focus stage');
  stage.tabIndex = -1;

  const stack = document.createElement('div');
  stack.className = 'stage-stack';

  const pips = document.createElement('div');
  pips.className = 'stage-pips';

  stage.appendChild(stack);
  stage.appendChild(pips);
  root.appendChild(stage);

  state.stage = stage;
  state.stackEl = stack;
  state.pipsEl = pips;
}

function unmountStage() {
  if (state.gestureDetach) {
    state.gestureDetach();
    state.gestureDetach = null;
  }
  state.gestureEl = null;
  state.gestureMachine = null;
  state.cards.clear();
  state.floatingEls.clear();
  state.flyingEls.clear();
  state.pips = [];
  if (state.stage && state.stage.parentNode) state.stage.parentNode.removeChild(state.stage);
  state.stage = null;
  state.stackEl = null;
  state.pipsEl = null;
}

function createCardElement(node) {
  const article = document.createElement('article');
  article.className = 'stage-card';
  article.dataset.id = node.id;
  article.dataset.depth = '0';

  const inner = document.createElement('div');
  inner.className = 'stage-card-inner';

  const front = document.createElement('div');
  front.className = 'stage-card-face stage-card-front';

  const title = document.createElement('h2');
  title.className = 'stage-card-title';
  // The hook lives INSIDE the styled element, exactly as the file page does it
  // (contracts §5.3): the container keeps the card's typography, the hook is
  // the text `edit.js` turns into an input.
  const titleHook = document.createElement('span');
  titleHook.dataset.edit = 'title';
  title.appendChild(titleHook);

  const body = document.createElement('div');
  body.className = 'stage-card-body';

  const text = document.createElement('span');
  text.className = 'stage-card-text';
  text.dataset.edit = 'body';

  const emptyAnswer = document.createElement('p');
  emptyAnswer.className = 'stage-card-no-answer';
  emptyAnswer.hidden = true;
  emptyAnswer.textContent = 'No answer recorded';

  body.appendChild(text);
  body.appendChild(emptyAnswer);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'stage-card-delete';
  remove.dataset.action = 'delete';
  remove.dataset.gestureIgnore = '';
  remove.setAttribute('aria-label', `Delete ${node.title}`);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'stage-card-dismiss';
  dismiss.dataset.gestureIgnore = '';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss this card and move to the next');

  dismiss.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    dismissFocused();
  });

  front.appendChild(title);
  front.appendChild(body);
  front.appendChild(remove);
  front.appendChild(dismiss);

  const back = document.createElement('div');
  back.className = 'stage-card-face stage-card-back';

  // The answer has a surface of its own — the back of the card — so it needs
  // no hidden container here: the file page hides its answer because the file
  // page has nowhere to show it.
  const answer = document.createElement('div');
  answer.className = 'stage-card-answer';
  const answerHook = document.createElement('span');
  answerHook.dataset.edit = 'answer';
  answer.appendChild(answerHook);

  back.appendChild(answer);

  inner.appendChild(front);
  inner.appendChild(back);
  article.appendChild(inner);

  return article;
}

/**
 * A hook that `edit.js` has turned into a real editor must not be
 * overwritten: `edit.js` keeps the hook element and mounts the input inside
 * it (marking it `is-editing-field`), so writing to it would throw the
 * editor away mid-edit.
 *
 * This is the same convention the file page uses (`filepage.js`).
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

function updateCardContent(el, node) {
  const titleHook = el.querySelector('[data-edit="title"]');
  const bodyHook = el.querySelector('[data-edit="body"]');
  const answerHook = el.querySelector('[data-edit="answer"]');
  const emptyAnswer = el.querySelector('.stage-card-no-answer');
  const remove = el.querySelector('.stage-card-delete');

  const answerText = (node.answer || '').trim();
  const hasAnswer = answerText.length > 0;

  if (titleHook && !isEditingHook(titleHook)) titleHook.textContent = node.title || '';
  if (bodyHook && !isEditingHook(bodyHook)) bodyHook.textContent = node.body || '';
  if (answerHook && !isEditingHook(answerHook)) answerHook.textContent = answerText;

  if (node.kind === 'folder') {
    // A folder has no answer, so "No answer recorded" would be nonsense here.
    // The line earns its place only when the folder really is empty — that is
    // also the feedback for the one case where descending cannot happen.
    const kids = store.getChildren(node.id) || [];
    emptyAnswer.textContent = 'This folder is empty — add a card in Edit Mode.';
    emptyAnswer.hidden = kids.length > 0;
  } else {
    emptyAnswer.textContent = 'No answer recorded';
    emptyAnswer.hidden = hasAnswer;
  }
  if (remove) remove.setAttribute('aria-label', `Delete ${node.title}`);
}

/** The nodes that make up the visible stack: the focused card + 3 siblings. */
function stackNodes() {
  const nodes = levelNodes();
  const index = nodes.findIndex((node) => node.id === state.focusedId);
  if (index < 0) {
    const node = focusedNode();
    return node ? [node] : [];
  }
  return nodes.slice(index, index + MAX_STACK_LAYERS);
}

function renderStack() {
  const stackEl = state.stackEl;
  if (!stackEl) return;

  const nodes = stackNodes();
  const wanted = new Set();

  nodes.forEach((node, depth) => {
    wanted.add(node.id);
    let el = state.cards.get(node.id);
    if (!el) {
      el = createCardElement(node);
      state.cards.set(node.id, el);
    }
    updateCardContent(el, node);
    el.dataset.depth = String(depth);
    el.dataset.id = node.id;
    el.classList.toggle('is-focused', depth === 0);

    const title = el.querySelector('.stage-card-title');
    if (title) {
      if (depth === 0) title.setAttribute('aria-live', 'polite');
      else title.removeAttribute('aria-live');
    }

    const current = stackEl.children[depth];
    if (current !== el) stackEl.insertBefore(el, current || null);
  });

  for (const [id, el] of Array.from(state.cards)) {
    if (wanted.has(id)) continue;
    if (state.floatingEls.has(el) || state.flyingEls.has(el)) continue;
    el.remove();
    state.cards.delete(id);
  }

  updateStackHeight();
  updateGestureBinding();
}

function updateStackHeight() {
  const stackEl = state.stackEl;
  if (!stackEl) return;
  const focused = stackEl.querySelector('.stage-card[data-depth="0"]');
  if (!focused) return;
  const height = focused.offsetHeight;
  if (height > 0) stackEl.style.height = `${height}px`;
}

/**
 * Re-layout the stack, optionally animating every moved card from its old
 * position to its new one (FLIP). The spring that settles the card rising into
 * focus is initialised with the throw velocity.
 */
function relayoutStack({ animate: shouldAnimate = true, velocity = { vx: 0, vy: 0 } } = {}) {
  const stackEl = state.stackEl;
  if (!stackEl) return { before: new Map(), after: new Map() };

  const before = new Map();
  for (const el of stackEl.querySelectorAll('.stage-card:not(.is-thrown)')) {
    resetFlip(el);
    before.set(el, el.getBoundingClientRect());
  }

  renderStack();

  const after = new Map();
  for (const el of stackEl.querySelectorAll('.stage-card:not(.is-thrown)')) {
    after.set(el, el.getBoundingClientRect());
  }

  if (!shouldAnimate) return { before, after };

  const reduced = prefersReducedMotion();
  const focusEl = stackEl.querySelector('.stage-card[data-depth="0"]');

  for (const [el, b] of before) {
    const a = after.get(el);
    if (!a) continue;

    const dx = b.left - a.left;
    const dy = b.top - a.top;
    const scale = a.width > 0 ? b.width / a.width : 1;

    if (reduced) {
      // 120ms opacity cross-fade instead of travel.
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) fade(el, 1, 0.35, REDUCED_MOTION_MS);
      continue;
    }

    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.002) continue;

    el.classList.add('is-animating');
    const spring = createSpring();
    spring.x = dx;
    spring.y = dy;
    spring.s = scale;
    // Velocity inheritance — the card that rises into focus inherits the
    // throw velocity. That is the difference between "animated" and "smooth".
    if (el === focusEl) {
      spring.vx = (velocity.vx || 0) * 1000;
      spring.vy = (velocity.vy || 0) * 1000;
    }
    animate({
      el,
      spring,
      apply: (sp) => {
        el.style.setProperty('--flip-x', `${sp.x}px`);
        el.style.setProperty('--flip-y', `${sp.y}px`);
        el.style.setProperty('--flip-scale', String(sp.s));
      },
      onDone: () => {
        el.classList.remove('is-animating');
        resetFlip(el);
      },
    });
  }

  for (const el of after.keys()) {
    if (!before.has(el)) fade(el, 0, 1, REDUCED_MOTION_MS);
  }

  return { before, after };
}

/* ---------------------------------------------------------------------------
 * Gestures
 * ------------------------------------------------------------------------ */

function applyDrag(el, dx, dy) {
  const tilt = clamp(dx / 24, -6, 6);
  el.style.setProperty('--flip-x', `${dx}px`);
  el.style.setProperty('--flip-y', `${dy}px`);
  el.style.setProperty('--flip-rotate', `${tilt}deg`);
}

function nextSiblingId() {
  const nodes = levelNodes();
  const index = nodes.findIndex((node) => node.id === state.focusedId);
  if (index < 0) return nodes.length > 0 ? nodes[0].id : null;
  const next = nodes[index + 1];
  return next ? next.id : null;
}

function handleDragEnd(el, info) {
  const { dx, dy, vx, vy, flick } = info;
  const distance = Math.hypot(dx, dy);
  const advance = distance >= GESTURE.DRAG_THRESHOLD_PX || flick;

  if (!advance) {
    // Released before the threshold: the card springs back to focus.
    springFlip(el, { x: dx, y: dy, s: 1 }, { vx: 0, vy: 0 });
    return;
  }

  throwCard(el, { dx, dy, vx, vy });
}

function throwCard(el, { dx, dy, vx, vy }) {
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const dirX = horizontal ? Math.sign(dx) || 1 : 0;
  const dirY = horizontal ? 0 : Math.sign(dy) || 1;
  const targetX = dx + dirX * (viewportWidth() + THROW_MARGIN);
  const targetY = dy + dirY * (viewportHeight() + THROW_MARGIN);

  el.classList.add('is-thrown');
  state.flyingEls.add(el);

  if (prefersReducedMotion()) {
    fade(el, 1, 0, REDUCED_MOTION_MS, () => {
      el.remove();
      state.flyingEls.delete(el);
    });
  } else {
    const spring = createSpring();
    spring.x = dx;
    spring.y = dy;
    spring.vx = (vx || 0) * 1000;
    spring.vy = (vy || 0) * 1000;
    spring.targetX = targetX;
    spring.targetY = targetY;
    animate({
      el,
      spring,
      apply: (sp) => {
        el.style.setProperty('--flip-x', `${sp.x}px`);
        el.style.setProperty('--flip-y', `${sp.y}px`);
        const offScreen =
          Math.abs(sp.x) > viewportWidth() + 120 || Math.abs(sp.y) > viewportHeight() + 120;
        if (offScreen) {
          el.style.opacity = '0';
        }
      },
      onDone: () => {
        el.remove();
        state.flyingEls.delete(el);
      },
    });
  }

  // The next sibling rises into focus. Nothing is recorded.
  const next = nextSiblingId();
  if (next) setFocus(next, { velocity: { vx, vy } });
}

function handleHold(el) {
  const node = focusedNode();
  if (!node) return;

  const sourceRect = el.getBoundingClientRect();
  const pip = buildPip(node);
  state.pips.push(pip);
  state.pipZ += 1;
  pip.el.style.zIndex = String(state.pipZ);
  state.pipsEl.appendChild(pip.el);

  // The source card stays in the DOM (invisible) while the gesture is live:
  // the pointer capture lives on it.
  el.classList.add('is-floating-source');
  state.floatingEls.add(el);

  const holdDelta = state.gestureMachine
    ? state.gestureMachine.getDisplacement()
    : { dx: 0, dy: 0 };

  const next = nextSiblingId();
  let anchor = sourceRect;
  if (next) {
    setFocus(next, { velocity: { vx: 0, vy: 0 } });
    const focusEl = state.stackEl?.querySelector('.stage-card[data-depth="0"]');
    if (focusEl) {
      resetFlip(focusEl);
      anchor = focusEl.getBoundingClientRect();
    }
  }

  const position = dockPosition(anchor, pip.width, pip.height);
  pip.x = position.x;
  pip.y = position.y;
  pip.holdDx = holdDelta.dx;
  pip.holdDy = holdDelta.dy;
  applyPipPosition(pip);

  // The lift: FLIP + spring from the stage position into the window.
  if (prefersReducedMotion()) {
    fade(pip.el, 0, 1, REDUCED_MOTION_MS);
  } else {
    const fromX = sourceRect.left;
    const fromY = sourceRect.top;
    const fromScale = sourceRect.width > 0 ? pip.width / sourceRect.width : 1;
    pip.el.style.transform = `translate(${fromX}px, ${fromY}px) scale(${fromScale})`;
    pip.el.style.transformOrigin = 'top left';
    const spring = createSpring();
    spring.x = fromX;
    spring.y = fromY;
    spring.s = fromScale;
    spring.targetX = pip.x;
    spring.targetY = pip.y;
    spring.targetS = 1;
    animate({
      el: pip.el,
      spring,
      apply: (sp) => {
        pip.el.style.transform = `translate(${sp.x}px, ${sp.y}px) scale(${sp.s})`;
      },
      onDone: () => {
        pip.el.style.transformOrigin = '';
        pip.el.style.transform = `translate(${pip.x}px, ${pip.y}px)`;
      },
    });
  }
}

function handlePipDrag(dx, dy) {
  const pip = state.pips[state.pips.length - 1];
  if (!pip) return;
  pip.x = pip.baseX + (dx - pip.holdDx);
  pip.y = pip.baseY + (dy - pip.holdDy);
  pip.userMoved = true;
  applyPipPosition(pip);
}

function cleanupFloatingSource() {
  for (const el of Array.from(state.floatingEls)) {
    el.remove();
    state.floatingEls.delete(el);
    state.cards.delete(el.dataset.id);
  }
}

function updateGestureBinding() {
  const el = state.stackEl?.querySelector('.stage-card[data-depth="0"]');
  if (el === state.gestureEl) return;

  if (state.gestureDetach) {
    state.gestureDetach();
    state.gestureDetach = null;
  }
  state.gestureEl = el;
  state.gestureMachine = null;
  if (!el) return;

  // Touch degrades to tap-only: no drag, no hold (design §4.2.8).
  if (isCoarsePointer()) return;

  state.gestureDetach = attachCardGestures(el, {
    onTap: () => activateFocused(),
    onDragStart: (target) => {
      state.dragging = true;
      target.classList.add('dragging');
    },
    onDragMove: (target, dx, dy) => applyDrag(target, dx, dy),
    onDragEnd: (target, info) => {
      state.dragging = false;
      target.classList.remove('dragging');
      handleDragEnd(target, info);
    },
    onHold: (target) => handleHold(target),
    onPipDrag: (_target, dx, dy) => handlePipDrag(dx, dy),
    onPipDragEnd: () => cleanupFloatingSource(),
  });
  state.gestureMachine = state.gestureDetach.machine || null;
}

/* ---------------------------------------------------------------------------
 * Floating windows (PiP)
 * ------------------------------------------------------------------------ */

function buildPip(node) {
  const width = pipWidth();
  const height = pipHeight(width);

  const el = document.createElement('div');
  el.className = 'pip';
  el.dataset.id = node.id;
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;

  const header = document.createElement('div');
  header.className = 'pip-header';

  const title = document.createElement('span');
  title.className = 'pip-title';
  title.textContent = node.title || '';

  header.appendChild(title);

  const body = document.createElement('div');
  body.className = 'pip-body';

  const text = document.createElement('p');
  text.className = 'pip-text';
  text.textContent = node.body || '';

  const answer = document.createElement('p');
  answer.className = 'pip-answer';
  const answerText = (node.answer || '').trim();
  answer.textContent = answerText || 'No answer recorded';
  if (!answerText) answer.classList.add('is-empty');

  body.appendChild(text);
  body.appendChild(answer);

  el.appendChild(header);
  el.appendChild(body);

  const pip = {
    id: node.id,
    el,
    x: 0,
    y: 0,
    baseX: 0,
    baseY: 0,
    holdDx: 0,
    holdDy: 0,
    width,
    height,
    userMoved: false,
    dragged: false,
  };

  attachPipDrag(pip);
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    bringToFront(pip);
    if (pip.dragged) {
      pip.dragged = false;
      return;
    }
    returnPipToStack(pip);
  });

  return pip;
}

/** Default dock: centred over the focused card, above it, 16px gap. */
function dockPosition(anchor, width, height) {
  let x = anchor.left + anchor.width / 2 - width / 2;
  let y = anchor.top - PIP_GAP - height;

  if (y < VIEWPORT_MARGIN) {
    // Would overflow the viewport top: dock below the focused card instead.
    y = anchor.bottom + PIP_GAP;
  }

  x = clamp(
    x,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewportWidth() - width - VIEWPORT_MARGIN),
  );
  y = clamp(
    y,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewportHeight() - height - VIEWPORT_MARGIN),
  );

  return { x, y };
}

function applyPipPosition(pip) {
  pip.el.style.transform = `translate(${pip.x}px, ${pip.y}px)`;
}

function bringToFront(pip) {
  state.pipZ += 1;
  pip.el.style.zIndex = String(state.pipZ);
}

/** The header is the only drag handle: 1:1 with the pointer, no transition. */
function attachPipDrag(pip) {
  const header = pip.el.querySelector('.pip-header');
  let dragging = false;
  let origin = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };

  const onPointerDown = (ev) => {
    if (ev.isPrimary === false) return;
    if (ev.pointerType === 'mouse' && typeof ev.button === 'number' && ev.button !== 0) return;
    dragging = true;
    pip.dragged = false;
    origin = { x: pip.x, y: pip.y };
    start = { x: ev.clientX, y: ev.clientY };
    pip.el.classList.add('dragging');
    try {
      header.setPointerCapture(ev.pointerId);
    } catch {
      /* best effort */
    }
    ev.preventDefault();
  };

  const onPointerMove = (ev) => {
    if (!dragging) return;
    pip.x = origin.x + (ev.clientX - start.x);
    pip.y = origin.y + (ev.clientY - start.y);
    pip.userMoved = true;
    pip.dragged = true;
    applyPipPosition(pip);
  };

  const onPointerUp = (ev) => {
    if (!dragging) return;
    dragging = false;
    pip.el.classList.remove('dragging');
    try {
      if (header.hasPointerCapture?.(ev.pointerId)) header.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };

  header.addEventListener('pointerdown', onPointerDown);
  header.addEventListener('pointermove', onPointerMove);
  header.addEventListener('pointerup', onPointerUp);
  header.addEventListener('pointercancel', onPointerUp);
}

/** The floating card returns to the stack — it becomes the focused card again. */
function returnPipToStack(pip) {
  const node = store.getNode(pip.id);
  const from = pip.el.getBoundingClientRect();

  const index = state.pips.indexOf(pip);
  if (index >= 0) state.pips.splice(index, 1);

  if (!node) {
    pip.el.remove();
    return;
  }

  state.focusedId = node.id;
  state.flipped = false;

  const { after } = relayoutStack({ animate: false });
  const el = state.cards.get(node.id);
  const to = after.get(el);

  fade(pip.el, 1, 0, REDUCED_MOTION_MS, () => pip.el.remove());

  if (!el || !to) return;

  if (prefersReducedMotion()) {
    fade(el, 0, 1, REDUCED_MOTION_MS);
    return;
  }

  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const scale = to.width > 0 ? from.width / to.width : 1;
  springFlip(el, { x: dx, y: dy, s: scale }, { vx: 0, vy: 0 });
}

/* ---------------------------------------------------------------------------
 * Focus movement
 * ------------------------------------------------------------------------ */

function setFocus(nodeId, { velocity = { vx: 0, vy: 0 } } = {}) {
  if (!nodeId) return false;
  const node = store.getNode(nodeId);
  if (!node) return false;
  state.focusedId = nodeId;
  state.flipped = false;
  relayoutStack({ animate: true, velocity });
  return true;
}

function advance(delta) {
  const nodes = levelNodes();
  if (nodes.length === 0) return false;
  const index = nodes.findIndex((node) => node.id === state.focusedId);
  if (index < 0) return false;
  const nextIndex = clamp(index + delta, 0, nodes.length - 1);
  if (nextIndex === index) return false;
  return setFocus(nodes[nextIndex].id);
}

function toggleReveal() {
  const node = focusedNode();
  if (!node) return false;
  const answer = (node.answer || '').trim();
  if (!answer) {
    // A card with no answer does not flip; it already says so on the front.
    return false;
  }
  const el = state.stackEl?.querySelector('.stage-card[data-depth="0"]');
  if (!el) return false;
  state.flipped = !state.flipped;
  el.classList.toggle('is-flipped', state.flipped);
  const back = el.querySelector('.stage-card-back');
  const front = el.querySelector('.stage-card-front');
  if (back) back.setAttribute('aria-hidden', state.flipped ? 'false' : 'true');
  if (front) front.setAttribute('aria-hidden', state.flipped ? 'true' : 'false');
  return true;
}

/** Clicking / activating the focused card: folders descend, cards reveal. */
function activateFocused() {
  const node = focusedNode();
  if (!node) return false;
  if (node.kind === 'folder') return descend();
  return toggleReveal();
}

function descend() {
  const node = focusedNode();
  if (!node || node.kind !== 'folder') return false;
  const children = store.getChildren(node.id) || [];
  if (children.length === 0) return false;
  state.levelId = node.id;
  state.focusedId = children[0].id;
  state.flipped = false;
  relayoutStack({ animate: true, velocity: { vx: 0, vy: 0 } });
  return true;
}

function ascend() {
  if (state.levelId === null || state.levelId === undefined) return false;
  const parentId = state.levelId;
  const parent = store.getNode(parentId);
  state.levelId = parent ? parent.parentId ?? null : null;
  state.focusedId = parentId;
  state.flipped = false;
  relayoutStack({ animate: true, velocity: { vx: 0, vy: 0 } });
  return true;
}

/** The coarse-pointer replacement for the drag gesture. */
function dismissFocused() {
  const el = state.stackEl?.querySelector('.stage-card[data-depth="0"]');
  const next = nextSiblingId();
  if (el) {
    fade(el, 1, 0, REDUCED_MOTION_MS, () => {
      el.remove();
      state.cards.delete(el.dataset.id);
    });
  }
  if (next) setFocus(next);
}

/* ---------------------------------------------------------------------------
 * Keyboard
 * ------------------------------------------------------------------------ */

function handleKeyDown(ev) {
  if (!state.active) return;
  const target = ev.target;
  const isEditable =
    target && typeof target.closest === 'function'
      ? target.closest('input, textarea, select, [contenteditable="true"]')
      : null;

  switch (ev.key) {
    case 'ArrowDown':
      if (isEditable) return;
      ev.preventDefault();
      advance(1);
      break;
    case 'ArrowUp':
      if (isEditable) return;
      ev.preventDefault();
      advance(-1);
      break;
    case 'Enter':
    case ' ':
    case 'Spacebar':
      if (isEditable) return;
      ev.preventDefault();
      activateFocused();
      break;
    case 'Escape':
      ev.preventDefault();
      // Precedence: close the top floating window, then ascend, then exit.
      if (state.pips.length > 0) {
        focus.closeTopFloatingWindow();
        return;
      }
      if (ascend()) return;
      focus.exit();
      break;
    default:
      break;
  }
}

/* ---------------------------------------------------------------------------
 * Store integration
 * ------------------------------------------------------------------------ */

function subscribeToStore() {
  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = store.subscribe(() => {
    if (!state.active || state.dragging) return;
    renderStack();
  });
}

/* ---------------------------------------------------------------------------
 * Public API (contracts §4.5)
 * ------------------------------------------------------------------------ */

export const focus = {
  isActive() {
    return state.active;
  },

  enter(nodeId) {
    const node = store.getNode(nodeId);
    if (!node) {
      console.error(`[focus] enter(): unknown node "${nodeId}"`);
      return;
    }
    const root = document.getElementById('stage-root');
    if (!root) {
      console.error('[focus] enter(): #stage-root is missing');
      return;
    }

    if (state.active) focus.exit();

    state.active = true;
    state.levelId = node.parentId ?? null;
    state.focusedId = node.id;
    state.flipped = false;
    state.rootEl = root;

    mountStage(root);
    renderStack();

    subscribeToStore();

    document.documentElement.setAttribute('data-register', 'stage');
    state.keyHandler = handleKeyDown;
    document.addEventListener('keydown', state.keyHandler);

    state.stage?.focus?.({ preventScroll: true });
  },

  exit() {
    if (!state.active) return;
    state.active = false;

    if (state.keyHandler) {
      document.removeEventListener('keydown', state.keyHandler);
      state.keyHandler = null;
    }
    if (state.unsubscribe) {
      state.unsubscribe();
      state.unsubscribe = null;
    }

    for (const pip of state.pips) pip.el.remove();
    state.pips = [];

    unmountStage();

    state.levelId = null;
    state.focusedId = null;
    state.flipped = false;

    document.documentElement.setAttribute('data-register', 'browse');
  },

  getFocusedId() {
    return state.focusedId;
  },

  advance(delta) {
    return advance(delta);
  },

  toggleReveal() {
    return toggleReveal();
  },

  getFloatingWindows() {
    return state.pips.map((pip) => ({
      id: pip.id,
      x: pip.x,
      y: pip.y,
      width: pip.width,
      height: pip.height,
    }));
  },

  closeTopFloatingWindow() {
    if (state.pips.length === 0) return false;
    const pip = state.pips[state.pips.length - 1];
    returnPipToStack(pip);
    return true;
  },
};
