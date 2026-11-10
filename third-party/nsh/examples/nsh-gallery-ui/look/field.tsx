// What text fields look like, shared by the gallery's form and control demos
// and the website's (through `demo.ts`): a recessed well on the field color,
// a stronger edge under the pointer, and one focus look for every field,
// a 2-point accent edge fading in while the field, or a view in it, has the
// keys. The edges are classes: the states' order puts `hover:` above
// `focus-within:`, which only a class can turn around (`hover:focus-within:`),
// and the border takes the accent with the outline, which not every platform
// draws over the border.
import type { InputStyle, ViewStyle } from "nsh";
import { platform, Text } from "nsh";
import { Icon } from "../icons";
import { colors, finish, radius, terminal, TERMINAL_COLUMN, TERMINAL_ROW, type Tone, toneColor, toneTint } from "../theme";
import { controlSize } from "./surface";

const pointer = platform.desktop;

/** A value, or a function reading it where the look is applied (a signal). */
type Live<T> = T | (() => T);

const read = <T,>(v: Live<T> | undefined): T | undefined => (typeof v === "function" ? (v as () => T)() : v);

/**
 * A text field's sizes: 28 points high, text 13 and 8 points in from its
 * edges with a pointer; 46 high, text 15 and 14 in on a touch screen. In the
 * terminal a field is three rows (its border's and the text's), the text one
 * Cell inside the border's own column.
 */
export const fieldSize = terminal
  ? { height: 3 * TERMINAL_ROW, font: 13, pad: 2 * TERMINAL_COLUMN - 1 }
  : pointer
    ? { height: 28, font: 13, pad: 8 }
    : { height: 46, font: 15, pad: 14 };

/** Options of `fieldLook` and `inputLook`. */
export interface FieldLookOptions {
  /** Edged in the danger tone, its focus edge too. */
  invalid?: Live<boolean>;
  /** Read-only: lies flat (no recess) on a quieter edge. */
  readonly?: Live<boolean>;
  /** Disabled: flat on the quieter edge, as read-only; `disabledStyle` dims it. */
  disabled?: Live<boolean>;
  /** Several lines: the content starts at the top. */
  multiline?: boolean;
  /** Layout over the look (a width, a height, a margin; on an input its text too), or a function reading it. */
  style?: Live<InputStyle>;
}

/** Options of `edgeClass`. */
interface EdgeOptions {
  /** The edge at rest: a border color class (`border-input`). */
  rest: string;
  /** The edge under the pointer (`border-faint`), none for a field that takes no hover. */
  hover?: string;
  /** The variant the hover takes (`hover`, `enabled:hover`). */
  hoverVariant?: string;
  /** The focus tone: the accent, or the danger tone while invalid. */
  invalid?: boolean;
  /** `focus:` for a well that has the keys itself, `focus-within:` (the default) for one around what has them. */
  focus?: "focus" | "focus-within";
}

/**
 * A well's edge as classes: at rest, stronger under the pointer, and while
 * it (or a view in it) has the keys a 2-point edge in the accent, the
 * border and the outline together, hovered or not; in the terminal the
 * border is the field's line, so it takes the accent alone.
 */
export function edgeClass(o: EdgeOptions): string {
  const tone = o.invalid ? "destructive" : "brand";
  const focus = o.focus ?? "focus-within";
  const hover = o.hoverVariant ?? "hover";
  return [
    o.rest,
    o.hover ? `${hover}:${o.hover} ${hover}:${focus}:border-${tone}` : "",
    `${focus}:border-${tone}`,
    terminal ? "" : `outline-2 -outline-offset-1 outline-${tone}/0 ${focus}:outline-${tone}`,
    "transition-colors duration-150 motion-reduce:transition-none",
  ]
    .filter(Boolean)
    .join(" ");
}

/** A field's edge: the danger tone while invalid, the line (no hover) while read-only or disabled. */
function fieldEdge(o: FieldLookOptions | undefined): string {
  const invalid = !!read(o?.invalid);
  const flat = !!read(o?.readonly) || !!read(o?.disabled);
  if (invalid) return edgeClass({ rest: "border-destructive", invalid });
  return flat ? edgeClass({ rest: "border-line" }) : edgeClass({ rest: "border-input", hover: "border-faint" });
}

function frame(o: FieldLookOptions | undefined): ViewStyle {
  const flat = !!read(o?.readonly) || !!read(o?.disabled);
  return {
    borderRadius: radius.control,
    borderCurve: "continuous",
    borderWidth: 1,
    backgroundColor: colors.field,
    // Recessed while editable; a read-only or disabled field lies flat. Its edge is `fieldEdge`'s classes.
    ...(flat ? {} : finish.field),
  };
}

/**
 * The well around a field's input (and its prefix, suffix, icons): spread
 * it on the view holding them. Its states (`class`): a stronger edge under
 * the pointer (none while invalid, read-only or disabled), the focus edge
 * while the input in it has the keys; 50% while disabled.
 */
export function fieldLook(o?: FieldLookOptions) {
  return {
    get class(): string {
      return fieldEdge(o);
    },
    get style(): InputStyle {
      return { flexDirection: "row", alignItems: o?.multiline ? "flex-start" : "center", ...frame(o), ...read(o?.style) };
    },
    disabledStyle: { opacity: 0.5 } as ViewStyle,
  };
}

/** Options of `fieldText`. */
export interface FieldTextOptions {
  /** Read-only: the value in the muted color. */
  readonly?: boolean;
  /** Several lines: a least height and the padding above and below instead of a set height. */
  multiline?: boolean;
}

/**
 * An input's text in a field: the field's size and padding, the text color
 * (muted while read-only), a faint placeholder, the caret and selection in
 * the accent. Call it where the style is read, so it follows the theme.
 */
export function fieldText(o?: FieldTextOptions): InputStyle {
  const box = terminal
    ? o?.multiline
      ? { minHeight: 3 * TERMINAL_ROW, paddingTop: TERMINAL_ROW - 1, paddingBottom: TERMINAL_ROW - 1 }
      : { height: 3 * TERMINAL_ROW }
    : o?.multiline
      ? pointer
        ? { minHeight: fieldSize.height, paddingTop: 6, paddingBottom: 6 }
        : { minHeight: fieldSize.height, paddingTop: 13, paddingBottom: 13 }
      : { height: fieldSize.height };
  return {
    flex: 1,
    paddingHorizontal: fieldSize.pad,
    fontSize: fieldSize.font,
    color: o?.readonly ? colors.muted : colors.text,
    placeholderColor: colors.faint,
    caretColor: colors.accent,
    selectionColor: colors.accent,
    ...box,
  };
}

/**
 * A lone `<Input>`'s props (`<Input {...inputLook()} />`): the well and its
 * states (`fieldLook`) and the text in it (`fieldText`) on the input itself.
 */
export function inputLook(o?: FieldLookOptions) {
  const look = fieldLook(o);
  return {
    get class(): string {
      return look.class;
    },
    get style(): InputStyle {
      const text = fieldText({ readonly: !!read(o?.readonly), multiline: o?.multiline });
      return { ...frame(o), ...text, flex: undefined, ...read(o?.style) } as InputStyle;
    },
    disabledStyle: look.disabledStyle,
  };
}


/** The step buttons' feedback: lit under the pointer, darker while pressed, faded where a step does nothing. */
const press = terminal
  ? "justify-center disabled:opacity-35"
  : "items-center justify-center transition-colors duration-100 motion-reduce:transition-none enabled:hover:bg-accent active:bg-track disabled:opacity-35";

/**
 * A number input's parts as classes (`NumberInput`'s `class` and its
 * buttons'): `frame` the well (32 high with a pointer, 44 on a touch
 * screen; a stronger edge under the pointer, the focus edge while its field
 * edits), `stepBefore` / `stepAfter` − before the field and + after it,
 * `pair` / `pairButton` the increment over the decrement at the well's end.
 * `w` is a button's width class (`w-8`). In a terminal the input is one band
 * a row high, its steppers at the band's end.
 */
export const numberInputClasses = {
  frame: terminal
    ? "h-4 flex-row items-stretch bg-field pl-2 disabled:opacity-50"
    : [pointer ? "h-8 rounded-md" : "h-11 rounded-lg", "flex-row items-stretch overflow-hidden border bg-field", edgeClass({ rest: "border-input", hover: "border-faint", hoverVariant: "enabled:hover" })].join(" "),
  press,
  stepBefore: (w: string) => `${w} ${press} border-r border-line`,
  stepAfter: (w: string) => `${w} ${press} border-l border-line`,
  pair: (w: string) => `${w} border-l border-line`,
  pairButton: (top: boolean) => `flex-1 ${press}${top ? " border-b border-line" : ""}`,
};

/** A number input's field (`inputStyle`): the label size, tabular figures; at the end of a terminal's band, as a column of numbers reads. */
export function numberInputText(): InputStyle {
  return {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 8,
    fontSize: controlSize.label,
    color: colors.text,
    placeholderColor: colors.faint,
    fontVariant: ["tabular-nums"],
    ...(terminal ? { textAlign: "right" as const } : {}),
  };
}

/** A step button's text glyph in a terminal, which draws no icons. */
const STEP_GLYPHS = { plus: "+", minus: "−" } as const;

/** A step button's glyph: the icon in the muted text color; a terminal's text glyph. */
export function NumberStep(props: { name: "plus" | "minus" | "chevron-up" | "chevron-down"; size: number }) {
  if (terminal && (props.name === "plus" || props.name === "minus")) return <Text style={{ color: colors.muted }}>{STEP_GLYPHS[props.name]}</Text>;
  return <Icon name={props.name} size={props.size} tint={colors.muted} />;
}

/**
 * A number input's step buttons (spread them on `NumberInput`): − before
 * the field and + after it (`split`), or a pair of chevrons at the well's
 * end (`pair`); in a terminal always − and + at the band's end, each in a
 * slot of three Cells. `w` is a button's width class, `icon` its glyph's size.
 */
export function numberInputSteps(kind: "split" | "pair", w: string, icon: number) {
  if (terminal) {
    return {
      controlsRight: true,
      controlsClass: "flex-row",
      decrementButtonClass: `w-6 shrink-0 flex-row items-center ${press}`,
      incrementButtonClass: `w-6 shrink-0 flex-row items-center ${press}`,
      decrementButton: <NumberStep name="minus" size={icon} />,
      incrementButton: <NumberStep name="plus" size={icon} />,
    };
  }
  if (kind === "split") {
    return {
      decrementButtonClass: numberInputClasses.stepBefore(w),
      incrementButtonClass: numberInputClasses.stepAfter(w),
      decrementButton: <NumberStep name="minus" size={icon} />,
      incrementButton: <NumberStep name="plus" size={icon} />,
    };
  }
  return {
    controlsRight: true,
    controlsClass: numberInputClasses.pair(w),
    incrementButtonClass: numberInputClasses.pairButton(true),
    decrementButtonClass: numberInputClasses.pairButton(false),
    incrementButton: <NumberStep name="chevron-up" size={icon - 2} />,
    decrementButton: <NumberStep name="chevron-down" size={icon - 2} />,
  };
}

/** A time field's well (`DatePicker`'s `timeFieldClass`): a number input's, its segments inside. */
export const timeFieldClass = [pointer ? "h-8 rounded-md px-2" : "h-11 rounded-lg px-3", "items-center border bg-field", edgeClass({ rest: "border-input", hover: "border-faint", hoverVariant: "enabled:hover" })].join(" ");

/** The cells of a code of six: 36 × 44 with a pointer, 44 × 52 on a touch screen. */
export const otpCells = pointer ? "w-9 h-11 text-lg" : "w-11 h-13 text-xl";

/** Options of `otpCellLook`. */
export interface OtpCellOptions {
  /** A cell's size classes (`otpCells` by default; a PIN's are larger). */
  cells?: string;
  /** A verdict: every cell edged and tinted in its tone (or a function reading it). */
  tone?: Live<Tone | undefined>;
}

/**
 * A one-time code's cells (spread on `OtpInput`): wells that a digit (a
 * bullet too) lifts out of (`data-filled:`), the cell taking the next digit
 * edged in the accent while the code has the keys (the fields' focus edge),
 * a verdict's tone over all of them, every change fading; the caret a
 * rounded bar in the text color, blinking (the input's own). In a terminal a
 * cell is a framed box, its line only.
 */
export function otpCellLook(o?: OtpCellOptions) {
  const cells = o?.cells ?? otpCells;
  return {
    cellClass: terminal
      ? "w-10 h-12 items-center justify-center border border-line font-semibold text-foreground focus:border-brand disabled:opacity-50"
      : `${cells} items-center justify-center rounded-lg border border-line bg-inset font-semibold text-foreground data-filled:border-input data-filled:bg-card data-filled:focus:border-brand disabled:opacity-50 ${edgeClass({ rest: "", focus: "focus" })}`,
    get cellStyle(): ViewStyle {
      const tone = read(o?.tone);
      if (terminal) return tone ? { borderColor: toneColor(tone) } : {};
      return tone ? { ...finish.inset, backgroundColor: toneTint(tone), borderColor: toneColor(tone) } : finish.inset;
    },
    caretClass: "w-0.5 h-6 rounded-full",
    get caretStyle(): ViewStyle {
      return { backgroundColor: colors.text };
    },
  };
}
