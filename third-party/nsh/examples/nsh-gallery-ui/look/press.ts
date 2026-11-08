// A press's feedback, native: a control sinks while pressed and eases back
// (Design Guides, "Motion"), from its `activeStyle`, so it never waits for
// JS. Shared by the buttons' looks, `Press` and `tabPress`.
import type { ViewStyle } from "nsh";
import { reduceMotion } from "nsh";

/** The easing of a press and of the state changes beside it: 150 ms, ease-out. */
export const pressEasing = { transitionDuration: 150, transitionTimingFunction: "ease-out" } satisfies ViewStyle;

/** A `style`'s transition for a press's sink: `transform`, and `also` (more
 * of CSS's property names the control's states change, as
 * `"background-color, opacity"`) alike, over `pressEasing`. */
export function pressTransition(also?: string): ViewStyle {
  return { transitionProperty: also ? `${also}, transform` : "transform", ...pressEasing };
}

/**
 * A press that sinks a control to `scale` (default 97%; none with reduced
 * motion). Spread `activeStyle` into the control's `activeStyle` (after its
 * own pressed shade) and `transition` into its `style`
 * (`pressTransition(also)`).
 */
export function pressSink(scale = 0.97, also?: string) {
  return {
    get activeStyle(): ViewStyle {
      return reduceMotion() ? {} : { transform: [{ scale }] };
    },
    transition: pressTransition(also),
  };
}
