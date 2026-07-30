/**
 * Card flight geometry contract.
 *
 * The properties worth pinning are the ones that make the motion mean
 * something: it must ARC (a slide reads as an unrelated popup appearing),
 * it must NOT overshoot the target (overshoot reads as imprecision when
 * the card is claiming "your target is exactly here"), and it must end
 * exactly on the docked rect — a few pixels off and the card sits visibly
 * crooked against the Settings window it is supposed to belong to.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ARC_MAX_PX,
  ARC_MIN_PX,
  FLIGHT_MS,
  frameAt,
  runFlight,
  springProgress,
  type Rect,
} from '../permission-overlay/card-flight.js';

const button: Rect = { x: 1000, y: 700, width: 96, height: 28 };
const docked: Rect = { x: 400, y: 200, width: 530, height: 109 };

describe('card flight geometry', () => {
  it('starts on the button and lands exactly on the docked rect', () => {
    assert.deepEqual(frameAt(button, docked, 0), {
      x: button.x, y: button.y, width: button.width, height: button.height,
    });
    assert.deepEqual(frameAt(button, docked, 1), docked);
  });

  it('arcs above the straight line instead of sliding along it', () => {
    const mid = frameAt(button, docked, 0.5);
    const midCy = mid.y + mid.height / 2;
    const straightCy =
      (button.y + button.height / 2)
      + ((docked.y + docked.height / 2) - (button.y + button.height / 2)) * springProgress(0.5);
    // Screen coordinates: "above" is a smaller y.
    assert.ok(
      midCy < straightCy - 10,
      `midpoint must bow upward off the straight path (arc ${straightCy - midCy}px)`,
    );
  });

  it('never overshoots the destination', () => {
    // Critically damped: progress approaches 1 from below, never past it.
    for (let i = 0; i <= 100; i++) {
      const p = springProgress(i / 100);
      assert.ok(p <= 1 + 1e-9, `springProgress(${i / 100}) = ${p} overshot`);
      assert.ok(p >= 0, `springProgress(${i / 100}) = ${p} went negative`);
    }
  });

  it('advances monotonically — no stalls or backtracking', () => {
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const p = springProgress(i / 100);
      assert.ok(p >= previous, `progress went backwards at t=${i / 100}`);
      previous = p;
    }
  });

  it('clamps the arc height for very short and very long flights', () => {
    const near: Rect = { x: 402, y: 202, width: 96, height: 28 };
    const nearMid = frameAt(near, docked, 0.5);
    const nearStraightCy =
      (near.y + near.height / 2)
      + ((docked.y + docked.height / 2) - (near.y + near.height / 2)) * springProgress(0.5);
    // Even a near-zero-distance hop still visibly arcs (ARC_MIN_PX).
    assert.ok(nearStraightCy - (nearMid.y + nearMid.height / 2) > ARC_MIN_PX / 4);

    const far: Rect = { x: 5000, y: 3000, width: 96, height: 28 };
    const farMid = frameAt(far, docked, 0.5);
    const farStraightCy =
      (far.y + far.height / 2)
      + ((docked.y + docked.height / 2) - (far.y + far.height / 2)) * springProgress(0.5);
    // ...and a cross-screen flight does not loop absurdly high.
    assert.ok(farStraightCy - (farMid.y + farMid.height / 2) <= ARC_MAX_PX + 1);
  });

  it('grows from the button footprint into the card', () => {
    const quarter = frameAt(button, docked, 0.25);
    assert.ok(quarter.width > button.width && quarter.width < docked.width);
    assert.ok(quarter.height > button.height && quarter.height < docked.height);
  });
});

describe('flight runner', () => {
  function harness(reducedMotion = false) {
    let clock = 0;
    const frames: Rect[] = [];
    let done = false;
    const ticks: Array<() => void> = [];
    const cancel = runFlight({
      from: button,
      to: docked,
      reducedMotion,
      now: () => clock,
      setFrame: (rect) => frames.push(rect),
      requestTick: (fn) => ticks.push(fn),
      onDone: () => { done = true; },
    });
    return {
      frames, ticks, cancel,
      isDone: () => done,
      advance(ms: number) { clock += ms; const pending = ticks.splice(0); pending.forEach((fn) => fn()); },
    };
  }

  it('jumps straight to the destination under reduced motion', () => {
    const h = harness(true);
    assert.deepEqual(h.frames, [docked], 'no intermediate frames when motion is reduced');
    assert.equal(h.isDone(), true);
    assert.equal(h.ticks.length, 0, 'and no animation scheduled');
  });

  it('animates to completion and reports done exactly once', () => {
    const h = harness();
    for (let i = 0; i < 60 && !h.isDone(); i++) h.advance(16);
    assert.equal(h.isDone(), true);
    assert.deepEqual(h.frames.at(-1), docked, 'must settle exactly on the docked rect');
    assert.ok(h.frames.length > 5, 'should have produced real intermediate frames');
  });

  it('stops moving the window once cancelled mid-flight', () => {
    const h = harness();
    h.advance(FLIGHT_MS / 4);
    const seen = h.frames.length;
    h.cancel();
    h.advance(FLIGHT_MS);
    assert.equal(h.frames.length, seen, 'a tick after cancel must not move a destroyed window');
    assert.equal(h.isDone(), false, 'and must not report completion');
  });
});
