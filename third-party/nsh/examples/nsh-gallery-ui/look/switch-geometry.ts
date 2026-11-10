// A switch's sizes and the arithmetic of its knob, apart from `switch.ts`
// and free of imports, so the website's tests can check it without NSH.

/** A switch's track and knob, in points. */
export interface SwitchGeometry {
  /** The track's outer width. */
  width: number;
  /** The track's outer height. */
  height: number;
  /** The track's border, on every side. */
  border: number;
  /** The track's padding, between its border and the knob, on every side. */
  inset: number;
  /** The knob's diameter. */
  knob: number;
}

/**
 * The switch's sizes: 28 × 16 with a pointer, 42 × 24 on a touch screen
 * (`small`: 34 × 20). The track is exactly the knob plus its border and
 * inset on each side, so the knob sits as far from the top and the bottom
 * as from the near end.
 */
export const switchGeometries = {
  pointer: { width: 28, height: 16, border: 1, inset: 1, knob: 12 },
  regular: { width: 42, height: 24, border: 1, inset: 1, knob: 20 },
  small: { width: 34, height: 20, border: 1, inset: 1, knob: 16 },
} satisfies Record<string, SwitchGeometry>;

/**
 * How far the knob travels from off to on. Off, it rests at the start of the
 * track's content box, `border + inset` from the leading edge; on, it must
 * end the same `border + inset` from the trailing edge. So it travels the
 * width less the knob and that gap at both ends.
 */
export const knobTravel = (g: SwitchGeometry) => g.width - 2 * (g.border + g.inset) - g.knob;

/** The smallest target a finger gets (Accessibility, "Touch targets"). */
export const TOUCH_TARGET = 44;

/**
 * How far presses count past a switch whose track makes up its height, so a
 * finger gets `TOUCH_TARGET` points on each axis without the track looking
 * bigger.
 */
export function switchSlop(g: SwitchGeometry): { top: number; bottom: number; left: number; right: number } {
  const v = Math.max(0, (TOUCH_TARGET - g.height) / 2);
  const h = Math.max(0, (TOUCH_TARGET - g.width) / 2);
  return { top: v, bottom: v, left: h, right: h };
}
