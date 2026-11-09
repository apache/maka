// What a button looks like, shared by the gallery's `Button`, `RoundButton`
// and icon buttons and by the website's demos (`button()` in `demo.ts`).
import type { TextStyle, ViewStyle } from "nsh";
import { platform, token } from "nsh";
import { alpha, colors, finish, focusRing, ghostFill, hovered, radius, terminal, TERMINAL_COLUMN, TERMINAL_ROW, tints } from "../theme";
import { pressSink, pressTransition } from "./press";

/**
 * `primary` and `accent`: the citrus fill (the one main action of a
 * decision area; a lit fill such as a counter's increment). `secondary`: a
 * raised neutral, the ordinary visible action. `ghost`: bare until the
 * pointer is over it, a quiet toolbar or inline action. `danger`: a
 * destructive action, the danger tone's tint, edge and text, as quiet as
 * `secondary`.
 */
export type ButtonKind = "primary" | "accent" | "secondary" | "ghost" | "danger";

/** A button's size: 24 / 28 / 34 points with a pointer, 36 / 40 / 48 on a touch screen. */
export type ButtonSize = "small" | "regular" | "large";

/** A value, or a function reading it where the look is applied (a signal). */
type Live<T> = T | (() => T);

/** Options of `buttonLook`, `buttonLabel` and `buttonGlyph` (the same object for all three). */
export interface ButtonLookOptions {
  /** Default `regular`. */
  size?: Live<ButtonSize | undefined>;
  /** Shown as chosen: what it opens is open (a menu's or a popover's
   * trigger), or it is the current one of a few. A raised button takes the
   * `on` fill, a ghost the neutral `accent` fill, a filled one its
   * pressed shade; no hover while selected. */
  selected?: Live<boolean | undefined>;
  /** No hover and no press feedback; dimmed to 40% (`disabledStyle`). */
  disabled?: Live<boolean | undefined>;
  /** Work started by it is going on: no hover and no press feedback, not dimmed. */
  busy?: Live<boolean | undefined>;
  /** More style (a flex, a width, a margin), over the look's. */
  style?: Live<ViewStyle | undefined>;
}

/** The sizes of a size: the height, the label's and the icon's size, the horizontal padding. */
export interface ButtonDimensions {
  height: number;
  font: number;
  icon: number;
  pad: number;
}

const pointer = platform.desktop;

/** A button's heights, label and icon sizes and paddings, by size: compact with a pointer, roomier on a touch screen. */
export const buttonSizes: Record<ButtonSize, ButtonDimensions> = pointer
  ? { small: { height: 24, font: 12, icon: 12, pad: 8 }, regular: { height: 28, font: 13, icon: 14, pad: 12 }, large: { height: 34, font: 14, icon: 15, pad: 16 } }
  : { small: { height: 36, font: 14, icon: 14, pad: 12 }, regular: { height: 40, font: 15, icon: 16, pad: 16 }, large: { height: 48, font: 17, icon: 18, pad: 20 } };

/** The smallest target a finger gets (Accessibility, "Touch targets"). */
const TOUCH_TARGET = 44;

/** How far presses count past a control `height` tall, so a finger gets 44
 * points without the control looking bigger: none with a pointer. */
const slop = (height: number) => (pointer || terminal ? undefined : Math.max(0, (TOUCH_TARGET - height) / 2) || undefined);

/** How far a press sinks a button (`activeStyle`): none with reduced motion. */
const sink = (scale: number): ViewStyle => pressSink(scale).activeStyle;

/** The properties a button's states change, eased over 150 ms: the press's
 * sink (Design Guides, "Motion") and the hover's and press's colors. */
const transition = pressTransition("background-color, border-color, box-shadow, opacity");

const read = <T,>(v: Live<T> | undefined): T | undefined => (typeof v === "function" ? (v as () => T)() : v);

const dimensions = (o?: ButtonLookOptions) => buttonSizes[read(o?.size) ?? "regular"];
const filled = (kind: ButtonKind) => kind === "primary" || kind === "accent";

/** The fill, edge and shadow of a kind at rest (or selected). */
function rest(kind: ButtonKind, selected: boolean): ViewStyle {
  if (filled(kind)) return { ...finish.accent, opacity: selected ? 0.88 : 1 };
  if (kind === "danger") {
    return {
      boxShadow: finish.raised.boxShadow,
      backgroundColor: selected ? alpha(colors.danger, 0.2) : tints.danger,
      backgroundImage: "none",
      borderColor: alpha(colors.danger, 0.32),
    };
  }
  if (kind === "ghost") return { backgroundColor: selected ? token("accent") : ghostFill(), borderColor: "transparent" };
  // Selected stays on: `on`, apart from rest and from hover in both
  // appearances (a sunk `pressed` is a press's, too faint to hold).
  return selected ? finish.on : finish.raised;
}

/**
 * A button's props (spread them: `<Button {...buttonLook("primary")}>`, or
 * on a `View` with `onPress`): its style and its states. One row, its label
 * centered, `radius.control` with continuous corners; 28 points tall with a
 * pointer, 40 on a touch screen (`small` 24 / 36, `large` 34 / 48), a hit
 * slop making a touch target 44 points. Under the pointer a raised button
 * lightens, a ghost gets a whisper of the text color, a filled one a touch
 * of transparency; pressed it sinks to 97% (none with reduced motion) and
 * shades (a raised button's inner shade, a filled one dims). Keyboard
 * focus: `focusRing()`. Disabled: 40%, no hover or press. Pair it with
 * `buttonLabel` for the label and `buttonGlyph` for an icon.
 */
export function buttonLook(kind: Live<ButtonKind> = "secondary", o?: ButtonLookOptions) {
  const k = () => read(kind) ?? "secondary";
  const idle = () => !!read(o?.disabled) || !!read(o?.busy);
  return {
    get style(): ViewStyle {
      const dims = dimensions(o);
      return {
        height: terminal ? TERMINAL_ROW : dims.height,
        paddingHorizontal: terminal ? TERMINAL_COLUMN : dims.pad,
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: pointer ? 6 : 8,
        ...rest(k(), !!read(o?.selected)),
        ...transition,
        ...read(o?.style),
      };
    },
    get hoverStyle(): ViewStyle | undefined {
      if (idle() || read(o?.selected)) return undefined;
      const kind = k();
      if (filled(kind)) return { opacity: 0.94 };
      if (kind === "danger") return { backgroundColor: alpha(colors.danger, 0.16) };
      return kind === "ghost" ? hovered() : finish.hover;
    },
    get activeStyle(): ViewStyle | undefined {
      if (idle()) return undefined;
      const kind = k();
      const shade: ViewStyle = filled(kind)
        ? { opacity: 0.88 }
        : kind === "danger"
          ? { backgroundColor: alpha(colors.danger, 0.22), boxShadow: "none" }
          : finish.pressed;
      return { ...shade, ...sink(0.97) };
    },
    get focusStyle(): ViewStyle {
      return focusRing();
    },
    disabledStyle: { opacity: 0.4 } as ViewStyle,
    get hitSlop(): number | undefined {
      return slop(dimensions(o).height);
    },
  };
}

/** The color of a kind's label and icon. */
function ink(live: Live<ButtonKind>) {
  const kind = read(live) ?? "secondary";
  return filled(kind) ? colors.onAccent : kind === "danger" ? colors.danger : colors.text;
}

/** The label of a `buttonLook` of the same kind and options: 13 points with a pointer, 15 on a touch screen (`small` 12 / 14, `large` 14 / 17), medium weight. */
export function buttonLabel(kind: Live<ButtonKind> = "secondary", o?: ButtonLookOptions): TextStyle {
  return {
    get color() {
      return ink(kind);
    },
    get fontSize() {
      return dimensions(o).font;
    },
    fontWeight: "500",
  };
}

/** An icon beside the label of a `buttonLook` (`<Icon {...buttonGlyph(..)} />`): its size and color. */
export function buttonGlyph(kind: Live<ButtonKind> = "secondary", o?: ButtonLookOptions) {
  return {
    get size() {
      return dimensions(o).icon;
    },
    get tint() {
      return ink(kind);
    },
  };
}

/** Options of `iconButtonLook` and `iconButtonGlyph`. */
export interface IconButtonLookOptions {
  /** Chosen (a favorite, a shown sidebar): the accent's tint, the icon in the accent, no hover. */
  on?: Live<boolean | undefined>;
  /** `danger`: its icon in the danger tone, the tone's tint under the pointer. */
  tone?: "danger";
  /** `ghost` (default): bare until the pointer is over it; `secondary`: raised. */
  variant?: "ghost" | "secondary";
  /** No hover and no press feedback; dimmed to 40%. */
  disabled?: Live<boolean | undefined>;
}

/**
 * An icon-only button's props (spread them on a `Button` or a `View` with
 * `onPress`): a square of 28 points with a pointer, 40 on a touch screen
 * (a hit slop making 44), `radius.control`. A ghost by default, raised as
 * `secondary`; `on` takes the accent's tint. Pressed it sinks to 90% (none
 * with reduced motion). The terminal sizes it to its label.
 */
export function iconButtonLook(o: IconButtonLookOptions = {}) {
  const side = pointer ? 28 : 40;
  const raised = o.variant === "secondary";
  return {
    get style(): ViewStyle {
      const on = !!read(o.on);
      return {
        width: terminal ? undefined : side,
        height: terminal ? undefined : side,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: "transparent",
        backgroundColor: on ? tints.accent : ghostFill(),
        ...(raised && !on ? finish.raised : {}),
        ...transition,
      };
    },
    get hoverStyle(): ViewStyle | undefined {
      if (read(o.on) || read(o.disabled)) return undefined;
      return o.tone === "danger" ? { backgroundColor: tints.danger } : raised ? finish.hover : hovered();
    },
    get activeStyle(): ViewStyle | undefined {
      if (read(o.disabled)) return undefined;
      return { ...(raised ? finish.pressed : { backgroundColor: alpha(colors.text, 0.1) }), ...sink(0.9) };
    },
    get focusStyle(): ViewStyle {
      return focusRing();
    },
    disabledStyle: { opacity: 0.4 } as ViewStyle,
    hitSlop: slop(side),
  };
}

/** The icon of an `iconButtonLook` of the same options: 15 points with a pointer, 18 on a touch screen; the accent when `on`, else the tone's, the text's (raised) or muted. */
export function iconButtonGlyph(o: IconButtonLookOptions = {}) {
  return {
    size: pointer ? 15 : 18,
    get tint() {
      return read(o.on) ? colors.accent : o.tone === "danger" ? colors.danger : o.variant === "secondary" ? colors.text : colors.muted;
    },
  };
}

/**
 * A round icon button's props (a composer's send, a player's play):
 * `primary` the citrus fill, `secondary` raised; `size` across (28 with a
 * pointer, 40 on a touch screen, a hit slop making 44). Under the pointer
 * it lightens; pressed it sinks to 92% (none with reduced motion).
 */
export function roundButtonLook(variant: "primary" | "secondary" = "primary", o: { size?: number; disabled?: Live<boolean | undefined> } = {}) {
  const side = o.size ?? (pointer ? 28 : 40);
  const primary = variant === "primary";
  return {
    get style(): ViewStyle {
      return {
        width: side,
        height: side,
        borderRadius: side / 2,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        ...(primary ? finish.accent : finish.raised),
        ...transition,
      };
    },
    get hoverStyle(): ViewStyle | undefined {
      if (read(o.disabled)) return undefined;
      return primary ? { opacity: 0.94 } : finish.hover;
    },
    get activeStyle(): ViewStyle | undefined {
      return read(o.disabled) ? undefined : sink(0.92);
    },
    get focusStyle(): ViewStyle {
      return focusRing();
    },
    disabledStyle: { opacity: 0.4 } as ViewStyle,
    hitSlop: slop(side),
  };
}

/** The icon of a `roundButtonLook`: 42% of its size, on the fill's color. */
export function roundButtonGlyph(variant: "primary" | "secondary" = "primary", size?: number) {
  return {
    size: (size ?? (pointer ? 28 : 40)) * 0.42,
    get tint() {
      return variant === "primary" ? colors.onLight : colors.text;
    },
  };
}
