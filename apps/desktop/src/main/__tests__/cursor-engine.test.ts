/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PRESENTATION_FINISHED_TIMEOUT_MS } from '@maka/runtime/computer-use-tools';

import {
  CURSOR_GLYPH,
  CURSOR_MOTION,
  CubicCursorPath,
  CURSOR_CLOSE_ENOUGH,
  CursorEngine,
  cursorHeadingAt,
  cursorPresentationReadyDeadlineMs,
  measureCursorPath,
  planCursorPath,
  scoreCursorPath,
} from '../../renderer/computer-use-overlay/engine/cursor-engine.js';
import { cursorCandidatePairs } from '../../renderer/computer-use-overlay/engine/cursor-candidate-grid.js';

const finite = (value: number): boolean => Number.isFinite(value);

type Vec = readonly [number, number];

const CLICK_DIRECTION: Vec = [
  Math.cos(CURSOR_MOTION.clickAngle),
  Math.sin(CURSOR_MOTION.clickAngle),
];

/**
 * Rebuilds one planner candidate: the same cubic the planner constructs for a
 * given perpendicular bulge, departing straight at the target.
 */
function candidateWithArc(start: Vec, end: Vec, arc: number): CubicCursorPath {
  const config = CURSOR_MOTION;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const distance = Math.hypot(dx, dy);
  const direction: Vec = [dx / distance, dy / distance];
  const perpendicular: Vec = [-direction[1], direction[0]];
  return new CubicCursorPath(
    start,
    [
      start[0] + direction[0] * distance * config.startHandle
        + perpendicular[0] * arc * config.arcFlow,
      start[1] + direction[1] * distance * config.startHandle
        + perpendicular[1] * arc * config.arcFlow,
    ],
    [
      end[0] - direction[0] * distance * config.endpointHandle
        + perpendicular[0] * arc * (1 - config.arcFlow),
      end[1] - direction[1] * distance * config.endpointHandle
        + perpendicular[1] * arc * (1 - config.arcFlow),
    ],
    end,
  );
}

/** Widest excursion of a path from the straight line between its endpoints. */
function maxChordDeviation(path: CubicCursorPath, start: Vec, end: Vec): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  const normal: Vec = [-dy / length, dx / length];
  let widest = 0;
  for (let index = 0; index <= 64; index++) {
    const [x, y] = path.sample(index / 64);
    widest = Math.max(widest, Math.abs((x - start[0]) * normal[0] + (y - start[1]) * normal[1]));
  }
  return widest;
}

const scoreOf = (path: CubicCursorPath, start: Vec, end: Vec): number => scoreCursorPath(
  measureCursorPath(path, start, end, null),
  Math.hypot(end[0] - start[0], end[1] - start[1]),
  CLICK_DIRECTION,
);

test('planner takes the straightest acceptable path, not the bendiest', () => {
  const start: Vec = [100, 100];
  const end: Vec = [700, 360];
  const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const maxArc = Math.min(distance * CURSOR_MOTION.arcSize, 120);

  const chosen = planCursorPath(start, end, null, null);
  const bulged = candidateWithArc(start, end, maxArc);
  const bulgedTheOtherWay = candidateWithArc(start, end, -maxArc);

  const chosenDeviation = maxChordDeviation(chosen, start, end);
  const bulgedDeviation = maxChordDeviation(bulged, start, end);
  assert.ok(bulgedDeviation > 40, `max-bulge candidate should bow hard, got ${bulgedDeviation}`);
  assert.ok(
    chosenDeviation < bulgedDeviation / 4,
    `planner bowed ${chosenDeviation}px against a ${bulgedDeviation}px maximum`,
  );
  assert.ok(chosenDeviation < 0.01 * distance, `${chosenDeviation}px over a ${distance}px move`);

  assert.ok(scoreOf(chosen, start, end) < scoreOf(bulged, start, end));
  assert.ok(scoreOf(chosen, start, end) < scoreOf(bulgedTheOtherWay, start, end));

  // The planner still ends exactly on the hotspot it was handed.
  const landing = chosen.sample(1);
  assert.ok(Math.hypot(landing[0] - end[0], landing[1] - end[1]) < 1e-9);
});


test('a fresh move departs toward its target, never along the parked rest angle', () => {
  // Down and to the left: the exact opposite of the -45 degree rest angle that
  // every fresh move used to launch along.
  const start: Vec = [600, 400];
  const end: Vec = [200, 700];
  const path = planCursorPath(start, end, null, null);
  const early = path.sample(0.05);
  const stepLength = Math.hypot(early[0] - start[0], early[1] - start[1]);
  assert.ok(stepLength > 0);
  const toTarget = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const alignment = ((early[0] - start[0]) / stepLength) * ((end[0] - start[0]) / toTarget)
    + ((early[1] - start[1]) / stepLength) * ((end[1] - start[1]) / toTarget);
  assert.ok(alignment > 0.95, `departure alignment with the target was ${alignment}`);

  const restAlignment = ((early[0] - start[0]) / stepLength) * CLICK_DIRECTION[0]
    + ((early[1] - start[1]) / stepLength) * CLICK_DIRECTION[1];
  assert.ok(restAlignment < 0, `move launched along the rest angle (${restAlignment})`);
});

test('an interrupted move can be planned dead straight', () => {
  // The candidate grid spans [-maxArc, +maxArc] in `arcCount` steps, so it only
  // contains arc = 0 when `arcCount` is odd. It used to be even in both cases:
  // 20 from rest (nearest candidate ~5.8pt off the chord, cosmetic) and 4 on an
  // interrupt, where the smallest bulge available was a third of maxArc. On a
  // 400pt move that is 36.9pt of perpendicular bow the scorer had no way to
  // decline, in a planner whose whole stated job is to pick the straightest
  // candidate that clears the viewport.
  const start: Vec = [400, 400];
  const end: Vec = [800, 400];
  const carried = Math.PI / 2; // travelling straight down when retargeted
  const distance = 400;
  const maxArc = Math.min(distance * CURSOR_MOTION.arcSize, 120);
  assert.ok(maxArc > 100, `the bulge ceiling should bite on this move, got ${maxArc}`);

  const straight = candidateWithArc(start, end, 0);
  assert.ok(
    maxChordDeviation(straight, start, end) < 1e-6,
    'the zero-arc candidate is the straight one',
  );

  const interrupted = planCursorPath(start, end, carried, null);
  const deviation = maxChordDeviation(interrupted, start, end);
  // A third of maxArc is what the old even grid forced. Well under a point is
  // what a reachable straight candidate buys.
  assert.ok(
    deviation < 1,
    `interrupted move bowed ${deviation.toFixed(2)}pt when a straight path scored better`,
  );
  assert.ok(
    scoreOf(interrupted, start, end)
      <= scoreOf(candidateWithArc(start, end, maxArc / 3), start, end),
    'the chosen path is no worse than the straightest the old grid could offer',
  );
});


test('the presentation deadline covers the slowest release the gate can ask for', () => {
  // The renderer releases an action at CURSOR_CLOSE_ENOUGH.progress; the runtime
  // gives up waiting at this deadline. Two constants picked apart from each
  // other is how a cross-display move came to be dispatched at 1000ms while its
  // own gate needed ~1940ms, putting the click ~180pt short of the target.
  const deadlineMs = cursorPresentationReadyDeadlineMs();
  // Simulate the worst case the spring can produce: the response is clamped at
  // springResponseMax, so no move can be slower than this one.
  const spring = {
    value: 0,
    velocity: 0,
    target: 1,
    response: CURSOR_MOTION.springResponseMax,
    damping: CURSOR_MOTION.springDampingFraction,
  };
  const dt = 1 / 240;
  let seconds = 0;
  while (spring.value < CURSOR_CLOSE_ENOUGH.progress && seconds < 30) {
    const omega = (Math.PI * 2) / spring.response;
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      spring.velocity
        += (omega * omega * (spring.target - spring.value)
          - 2 * spring.damping * omega * spring.velocity) * h;
      spring.value += spring.velocity * h;
    }
    seconds += dt;
  }
  assert.ok(spring.value >= CURSOR_CLOSE_ENOUGH.progress, 'the gate does open');
  assert.ok(
    deadlineMs >= seconds * 1000,
    `deadline ${deadlineMs}ms is shorter than the ${(seconds * 1000).toFixed(0)}ms `
      + 'the slowest move needs to reach the release gate',
  );
  // And not so generous that a dead renderer hangs the turn.
  assert.ok(deadlineMs < 5_000, `deadline ${deadlineMs}ms is an unreasonable backstop`);
});

test('the deadline holds at every frame rate the overlay can paint at', () => {
  // The test above integrates its own spring at a fixed 1/240 and measures
  // simulated time, so it says nothing about where the wall clock actually
  // enters. `tick` clamped its step to the integrator's stability bound and
  // dropped the rest, so a frame longer than that advanced the simulation by
  // less time than had passed: measured, the gate opened at 1950ms at 20fps and
  // 3900ms at 10fps, against a 2402ms deadline. The docstring claimed the bound
  // did not depend on the frame rate; below 20fps it did, and 17ms of headroom
  // covers one dropped frame rather than sustained throttling.
  //
  // This drives `tickTo` with a frame clock, because that is the entry point
  // the overlay's rAF loop calls and the delta is derived behind it. An earlier
  // version of this test called `tick` with a step it computed itself, which is
  // the one thing the overlay does not do — it clamped its own delta to 50ms
  // before calling in, so the sub-stepping under test never saw a long frame
  // and this test could not go red for the defect it was written for.
  const deadlineMs = cursorPresentationReadyDeadlineMs();
  // The overlay's own release gate, from apps/desktop/src/overlay/cursor-overlay.ts.
  const gateOpen = (engine: CursorEngine): boolean =>
    !engine.hasMotionPath()
    || engine.motionProgress() >= CURSOR_CLOSE_ENOUGH.progress
    || engine.motionDistanceRemaining() <= CURSOR_CLOSE_ENOUGH.distance;

  for (const fps of [240, 120, 60, 30, 20, 15, 10, 5, 1]) {
    const engine = new CursorEngine();
    engine.setViewport(3840, 1600);
    // The first move only fades the glyph in at its hotspot; settle that before
    // asking for the move whose deadline is under test.
    let frameMs = 0;
    engine.moveTo(20, 20);
    for (let i = 0; i < 200; i++) {
      frameMs += 1000 / 240;
      engine.tickTo(frameMs);
    }
    // A cross-display move, long enough to clamp at springResponseMax, which is
    // the worst case the deadline is derived from.
    engine.moveTo(3800, 1500);
    assert.equal(gateOpen(engine), false, `${fps}fps: the move has a path to begin with`);

    // The frame that starts the clock. The previous motion settled, so the
    // overlay stopped asking for frames and the engine dropped its clock; the
    // first frame after a resume has no previous frame to measure against and
    // advances nothing. That is deliberate — the alternative is replaying the
    // idle gap as motion, which the test below pins — and it is not part of
    // what this deadline bounds. `cursorPresentationReadyDeadlineMs` bounds how
    // long the motion takes once the overlay is painting it; how long the
    // overlay takes to start painting is the presentation fence's own backstop.
    const stepMs = 1000 / fps;
    frameMs += stepMs;
    engine.tickTo(frameMs);

    let wallClockMs = 0;
    while (!gateOpen(engine) && wallClockMs < 30_000) {
      frameMs += stepMs;
      wallClockMs += stepMs;
      engine.tickTo(frameMs);
    }
    assert.ok(
      gateOpen(engine),
      `${fps}fps: the gate never opened within 30s of wall clock`,
    );
    assert.ok(
      wallClockMs <= deadlineMs,
      `${fps}fps: the gate opened after ${Math.round(wallClockMs)}ms of wall clock, `
        + `past the ${deadlineMs}ms the runtime waits`,
    );
  }
});

test('a presentation resumed after an idle gap does not replay the gap', () => {
  // The frame clock is the engine's now, so it has to survive the overlay's rAF
  // loop stopping. `cursor-overlay.ts` blocks on idle — no frames at all while
  // the cursor rests — and the next `tickTo` after a move arrives carries the
  // whole gap as its delta. Kept, that is up to `MAX_CATCH_UP` of a motion the
  // engine was handed a millisecond ago, integrated before the first frame is
  // painted: the glyph teleports most of the way and the release gate opens
  // instantly, which is the mid-flight dispatch the gate exists to prevent.
  const engine = new CursorEngine();
  engine.setViewport(3840, 1600);
  engine.moveTo(20, 20);
  let frameMs = 0;
  while (engine.isMoving() && frameMs < 30_000) {
    frameMs += 1000 / 60;
    engine.tickTo(frameMs);
  }
  assert.equal(engine.isMoving(), false, 'the first move settles, so the loop would stop here');

  // Sixty seconds of no frames, then a fresh move — exactly the shape of a
  // cursor that rested through a turn and was asked to move again.
  const idleMs = 60_000;
  engine.moveTo(3800, 1500);
  const startedAt: [number, number] = [engine.pos[0], engine.pos[1]];
  engine.tickTo(frameMs + idleMs);

  const travelled = Math.hypot(engine.pos[0] - startedAt[0], engine.pos[1] - startedAt[1]);
  const total = Math.hypot(3800 - startedAt[0], 1500 - startedAt[1]);
  assert.ok(
    travelled < total * 0.05,
    `the first frame after a ${idleMs}ms idle advanced the glyph ${Math.round(travelled)}px `
      + `of ${Math.round(total)}px; the gap was replayed as motion`,
  );
  assert.equal(engine.motionProgress() < CURSOR_CLOSE_ENOUGH.progress, true);
});


test('the landing the runtime waits for fits in the backstop it waits with', () => {
  // `presentationFinishedTimeoutMs` looks like `readyTimeoutMs` chosen a second
  // time and smaller. It is not: the two bound sequential intervals. The ready
  // deadline covers the whole motion, up to the release gate; the finished
  // backstop starts only after `onActionEnd`, so all it has to cover is the
  // tail left after the gate opened. Nothing related the two numbers and
  // nothing measured the tail, which is the part worth fixing.
  const gateOpen = (engine: CursorEngine): boolean =>
    !engine.hasMotionPath()
    || engine.motionProgress() >= CURSOR_CLOSE_ENOUGH.progress
    || engine.motionDistanceRemaining() <= CURSOR_CLOSE_ENOUGH.distance;

  const engine = new CursorEngine();
  engine.setViewport(3840, 1600);
  engine.moveTo(20, 20);
  for (let i = 0; i < 200; i++) engine.tick(1 / 240);
  // The worst case again: a cross-display move at springResponseMax.
  engine.moveTo(3800, 1500);

  const dt = 1 / 60;
  let elapsedMs = 0;
  let gateMs: number | null = null;
  while (engine.hasMotionPath() && elapsedMs < 30_000) {
    engine.tick(dt);
    elapsedMs += dt * 1000;
    if (gateMs === null && gateOpen(engine)) gateMs = elapsedMs;
  }
  assert.notEqual(gateMs, null, 'the gate opens');
  assert.equal(engine.hasMotionPath(), false, 'the motion settles');
  // The upper bound on the tail: in practice `complete()` truncates it the
  // moment the dispatch returns, so the real wait is shorter than this.
  const tailMs = elapsedMs - (gateMs as number);
  assert.ok(
    tailMs <= DEFAULT_PRESENTATION_FINISHED_TIMEOUT_MS,
    `the longest tail after the release gate is ${Math.round(tailMs)}ms, past the `
      + `${DEFAULT_PRESENTATION_FINISHED_TIMEOUT_MS}ms the runtime waits for a presentation `
      + 'to report it has finished',
  );
});

test('an interrupted move may still honour the heading it is already carrying', () => {  const start: Vec = [400, 400];
  const end: Vec = [800, 420];
  const carried = Math.PI / 2; // travelling straight down when retargeted
  const continued = planCursorPath(start, end, carried, null);
  const fresh = planCursorPath(start, end, null, null);
  assert.ok(finite(continued.p1[0]) && finite(continued.p1[1]));
  // Both plans land on the hotspot; the in-flight one is free to differ because
  // its departure fan is anchored on the heading it inherited.
  assert.deepEqual(continued.sample(1), fresh.sample(1));
});


test('first appearance uses the requested action hotspot without an off-screen glide', () => {
  const engine = new CursorEngine();
  engine.moveTo(400, 300);
  assert.deepEqual(engine.pos, [400, 300]);
  assert.equal(engine.hasMotionPath(), false);
  assert.ok(engine.isMoving(), 'first appearance fades in at the target');
  for (let frame = 0; frame < 12; frame++) engine.tick(1 / 60);
  assert.ok(!engine.isMoving());
});

test('subsequent move spring-settles exactly on the action hotspot', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.moveTo(700, 360);
  let frames = 0;
  while (engine.isMoving() && frames < 60 * 8) {
    engine.tick(1 / 60);
    assert.ok(finite(engine.pos[0]) && finite(engine.pos[1]) && finite(engine.heading));
    frames++;
  }
  assert.ok(!engine.isMoving(), `settled in ${frames} frames`);
  assert.ok(Math.hypot(engine.pos[0] - 700, engine.pos[1] - 360) < 0.01);
  assert.ok(frames > 10 && frames < 60 * 4);
});

test('presentation progress APIs track the active spring path', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.moveTo(700, 360);
  assert.equal(engine.hasMotionPath(), true);
  assert.equal(engine.motionProgress(), 0);
  assert.ok(engine.motionDistanceRemaining() > 600);
  for (let frame = 0; frame < 20; frame++) engine.tick(1 / 60);
  assert.ok(engine.motionProgress() > 0);
  assert.ok(engine.motionDistanceRemaining() < 654);
});

test('short move remains finite and converges without a curved overshoot', () => {
  const engine = new CursorEngine();
  engine.moveTo(200, 200);
  engine.moveTo(206, 204);
  let frames = 0;
  while (engine.isMoving() && frames < 300) {
    engine.tick(1 / 60);
    frames++;
  }
  assert.ok(Math.hypot(engine.pos[0] - 206, engine.pos[1] - 204) < 0.01);
});

test('boundary path never bows outside the viewport', () => {
  const engine = new CursorEngine();
  engine.setViewport(800, 600);
  engine.moveTo(5, 5);
  engine.moveTo(5, 500);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (let frame = 0; engine.isMoving() && frame < 300; frame++) {
    engine.tick(1 / 60);
    minX = Math.min(minX, engine.pos[0]);
    minY = Math.min(minY, engine.pos[1]);
  }
  assert.ok(minX >= 0, `minimum x should remain visible, got ${minX}`);
  assert.ok(minY >= 0, `minimum y should remain visible, got ${minY}`);
  assert.deepEqual(engine.pos, [5, 500]);
});

test('a long fast move keeps the glyph inside a single scootRotationMax', () => {
  const engine = new CursorEngine();
  engine.setViewport(4000, 3000);
  engine.moveTo(2000, 1500);
  for (let frame = 0; frame < 20; frame++) engine.tick(1 / 60);
  // Just past scootDistanceThreshold and turning hard away from the rest angle:
  // the case where the old base-rotation-plus-offset pair summed past its own
  // ceiling into a visible spin.
  engine.moveTo(2000 + Math.cos(Math.PI * 5 / 8) * 200, 1500 + Math.sin(Math.PI * 5 / 8) * 200);

  const rotations: number[] = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    createLinearGradient: () => gradient,
    beginPath() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    closePath() {},
    save() {},
    restore() {},
    translate() {},
    rotate(angle: number) { rotations.push(angle); },
    scale() {},
    set fillStyle(_value: unknown) {},
    set strokeStyle(_value: unknown) {},
    set lineWidth(_value: number) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set lineCap(_value: CanvasLineCap) {},
    set shadowColor(_value: string) {},
    set shadowBlur(_value: number) {},
    set shadowOffsetX(_value: number) {},
    set shadowOffsetY(_value: number) {},
    set globalAlpha(_value: number) {},
  } as unknown as CanvasRenderingContext2D;

  let widest = 0;
  for (let frame = 0; engine.isMoving() && frame < 600; frame++) {
    engine.tick(1 / 60);
    rotations.length = 0;
    engine.paint(ctx, 0, 0);
    // paint applies the stretch axis, unwinds it, then applies the one rotation
    // term. Three rotate calls, and the third is the whole glyph rotation.
    assert.equal(rotations.length, 3);
    assert.ok(Math.abs(rotations[0] + rotations[1]) < 1e-12, 'stretch axis must unwind');
    widest = Math.max(widest, Math.abs(rotations[2]));
  }
  assert.ok(widest > 0.05, `rotation term never engaged (${widest})`);
  // The rotation target is clamped to scootRotationMax exactly once; the spring
  // chasing it is underdamped, so allow it a few percent of settling overshoot.
  // The two-term version reached 1.62 rad here, well past this line.
  assert.ok(
    widest <= CURSOR_MOTION.scootRotationMax * 1.05,
    `glyph rotated ${widest} rad, past the ${CURSOR_MOTION.scootRotationMax} rad ceiling`,
  );
});



test('native completion snaps the action hotspot and cancels the planned move', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.moveTo(500, 300);
  engine.tick(1 / 60);
  engine.completeAt(320, 240, true);
  assert.deepEqual(engine.pos, [320, 240]);
  assert.equal(engine.hasMotionPath(), false);
  assert.equal(engine.motionProgress(), 1);
  assert.equal(engine.motionDistanceRemaining(), 0);
  assert.equal(engine.isMoving(), true, 'press animation remains active');
});

test('cancel clears path, pressed state, and press animation', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.moveTo(500, 300, undefined, true);
  engine.pressed = true;
  engine.triggerClick(500, 300);
  engine.cancel();
  assert.equal(engine.hasMotionPath(), false);
  assert.equal(engine.isMoving(), false);
  assert.equal(engine.pressed, false);
});

test('cancel during first fade restores full opacity for the next move', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.tick(1 / 60);
  engine.cancel();
  engine.moveTo(200, 200);

  let globalAlpha = -1;
  const gradient = { addColorStop() {} };
  const ctx = {
    createLinearGradient: () => gradient,
    beginPath() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    closePath() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    set fillStyle(_value: unknown) {},
    set strokeStyle(_value: unknown) {},
    set lineWidth(_value: number) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set lineCap(_value: CanvasLineCap) {},
    set shadowColor(_value: string) {},
    set shadowBlur(_value: number) {},
    set shadowOffsetX(_value: number) {},
    set shadowOffsetY(_value: number) {},
    set globalAlpha(value: number) { globalAlpha = value; },
  } as unknown as CanvasRenderingContext2D;

  engine.paint(ctx, 0, 0);
  assert.equal(globalAlpha, 1);
});

test('click press animation clears over about 0.25 seconds', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.triggerClick(100, 100);
  let ticks = 0;
  while (engine.isMoving() && ticks < 60) {
    engine.tick(1 / 60);
    ticks++;
  }
  assert.ok(ticks >= 14 && ticks <= 18, `${ticks} ticks`);
});

function slowestSpringSamples(seconds = 10): number[] {
  const dt = 1 / 240;
  const omega = (Math.PI * 2) / CURSOR_MOTION.springResponseMax;
  let value = 0;
  let velocity = 0;
  const samples: number[] = [];
  for (let step = 0; step < seconds / dt; step++) {
    velocity += (
      omega * omega * (1 - value)
      - 2 * CURSOR_MOTION.springDampingFraction * omega * velocity
    ) * dt;
    value += velocity * dt;
    samples.push(value);
  }
  return samples;
}

function signedAngleDifference(value: number): number {
  let result = value;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
}

test('independent score charges a direct route less than an equal-length detour', () => {
  const common = {
    length: 100,
    angleChangeEnergy: 0,
    maxAngleChange: 0,
    totalTurn: 0,
    staysInBounds: true,
    arrivalDirection: [1, 0] as const,
  };
  const directScore = scoreCursorPath(common, 100, [1, 0]);
  const detourScore = scoreCursorPath(common, 80, [1, 0]);

  assert.ok(directScore < detourScore);
  assert.equal(detourScore - directScore, 8 * 0.25);
});

test('independent score rejects an out-of-bounds shortcut in favour of a usable route', () => {
  const usable = {
    length: 200,
    angleChangeEnergy: 0,
    maxAngleChange: 0,
    totalTurn: 0,
    staysInBounds: true,
    arrivalDirection: [1, 0] as const,
  };
  const shortcut = { ...usable, length: 100, staysInBounds: false };

  assert.ok(
    scoreCursorPath(shortcut, 100, [1, 0]) > scoreCursorPath(usable, 100, [1, 0]),
    'leaving the viewport must lose even when it halves the raw path length',
  );
});

test('the rendered glyph tip is the action hotspot and every path lands exactly on it', () => {
  const engine = new CursorEngine();
  engine.moveTo(320, 240);
  engine.tick(1);
  const translations: Array<readonly [number, number]> = [];
  const starts: Array<readonly [number, number]> = [];
  const curves: number[][] = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    createLinearGradient: () => gradient,
    beginPath() {},
    fill() {},
    stroke() {},
    moveTo(x: number, y: number) { starts.push([x, y]); },
    lineTo() {},
    bezierCurveTo(...points: number[]) { curves.push(points); },
    closePath() {},
    save() {},
    restore() {},
    translate(x: number, y: number) { translations.push([x, y]); },
    rotate() {},
    scale() {},
    set fillStyle(_value: unknown) {},
    set strokeStyle(_value: unknown) {},
    set lineWidth(_value: number) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set lineCap(_value: CanvasLineCap) {},
    set shadowColor(_value: string) {},
    set shadowBlur(_value: number) {},
    set shadowOffsetX(_value: number) {},
    set shadowOffsetY(_value: number) {},
    set globalAlpha(_value: number) {},
  } as unknown as CanvasRenderingContext2D;

  engine.paint(ctx, 0, 0);
  assert.deepEqual(engine.pos, [320, 240]);
  assert.deepEqual(translations[0], engine.pos);
  assert.deepEqual(CURSOR_GLYPH.start, [0, 0]);
  assert.deepEqual(starts[0], [0, 0]);
  assert.deepEqual(curves.at(-1)?.slice(-2), [0, 0]);

  const destination: Vec = [987, 654];
  assert.deepEqual(planCursorPath([320, 240], destination, null, null).sample(1), destination);
});

test('the independently tuned position spring never overshoots its target', () => {
  const samples = slowestSpringSamples();
  assert.ok(samples.some((value) => value >= CURSOR_CLOSE_ENOUGH.progress));
  assert.ok(
    samples.every((value) => value <= 1 + Number.EPSILON),
    `position spring overshot by ${Math.max(...samples) - 1}`,
  );
});

test('five-nines progress and the two-pixel gate cover the same landing', () => {
  assert.equal(CURSOR_CLOSE_ENOUGH.progress, 0.99999);
  assert.equal(CURSOR_CLOSE_ENOUGH.distance, 2);
  const remainingAtFiveNines = 100_000 * (1 - CURSOR_CLOSE_ENOUGH.progress);
  assert.ok(
    remainingAtFiveNines <= CURSOR_CLOSE_ENOUGH.distance,
    `${remainingAtFiveNines}px remains after the progress gate opens`,
  );
});

test('the 2100ms deadline covers 240Hz release and one-fps observability', () => {
  const samples = slowestSpringSamples();
  const releaseStep = samples.findIndex((value) => value >= CURSOR_CLOSE_ENOUGH.progress) + 1;
  assert.ok(releaseStep > 0, 'the slowest spring reaches the progress gate');
  const releaseMs = releaseStep * 1000 / 240;
  assert.equal(releaseMs, 1725);

  const observableAtOneFpsMs = Math.ceil(releaseMs / 1000) * 1000;
  assert.equal(observableAtOneFpsMs, 2000);
  assert.equal(cursorPresentationReadyDeadlineMs(), observableAtOneFpsMs + 100);
  assert.ok(cursorPresentationReadyDeadlineMs() < 5000);
});

test('terminal heading smoothsteps through the shortest signed angle', () => {
  const tangentAngle = 170 * Math.PI / 180;
  const tangent: Vec = [Math.cos(tangentAngle), Math.sin(tangentAngle)];
  const progress = 0.85;
  const phase = (progress - 0.80) / 0.20;
  const smoothstep = phase * phase * (3 - 2 * phase);
  const shortest = signedAngleDifference(CURSOR_MOTION.clickAngle - tangentAngle);
  const expected = signedAngleDifference(tangentAngle + shortest * smoothstep);
  const actual = cursorHeadingAt(tangent, progress);

  assert.ok(Math.abs(signedAngleDifference(actual - expected)) < 1e-12);
  assert.ok(
    Math.abs(signedAngleDifference(cursorHeadingAt(tangent, 1) - CURSOR_MOTION.clickAngle))
      < 1e-12,
  );
});

test('independent score preserves detour ratios for positive subpixel chords', () => {
  const measurement = {
    length: 0.75,
    angleChangeEnergy: 0,
    maxAngleChange: 0,
    totalTurn: 0,
    staysInBounds: true,
    arrivalDirection: [1, 0] as const,
  };

  assert.equal(scoreCursorPath(measurement, 0.5, [1, 0]), 4.75);
});

test('fresh planning spends all nine candidates on a symmetric direct-departure arc grid', () => {
  const pairs = cursorCandidatePairs(CURSOR_MOTION.candidateCount, 5, false);
  assert.equal(pairs.length, 9);
  assert.deepEqual([...new Set(pairs.map(({ departureWeight }) => departureWeight))], [0]);
  assert.deepEqual(
    pairs.map(({ arcWeight }) => arcWeight),
    [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1],
  );
});

test('interrupted planning selects nine candidates across all five departure weights', () => {
  const pairs = cursorCandidatePairs(CURSOR_MOTION.candidateCount, 5, true);
  assert.equal(pairs.length, 9);
  assert.deepEqual(
    pairs.filter(({ departureWeight }) => departureWeight === 0).map(({ arcWeight }) => arcWeight),
    [-1, -0.5, 0, 0.5, 1],
    'direct departure keeps five symmetric arcs including zero',
  );
  assert.deepEqual(
    pairs.filter(({ arcWeight }) => arcWeight === 0).map(({ departureWeight }) => departureWeight),
    [0, 0.25, 0.5, 0.75, 1],
    'zero arc covers every DEPARTURE_FAN weight including direct and incoming endpoints',
  );
});

test('zero path length over a zero chord has no detour', () => {
  const stationary = {
    length: 0,
    angleChangeEnergy: 0,
    maxAngleChange: 0,
    totalTurn: 0,
    staysInBounds: true,
    arrivalDirection: [1, 0] as const,
  };

  assert.equal(scoreCursorPath(stationary, 0, [1, 0]), 0);
});

test('positive path length over a zero chord is rejected', () => {
  const impossible = {
    length: 0.5,
    angleChangeEnergy: 0,
    maxAngleChange: 0,
    totalTurn: 0,
    staysInBounds: true,
    arrivalDirection: [1, 0] as const,
  };

  assert.equal(scoreCursorPath(impossible, 0, [1, 0]), Number.POSITIVE_INFINITY);
});

test('moving and pressed canvas transforms keep the local tip on engine.pos', () => {
  type Matrix = [number, number, number, number, number, number];
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const transformedStarts: Array<readonly [number, number]> = [];
  const rotations: number[] = [];
  const scales: Array<readonly [number, number]> = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    createLinearGradient: () => gradient,
    beginPath() {},
    fill() {},
    stroke() {},
    moveTo(x: number, y: number) {
      transformedStarts.push([
        matrix[0] * x + matrix[2] * y + matrix[4],
        matrix[1] * x + matrix[3] * y + matrix[5],
      ]);
    },
    lineTo() {},
    bezierCurveTo() {},
    closePath() {},
    save() { stack.push([...matrix]); },
    restore() { matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0]; },
    translate(x: number, y: number) {
      matrix[4] += matrix[0] * x + matrix[2] * y;
      matrix[5] += matrix[1] * x + matrix[3] * y;
    },
    rotate(angle: number) {
      rotations.push(angle);
      const [a, b, c, d, e, f] = matrix;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      matrix = [
        a * cosine + c * sine,
        b * cosine + d * sine,
        -a * sine + c * cosine,
        -b * sine + d * cosine,
        e,
        f,
      ];
    },
    scale(x: number, y: number) {
      scales.push([x, y]);
      matrix[0] *= x;
      matrix[1] *= x;
      matrix[2] *= y;
      matrix[3] *= y;
    },
    set fillStyle(_value: unknown) {},
    set strokeStyle(_value: unknown) {},
    set lineWidth(_value: number) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set lineCap(_value: CanvasLineCap) {},
    set shadowColor(_value: string) {},
    set shadowBlur(_value: number) {},
    set shadowOffsetX(_value: number) {},
    set shadowOffsetY(_value: number) {},
    set globalAlpha(_value: number) {},
  } as unknown as CanvasRenderingContext2D;

  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.tick(1);
  engine.moveTo(900, 500);
  engine.pressed = true;
  engine.tick(1 / 60);
  assert.equal(engine.hasMotionPath(), true);

  engine.paint(ctx, 0, 0);
  assert.equal(rotations.length, 3, 'stretch axis, unwind, and rotation offset apply');
  assert.equal(scales.length, 2, 'stretch and pressed scale apply');
  assert.ok(Math.abs(rotations[0]) > 1e-9, 'moving stretch axis is rotated');
  assert.ok(Math.abs(rotations[0] + rotations[1]) < 1e-12, 'stretch axis is unwound');
  assert.ok(Math.abs(rotations[2]) > 1e-9, 'moving rotation offset is active');
  assert.ok(
    Math.abs(scales[0][0] - 1) > 1e-9 || Math.abs(scales[0][1] - 1) > 1e-9,
    'moving stretch scale is active',
  );
  assert.ok(scales[1][0] < 1 && scales[1][1] < 1, 'pressed scale is active');
  const transformedTip = transformedStarts[0];
  assert.ok(transformedTip, 'glyph path starts at its local tip');
  assert.ok(
    Math.hypot(transformedTip[0] - engine.pos[0], transformedTip[1] - engine.pos[1]) < 1e-9,
    `transformed tip ${transformedTip} diverged from action coordinate ${engine.pos}`,
  );
});
