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

/**
 * Motion for the Computer Use picture-in-picture mirror: where it can rest,
 * where a flick should send it, and how it travels there.
 *
 * Every constant here was recovered from Codex's `sky.node`
 * (`PIPStackController`, `PIPStackItemMotion`), because the interaction is the
 * part of that window people notice and guessed numbers read as wrong even
 * when the structure is right. Provenance is recorded per constant; the
 * disassembly they came from is quoted where the shape is not obvious.
 *
 * No Electron here on purpose — this is the half that can be tested exactly.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which corner of the host an anchor sits in. */
export type PipAlignment = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface PipAnchor {
  alignment: PipAlignment;
  /** Top-left origin of the mirror when resting on this anchor, in screen points. */
  point: Point;
}

/**
 * Spring constants for the item that leads the motion.
 *
 * From `-[PIPStackController configureMotionSpringsWithLeadItem:dragging:
 * programmaticMove:]`, which selects between two columns with a single
 * `cmp w26, #0` followed by four `fcsel`:
 *
 *     lead stiffness       320 | 900
 *     lead damping          42 |  55
 *     follower stiffness   150 | 260   (divided by 1 + 0.18 * softIndex)
 *     follower damping      30 |  32   (divided by 1 + 0.08 * softIndex)
 *
 * Maka shows one mirror rather than a stack, so only the lead column applies
 * and the follower falloff has nothing to fall off. Note the damping ratios
 * that fall out of these: settling is ζ≈1.17, slightly overdamped, so it never
 * bounces past the corner; dragging is ζ≈0.92, just under critical, so the
 * window keeps a trace of give while the pointer pulls it.
 */
/** Codex clamps the longest edge to [100, 400] and defaults to 200. */
export const PIP_MIN_EDGE = 100;
export const PIP_DEFAULT_EDGE = 200;
export const PIP_MAX_EDGE = 400;

/**
 * Inset from the host's corner, matching Codex's 24pt anchor inset.
 *
 * Lives here, with the rest of the geometry, rather than in the controller.
 * It used to live in pip-window.ts and be imported back by pip-electron.ts,
 * which pip-window.ts imports from — a value-level cycle that only worked
 * because each side touched the other's bindings from inside a function body.
 * This module imports nothing, so nothing can cycle through it.
 */
export const PIP_MARGIN = 24;

/**
 * The corner of the tile the resize grip sits on: the one opposite the anchor.
 *
 * The gesture's sign already follows the anchor (`pipResizeEdge`), because the
 * anchored corner is the one that stays put while the tile grows. The handle
 * has to follow it too, or the pointer separates from the grip on the first
 * pixel of the drag — which is what happened in all three non-default corners
 * while the grip was pinned to the tile's top-left in CSS.
 */
export function pipGripCorner(alignment: PipAlignment): PipAlignment {
  switch (alignment) {
    case 'bottom-right':
      return 'top-left';
    case 'bottom-left':
      return 'top-right';
    case 'top-right':
      return 'bottom-left';
    case 'top-left':
      return 'bottom-right';
  }
}

export const PIP_SPRING = {
  dragging: { stiffness: 900, damping: 55 },
  settling: { stiffness: 320, damping: 42 },
} as const;

export interface Spring {
  stiffness: number;
  damping: number;
}

export interface MotionState {
  position: Point;
  velocity: Point;
}

/**
 * One semi-implicit Euler step of a critically-ish damped spring, per axis.
 *
 * Semi-implicit rather than explicit Euler because the explicit form gains
 * energy at large `dt` — a frame drop would make the mirror fly off rather
 * than arrive late, which is the one failure mode an animation must not have.
 * `dt` is clamped for the same reason: a backgrounded window can hand us a
 * gap of seconds, and no spring is stable across that.
 */
export function stepSpring(
  state: MotionState,
  target: Point,
  spring: Spring,
  dt: number,
): MotionState {
  const step = Math.min(Math.max(dt, 0), 1 / 30);
  const ax = -spring.stiffness * (state.position.x - target.x) - spring.damping * state.velocity.x;
  const ay = -spring.stiffness * (state.position.y - target.y) - spring.damping * state.velocity.y;
  const vx = state.velocity.x + ax * step;
  const vy = state.velocity.y + ay * step;
  return {
    velocity: { x: vx, y: vy },
    position: { x: state.position.x + vx * step, y: state.position.y + vy * step },
  };
}

/** Within half a point and slower than half a point per second reads as arrived. */
export function springAtRest(state: MotionState, target: Point): boolean {
  return (
    Math.abs(state.position.x - target.x) < 0.5 &&
    Math.abs(state.position.y - target.y) < 0.5 &&
    Math.hypot(state.velocity.x, state.velocity.y) < 0.5
  );
}

/**
 * The four resting places, one per corner of the host, inset by `margin`.
 *
 * Codex builds `PIPStackHost` from an owner window plus an anchor rect and a
 * list of `PIPStackHostAnchor{contentPoint, alignment}`. Its own registration
 * passes a single anchor because it is pinning a mascot; a mirror the user can
 * throw wants every corner available, which is what the alignment enum and
 * `compatibleAnchorsForCurrentLayout` exist for.
 */
export function pipAnchors(
  host: Rect,
  size: { width: number; height: number },
  margin: number,
): PipAnchor[] {
  const left = host.x + margin;
  const right = host.x + host.width - size.width - margin;
  const top = host.y + margin;
  const bottom = host.y + host.height - size.height - margin;
  return [
    { alignment: 'top-left', point: { x: left, y: top } },
    { alignment: 'top-right', point: { x: right, y: top } },
    { alignment: 'bottom-left', point: { x: left, y: bottom } },
    { alignment: 'bottom-right', point: { x: right, y: bottom } },
  ];
}

export function anchorFor(anchors: PipAnchor[], alignment: PipAlignment): PipAnchor | undefined {
  return anchors.find((a) => a.alignment === alignment);
}

/**
 * How far a flick throws the mirror, as a fraction of the host.
 *
 * From `-[PIPStackController nearestTargetAnchorForCurrentAnchor:
 * draggingVelocity:]`:
 *
 *     d11,d12 = velocity * 0.55          ; the throw, not the raw velocity
 *     d10     = hypot(d11, d12)
 *     d8      = d10 / 5000               ; normalized against a full-speed flick
 *     t       = min(d8, 0.45)            ; and never more than 45% of the host
 *     target  = current + unit(throw) * t
 *
 * The 0.55 matters: it is the difference between "the window goes where you
 * threw it" and "the window goes where you were pointing", and only the first
 * one feels like it has weight.
 *
 * Codex has a fourth constant here, `hypot(velocity) >= 120`, and it is
 * deliberately not carried over: it gates whether anchors on *other displays*
 * are candidates at all. Maka's anchors are the four corners of one host
 * window, so there is no cross-display candidate for it to gate, and a slow
 * release already reads as a place rather than a throw — the reach it produces
 * is near zero, so the nearest corner wins on distance alone. It was ported
 * once with no reader and one assertion that compared the literal to itself.
 */
export const PIP_THROW_SCALE = 0.55;
export const PIP_THROW_REFERENCE = 5000;
export const PIP_THROW_MAX = 0.45;

/**
 * Score every anchor against a throw and return the winner.
 *
 * Codex's loop, in order: project the current point along the throw, take the
 * distance from each candidate to that projection, then subtract a bonus for
 * candidates that lie in the direction actually thrown —
 * `hypot(throw) * max(0, dot(unitThrow, unitToCandidate))`. Distance alone
 * picks the corner you are nearest to, which is usually the one you are
 * leaving; the dot product is what makes a deliberate throw across the window
 * land where it was aimed.
 */
export function pickPipAnchor(
  anchors: PipAnchor[],
  current: Point,
  velocity: Point,
  host: Rect,
): PipAnchor {
  if (anchors.length === 0) throw new Error('pickPipAnchor needs at least one anchor');
  const throwX = velocity.x * PIP_THROW_SCALE;
  const throwY = velocity.y * PIP_THROW_SCALE;
  const speed = Math.hypot(throwX, throwY);
  // Scale the normalized throw back into points, so the projection lands in the
  // same space the anchors live in. Codex works in the host's content
  // coordinates, where its 0.45 cap is 45% of the host; the cap means the same
  // thing here, measured against the host's diagonal.
  const reach =
    Math.min(speed / PIP_THROW_REFERENCE, PIP_THROW_MAX) * Math.hypot(host.width, host.height);
  const unit = speed > 0 ? { x: throwX / speed, y: throwY / speed } : { x: 0, y: 0 };
  const target = { x: current.x + unit.x * reach, y: current.y + unit.y * reach };

  let best = anchors[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    const distance = Math.hypot(anchor.point.x - target.x, anchor.point.y - target.y);
    const toAnchor = { x: anchor.point.x - current.x, y: anchor.point.y - current.y };
    const toAnchorLength = Math.hypot(toAnchor.x, toAnchor.y);
    const alignment =
      speed > 0 && toAnchorLength > 0
        ? Math.max(0, (unit.x * toAnchor.x + unit.y * toAnchor.y) / toAnchorLength)
        : 0;
    const score = distance - speed * alignment;
    if (score < bestScore) {
      bestScore = score;
      best = anchor;
    }
  }
  return best;
}

/**
 * Where a resize drag takes the mirror's longest edge.
 *
 * From `-[PIPStackResizeInteraction maxDisplaySizeForPointerScreenPoint:]`,
 * which is four instructions:
 *
 *     sign = (alignment & ~1) == 2 ? +1 : -1
 *     size = initialMaxDisplaySize + (pointer.y - initialPointer.y) * sign
 *
 * Only the vertical component moves it, and the sign comes from which corner
 * the mirror is resting on: dragging away from the anchor grows it, dragging
 * toward it shrinks it, so the gesture reads the same in every corner.
 *
 * Clamped to the same [100, 400] the rest of the sizing uses — the constants
 * are literally the same three doubles in the binary — and snapped to whole
 * points, which is what Codex's `snapPointToBackingScale:` does for the same
 * reason: a fractional edge on a transparent window shimmers.
 */
export function pipResizeEdge(
  initialEdge: number,
  initialPointerY: number,
  pointerY: number,
  alignment: PipAlignment,
): number {
  const growsDownward = alignment === 'top-left' || alignment === 'top-right';
  const delta = (pointerY - initialPointerY) * (growsDownward ? 1 : -1);
  return Math.round(Math.min(PIP_MAX_EDGE, Math.max(PIP_MIN_EDGE, initialEdge + delta)));
}

/**
 * Keep the mirror on a display, wherever the drag left it.
 *
 * Codex's `clampEnvelopeToVisibleScreen:`. Without it a throw at the edge puts
 * the mirror half off-screen, and on macOS a window can be dragged into the
 * region between two displays and left there.
 */
export function clampToWorkArea(
  point: Point,
  size: { width: number; height: number },
  workArea: Rect,
): Point {
  return {
    x: Math.min(Math.max(point.x, workArea.x), workArea.x + workArea.width - size.width),
    y: Math.min(Math.max(point.y, workArea.y), workArea.y + workArea.height - size.height),
  };
}

/**
 * Pointer sampling, so a release knows how fast it was going.
 *
 * `PIPStackDragInteraction` keeps the previous pointer point and a timestamp
 * and reports `velocity` from the pair. Sampling only the last two events is
 * deliberate: averaging a longer window makes a flick that ends in a pause
 * still throw, which is the opposite of what the pause meant.
 */
export class PipDragTracker {
  private origin: Point;
  private grab: Point;
  private previous: { point: Point; at: number } | null = null;
  private latest: { point: Point; at: number };

  constructor(pointer: Point, windowOrigin: Point, at: number) {
    this.origin = windowOrigin;
    this.grab = { x: pointer.x - windowOrigin.x, y: pointer.y - windowOrigin.y };
    this.latest = { point: pointer, at };
  }

  /** Window origin implied by the pointer, keeping the grab offset. */
  update(pointer: Point, at: number): Point {
    this.previous = this.latest;
    this.latest = { point: pointer, at };
    this.origin = { x: pointer.x - this.grab.x, y: pointer.y - this.grab.y };
    return this.origin;
  }

  get windowOrigin(): Point {
    return this.origin;
  }

  /** Points per second at release, or zero when the pointer was still. */
  velocity(): Point {
    const previous = this.previous;
    if (!previous) return { x: 0, y: 0 };
    const seconds = (this.latest.at - previous.at) / 1000;
    // A zero or negative gap is a duplicate event, not an infinite flick.
    if (!(seconds > 0)) return { x: 0, y: 0 };
    return {
      x: (this.latest.point.x - previous.point.x) / seconds,
      y: (this.latest.point.y - previous.point.y) / seconds,
    };
  }
}
