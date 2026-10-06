import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bindKeyboardFlight } from './keyboardFlight.js';

/**
 * Minimal DOM/rAF harness.
 *
 * The module drives the camera from a requestAnimationFrame loop keyed on real
 * timestamps, so the harness owns the clock: `frame(ms)` advances it by one
 * step, which is what makes the movement assertions deterministic.
 */
function harness({ cockpitActive = false } = {}) {
  const listeners = new Map();
  const viewListeners = new Map();
  const view = {
    addEventListener: (type, fn) => viewListeners.set(type, fn),
    removeEventListener: (type) => viewListeners.delete(type),
  };
  const documentRef = {
    defaultView: view,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };

  const calls = [];
  const camera = {
    positionCartographic: { height: 1000 },
    moveForward: (d) => calls.push(['forward', d]),
    moveBackward: (d) => calls.push(['backward', d]),
    moveLeft: (d) => calls.push(['left', d]),
    moveRight: (d) => calls.push(['right', d]),
    lookLeft: (a) => calls.push(['lookLeft', a]),
    lookRight: (a) => calls.push(['lookRight', a]),
  };
  const viewer = { camera, isDestroyed: () => false };

  // rAF queue under test control.
  let nextId = 1;
  const pending = new Map();
  globalThis.requestAnimationFrame = (fn) => {
    const id = nextId++;
    pending.set(id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => pending.delete(id);

  const flight = bindKeyboardFlight({
    viewer,
    documentRef,
    searchInput: null,
    isEnabled: () => !cockpitActive,
  });

  let prevented = 0;
  const press = (code, target = null) =>
    listeners.get('keydown')?.({
      code,
      target,
      preventDefault: () => {
        prevented += 1;
      },
    });
  const release = (code) => listeners.get('keyup')?.({ code });
  const blur = () => viewListeners.get('blur')?.();

  /** Run every queued frame callback once, at `timestamp`. */
  const frame = (timestamp) => {
    const queued = [...pending.entries()];
    pending.clear();
    for (const [, fn] of queued) fn(timestamp);
  };

  return {
    flight,
    calls,
    camera,
    press,
    release,
    blur,
    frame,
    pendingCount: () => pending.size,
    preventedCount: () => prevented,
  };
}

test('W moves the camera forward once the loop ticks', () => {
  const h = harness();
  h.press('KeyW');
  // First frame only establishes the time base; movement needs a delta.
  h.frame(1000);
  h.frame(1100);
  const forward = h.calls.filter(([role]) => role === 'forward');
  assert.equal(forward.length, 1);
  assert.ok(forward[0][1] > 0, 'forward distance must be positive');
  h.flight.destroy();
});

test('WASD map to the four translation directions', () => {
  const cases = [
    ['KeyW', 'forward'],
    ['KeyS', 'backward'],
    ['KeyA', 'left'],
    ['KeyD', 'right'],
  ];
  for (const [code, role] of cases) {
    const h = harness();
    h.press(code);
    h.frame(0);
    h.frame(100);
    assert.ok(
      h.calls.some(([r]) => r === role),
      `${code} must drive ${role}`,
    );
    h.flight.destroy();
  }
});

test('G turns right and F turns left', () => {
  const right = harness();
  right.press('KeyG');
  right.frame(0);
  right.frame(100);
  assert.ok(right.calls.some(([r]) => r === 'lookRight'));
  assert.ok(!right.calls.some(([r]) => r === 'lookLeft'));
  right.flight.destroy();

  const left = harness();
  left.press('KeyF');
  left.frame(0);
  left.frame(100);
  assert.ok(left.calls.some(([r]) => r === 'lookLeft'));
  assert.ok(!left.calls.some(([r]) => r === 'lookRight'));
  left.flight.destroy();
});

test('keys combine — diagonal movement while turning', () => {
  const h = harness();
  h.press('KeyW');
  h.press('KeyD');
  h.press('KeyG');
  h.frame(0);
  h.frame(100);
  const roles = new Set(h.calls.map(([r]) => r));
  assert.ok(roles.has('forward'));
  assert.ok(roles.has('right'));
  assert.ok(roles.has('lookRight'));
  h.flight.destroy();
});

test('movement stops when the key is released', () => {
  const h = harness();
  h.press('KeyW');
  h.frame(0);
  h.frame(100);
  const moved = h.calls.length;
  h.release('KeyW');
  h.frame(200);
  h.frame(300);
  assert.equal(h.calls.length, moved, 'no movement after keyup');
  assert.equal(h.pendingCount(), 0, 'loop must not keep scheduling frames');
  h.flight.destroy();
});

test('losing window focus clears stuck keys', () => {
  // Alt-Tab never delivers keyup, so without the blur handler the camera
  // would keep flying after the operator came back.
  const h = harness();
  h.press('KeyW');
  h.frame(0);
  h.frame(100);
  const moved = h.calls.length;
  h.blur();
  h.frame(200);
  h.frame(300);
  assert.equal(h.calls.length, moved);
  assert.equal(h.pendingCount(), 0);
  h.flight.destroy();
});

test('typing in a form control never moves the camera', () => {
  const h = harness();
  const input = { matches: (sel) => sel.includes('input'), isContentEditable: false };
  h.press('KeyW', input);
  h.frame(0);
  h.frame(100);
  assert.equal(h.calls.length, 0);
  h.flight.destroy();
});

test('contenteditable targets are treated as typing', () => {
  const h = harness();
  const editor = { matches: () => false, isContentEditable: true };
  h.press('KeyA', editor);
  h.frame(0);
  h.frame(100);
  assert.equal(h.calls.length, 0);
  h.flight.destroy();
});

test('isEnabled gate suppresses flight (cockpit owns the camera)', () => {
  const h = harness({ cockpitActive: true });
  h.press('KeyW');
  h.frame(0);
  h.frame(100);
  assert.equal(h.calls.length, 0);
  h.flight.destroy();
});

test('unrelated keys are ignored and never preventDefault', () => {
  const h = harness();
  h.press('KeyH');
  h.press('KeyC');
  h.press('Escape');
  assert.equal(h.preventedCount(), 0);
  assert.equal(h.pendingCount(), 0);
  h.flight.destroy();
});

test('handled keys call preventDefault so other shortcuts do not double-fire', () => {
  const h = harness();
  h.press('KeyW');
  assert.equal(h.preventedCount(), 1);
  h.flight.destroy();
});

test('move rate scales with camera height', () => {
  const low = harness();
  low.camera.positionCartographic.height = 500;
  low.press('KeyW');
  low.frame(0);
  low.frame(100);
  const lowDistance = low.calls.find(([r]) => r === 'forward')[1];
  low.flight.destroy();

  const high = harness();
  high.camera.positionCartographic.height = 500000;
  high.press('KeyW');
  high.frame(0);
  high.frame(100);
  const highDistance = high.calls.find(([r]) => r === 'forward')[1];
  high.flight.destroy();

  assert.ok(
    highDistance > lowDistance * 100,
    'a camera at altitude must travel far more per tick than one near the ground',
  );
});

test('a huge frame delta is clamped so the camera cannot teleport', () => {
  // A backgrounded tab resumes with one enormous timestamp jump.
  const h = harness();
  h.camera.positionCartographic.height = 1000;
  h.press('KeyW');
  h.frame(0);
  h.frame(60_000); // one minute later
  const distance = h.calls.find(([r]) => r === 'forward')[1];
  // height 1000 * 0.6 = 600 m/s, clamped to a 0.1 s step => 60 m.
  assert.ok(distance <= 60.001, `expected a clamped step, got ${distance}`);
  h.flight.destroy();
});

test('an invalid camera height falls back to the floor rate', () => {
  const h = harness();
  h.camera.positionCartographic.height = Number.NaN;
  h.press('KeyW');
  h.frame(0);
  h.frame(1000);
  const distance = h.calls.find(([r]) => r === 'forward')[1];
  assert.ok(Number.isFinite(distance) && distance > 0);
  h.flight.destroy();
});

test('repeat keydown does not stack duplicate motion', () => {
  const h = harness();
  h.press('KeyW');
  h.press('KeyW');
  h.press('KeyW');
  h.frame(0);
  h.frame(100);
  assert.equal(
    h.calls.filter(([r]) => r === 'forward').length,
    1,
    'one held key is one movement per frame',
  );
  h.flight.destroy();
});

test('destroy is idempotent and stops the loop', () => {
  const h = harness();
  h.press('KeyW');
  h.frame(0);
  h.flight.destroy();
  h.flight.destroy();
  assert.equal(h.pendingCount(), 0);
});

test('a destroyed viewer ends the loop instead of throwing', () => {
  const h = harness();
  h.press('KeyW');
  h.frame(0);
  // Simulate the viewer being torn down between frames.
  h.flight && (h.camera.positionCartographic = null);
  assert.doesNotThrow(() => h.frame(100));
  h.flight.destroy();
});
