// What checkboxes and radios look like, shared by the gallery's control
// demos and the website's (through `demo.ts`): a box or ring sunk like a
// field that lights up in the main button's citrus, its mark springing in,
// and the choice cards whose whole surface is the control.
import type { AnimatedValue, ViewStyle } from "nsh";
import { reduceMotion, View } from "nsh";
import { Icon } from "../icons";
import { colors, finish, focusRing, follow, radius, terminal, TERMINAL_ROW, tints } from "../theme";
import { pressSink } from "./press";
import { controlSize } from "./surface";

/** What a checkbox's box shows: a check, a dash (indeterminate) or nothing. */
export type CheckboxMarkKind = "check" | "dash" | null;

/** Options of `checkboxLook`, `CheckboxMark` and `RadioRing`. */
export interface ChoiceOptions {
  /** Times the page's size (`controlSize.control`): 0.8 small, 1.25 large. */
  scale?: number;
  /** A round box (a task's, as reminders draw it). */
  round?: boolean;
}

/** A box's or ring's size: `scale` times the page's; one row high in the
 * terminal, where it is a glyph three Cells wide. */
const dims = (scale = 1) => ({
  control: Math.round(controlSize.control * scale),
  height: terminal ? TERMINAL_ROW : Math.round(controlSize.control * scale),
  check: Math.round(controlSize.check * scale),
  corner: Math.round(controlSize.corner * scale),
  dot: Math.round(controlSize.dot * scale),
});

/** The fill of a box or ring that is off, the field's well: spread it after
 * the box's `borderWidth` (a quick setting's icon lights up from it too,
 * under a `ChoiceLight`). */
export const choiceWell = (): ViewStyle => ({ backgroundColor: colors.field, backgroundImage: "none", borderColor: colors.fieldBorder, boxShadow: finish.field.boxShadow });

/** A layer over the whole of its parent, its content centered: layers that cross over in place. */
const centered = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" } as const;

/**
 * The press feedback of a box or a ring: it sinks to 90% while its row is
 * pressed (the row is the `group`: give it `class="group"`), and eases back;
 * still with reduced motion.
 */
export const choiceSink = "transition-transform duration-150 ease-out group-active:scale-90 motion-reduce:transition-none";

/** The props `checkboxLook` gives a `Checkbox`'s indicator. */
export interface CheckboxLook {
  readonly indicatorClass: string;
  readonly indicatorStyle: ViewStyle;
}

/**
 * A checkbox's box, as the props of `Checkbox`'s indicator (spread them:
 * `<Checkbox class="group" {...checkboxLook()} indicator={<CheckboxMark mark={..} />}>`):
 * sunk like a field (the field's color and edge), 16 points with a pointer,
 * 22 on a touch screen, its corners 5 / 7 (`round`: a circle), sinking to
 * 90% while its row (the `group`) is pressed. `CheckboxMark` fills it.
 */
export function checkboxLook(o?: ChoiceOptions): CheckboxLook {
  const d = dims(o?.scale);
  return {
    indicatorClass: choiceSink,
    get indicatorStyle(): ViewStyle {
      return {
        width: d.control,
        height: d.height,
        borderRadius: o?.round ? d.control / 2 : d.corner,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        ...choiceWell(),
      };
    },
  };
}

/**
 * The fill of a box or ring that is on (the main button's citrus finish:
 * its darker olive edge and lit top), over the empty one and covering its
 * edge: it fades in and out as the value changes. Gradients do not
 * interpolate, so the finish fades whole rather than its colors.
 */
export function ChoiceLight(props: { on: AnimatedValue; radius: number }) {
  return (
    <View
      style={{ pointerEvents: "none", position: "absolute", top: -1, left: -1, right: -1, bottom: -1, borderRadius: props.radius, borderWidth: 1, ...finish.light, opacity: props.on }}
    />
  );
}

/** The stroke of a checkbox's check and dash (about 2 points at the desktop
 * size): the bold pen of every check that marks something done. */
export const MARK_WEIGHT = 3.2;

/**
 * What a checkbox's box shows (its `indicator`): citrus with a check or a
 * dash, drawn with the same bold pen. Each part follows the value on a
 * spring of its own (`motion.control`) and grows in from 75%, so a check
 * turning into a dash crosses over on a fill that stays; at once with
 * reduced motion.
 */
export function CheckboxMark(props: { mark: CheckboxMarkKind } & ChoiceOptions) {
  const d = dims(props.scale);
  // Each part stays mounted while it fades out (unmounting it on the value
  // showed only the fade in).
  const on = follow(() => (props.mark ? 1 : 0));
  const check = follow(() => (props.mark === "check" ? 1 : 0));
  const dash = follow(() => (props.mark === "dash" ? 1 : 0));
  /** A mark: centered in the box, growing a little as it fades in. */
  const glyph = (t: AnimatedValue, name: "check" | "minus") => (
    <View
      style={{
        ...centered,
        pointerEvents: "none",
        opacity: t,
        transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] }) }],
      }}
    >
      <Icon name={name} size={d.check} tint={colors.onAccent} weight={MARK_WEIGHT} />
    </View>
  );
  // One view as large as the box inside its border holds the layers: the
  // slot's content sits in a holder view sized to it, so layers placed only
  // absolutely made it 0 × 0 and the fill a speck at the box's middle.
  return (
    <View style={{ width: d.control - 2, height: d.height - 2 }}>
      <ChoiceLight on={on} radius={props.round ? d.control / 2 : d.corner} />
      {glyph(check, "check")}
      {glyph(dash, "minus")}
    </View>
  );
}

/**
 * A radio's ring, among the `Radio`'s children (give the radio
 * `class="group"`, so the ring sinks with it): sunk like a field, citrus
 * once checked, with a dot of the ink on the citrus growing in from half
 * its size; 16 points with a pointer, 22 on a touch screen.
 */
export function RadioRing(props: { on: boolean; scale?: number }) {
  const d = dims(props.scale);
  const on = follow(() => (props.on ? 1 : 0));
  return (
    <View
      class={choiceSink}
      style={{ width: d.control, height: d.height, borderRadius: d.control / 2, alignItems: "center", justifyContent: "center", borderWidth: 1, ...choiceWell() }}
    >
      <ChoiceLight on={on} radius={d.control / 2} />
      <View
        style={{
          width: d.dot,
          height: d.dot,
          borderRadius: d.dot / 2,
          backgroundColor: colors.onAccent,
          opacity: on,
          transform: [{ scale: on.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }],
        }}
      />
    </View>
  );
}

/** A value, or a function reading it where the look is applied (a signal). */
type Live<T> = T | (() => T);

const read = <T,>(v: Live<T> | undefined): T | undefined => (typeof v === "function" ? (v as () => T)() : v);

/** Options of `choiceTileLook`. */
export interface ChoiceTileOptions {
  /** No hover and no press; dimmed to 40%. Pass the same value to the control's `disabled`. */
  disabled?: Live<boolean | undefined>;
  /** More style (a width, a gap), over the card's. */
  style?: Live<ViewStyle | undefined>;
}

/** The props `choiceTileLook` gives a choice card. */
export interface ChoiceTileLook {
  readonly style: ViewStyle;
  readonly hoverStyle: ViewStyle | undefined;
  readonly activeStyle: ViewStyle;
  readonly focusStyle: ViewStyle;
  readonly disabledStyle: ViewStyle;
}

/**
 * A choice card, whose whole surface is the checkbox or radio (spread it:
 * `<Radio {...choiceTileLook(() => on())}>`, the ring or box in its corner;
 * `on` is read where the look is applied, so a spread follows it): raised
 * while off, its edge the faint text color under the pointer; edged in the
 * accent over its tint while on, the change faded. It sinks to 97% while
 * pressed, natively (`pressSink`). Cards share a row (`flex: 1`).
 */
export function choiceTileLook(on: Live<boolean>, o?: ChoiceTileOptions): ChoiceTileLook {
  const sink = pressSink(0.97);
  const lit = () => !!read(on);
  return {
    get style(): ViewStyle {
      const on = lit();
      return {
        flex: 1,
        minWidth: 0,
        padding: 12,
        paddingTop: 14,
        borderRadius: radius.inset,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: on ? colors.accent : colors.border,
        backgroundColor: on ? tints.accent : colors.raised,
        boxShadow: on ? "none" : finish.raised.boxShadow,
        transitionProperty: "transform, border-color, background-color, box-shadow",
        transitionDuration: reduceMotion() ? 0 : 150,
        transitionTimingFunction: "ease-out",
        ...(read(o?.style) ?? {}),
      };
    },
    get hoverStyle(): ViewStyle | undefined {
      return read(o?.disabled) || lit() ? undefined : { borderColor: colors.faint };
    },
    get activeStyle(): ViewStyle {
      return sink.activeStyle;
    },
    get focusStyle(): ViewStyle {
      return focusRing();
    },
    disabledStyle: { opacity: 0.4 },
  };
}
