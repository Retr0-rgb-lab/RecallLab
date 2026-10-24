/**
 * RecallLab — gesture state machine tests (contracts §4.6, design §4.2.6).
 *
 * These drive the PURE state machine exported by `public/js/gestures.js`.
 * No pointer device and no DOM are involved: time is injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GESTURE,
  GESTURE_STATE,
  createGestureStateMachine,
  computeVelocity,
} from '../public/js/gestures.js';

/** An injectable clock: `advance` fires the timers that are due. */
function createClock() {
  let current = 0;
  let seq = 0;
  const timers = new Map();

  return {
    now: () => current,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, at: current + ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    advance(ms) {
      current += ms;
      let guard = 0;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= current)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0 || guard++ > 50) break;
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    get time() {
      return current;
    },
  };
}

function setup(extraHandlers = {}) {
  const clock = createClock();
  const calls = {
    tap: [],
    dragStart: [],
    dragMove: [],
    dragEnd: [],
    hold: [],
    pipDrag: [],
    pipDragEnd: [],
    expand: [],
  };

  const machine = createGestureStateMachine(
    {
      onTap: (el) => calls.tap.push(el),
      onDragStart: (el, ev) => calls.dragStart.push(ev),
      onDragMove: (el, dx, dy) => calls.dragMove.push({ dx, dy }),
      onDragEnd: (el, info) => calls.dragEnd.push(info),
      onHold: (el) => calls.hold.push(el),
      onPipDrag: (el, dx, dy) => calls.pipDrag.push({ dx, dy }),
      onPipDragEnd: (el, info) => calls.pipDragEnd.push(info),
      onExpand: (el) => calls.expand.push(el),
      ...extraHandlers,
    },
    { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  );

  return { clock, machine, calls };
}

const down = (machine, x = 0, y = 0, pointerId = 1) =>
  machine.pointerDown({ clientX: x, clientY: y, pointerId });
const move = (machine, x, y, pointerId = 1) =>
  machine.pointerMove({ clientX: x, clientY: y, pointerId });
const up = (machine, x, y, pointerId = 1) =>
  machine.pointerUp({ clientX: x, clientY: y, pointerId });

test('GESTURE constants are the authoritative values', () => {
  assert.equal(GESTURE.HOLD_MS, 450);
  assert.equal(GESTURE.DRAG_THRESHOLD_PX, 56);
  assert.equal(GESTURE.HOLD_SLOP_PX, 8);
  assert.equal(GESTURE.FLICK_VELOCITY, 0.35);
  assert.ok(Object.isFrozen(GESTURE));
});

test('a press and release below the drag threshold is a tap', () => {
  const { machine, calls } = setup();

  down(machine, 100, 100);
  move(machine, 110, 104); // 11px — below DRAG_THRESHOLD_PX
  up(machine, 110, 104);

  assert.equal(calls.tap.length, 1, 'onTap fires once');
  assert.equal(calls.dragStart.length, 0, 'the gesture is not classified as a drag');
  assert.equal(calls.dragEnd.length, 0);
  assert.equal(calls.hold.length, 0);
});

test('a drag past the threshold is classified as a drag exactly once', () => {
  const { machine, calls } = setup();

  down(machine, 0, 0);
  move(machine, 30, 0); // below the threshold — still a press
  assert.equal(calls.dragStart.length, 0);

  move(machine, 60, 0); // 60px — crosses DRAG_THRESHOLD_PX
  assert.equal(calls.dragStart.length, 1);
  assert.equal(machine.getState(), GESTURE_STATE.DRAGGING);

  move(machine, 90, 0);
  assert.equal(calls.dragStart.length, 1, 'classified once only');
  assert.equal(calls.dragMove.length, 2, 'every move while dragging is reported');

  up(machine, 90, 0);
  assert.equal(calls.tap.length, 0, 'a drag is never a tap');
  assert.equal(calls.dragEnd.length, 1);
});

test('a hold shorter than 450ms does not fire onHold', () => {
  const { clock, machine, calls } = setup();

  down(machine, 10, 10);
  clock.advance(449);
  assert.equal(calls.hold.length, 0, 'no hold before HOLD_MS');

  up(machine, 10, 10);
  assert.equal(calls.hold.length, 0, 'a release before HOLD_MS does not fire the hold');
  assert.equal(calls.tap.length, 1, 'it is still a tap');
});

test('a hold of 450ms with movement under the slop fires onHold', () => {
  const { clock, machine, calls } = setup();

  down(machine, 10, 10);
  move(machine, 14, 10); // 4px — under HOLD_SLOP_PX
  clock.advance(450);

  assert.equal(calls.hold.length, 1, 'onHold fires at HOLD_MS');
  assert.equal(machine.getState(), GESTURE_STATE.PIP);
  assert.equal(calls.dragStart.length, 0, 'a hold is not a drag');
});

test('a hold with movement over the slop does not fire onHold', () => {
  const { clock, machine, calls } = setup();

  down(machine, 10, 10);
  move(machine, 22, 10); // 12px — over HOLD_SLOP_PX
  clock.advance(450);

  assert.equal(calls.hold.length, 0, 'the hold is cancelled by the movement');
  assert.notEqual(machine.getState(), GESTURE_STATE.PIP);
});

test('a drag never fires onHold', () => {
  const { clock, machine, calls } = setup();

  down(machine, 0, 0);
  move(machine, 80, 0); // over the drag threshold
  clock.advance(450);

  assert.equal(calls.hold.length, 0);
  assert.equal(machine.getState(), GESTURE_STATE.DRAGGING);
});

test('a release velocity above the flick threshold is a flick', () => {
  const { clock, machine, calls } = setup();

  down(machine, 0, 0);
  clock.advance(100);
  machine.pointerMove({ clientX: 60, clientY: 0, pointerId: 1 });
  clock.advance(20);
  machine.pointerMove({ clientX: 120, clientY: 0, pointerId: 1 });
  up(machine, 120, 0);

  const info = calls.dragEnd[0];
  // 60px in 20ms = 3px/ms
  assert.ok(Math.abs(info.vx - 3) < 1e-9, `expected vx ≈ 3, got ${info.vx}`);
  assert.equal(info.flick, true);
});

test('a release velocity below the flick threshold is not a flick', () => {
  const { clock, machine, calls } = setup();

  down(machine, 0, 0);
  clock.advance(100);
  machine.pointerMove({ clientX: 60, clientY: 0, pointerId: 1 });
  clock.advance(20);
  machine.pointerMove({ clientX: 62, clientY: 0, pointerId: 1 });
  up(machine, 62, 0);

  const info = calls.dragEnd[0];
  assert.ok(Math.abs(info.vx - 0.1) < 1e-9, `expected vx ≈ 0.1, got ${info.vx}`);
  assert.equal(info.flick, false);
});

test('onDragEnd reports the velocity in px/ms', () => {
  const { clock, machine, calls } = setup();

  down(machine, 0, 0);
  clock.advance(100);
  machine.pointerMove({ clientX: 56, clientY: 0, pointerId: 1 });
  clock.advance(20);
  machine.pointerMove({ clientX: 112, clientY: 0, pointerId: 1 });
  up(machine, 112, 0);

  const info = calls.dragEnd[0];
  assert.equal(typeof info.vx, 'number');
  assert.equal(typeof info.vy, 'number');
  assert.equal(info.dx, 112);
  assert.equal(info.dy, 0);
  // 56px in the measured window → px/ms, not px/s.
  assert.ok(info.vx > GESTURE.FLICK_VELOCITY, 'a fast throw exceeds the flick threshold');
  assert.ok(info.vx < 10, 'the unit is px/ms');
});

test('velocity is measured over the last ~80ms of movement', () => {
  const samples = [
    { t: 0, x: 0, y: 0 },
    { t: 100, x: 10, y: 0 },
    { t: 160, x: 30, y: 0 },
    { t: 180, x: 50, y: 0 },
  ];
  const { vx } = computeVelocity(samples, 80);
  // window = [100, 180] → 40px in 80ms = 0.5px/ms
  assert.ok(Math.abs(vx - 0.5) < 1e-9, `expected vx ≈ 0.5, got ${vx}`);
});

test('a pointer at rest before the release reports no flick', () => {
  const { clock, machine, calls } = setup();

  down(machine, 0, 0);
  clock.advance(100);
  machine.pointerMove({ clientX: 200, clientY: 0, pointerId: 1 });
  // The pointer stops and rests for a long time before the release.
  clock.advance(500);
  machine.pointerUp({ clientX: 200, clientY: 0, pointerId: 1 });

  assert.equal(calls.dragEnd.length, 1);
  assert.equal(calls.dragEnd[0].flick, false);
});

test('after a hold the gesture drags the floating window instead of advancing', () => {
  const { clock, machine, calls } = setup();

  down(machine, 0, 0);
  clock.advance(450);
  assert.equal(machine.getState(), GESTURE_STATE.PIP);

  move(machine, 200, 10); // far past the drag threshold
  assert.equal(calls.dragStart.length, 0, 'the stack is not advanced');
  assert.equal(calls.pipDrag.length, 1);

  up(machine, 200, 10);
  assert.equal(calls.pipDragEnd.length, 1);
  assert.equal(calls.dragEnd.length, 0);
});

test('a floating card expands back into focus', () => {
  const { clock, machine, calls } = setup();

  down(machine, 0, 0);
  clock.advance(450);
  assert.equal(machine.getState(), GESTURE_STATE.PIP);

  assert.equal(machine.expandFromPip(), true);
  assert.equal(machine.getState(), GESTURE_STATE.FOCUS);
  assert.equal(calls.expand.length, 1);
});

test('a cancelled drag falls back to the focus position', () => {
  const { machine, calls } = setup();

  down(machine, 0, 0);
  move(machine, 80, 0);
  machine.pointerCancel({ clientX: 80, clientY: 0, pointerId: 1 });

  assert.equal(calls.dragEnd.length, 1);
  assert.equal(calls.dragEnd[0].flick, false, 'a cancelled drag never throws');
  assert.equal(machine.getState(), GESTURE_STATE.IDLE);
});

test('a second pointer is ignored while a gesture is live', () => {
  const { machine, calls } = setup();

  down(machine, 0, 0, 1);
  move(machine, 10, 10, 2);
  up(machine, 10, 10, 2);

  assert.equal(calls.tap.length, 0, 'the second pointer does not end the gesture');
  assert.equal(machine.getState(), GESTURE_STATE.IDLE);
});
