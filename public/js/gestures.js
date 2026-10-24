/**
 * RecallLab — pointer gesture state machine (contracts §4.6, design §4.2.6).
 *
 * The state machine is exported as a PURE unit: `createGestureStateMachine()`
 * takes plain objects with `clientX` / `clientY` / `timeStamp`, so it can be
 * driven by a test without a pointer device. `attachCardGestures()` is a thin
 * DOM adapter that feeds real Pointer Events into the same machine.
 *
 * States (design §4.2.6):
 *
 *   idle ──hold ≥ HOLD_MS (movement < HOLD_SLOP_PX)──► pip
 *   idle ──movement ≥ DRAG_THRESHOLD_PX──────────────► dragging
 *   dragging ──release (≥ threshold or flick)──────► advance / dismiss
 *   dragging ──release (below threshold, no flick)──► back to focus
 *   pip ──click────────────────────────────────────► focus (expand back)
 *
 * Rules enforced here (contracts §4.6):
 *   1. `dragging` never animates — the owner adds a `dragging` class.
 *   2. `onHold` fires only when the pointer moved less than HOLD_SLOP_PX.
 *   3. Velocity is measured over the last ~80ms of movement, in px/ms.
 *   4. Pointer Events only, with setPointerCapture. No mouse events.
 *   5. `touch-action: none` on the draggable element.
 */

/** Authoritative constants (contracts §8). Do not re-derive. */
export const GESTURE = Object.freeze({
  HOLD_MS: 450,
  DRAG_THRESHOLD_PX: 56,
  HOLD_SLOP_PX: 8,
  FLICK_VELOCITY: 0.35,
});

/** Machine states. */
export const GESTURE_STATE = Object.freeze({
  IDLE: 'idle',
  DRAGGING: 'dragging',
  PIP: 'pip',
  FOCUS: 'focus',
});

/** Velocity is measured over the last ~80ms of movement. */
export const VELOCITY_WINDOW_MS = 80;

const defaultNow = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/**
 * Velocity over the last `windowMs` of movement, in px/ms.
 *
 * The release position is sampled as the last sample so that a pointer which
 * came to rest before the release reports ~0 velocity (no flick). When every
 * sample inside the window shares one timestamp the window cannot be measured;
 * the nearest earlier sample with a distinct timestamp is used instead.
 */
export function computeVelocity(samples, windowMs = VELOCITY_WINDOW_MS) {
  if (!samples || samples.length < 2) return { vx: 0, vy: 0 };

  const last = samples[samples.length - 1];
  const windowStart = last.t - windowMs;

  let firstIndex = samples.length - 1;
  while (firstIndex > 0 && samples[firstIndex - 1].t >= windowStart) firstIndex -= 1;

  // Only the release sample sits inside the window: the pointer was at rest.
  if (firstIndex === samples.length - 1) return { vx: 0, vy: 0 };

  let from = samples[firstIndex];
  let to = last;

  if (to.t - from.t <= 0) {
    // Degenerate window (same millisecond): fall back to the nearest earlier
    // sample with a distinct timestamp.
    let i = samples.length - 1;
    while (i > 0 && samples[i - 1].t >= to.t) i -= 1;
    if (i === 0) return { vx: 0, vy: 0 };
    from = samples[i - 1];
    to = samples[i];
    if (to.t - from.t <= 0) return { vx: 0, vy: 0 };
  }

  const dt = to.t - from.t;
  return {
    vx: (to.x - from.x) / dt,
    vy: (to.y - from.y) / dt,
  };
}

/**
 * Pure pointer state machine.
 *
 * @param {object} handlers
 * @param {(el: Element|null) => void} [handlers.onTap]
 * @param {(el: Element|null, ev: object) => void} [handlers.onDragStart]
 * @param {(el: Element|null, dx: number, dy: number, ev: object) => void} [handlers.onDragMove]
 * @param {(el: Element|null, info: {dx:number,dy:number,vx:number,vy:number,flick:boolean}) => void} [handlers.onDragEnd]
 * @param {(el: Element|null) => void} [handlers.onHold]
 * @param {(el: Element|null, dx: number, dy: number, ev: object) => void} [handlers.onPipDrag]      (extension)
 * @param {(el: Element|null, info: object) => void} [handlers.onPipDragEnd]                        (extension)
 * @param {(el: Element|null) => void} [handlers.onExpand]                                         (extension)
 *
 * @param {object} [options]
 * @param {() => number} [options.now]          clock, injectable for tests
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(id: any) => void} [options.clearTimer]
 * @param {number} [options.velocityWindowMs]
 * @param {Element|null} [options.el]           element handed to the handlers
 */
export function createGestureStateMachine(handlers = {}, options = {}) {
  const now = typeof options.now === 'function' ? options.now : defaultNow;
  const setTimer =
    typeof options.setTimer === 'function'
      ? options.setTimer
      : (fn, ms) => setTimeout(fn, ms);
  const clearTimer =
    typeof options.clearTimer === 'function'
      ? options.clearTimer
      : (id) => clearTimeout(id);
  const velocityWindowMs =
    typeof options.velocityWindowMs === 'number' ? options.velocityWindowMs : VELOCITY_WINDOW_MS;
  const el = options.el ?? null;

  let state = GESTURE_STATE.IDLE;
  let origin = null;
  let pressTime = 0;
  let samples = [];
  let maxDistance = 0;
  let timerId = null;
  let pointerId = null;
  let tracking = false;
  let held = false;
  let velocity = { vx: 0, vy: 0 };
  let displacement = { dx: 0, dy: 0 };

  function setState(next) {
    state = next;
  }

  function cancelTimer() {
    if (timerId !== null) {
      clearTimer(timerId);
      timerId = null;
    }
  }

  function scheduleHold(delayMs = GESTURE.HOLD_MS) {
    cancelTimer();
    timerId = setTimer(() => {
      timerId = null;
      tick();
    }, Math.max(0, delayMs));
  }

  /**
   * Evaluate the hold condition right now. Returns true when the hold fired.
   */
  function tick() {
    if (!tracking || state !== GESTURE_STATE.IDLE || held) return false;
    if (maxDistance >= GESTURE.HOLD_SLOP_PX) return false;

    const elapsed = now() - pressTime;
    if (elapsed < GESTURE.HOLD_MS) {
      scheduleHold(GESTURE.HOLD_MS - elapsed);
      return false;
    }

    held = true;
    setState(GESTURE_STATE.PIP);
    handlers.onHold?.(el);
    return true;
  }

  function reset() {
    cancelTimer();
    state = GESTURE_STATE.IDLE;
    origin = null;
    pressTime = 0;
    samples = [];
    maxDistance = 0;
    pointerId = null;
    tracking = false;
    held = false;
    velocity = { vx: 0, vy: 0 };
    displacement = { dx: 0, dy: 0 };
  }

  function pointOf(ev) {
    return { x: ev.clientX ?? 0, y: ev.clientY ?? 0 };
  }

  function pointerDown(ev) {
    if (tracking) return false;
    if (ev?.target && typeof ev.target.closest === 'function') {
      if (ev.target.closest('[data-gesture-ignore]')) return false;
    }

    const p = pointOf(ev);
    state = GESTURE_STATE.IDLE;
    held = false;
    tracking = true;
    pointerId = ev.pointerId ?? null;
    origin = p;
    pressTime = now();
    samples = [{ t: pressTime, x: p.x, y: p.y }];
    maxDistance = 0;
    velocity = { vx: 0, vy: 0 };
    displacement = { dx: 0, dy: 0 };
    scheduleHold();
    return true;
  }

  function pointerMove(ev) {
    if (!tracking) return false;
    if (pointerId !== null && ev.pointerId !== undefined && ev.pointerId !== pointerId) {
      return false;
    }

    const p = pointOf(ev);
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    displacement = { dx, dy };
    const distance = Math.hypot(dx, dy);
    if (distance > maxDistance) maxDistance = distance;
    samples.push({ t: now(), x: p.x, y: p.y });

    if (state === GESTURE_STATE.IDLE) {
      if (distance >= GESTURE.DRAG_THRESHOLD_PX) {
        // Classified as a drag exactly once.
        cancelTimer();
        setState(GESTURE_STATE.DRAGGING);
        handlers.onDragStart?.(el, ev);
        handlers.onDragMove?.(el, dx, dy, ev);
      }
      return true;
    }

    if (state === GESTURE_STATE.DRAGGING) {
      handlers.onDragMove?.(el, dx, dy, ev);
      return true;
    }

    if (state === GESTURE_STATE.PIP) {
      // A long press that then moves drags the floating window, it does not
      // advance the stack (design §4.2.5).
      handlers.onPipDrag?.(el, dx, dy, ev);
      return true;
    }

    return false;
  }

  function pointerUp(ev) {
    if (!tracking) return false;
    if (pointerId !== null && ev.pointerId !== undefined && ev.pointerId !== pointerId) {
      return false;
    }

    const p = pointOf(ev);
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    displacement = { dx, dy };
    const distance = Math.hypot(dx, dy);
    if (distance > maxDistance) maxDistance = distance;
    samples.push({ t: now(), x: p.x, y: p.y });

    // A hold that is released before its timer fires still counts.
    tick();

    if (state === GESTURE_STATE.PIP) {
      velocity = computeVelocity(samples, velocityWindowMs);
      cancelTimer();
      tracking = false;
      pointerId = null;
      handlers.onPipDragEnd?.(el, { dx, dy, vx: velocity.vx, vy: velocity.vy });
      return true;
    }

    if (state === GESTURE_STATE.DRAGGING) {
      velocity = computeVelocity(samples, velocityWindowMs);
      const flick = Math.hypot(velocity.vx, velocity.vy) >= GESTURE.FLICK_VELOCITY;
      cancelTimer();
      tracking = false;
      pointerId = null;
      setState(GESTURE_STATE.IDLE);
      handlers.onDragEnd?.(el, {
        dx,
        dy,
        vx: velocity.vx,
        vy: velocity.vy,
        flick,
      });
      return true;
    }

    // idle: released before the drag threshold was crossed.
    cancelTimer();
    tracking = false;
    pointerId = null;
    setState(GESTURE_STATE.IDLE);
    if (distance < GESTURE.DRAG_THRESHOLD_PX) {
      handlers.onTap?.(el);
    }
    return true;
  }

  function pointerCancel(ev) {
    if (!tracking) return false;
    if (pointerId !== null && ev.pointerId !== undefined && ev.pointerId !== pointerId) {
      return false;
    }

    const wasDragging = state === GESTURE_STATE.DRAGGING;
    const dx = displacement.dx;
    const dy = displacement.dy;
    cancelTimer();
    tracking = false;
    pointerId = null;
    setState(GESTURE_STATE.IDLE);

    if (wasDragging) {
      // A cancelled drag never advances: it falls back to the focus position.
      handlers.onDragEnd?.(el, { dx, dy, vx: 0, vy: 0, flick: false });
    }
    return true;
  }

  /** `pip` → `focus`: the floating card is expanded back into the focus slot. */
  function expandFromPip() {
    if (state !== GESTURE_STATE.PIP) return false;
    setState(GESTURE_STATE.FOCUS);
    handlers.onExpand?.(el);
    return true;
  }

  return {
    pointerDown,
    pointerMove,
    pointerUp,
    pointerCancel,
    expandFromPip,
    tick,
    reset,
    getState: () => state,
    isTracking: () => tracking,
    isDragging: () => state === GESTURE_STATE.DRAGGING,
    isPip: () => state === GESTURE_STATE.PIP,
    isHolding: () => held,
    getOrigin: () => (origin ? { ...origin } : null),
    getDisplacement: () => ({ ...displacement }),
    getMaxDistance: () => maxDistance,
    getVelocity: () => ({ ...velocity }),
    getElapsed: () => (tracking ? now() - pressTime : 0),
  };
}

/**
 * Attach the gesture machine to a DOM element using Pointer Events only.
 *
 * @param {Element} el
 * @param {object} handlers  see `createGestureStateMachine`
 * @returns {() => void} detach
 */
export function attachCardGestures(el, handlers = {}) {
  if (!el || typeof el.addEventListener !== 'function') {
    throw new TypeError('attachCardGestures(el, handlers): el must be an element');
  }

  const machine = createGestureStateMachine(handlers, { el });

  const previousTouchAction = el.style ? el.style.touchAction : '';
  if (el.style) el.style.touchAction = 'none';

  const capture = (ev) => {
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* capture is best effort — some synthetic events have no active pointer */
    }
  };

  const release = (ev) => {
    try {
      if (el.hasPointerCapture && el.hasPointerCapture(ev.pointerId)) {
        el.releasePointerCapture(ev.pointerId);
      }
    } catch {
      /* ignore */
    }
  };

  const onPointerDown = (ev) => {
    if (ev.isPrimary === false) return;
    if (ev.pointerType === 'mouse' && typeof ev.button === 'number' && ev.button !== 0) return;
    if (machine.isTracking()) return;
    if (machine.pointerDown(ev)) capture(ev);
  };

  const onPointerMove = (ev) => {
    if (!machine.isTracking()) return;
    machine.pointerMove(ev);
  };

  const onPointerUp = (ev) => {
    if (!machine.isTracking()) return;
    machine.pointerUp(ev);
    release(ev);
  };

  const onPointerCancel = (ev) => {
    if (!machine.isTracking()) return;
    machine.pointerCancel(ev);
    release(ev);
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerCancel);
  el.addEventListener('dragstart', (ev) => ev.preventDefault());

  function detachCardGestures() {
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerCancel);
    machine.reset();
    if (el.style) el.style.touchAction = previousTouchAction;
  }

  // The machine is exposed so an owner can read the live displacement (the
  // PiP lift needs the pointer offset at the moment the hold fired).
  detachCardGestures.machine = machine;

  return detachCardGestures;
}
