/**
 * The card's flight from the button to the System Settings window.
 *
 * This is the part of the effect that carries the meaning: a card that
 * simply appears next to Settings reads as an unrelated popup, while one
 * that arcs out of the button the user just pressed reads as "this thing
 * came from there and belongs over here". So the path is deliberately an
 * arc, not a slide.
 *
 * Pure geometry — no timers, no Electron. The caller samples `frameAt(t)`
 * on whatever clock it has, which is what makes the curve and the spring
 * testable without animating anything.
 */

export interface Rect { x: number; y: number; width: number; height: number }

/** Total flight time. Long enough to read as motion, short enough that it
 *  never feels like a wait before the user can start dragging. */
export const FLIGHT_MS = 620;

/**
 * How high the arc bows, as a fraction of the distance travelled, clamped
 * so a short hop still visibly arcs and a cross-screen flight does not
 * loop absurdly high.
 */
export const ARC_RATIO = 0.18;
export const ARC_MIN_PX = 44;
export const ARC_MAX_PX = 140;

/**
 * Critically damped spring, normalised to reach ~1 at t=1.
 *
 * Critically damped, not underdamped: the card must not overshoot past
 * the Settings window and swing back. Overshoot looks playful in a demo
 * and reads as imprecision when the thing is claiming "your target is
 * exactly here".
 */
export function springProgress(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const omega = 6;
  return 1 - Math.exp(-omega * t) * (1 + omega * t);
}

function lift(from: Rect, to: Rect): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  return Math.min(Math.max(distance * ARC_RATIO, ARC_MIN_PX), ARC_MAX_PX);
}

/**
 * Position + size at normalised time `t` (0..1).
 *
 * The arc is a quadratic Bézier whose control point sits at the midpoint
 * lifted UPWARD (negative y, screen coordinates). Size interpolates
 * separately on the same eased clock, so the card grows from the button's
 * footprint into the docked card rather than sliding at full size.
 */
export function frameAt(from: Rect, to: Rect, t: number): Rect {
  const eased = springProgress(t);
  const arc = lift(from, to);

  // Quadratic Bézier on the CENTRES, so the arc is not skewed by the
  // card growing from a small button.
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;
  const ctrlX = (fromCx + toCx) / 2;
  const ctrlY = (fromCy + toCy) / 2 - arc;

  const inv = 1 - eased;
  const cx = inv * inv * fromCx + 2 * inv * eased * ctrlX + eased * eased * toCx;
  const cy = inv * inv * fromCy + 2 * inv * eased * ctrlY + eased * eased * toCy;

  const width = from.width + (to.width - from.width) * eased;
  const height = from.height + (to.height - from.height) * eased;

  return {
    x: Math.round(cx - width / 2),
    y: Math.round(cy - height / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export interface FlightDeps {
  from: Rect;
  to: Rect;
  /** Monotonic clock, injected so tests do not wait. */
  now(): number;
  setFrame(rect: Rect): void;
  requestTick(fn: () => void): void;
  onDone(): void;
  /** Honour the system setting: skip straight to the destination. */
  reducedMotion: boolean;
}

/**
 * Run the flight. Returns a cancel function — the card can be dismissed
 * or the grant can land mid-flight, and a tick that fires after that must
 * not move a destroyed window.
 */
export function runFlight(deps: FlightDeps): () => void {
  if (deps.reducedMotion) {
    deps.setFrame(deps.to);
    deps.onDone();
    return () => {};
  }

  const start = deps.now();
  let cancelled = false;

  const step = (): void => {
    if (cancelled) return;
    const t = Math.min(1, (deps.now() - start) / FLIGHT_MS);
    deps.setFrame(frameAt(deps.from, deps.to, t));
    if (t >= 1) {
      deps.onDone();
      return;
    }
    deps.requestTick(step);
  };

  deps.requestTick(step);
  return () => { cancelled = true; };
}
