// Contract for the picture-in-picture mirror's motion: the spring, the anchor
// set, the throw projection and the pointer tracker. These are the parts that
// can be checked exactly, so they are checked exactly — the numbers came from
// Codex's sky.node and a silent drift in any of them would be felt but not
// seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PIP_SPRING,
  PIP_THROW_MAX,
  PIP_THROW_REFERENCE,
  PIP_THROW_SCALE,
  PipDragTracker,
  anchorFor,
  pipGripCorner,
  pipResizeEdge,
  clampToWorkArea,
  pickPipAnchor,
  pipAnchors,
  springAtRest,
  stepSpring,
} from '../computer-use/pip-motion.js';

const HOST = { x: 0, y: 0, width: 1000, height: 800 };
const SIZE = { width: 200, height: 125 };

test('picture-in-picture motion', async (t) => {
  await t.test('carries Codex’s spring constants, and their damping ratios', () => {
    // `configureMotionSpringsWithLeadItem:dragging:programmaticMove:`, lead column.
    assert.deepEqual(PIP_SPRING.settling, { stiffness: 320, damping: 42 });
    assert.deepEqual(PIP_SPRING.dragging, { stiffness: 900, damping: 55 });

    // The ratios are the reason those numbers and not others: settling must not
    // overshoot the corner it is landing on, dragging should keep a little give.
    const ratio = (s: { stiffness: number; damping: number }) =>
      s.damping / (2 * Math.sqrt(s.stiffness));
    assert.ok(ratio(PIP_SPRING.settling) > 1, 'settling is overdamped, so it never bounces');
    assert.ok(ratio(PIP_SPRING.dragging) < 1, 'dragging is under critical, so it has give');
    assert.ok(ratio(PIP_SPRING.dragging) > 0.85, 'but only just — it must not wobble');
  });

  await t.test('the spring arrives, and never overshoots while settling', () => {
    let state = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
    const target = { x: 400, y: 300 };
    let maxX = 0;
    for (let i = 0; i < 240 && !springAtRest(state, target); i++) {
      state = stepSpring(state, target, PIP_SPRING.settling, 1 / 60);
      maxX = Math.max(maxX, state.position.x);
    }
    assert.ok(springAtRest(state, target), 'arrives inside four seconds');
    assert.ok(maxX <= target.x + 0.5, `overdamped means no overshoot (peaked at ${maxX})`);
  });

  await t.test('a dropped frame makes the spring late, never explosive', () => {
    // Explicit Euler gains energy at large dt. A backgrounded window can hand
    // us a gap of seconds, and the mirror must not be launched off-screen by
    // the machine having been busy.
    let state = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
    const target = { x: 400, y: 0 };
    for (let i = 0; i < 60; i++) state = stepSpring(state, target, PIP_SPRING.settling, 5);
    assert.ok(Number.isFinite(state.position.x));
    assert.ok(state.position.x <= target.x + 1, 'still converges from above');
    assert.ok(springAtRest(state, target));
  });

  await t.test('offers one anchor per corner, inset by the same margin', () => {
    const anchors = pipAnchors(HOST, SIZE, 24);
    assert.equal(anchors.length, 4);
    assert.deepEqual(anchorFor(anchors, 'top-left')?.point, { x: 24, y: 24 });
    assert.deepEqual(anchorFor(anchors, 'top-right')?.point, { x: 1000 - 200 - 24, y: 24 });
    assert.deepEqual(anchorFor(anchors, 'bottom-left')?.point, { x: 24, y: 800 - 125 - 24 });
    assert.deepEqual(anchorFor(anchors, 'bottom-right')?.point, {
      x: 1000 - 200 - 24,
      y: 800 - 125 - 24,
    });
  });

  await t.test('a still release lands on the corner it is nearest', () => {
    const anchors = pipAnchors(HOST, SIZE, 24);
    const near = { x: 700, y: 40 };
    assert.equal(pickPipAnchor(anchors, near, { x: 0, y: 0 }, HOST).alignment, 'top-right');
    assert.equal(
      pickPipAnchor(anchors, { x: 30, y: 600 }, { x: 0, y: 0 }, HOST).alignment,
      'bottom-left',
    );
  });

  await t.test('a throw lands where it was aimed, not where it started', () => {
    // This is the whole point of the projection. Released in the top-left
    // quadrant but flung hard to the right, the mirror must cross the window —
    // nearest-corner alone would drop it back where it came from.
    const anchors = pipAnchors(HOST, SIZE, 24);
    const from = { x: 300, y: 40 };
    assert.equal(
      pickPipAnchor(anchors, from, { x: 0, y: 0 }, HOST).alignment,
      'top-left',
      'without a throw it stays near',
    );
    assert.equal(
      pickPipAnchor(anchors, from, { x: 3000, y: 0 }, HOST).alignment,
      'top-right',
      'thrown right, it crosses',
    );
    assert.equal(
      pickPipAnchor(anchors, from, { x: 2000, y: 2500 }, HOST).alignment,
      'bottom-right',
      'thrown down and right, it takes the far corner',
    );
  });

  await t.test('carries Codex’s throw constants', () => {
    assert.equal(PIP_THROW_SCALE, 0.55);
    assert.equal(PIP_THROW_REFERENCE, 5000);
    assert.equal(PIP_THROW_MAX, 0.45);
  });

  await t.test('the grip is on the corner the resize gesture actually moves', () => {
    // `pipResizeEdge` takes its sign from the anchor, because the anchored
    // corner is the one held still while the tile grows. The handle has to be
    // on the corner that moves, or the pointer separates from it immediately.
    // These two functions are the only reason the gesture is coherent, and
    // they used to disagree: the sign came from here and the handle's position
    // was hard-coded to the tile's top-left in CSS.
    assert.equal(pipGripCorner('bottom-right'), 'top-left');
    assert.equal(pipGripCorner('bottom-left'), 'top-right');
    assert.equal(pipGripCorner('top-right'), 'bottom-left');
    assert.equal(pipGripCorner('top-left'), 'bottom-right');

    // Stated as the invariant rather than as four pairs: for every anchor, the
    // grip is on the opposite corner *and* dragging it away from the anchor
    // grows the tile. Flip either function alone and this fails.
    for (const alignment of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const grip = pipGripCorner(alignment);
      assert.notEqual(grip.startsWith('top'), alignment.startsWith('top'), alignment);
      assert.notEqual(grip.endsWith('left'), alignment.endsWith('left'), alignment);
      // The grip is below the anchor exactly when dragging down must grow.
      const growsDownward = pipResizeEdge(200, 500, 560, alignment) > 200;
      assert.equal(growsDownward, grip.startsWith('bottom'), alignment);
    }
  });

  await t.test('a resize drag grows away from the anchor, in every corner', () => {
    // `-[PIPStackResizeInteraction maxDisplaySizeForPointerScreenPoint:]` is
    // four instructions: a sign chosen from the alignment, and the pointer's
    // vertical travel added to the edge it started at. Only the vertical
    // component moves it, and the sign is what makes the gesture read the same
    // wherever the mirror is resting: away from the anchor grows it.
    //
    // Anchored at the top, the grip is below, so dragging down grows.
    assert.equal(pipResizeEdge(200, 500, 560, 'top-left'), 260);
    assert.equal(pipResizeEdge(200, 500, 440, 'top-left'), 140);
    // Anchored at the bottom, the grip is above, so dragging up grows.
    assert.equal(pipResizeEdge(200, 500, 440, 'bottom-right'), 260);
    assert.equal(pipResizeEdge(200, 500, 560, 'bottom-right'), 140);
  });

  await t.test('a resize stays inside Codex’s clamp and lands on whole points', () => {
    // The same [100, 400] the rest of the sizing uses — the three constants are
    // literally the same doubles in the binary. A fractional edge on a
    // transparent window shimmers, which is what Codex's
    // `snapPointToBackingScale:` exists to stop.
    assert.equal(pipResizeEdge(200, 500, 5000, 'top-left'), 400, 'ceiling');
    assert.equal(pipResizeEdge(200, 500, -5000, 'top-left'), 100, 'floor');
    assert.equal(pipResizeEdge(200, 500, 500.4, 'top-left') % 1, 0, 'whole points');
  });

  await t.test('a resize that does not move the pointer does not move the edge', () => {
    assert.equal(pipResizeEdge(200, 500, 500, 'top-left'), 200);
    assert.equal(pipResizeEdge(137, 500, 500, 'bottom-left'), 137);
  });

  await t.test('never leaves the mirror off the display', () => {
    const work = { x: 0, y: 0, width: 1440, height: 900 };
    assert.deepEqual(clampToWorkArea({ x: -500, y: -500 }, SIZE, work), { x: 0, y: 0 });
    assert.deepEqual(clampToWorkArea({ x: 5000, y: 5000 }, SIZE, work), {
      x: 1440 - 200,
      y: 900 - 125,
    });
  });

  await t.test('the drag keeps the grab point under the pointer', () => {
    // Grab the mirror 30pt in and 20pt down, and that spot stays under the
    // cursor for the whole drag. Anything else makes the window jump on
    // mousedown, which reads as the drag having missed.
    const tracker = new PipDragTracker({ x: 130, y: 220 }, { x: 100, y: 200 }, 0);
    assert.deepEqual(tracker.update({ x: 530, y: 420 }, 100), { x: 500, y: 400 });
    assert.deepEqual(tracker.update({ x: 330, y: 320 }, 200), { x: 300, y: 300 });
  });

  await t.test('velocity comes from the last pair of samples only', () => {
    // A flick that ends in a pause is not a flick. Averaging the whole drag
    // would throw the mirror anyway, which is the opposite of what the pause
    // said.
    const tracker = new PipDragTracker({ x: 0, y: 0 }, { x: 0, y: 0 }, 0);
    tracker.update({ x: 500, y: 0 }, 100);
    assert.deepEqual(tracker.velocity(), { x: 5000, y: 0 }, 'a fast sample is a fast throw');
    tracker.update({ x: 500, y: 0 }, 600);
    assert.deepEqual(tracker.velocity(), { x: 0, y: 0 }, 'and then it stopped');
  });

  await t.test('a duplicate pointer event is not an infinite flick', () => {
    const tracker = new PipDragTracker({ x: 0, y: 0 }, { x: 0, y: 0 }, 0);
    tracker.update({ x: 10, y: 10 }, 50);
    tracker.update({ x: 20, y: 20 }, 50);
    const v = tracker.velocity();
    assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y), `finite, got ${JSON.stringify(v)}`);
  });
});
