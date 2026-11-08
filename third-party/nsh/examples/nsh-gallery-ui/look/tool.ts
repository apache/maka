// What a toggle and a toolbar's tools look like, shared by the gallery's
// Toggle and Toolbar demos and by the website's demos (through `demo.ts`).
import type { TextStyle, ViewStyle } from "nsh";
import { platform } from "nsh";
import { colors, finish, focusRing, hovered, terminal, TERMINAL_GAP } from "../theme";
import { pressSink, pressTransition } from "./press";

/** A toggle's size: 24 / 28 / 34 points with a pointer, 32 / 38 / 44 on a touch screen. */
export type ToggleSize = "small" | "regular" | "large";

/** A value, or a function reading it where the look is applied (a signal). */
type Live<T> = T | (() => T);

/** Options of `toggleLook`, `toggleLabel` and `toggleGlyph` (the same object for all three). */
export interface ToggleLookOptions {
  /** Default `regular`. */
  size?: Live<ToggleSize | undefined>;
  /** `ghost` (default): bare while off, a toolbar's tool. `outline`: on a
   * field's edge while off, a toggle standing on its own among buttons. */
  variant?: "ghost" | "outline";
  /** It carries a text label (beside its icon or alone): padded at its
   * sides rather than a square. */
  text?: boolean;
  /** For a `Button` or a popup's trigger that shows as on (what it opens
   * is open, a mode it starts is running): the on fill in `style`, no
   * hover. A `Toggle` needs none of it: its `pressedStyle` follows its
   * `pressed`. */
  on?: Live<boolean | undefined>;
  /** No hover and no press feedback; dimmed to 40% (`disabledStyle`). */
  disabled?: Live<boolean | undefined>;
  /** More style (a flex, a width, a margin), over the look's. */
  style?: Live<ViewStyle | undefined>;
}

/** The sizes of a size: the side (the height, and the width of an icon-only toggle), the icon's and the label's size, the padding of a toggle with text. */
export interface ToggleDimensions {
  side: number;
  icon: number;
  text: number;
  pad: number;
}

const pointer = platform.desktop;

/** A toggle's sides, icon and label sizes and paddings, by size: compact with a pointer, roomier on a touch screen. */
export const toggleSizes: Record<ToggleSize, ToggleDimensions> = pointer
  ? { small: { side: 24, icon: 14, text: 12, pad: 8 }, regular: { side: 28, icon: 16, text: 13, pad: 10 }, large: { side: 34, icon: 18, text: 14, pad: 12 } }
  : { small: { side: 32, icon: 16, text: 13, pad: 10 }, regular: { side: 38, icon: 18, text: 15, pad: 12 }, large: { side: 44, icon: 20, text: 16, pad: 14 } };

/** The smallest target a finger gets (Accessibility, "Touch targets"). */
const TOUCH_TARGET = 44;

/** How far presses count past a toggle `side` tall, so a finger gets 44
 * points without the toggle looking bigger: none with a pointer. */
const slop = (side: number) => (pointer || terminal ? undefined : Math.max(0, (TOUCH_TARGET - side) / 2) || undefined);

/** How far a press sinks a toggle (`activeStyle`): none with reduced motion. */
const sink = (scale: number): ViewStyle => pressSink(scale).activeStyle;

/** The properties a toggle's states change, eased as a button's press
 * (`pressTransition`): the sink (Design Guides, "Motion"), the on fill
 * fading in and out, the hover's. */
const transition: ViewStyle = pressTransition("background-color, border-color, box-shadow, opacity");

const read = <T,>(v: Live<T> | undefined): T | undefined => (typeof v === "function" ? (v as () => T)() : v);

const dimensions = (o?: ToggleLookOptions) => toggleSizes[read(o?.size) ?? "regular"];

/**
 * A toggle's props (spread them: `<Toggle pressed={..} {...toggleLook()}>`,
 * or on a toolbar's `Button` or trigger with `on`): its style and its
 * states. A square 28 points across with a pointer, 38 on a touch screen
 * (`small` 24 / 32, `large` 34 / 44), padded at its sides when it carries
 * text, its corners a quarter of its side; a hit slop makes a touch target
 * 44 points. Off, a `ghost` is bare and an `outline` sits on a field's
 * edge; on (`pressedStyle`), it takes `finish.on`, a fill that stands off
 * its surface in both appearances, further than the hover's whisper of the
 * text color. Pressed it sinks to 92% (none with reduced motion). Keyboard
 * focus: `focusRing(1)`. Disabled: 40%, no hover or press. Pair it with
 * `toggleLabel` for a label and `toggleGlyph` for an icon: muted while
 * off, the text's color while on.
 */
export function toggleLook(o?: ToggleLookOptions) {
  const outline = o?.variant === "outline";
  return {
    get style(): ViewStyle {
      const dims = dimensions(o);
      return {
        // The terminal sizes it to its label, which it never breaks: a
        // track too narrow for its tools wraps them instead.
        minWidth: terminal ? undefined : dims.side,
        height: terminal ? undefined : dims.side,
        flexShrink: terminal ? 0 : undefined,
        paddingHorizontal: o?.text ? dims.pad : 0,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        borderRadius: dims.side / 4 + 1,
        borderCurve: "continuous",
        borderWidth: 1,
        ...(outline ? { borderColor: colors.fieldBorder, backgroundColor: colors.field } : { borderColor: "transparent" }),
        ...(read(o?.on) ? finish.on : {}),
        ...transition,
        ...read(o?.style),
      };
    },
    get pressedStyle(): ViewStyle {
      return { ...finish.on };
    },
    get hoverStyle(): ViewStyle | undefined {
      return read(o?.on) || read(o?.disabled) ? undefined : hovered();
    },
    get activeStyle(): ViewStyle | undefined {
      return read(o?.disabled) ? undefined : sink(0.92);
    },
    get focusStyle(): ViewStyle {
      return focusRing(1);
    },
    disabledStyle: { opacity: 0.4 } as ViewStyle,
    get hitSlop(): number | undefined {
      return slop(dimensions(o).side);
    },
  };
}

/** The ink of a toggle's content: the text's color while on, muted while off. */
const ink = (pressed: Live<boolean | undefined>) => (read(pressed) ? colors.text : colors.muted);

/** The label of a `toggleLook` of the same options: 13 points with a pointer, 15 on a touch screen (`small` 12 / 13, `large` 14 / 16), medium weight, muted while off. */
export function toggleLabel(pressed: Live<boolean | undefined>, o?: ToggleLookOptions): TextStyle {
  return {
    get color() {
      return ink(pressed);
    },
    get fontSize() {
      return dimensions(o).text;
    },
    fontWeight: "500",
  };
}

/** An icon in a `toggleLook` (`<Icon {...toggleGlyph(pressed)} />`): 16 points with a pointer, 18 on a touch screen (`small` 14 / 16, `large` 18 / 20), muted while off. */
export function toggleGlyph(pressed: Live<boolean | undefined>, o?: ToggleLookOptions) {
  return {
    get size() {
      return dimensions(o).icon;
    },
    get tint() {
      return ink(pressed);
    },
  };
}

/** Options of `toolbarTrack`. */
export interface ToolbarTrackOptions {
  /** A column of tools (a `Toolbar`'s `axis="vertical"`). */
  vertical?: boolean;
}

/**
 * The inset track a toolbar or a `ToggleGroup` sits in: its tools in a row
 * (a column when `vertical`) 2 points apart, 3 points inside its edge, on
 * the inset with the border's edge. A terminal sets each tool as its label
 * two columns apart and wraps a row too narrow for them.
 */
export function toolbarTrack(o?: ToolbarTrackOptions): ViewStyle {
  return {
    flexDirection: o?.vertical ? "column" : "row",
    alignItems: o?.vertical && terminal ? "flex-start" : "center",
    gap: terminal ? TERMINAL_GAP : 2,
    flexWrap: terminal && !o?.vertical ? "wrap" : undefined,
    padding: 3,
    borderRadius: 10,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.inset,
  };
}

/** A hairline between runs of a toolbar's tools (a `ToolbarSeparator`'s or a view's `style`): 18 points tall in a row, across a column. */
export function toolbarRule(vertical = false): ViewStyle {
  return vertical
    ? { height: 1, alignSelf: "stretch", marginVertical: 4, marginHorizontal: 6, backgroundColor: colors.line }
    : { width: 1, height: 18, marginHorizontal: 4, backgroundColor: colors.line };
}
