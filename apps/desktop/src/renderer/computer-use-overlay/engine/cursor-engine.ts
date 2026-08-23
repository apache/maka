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

// Maka's agent-cursor renderer.
//
// This file has mixed provenance:
// - the first Maka renderer was a TypeScript adaptation of the MIT-licensed
//   trycua/cua cursor-overlay, introduced in commit 025d0c628;
// - the normalized glyph, center-hotspot convention, MotionConfiguration values,
//   close-enough thresholds, path-measurement terms, and core scorer weights were
//   recovered from the signed 2026-07-16 SkyComputerUseService build;
// - the current candidate family, additional score terms, viewport behavior,
//   frame clock, presentation fences, rendering, and host integration were
//   authored or adjusted in Maka.
//
// No OpenAI source code or executable is included or redistributed. See
// docs/computer-use-cursor-provenance.md for the exact boundary.
import { makaBrandPalette, type Palette, rgba } from './palette.js';

const PI = Math.PI;
const TAU = PI * 2;
const SENTINEL = -200;

// Exact MotionConfiguration.live values for the inspected 2026-07-16 build.
export const CODEX_CURSOR_MOTION = {
  clickAngle: -44 * PI / 180,
  candidateCount: 20,
  boundsMargin: 20,
  startHandle: 0.41960295031576633,
  endpointHandle: 0.15,
  arcSize: 0.27655231880642772,
  arcFlow: 0.5783555327868779,
  straightPathDistanceThreshold: 10,
  springResponseScaler: 0.9,
  springResponseMin: 0.12,
  springResponseMax: 2.2,
  springDampingFraction: 0.9,
  scootDistanceThreshold: 196,
  scootPositionResponse: 0.24,
  scootPositionDampingFraction: 0.84,
  scootPositionSettleVelocity: 12,
  scootAxisResponse: 0.07,
  scootAxisDampingFraction: 0.82,
  scootBaseRotationResponse: 0.09,
  scootBaseRotationDampingFraction: 0.86,
  scootStretchResponse: 0.095,
  scootStretchDampingFraction: 0.72,
  scootStretchMin: 0,
  scootStretchPivotX: 0.5,
  scootStretchXAmount: 0.38,
  scootSquashYAmount: 0.18,
  scootRotationResponse: 0.055,
  scootRotationDampingFraction: 0.76,
  scootRotationMax: 76 * PI / 180,
  terminalTangentBlendStart: 0.99,
} as const;

/**
 * Codex `CloseEnoughConfiguration.default` for the inspected 2026-07-16 build,
 * recovered from doubles at 0x100d68cd0 / 0x100d68cd8. These addresses and
 * defaults are build-specific. The action is released only once the cursor has
 * effectively landed; releasing earlier makes the click visibly fire while the
 * glyph is still travelling.
 *
 * These live here, next to the spring they are read against, because they are
 * not independently choosable: `cursorPresentationReadyDeadlineMs` below is
 * derived from both, and a fence shorter than that deadline reintroduces
 * exactly the mid-flight dispatch the thresholds exist to prevent.
 */
export const CURSOR_CLOSE_ENOUGH = {
  progress: 0.995,
  distance: 3.157,
} as const;

/**
 * The longest single step the spring integrator is advanced by.
 *
 * A semi-implicit step is only stable while `dt` is small relative to the
 * spring's response; one frame of a stalled compositor fed in whole would
 * throw the glyph across the screen. A frame longer than this is split into
 * sub-steps of this size or less, so the bound is on each step and not on how
 * much time the simulation is allowed to account for.
 */
const MAX_INTEGRATION_STEP = 0.05;

/**
 * The most wall clock one `tick` will account for, in seconds.
 *
 * Below one frame per second the overlay is not painting slowly, it has
 * stopped, and replaying the whole gap as motion nobody saw buys nothing. The
 * presentation fence's backstop is what covers that case.
 */
const MAX_CATCH_UP = 1;

/**
 * The longest a motion can take to open the `closeEnough` gate, in milliseconds.
 *
 * The progress spring is a unit step response with damping ratio
 * `springDampingFraction` and angular frequency `2π / response`. Its error
 * envelope is `A·e^(−ζωt)` with `A = 1/√(1−ζ²)`, so the gate is guaranteed open
 * once `A·e^(−ζωt) ≤ 1 − progress`, i.e. at
 *
 *     t = response · ln(A / (1 − progress)) / (2π·ζ)
 *
 * `response` is `clamp(distance/1000 · scaler, min, max)`, so the worst case is
 * `springResponseMax`. The bound is the envelope rather than the measured first
 * crossing (which is earlier, ≈0.88·response) so it does not depend on where
 * the integrator happens to land; one frame at 60Hz is added on top because the
 * gate is only evaluated once per painted frame.
 *
 * It is a bound on simulated time, and `tick` is what makes simulated time
 * equal wall clock: it sub-steps a long frame instead of truncating it, down to
 * {@link MAX_CATCH_UP}. Truncating is what made this bound frame-rate dependent
 * — measured, the gate opened at 1950ms at 20fps but 3900ms at 10fps, against
 * the 2402ms declared here, and 17ms of headroom covers one dropped frame, not
 * sustained throttling.
 *
 * This is the number the runtime's presentation fence has to be at least as
 * long as. Two independently chosen constants is how the fence came to cut a
 * cross-display move off at 1000ms while the gate needed ~1940ms, dispatching
 * the click with the glyph ~180px short of the target.
 */
export function cursorPresentationReadyDeadlineMs(): number {
  const zeta = CODEX_CURSOR_MOTION.springDampingFraction;
  const amplitude = 1 / Math.sqrt(1 - zeta * zeta);
  const seconds =
    CODEX_CURSOR_MOTION.springResponseMax
    * Math.log(amplitude / (1 - CURSOR_CLOSE_ENOUGH.progress))
    / (TAU * zeta);
  return Math.ceil(seconds * 1000) + Math.ceil(1000 / 60);
}

// The five core coefficients were recovered from the scorer inlined at
// 0x1000972ec in the inspected build. The current Maka score is not term-for-term:
// it also includes raw path length and the local backwards-arrival penalty.
/** Segments the scorer walks the candidate in (25 samples, 24 steps). */
const SCORE_SAMPLES = 24;
const SCORE_DETOUR_WEIGHT = 320;
const SCORE_ANGLE_ENERGY_WEIGHT = 140;
const SCORE_MAX_ANGLE_WEIGHT = 180;
const SCORE_TOTAL_TURN_WEIGHT = 18;
const SCORE_OUT_OF_BOUNDS_PENALTY = 45;
const SCORE_BACKWARDS_PENALTY = 90;
/** Dot product at which the backwards penalty starts ramping in. */
const SCORE_BACKWARDS_ONSET = -0.08;

/**
 * Ceiling on the perpendicular bulge. NOT a MotionConfiguration field — the
 * recovered config has no arc cap — so it is a local clamp kept from the
 * previous planner to stop very long moves sweeping half the desktop.
 */
const MAX_DESIRED_ARC = 120;

/**
 * How many departure directions the candidate grid fans across when a move
 * interrupts an in-flight move. `candidateCount` stays the budget either way:
 * from rest the departure axis collapses and all 20 candidates go to arc.
 */
const DEPARTURE_FAN = 5;

/** Weight on the normalized heading deviation inside the single rotation term. */
const ROTATION_HEADING_WEIGHT = 0.75;
/** Seconds-per-progress-unit coefficient turning spring velocity into sway. */
const ROTATION_SWAY_COEFFICIENT = 0.035;

/** Neutral drop-shadow colour, kept out of the palette so no theme tints it. */
const SHADOW_RGB = [0, 0, 0] as const;
/**
 * The outline colour, which is not a brand colour.
 *
 * The one colour literal in the whole of the native cursor's drawing code is
 * `Color.white.opacity(0.8)`, and it is the outline. A white rim is what makes
 * a small dark glyph readable over an arbitrary application, the same way the
 * system pointer's is. The brand colour still owns the fill.
 */
const OUTLINE_RGB = [255, 255, 255] as const;

export const CODEX_CURSOR_GLYPH = {
  /**
   * The arrow's frame, in points.
   *
   * This was 14, measured off the black core of a rendered cursor while the
   * outline and its outward half sat outside the ruler. The native view binds
   * `cursorRadius = 9.0` and draws at `width: 2r`, so the frame is 18 — which
   * is also what the white rim's outer edge measures, per pixel, in a captured
   * frame. Two independent readings, one number.
   *
   * At 14 with a one-third-transparent fill and a 1.55pt rounded outline, the
   * glyph read as a blob rather than a pointer at 1x.
   */
  size: 18,
  shadowBlur: 9,
  // Normalized AgentCursor.path(in:) coordinates recovered from the inspected
  // native function's floating-point constants.
  start: [0.00599, 0.15864] as const,
  curve1: [
    [0.15158, 0.00627],
    [-0.02364, 0.06456],
    [0.06169, -0.02474],
  ] as const,
  line1: [0.87634, 0.25652] as const,
  curve2: [
    [0.88794, 0.48095],
    [0.97594, 0.29096],
    [0.9834, 0.43547],
  ] as const,
  line2: [0.59343, 0.62108] as const,
  line3: [0.45955, 0.92925] as const,
  curve3: [
    [0.2451, 0.91717],
    [0.41611, 1.02925],
    [0.27801, 1.02146],
  ] as const,
} as const;

type Point = readonly [number, number];
type Viewport = { width: number; height: number };

interface SpringValue {
  value: number;
  velocity: number;
  target: number;
  response: number;
  damping: number;
}

export class CubicCursorPath {
  constructor(
    readonly p0: Point,
    readonly p1: Point,
    readonly p2: Point,
    readonly p3: Point,
  ) {}

  sample(tIn: number): Point {
    const t = clamp(tIn, 0, 1);
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return [
      a * this.p0[0] + b * this.p1[0] + c * this.p2[0] + d * this.p3[0],
      a * this.p0[1] + b * this.p1[1] + c * this.p2[1] + d * this.p3[1],
    ];
  }

  tangent(tIn: number): Point {
    const t = clamp(tIn, 0, 1);
    const u = 1 - t;
    return [
      3 * u * u * (this.p1[0] - this.p0[0])
        + 6 * u * t * (this.p2[0] - this.p1[0])
        + 3 * t * t * (this.p3[0] - this.p2[0]),
      3 * u * u * (this.p1[1] - this.p0[1])
        + 6 * u * t * (this.p2[1] - this.p1[1])
        + 3 * t * t * (this.p3[1] - this.p2[1]),
    ];
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * The smallest odd count of at least three, so a symmetric grid spanning
 * `[-maxArc, +maxArc]` always contains its own midpoint.
 */
export function oddAtLeastThree(count: number): number {
  const floor = Math.max(3, Math.trunc(count));
  return floor % 2 === 0 ? floor + 1 : floor;
}

function wrapAngle(value: number): number {
  let result = value;
  while (result > PI) result -= TAU;
  while (result < -PI) result += TAU;
  return result;
}

function setAngleTarget(spring: SpringValue, target: number): void {
  spring.target = spring.value + wrapAngle(target - spring.value);
}

function stepSpring(spring: SpringValue, dt: number): void {
  const response = Math.max(0.001, spring.response);
  const omega = TAU / response;
  const stiffness = omega * omega;
  const damping = 2 * spring.damping * omega;
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    spring.velocity += (
      stiffness * (spring.target - spring.value) - damping * spring.velocity
    ) * h;
    spring.value += spring.velocity * h;
  }
}

function springSettled(spring: SpringValue, valueEpsilon = 0.001, velocityEpsilon = 0.01): boolean {
  return Math.abs(spring.target - spring.value) <= valueEpsilon
    && Math.abs(spring.velocity) <= velocityEpsilon;
}

function makeSpring(value: number, response: number, damping: number): SpringValue {
  return { value, velocity: 0, target: value, response, damping };
}

function settleSpring(spring: SpringValue, value: number): void {
  spring.value = value;
  spring.velocity = 0;
  spring.target = value;
}

function directCursorPath(start: Point, end: Point): CubicCursorPath {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  return new CubicCursorPath(
    start,
    [start[0] + dx / 3, start[1] + dy / 3],
    [start[0] + dx * 2 / 3, start[1] + dy * 2 / 3],
    end,
  );
}

interface PathBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PathMeasurement {
  length: number;
  angleChangeEnergy: number;
  maxAngleChange: number;
  totalTurn: number;
  staysInBounds: boolean;
  /** Unit direction of the last sampled segment: how the cursor arrives. */
  arrivalDirection: Point;
}

/**
 * The viewport inset by boundsMargin, widened where necessary so the move's own
 * endpoints never count as violations. Without the widening a click 5px from
 * the screen edge would mark every candidate out of bounds, flattening the term
 * exactly where it is needed to keep the bulge on-screen.
 */
function pathBounds(start: Point, end: Point, viewport: Viewport | null): PathBounds | null {
  if (!viewport) return null;
  const margin = CODEX_CURSOR_MOTION.boundsMargin;
  return {
    minX: Math.max(0, Math.min(margin, start[0], end[0])),
    minY: Math.max(0, Math.min(margin, start[1], end[1])),
    maxX: Math.min(viewport.width, Math.max(viewport.width - margin, start[0], end[0])),
    maxY: Math.min(viewport.height, Math.max(viewport.height - margin, start[1], end[1])),
  };
}

/**
 * Walks the candidate as a 24-segment polyline, accumulating arc length, the
 * per-step heading deltas the scorer charges for, and whether every sample sat
 * inside the inset viewport.
 */
export function measureCursorPath(
  path: CubicCursorPath,
  start: Point,
  end: Point,
  viewport: Viewport | null,
): PathMeasurement {
  const bounds = pathBounds(start, end, viewport);
  const inside = (point: Point): boolean => !bounds
    || (point[0] >= bounds.minX && point[0] <= bounds.maxX
      && point[1] >= bounds.minY && point[1] <= bounds.maxY);

  let length = 0;
  let angleChangeEnergy = 0;
  let maxAngleChange = 0;
  let totalTurn = 0;
  let previous = path.sample(0);
  let staysInBounds = inside(previous);
  let previousAngle: number | null = null;
  let arrivalDirection: Point = [0, 0];

  for (let index = 1; index <= SCORE_SAMPLES; index++) {
    const point = path.sample(index / SCORE_SAMPLES);
    const dx = point[0] - previous[0];
    const dy = point[1] - previous[1];
    const step = Math.hypot(dx, dy);
    length += step;
    if (step > 1e-9) {
      const angle = Math.atan2(dy, dx);
      if (previousAngle !== null) {
        const delta = Math.abs(wrapAngle(angle - previousAngle));
        angleChangeEnergy += delta * delta;
        totalTurn += delta;
        if (delta > maxAngleChange) maxAngleChange = delta;
      }
      previousAngle = angle;
      arrivalDirection = [dx / step, dy / step];
    }
    if (!inside(point)) staysInBounds = false;
    previous = point;
  }

  return { length, angleChangeEnergy, maxAngleChange, totalTurn, staysInBounds, arrivalDirection };
}

/**
 * Maka's extension of the recovered core score. The detour, angle-energy,
 * max-angle, total-turn, and out-of-bounds terms use binary-derived
 * coefficients. Raw path length and the backwards-arrival term are Maka
 * additions.
 */
export function scoreCursorPath(
  measurement: PathMeasurement,
  chordLength: number,
  clickDirection: Point,
): number {
  const detour = Math.max(0, measurement.length / Math.max(chordLength, 1) - 1);
  const dot = measurement.arrivalDirection[0] * clickDirection[0]
    + measurement.arrivalDirection[1] * clickDirection[1];
  // travelDirection · clickAngleDirection. The recovered notes do not pin which
  // stretch of travel the term reads, so it is bound to the arrival direction:
  // a candidate that arrives opposite the angle the glyph snaps to would force
  // a near-180° rotation inside the terminal blend, which is the spin this
  // penalty exists to price. The ramp only opens once the arrival is genuinely
  // backwards, so ordinary sideways approaches pay nothing.
  const backwards = clamp(
    (SCORE_BACKWARDS_ONSET - dot) / (1 + SCORE_BACKWARDS_ONSET),
    0,
    1,
  ) * SCORE_BACKWARDS_PENALTY;

  return measurement.length
    + SCORE_DETOUR_WEIGHT * detour
    + SCORE_ANGLE_ENERGY_WEIGHT * measurement.angleChangeEnergy
    + SCORE_MAX_ANGLE_WEIGHT * measurement.maxAngleChange
    + SCORE_TOTAL_TURN_WEIGHT * measurement.totalTurn
    + (measurement.staysInBounds ? 0 : SCORE_OUT_OF_BOUNDS_PENALTY)
    + backwards;
}

/**
 * Builds Maka's local single-segment cubic candidate family and returns the
 * cheapest under the mixed-provenance scorer above. This is not the inspected
 * binary's later-reconstructed two-base-plus-18-mirrored candidate generator.
 *
 * `incomingHeading` is the direction the cursor is already travelling, and is
 * null whenever the cursor is at rest. It must stay null in that case: the
 * engine parks `heading` at clickAngle between moves, so feeding it back in
 * launched every fresh move up-and-right no matter where the target was.
 */
export function planCursorPath(
  start: Point,
  end: Point,
  incomingHeading: number | null,
  viewport: Viewport | null,
): CubicCursorPath {
  const config = CODEX_CURSOR_MOTION;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const distance = Math.hypot(dx, dy);
  if (distance <= config.straightPathDistanceThreshold) {
    return directCursorPath(start, end);
  }

  const directAngle = Math.atan2(dy, dx);
  const direction: Point = [Math.cos(directAngle), Math.sin(directAngle)];
  const perpendicular: Point = [-direction[1], direction[0]];
  const clickDirection: Point = [Math.cos(config.clickAngle), Math.sin(config.clickAngle)];
  const maxArc = Math.min(distance * config.arcSize, MAX_DESIRED_ARC);

  // From rest there is no heading to honour, so the whole budget goes to arc
  // resolution. Interrupting a move fans the start handle from "straight at the
  // target" to "keep going the way we were", and lets the scorer choose.
  const headingDelta = incomingHeading !== null && Number.isFinite(incomingHeading)
    ? wrapAngle(incomingHeading - directAngle)
    : 0;
  const departureCount = headingDelta === 0 ? 1 : DEPARTURE_FAN;
  // Odd, so that `a = (arcCount - 1) / 2` lands exactly on `arc = 0` and the
  // straight candidate is actually in the grid. An even count skips it: at rest
  // the nearest candidate still bulged ~5.8pt, and on an interrupt (4
  // candidates) the smallest bulge available was a third of `maxArc` — 36.9pt
  // on a 400pt move — so an interrupted move could not be planned straight no
  // matter what the scorer preferred, which is the opposite of what the scorer
  // is for.
  const arcCount = oddAtLeastThree(Math.round(config.candidateCount / departureCount));

  let bestPath: CubicCursorPath | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let d = 0; d < departureCount; d++) {
    const departureWeight = departureCount === 1 ? 0 : d / (departureCount - 1);
    const departureAngle = directAngle + headingDelta * departureWeight;
    const departure: Point = [Math.cos(departureAngle), Math.sin(departureAngle)];
    for (let a = 0; a < arcCount; a++) {
      const arc = (a / (arcCount - 1) * 2 - 1) * maxArc;
      const p1: Point = [
        start[0] + departure[0] * distance * config.startHandle
          + perpendicular[0] * arc * config.arcFlow,
        start[1] + departure[1] * distance * config.startHandle
          + perpendicular[1] * arc * config.arcFlow,
      ];
      const p2: Point = [
        end[0] - direction[0] * distance * config.endpointHandle
          + perpendicular[0] * arc * (1 - config.arcFlow),
        end[1] - direction[1] * distance * config.endpointHandle
          + perpendicular[1] * arc * (1 - config.arcFlow),
      ];
      const candidate = new CubicCursorPath(start, p1, p2, end);
      const score = scoreCursorPath(
        measureCursorPath(candidate, start, end, viewport),
        distance,
        clickDirection,
      );
      if (score < bestScore) {
        bestScore = score;
        bestPath = candidate;
      }
    }
  }
  return bestPath ?? directCursorPath(start, end);
}

/**
 * Heading for a point on the path. Over the last 1% the tangent is blended into
 * the click angle as a cubic-eased unit-vector interpolation (0x100096cf8), not
 * a scalar angle lerp: the vector form cannot wind the long way round.
 */
export function cursorHeadingAt(tangent: Point, progress: number): number {
  const clickAngle = CODEX_CURSOR_MOTION.clickAngle;
  const magnitude = Math.hypot(tangent[0], tangent[1]);
  if (magnitude < 1e-9) return clickAngle;
  const unit: Point = [tangent[0] / magnitude, tangent[1] / magnitude];

  const blendStart = CODEX_CURSOR_MOTION.terminalTangentBlendStart;
  const w = clamp((progress - blendStart) / (1 - blendStart), 0, 1);
  if (w <= 0) return Math.atan2(unit[1], unit[0]);

  const k = 1 - (1 - w) ** 3;
  const x = unit[0] * (1 - k) + Math.cos(clickAngle) * k;
  const y = unit[1] * (1 - k) + Math.sin(clickAngle) * k;
  // Exactly opposed vectors cancel at k = 0.5; snap to the click angle rather
  // than reading an angle off the zero vector.
  if (Math.hypot(x, y) < 1e-9) return clickAngle;
  return Math.atan2(y, x);
}

export class CursorEngine {
  pos: [number, number] = [SENTINEL, SENTINEL];
  heading = CODEX_CURSOR_MOTION.clickAngle;
  pressed = false;

  private path: CubicCursorPath | null = null;
  private progress: SpringValue | null = null;
  private target: Point | null = null;
  private moveDistance = 0;
  private opacity = 0;
  private fadingIn = false;
  private clickT: number | null = null;
  private clickPoint: [number, number] | null = null;
  private clickOnArrive = false;
  private palette: Palette = makaBrandPalette();
  private viewport: Viewport | null = null;
  /**
   * The frame timestamp {@link tickTo} last accounted for, or `undefined` when
   * the presentation is at rest and the next frame starts a new clock.
   */
  private lastFrameMs: number | undefined;

  private readonly axis = makeSpring(
    CODEX_CURSOR_MOTION.clickAngle,
    CODEX_CURSOR_MOTION.scootAxisResponse,
    CODEX_CURSOR_MOTION.scootAxisDampingFraction,
  );
  private readonly stretchX = makeSpring(
    1,
    CODEX_CURSOR_MOTION.scootStretchResponse,
    CODEX_CURSOR_MOTION.scootStretchDampingFraction,
  );
  private readonly stretchY = makeSpring(
    1,
    CODEX_CURSOR_MOTION.scootStretchResponse,
    CODEX_CURSOR_MOTION.scootStretchDampingFraction,
  );
  /**
   * The one rotation spring. Codex applies a single rotation term bounded by
   * scootRotationMax (0x1000963cc); the earlier split into a base rotation plus
   * an offset let the glyph reach twice that, which is what made it spin.
   * scootBaseRotation{Response,DampingFraction} stay in the recovered config as
   * inspected data, but nothing in the native rotation path consumes them.
   */
  private readonly rotationOffset = makeSpring(
    0,
    CODEX_CURSOR_MOTION.scootRotationResponse,
    CODEX_CURSOR_MOTION.scootRotationDampingFraction,
  );

  setSession(_sessionId: string): void {
    this.palette = makaBrandPalette();
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
  }

  setViewport(width: number, height: number): void {
    this.viewport = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? { width, height }
      : null;
  }

  moveTo(x: number, y: number, _endHeading?: number, clickOnArrive = false): void {
    const destination: Point = [x, y];
    if (clickOnArrive) this.clickPoint = [x, y];

    // Codex fades the first appearance in at the requested hotspot. Starting
    // off-screen and gliding across the desktop is not part of the native path.
    if (!this.isVisible()) {
      this.pos = [x, y];
      this.heading = CODEX_CURSOR_MOTION.clickAngle;
      this.target = null;
      this.clickOnArrive = false;
      this.opacity = 0;
      this.fadingIn = true;
      if (clickOnArrive) this.clickT = 0;
      return;
    }

    const start: Point = [this.pos[0], this.pos[1]];
    const distance = Math.hypot(x - start[0], y - start[1]);
    if (distance < 0.01) {
      this.pos = [x, y];
      if (clickOnArrive) this.clickT = 0;
      return;
    }

    // `heading` is parked at the rest angle between moves, so it is only a real
    // departure direction while a move is still in flight. Feeding the rest
    // angle back in launched every fresh move up-and-right, target be damned.
    // `heading` is parked at the rest angle between moves, so it is only a real
    // departure direction while a move is still in flight.
    //
    // It is not what stops a fresh move launching up-and-right: measured
    // through this method, removing this line leaves the departure alignment at
    // 1.0000 and every test in `cursor-engine.test.ts` green, because the odd
    // candidate grid and the scorer already deliver the direct departure even
    // when the rest angle is handed to them. What it does still decide is the
    // candidate budget — see `DEPARTURE_FAN`: a non-null heading spends the 20
    // candidates on a 5-way departure fan instead of on arc, which from rest is
    // a fan across directions the cursor is not travelling in.
    const incomingHeading = this.path !== null && Number.isFinite(this.heading)
      ? this.heading
      : null;
    this.path = planCursorPath(start, destination, incomingHeading, this.viewport);
    this.target = destination;
    this.moveDistance = distance;
    const response = clamp(
      distance / 1000 * CODEX_CURSOR_MOTION.springResponseScaler,
      CODEX_CURSOR_MOTION.springResponseMin,
      CODEX_CURSOR_MOTION.springResponseMax,
    );
    this.progress = {
      value: 0,
      velocity: 0,
      target: 1,
      response,
      damping: CODEX_CURSOR_MOTION.springDampingFraction,
    };
    this.clickOnArrive = clickOnArrive;
  }

  /** Reconcile presentation with the coordinate confirmed by native execution. */
  completeAt(x: number, y: number, pulse = false, _endHeading?: number): void {
    this.pos = [x, y];
    this.heading = CODEX_CURSOR_MOTION.clickAngle;
    this.path = null;
    this.progress = null;
    this.target = null;
    this.moveDistance = 0;
    this.opacity = 1;
    this.fadingIn = false;
    this.clickOnArrive = false;
    this.pressed = false;
    this.clickT = null;
    this.clickPoint = null;
    this.resetVisualSprings();
    if (pulse) this.triggerClick(x, y);
  }

  triggerClick(x?: number, y?: number): void {
    if (typeof x === 'number' && typeof y === 'number') {
      if (!this.isVisible()) this.pos = [x, y];
      this.clickPoint = [x, y];
    }
    this.clickT = 0;
  }

  cancel(): void {
    this.path = null;
    this.progress = null;
    this.target = null;
    this.moveDistance = 0;
    this.opacity = 1;
    this.fadingIn = false;
    this.clickT = null;
    this.clickPoint = null;
    this.clickOnArrive = false;
    this.pressed = false;
    this.resetVisualSprings();
  }

  isMoving(): boolean {
    return this.path !== null
      || this.fadingIn
      || this.clickT !== null
      || !springSettled(this.stretchX)
      || !springSettled(this.stretchY)
      || !springSettled(this.rotationOffset);
  }

  isVisible(): boolean {
    return this.pos[0] >= -100;
  }

  motionProgress(): number {
    return this.progress ? clamp(this.progress.value, 0, 1) : 1;
  }

  motionDistanceRemaining(): number {
    if (!this.path || !this.target) return 0;
    return Math.hypot(this.target[0] - this.pos[0], this.target[1] - this.pos[1]);
  }

  hasMotionPath(): boolean {
    return this.path !== null;
  }

  /**
   * Advance the presentation by `dtIn` seconds of wall clock.
   *
   * The integrator is only stable up to {@link MAX_INTEGRATION_STEP}, so a
   * longer frame is walked in sub-steps rather than truncated to one. Truncating
   * is what made `cursorPresentationReadyDeadlineMs` a claim about frame rate
   * instead of about the spring: with a single clamped step, a frame longer
   * than 50ms advanced the simulation by less time than had actually passed, so
   * the gate opened later in wall clock the slower the overlay painted —
   * 1950ms at 20fps, 2600ms at 15fps, 3900ms at 10fps against a 2402ms
   * deadline. Sub-stepping keeps simulated time equal to wall clock at any
   * frame rate down to {@link MAX_CATCH_UP}, below which the presentation has
   * stopped rather than slowed and the fence's own backstop is what covers it.
   */
  tick(dtIn: number): void {
    const total = clamp(dtIn, 0, MAX_CATCH_UP);
    if (total === 0) {
      this.step(0);
      return;
    }
    const steps = Math.ceil(total / MAX_INTEGRATION_STEP);
    const step = total / steps;
    for (let i = 0; i < steps; i++) this.step(step);
  }

  /**
   * Advance the presentation to the frame timestamp `nowMs`, in milliseconds on
   * whatever monotonic clock the caller's frames are stamped with
   * (`requestAnimationFrame`'s argument, in the overlay).
   *
   * This exists because {@link tick} sub-stepping a long frame bought nothing
   * while the only production caller never handed it one. `cursor-overlay.ts`
   * computed its own delta as `Math.min(0.05, (now - last) / 1000)` — the same
   * truncation `tick` had just been fixed not to do, one call frame earlier —
   * so a throttled compositor still advanced the simulation by less time than
   * had passed, and `cursorPresentationReadyDeadlineMs` was still a claim about
   * frame rate rather than about the spring. The engine test drove `tick`
   * directly and stayed green through all of it.
   *
   * The delta is derived here, from a clock the engine owns, so there is no
   * delta for a caller to clamp: the caller's only input is when the frame
   * happened. {@link tick} stays public for tests that want to state a step
   * outright, and it is still the bound on how much wall clock one frame may
   * account for.
   *
   * The clock is dropped whenever the presentation comes to rest, which is
   * exactly when the overlay stops asking for frames. Without that, a cursor
   * idle for a minute would resume with a minute of arrears and replay
   * {@link MAX_CATCH_UP} of a motion that had only just been given to it.
   */
  tickTo(nowMs: number): void {
    const previous = this.lastFrameMs;
    this.lastFrameMs = nowMs;
    this.tick(previous === undefined ? 0 : (nowMs - previous) / 1000);
    if (!this.isMoving()) this.lastFrameMs = undefined;
  }

  private step(dt: number): void {
    if (this.fadingIn) {
      this.opacity = Math.min(1, this.opacity + dt / 0.16);
      if (this.opacity >= 1) this.fadingIn = false;
    }
    if (this.path && this.progress && this.target) {
      const previous: Point = [this.pos[0], this.pos[1]];
      stepSpring(this.progress, dt);
      const progress = clamp(this.progress.value, 0, 1);
      const sampled = this.path.sample(progress);
      const tangent = this.path.tangent(progress);
      const tangentAngle = cursorHeadingAt(tangent, progress);

      this.pos = [sampled[0], sampled[1]];
      this.heading = tangentAngle;
      const speed = dt > 0 ? Math.hypot(sampled[0] - previous[0], sampled[1] - previous[1]) / dt : 0;
      const scootEnabled = this.moveDistance >= CODEX_CURSOR_MOTION.scootDistanceThreshold;
      const intensity = scootEnabled ? clamp(speed / 900, 0, 1) : 0;

      setAngleTarget(this.axis, tangentAngle);
      this.stretchX.target = 1 + CODEX_CURSOR_MOTION.scootStretchXAmount * intensity;
      this.stretchY.target = 1 - CODEX_CURSOR_MOTION.scootSquashYAmount * intensity;
      // One rotation term: intensity * clamp(0.75 * headingDeviation + sway,
      // -1, 1) * scootRotationMax. Both inputs are unitless fractions and the
      // clamp is applied once, so the glyph cannot exceed scootRotationMax.
      const headingDeviation = wrapAngle(tangentAngle - CODEX_CURSOR_MOTION.clickAngle) / PI;
      const sway = this.progress.velocity * ROTATION_SWAY_COEFFICIENT;
      this.rotationOffset.target = intensity * clamp(
        ROTATION_HEADING_WEIGHT * headingDeviation + sway,
        -1,
        1,
      ) * CODEX_CURSOR_MOTION.scootRotationMax;

      const progressSettled = springSettled(this.progress, 0.0005, 0.005);
      if (progressSettled) {
        this.pos = [this.target[0], this.target[1]];
        this.heading = CODEX_CURSOR_MOTION.clickAngle;
        this.path = null;
        this.progress = null;
        this.target = null;
        this.stretchX.target = 1;
        this.stretchY.target = 1;
        this.rotationOffset.target = 0;
        if (this.clickOnArrive) {
          this.clickT = 0;
          this.clickOnArrive = false;
        }
      }
    } else {
      this.stretchX.target = 1;
      this.stretchY.target = 1;
      this.rotationOffset.target = 0;
    }

    stepSpring(this.axis, dt);
    stepSpring(this.stretchX, dt);
    stepSpring(this.stretchY, dt);
    stepSpring(this.rotationOffset, dt);

    if (this.clickT !== null) {
      const next = this.clickT + dt * 4;
      this.clickT = next >= 1 ? null : next;
      if (next >= 1) this.clickPoint = null;
    }
  }

  private resetVisualSprings(): void {
    settleSpring(this.axis, CODEX_CURSOR_MOTION.clickAngle);
    settleSpring(this.stretchX, 1);
    settleSpring(this.stretchY, 1);
    settleSpring(this.rotationOffset, 0);
  }

  paint(ctx: CanvasRenderingContext2D, originX: number, originY: number): void {
    if (!this.isVisible()) return;
    const px = this.pos[0] - originX;
    const py = this.pos[1] - originY;
    const pressProgress = this.clickT === null ? 0 : Math.sin(PI * this.clickT);
    const pressedAmount = this.pressed ? 1 : pressProgress;
    // The native cursor multiplies its scale by 0.7 while pressed. Maka's 0.9
    // was a third of that, which at 14pt was a shrink of one and a half pixels
    // — the press was happening and nothing on screen said so.
    const scale = 1 - 0.3 * pressedAmount;

    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.translate(px, py);
    ctx.rotate(this.axis.value);
    ctx.scale(this.stretchX.value, this.stretchY.value);
    ctx.rotate(-this.axis.value);
    ctx.rotate(this.rotationOffset.value);
    ctx.scale(scale, scale);
    this.paintAgentCursor(ctx, pressedAmount);
    ctx.restore();
  }

  private paintAgentCursor(ctx: CanvasRenderingContext2D, pressedAmount: number): void {
    const glyph = CODEX_CURSOR_GLYPH;
    const size = glyph.size;
    const offset = -size / 2;
    const point = ([x, y]: Point): Point => [offset + x * size, offset + y * size];
    const start = point(glyph.start);
    const curve1End = point(glyph.curve1[0]);
    const curve1Control1 = point(glyph.curve1[1]);
    const curve1Control2 = point(glyph.curve1[2]);
    const line1 = point(glyph.line1);
    const curve2End = point(glyph.curve2[0]);
    const curve2Control1 = point(glyph.curve2[1]);
    const curve2Control2 = point(glyph.curve2[2]);
    const line2 = point(glyph.line2);
    const line3 = point(glyph.line3);
    const curve3End = point(glyph.curve3[0]);
    const curve3Control1 = point(glyph.curve3[1]);
    const curve3Control2 = point(glyph.curve3[2]);

    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.bezierCurveTo(
      curve1Control1[0], curve1Control1[1],
      curve1Control2[0], curve1Control2[1],
      curve1End[0], curve1End[1],
    );
    ctx.lineTo(line1[0], line1[1]);
    ctx.bezierCurveTo(
      curve2Control1[0], curve2Control1[1],
      curve2Control2[0], curve2Control2[1],
      curve2End[0], curve2End[1],
    );
    ctx.lineTo(line2[0], line2[1]);
    ctx.lineTo(line3[0], line3[1]);
    ctx.bezierCurveTo(
      curve3Control1[0], curve3Control1[1],
      curve3Control2[0], curve3Control2[1],
      curve3End[0], curve3End[1],
    );
    ctx.lineTo(start[0], start[1]);
    ctx.closePath();

    const palette = this.palette;
    const gradient = ctx.createLinearGradient(offset, offset, -offset, -offset);
    // Opaque. The fill was carrying a third of its own colour, which let every
    // control underneath show through and left the arrow with no interior of
    // its own — the single largest reason it read as a smudge. The native
    // cursor's fill has no alpha at all; the gradient across the brand colours
    // is Maka's and stays.
    gradient.addColorStop(0, rgba(palette.cursorStart, 0.97));
    gradient.addColorStop(0.55, rgba(palette.cursorMid, 0.95));
    gradient.addColorStop(1, rgba(palette.cursorEnd, 0.93));
    // A drop shadow, not a bloom. The upstream engine shadowed with the
    // cursor's own brand colour, which reads as a glow: pleasant over light
    // surfaces, but on a dark control it blends into the background instead of
    // separating the cursor from it — exactly where separation matters most.
    // Neutral black is what the system cursor uses, and for the same reason.
    // The brand colour still owns the fill, and the white outline below is what
    // the native cursor separates itself with.
    ctx.shadowColor = rgba(SHADOW_RGB, 0.3 + pressedAmount * 0.1);
    ctx.shadowBlur = glyph.shadowBlur + pressedAmount * 3;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = gradient;
    ctx.fill();
    // `Color.white.opacity(0.8)`, `lineWidth: 2`, `lineJoin: .miter`,
    // `miterLimit: 10`, `lineCap: .butt` — the native stroke, read off the only
    // colour literal in its drawing code. The rounded join Maka had was
    // rounding off the arrow's point, which is the part that says which way it
    // is pointing.
    ctx.strokeStyle = rgba(OUTLINE_RGB, 0.8);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 10;
    ctx.lineCap = 'butt';
    ctx.stroke();
  }
}
