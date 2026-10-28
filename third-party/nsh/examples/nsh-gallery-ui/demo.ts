import type { JSX as __JSX } from "nsh";
import { Text as __Text, View as __View } from "nsh";
import { platform as __platform, windowSize as __windowSize } from "nsh";
import { Segmented as GallerySegmented } from "./segmented";
import { ui, tint } from "./palette";
import { colors, finish, focusRing } from "./theme";
export { ui, tint } from "./palette";

/** A pressable under the pointer (`hoverStyle`): a whisper of the text
 * color over its surface, quieter than pressed and than selected. Leave it
 * off a disabled control. */
export const hoverFill = () => ({ backgroundColor: tint(ui().text, 0.05) });

/** The keyboard focus (`focusStyle`, `focus-visible:`): a 2-point ring of
 * `info` inside the view's edge, so a card's `overflow: hidden` and rounded
 * corners do not clip it. */
export { focusRing } from "./theme";

/** A pointer and a keyboard: desktop density and copy ("Click", "Tab to it
 * and press Space"); touch density and copy ("Tap") otherwise. */
export const desktop = __platform.idiom === "desktop";

/** A window wide enough for the desktop layout (the site's Desktop frame is
 * 1024 points): the subject on a stage, its state and options beside it. */
export const wide = () => __windowSize().width >= 700;

/** Heights and type of the idiom (Design Guides, "Density tiers"): compact
 * with a pointer, 44-point targets on a touch screen. */
export const size = desktop
  ? { control: 32, controlSm: 28, row: 40, rowSm: 32, label: 14, detail: 12 }
  : { control: 44, controlSm: 44, row: 52, rowSm: 44, label: 15, detail: 12 };

/** What a button looks like (`button`, `buttonText`): `primary` the one
 * emphasized commitment of a decision area, `accent` a lit fill (a counter's
 * increment, a toggled chip), `secondary` the ordinary visible action,
 * `ghost` a quiet toolbar or inline action, `danger` a destructive commit. */
export type ButtonKind = "primary" | "accent" | "secondary" | "ghost" | "danger";

/** Options of `button` and `buttonText` (the same object for both). */
export interface ButtonOptions {
  /** `sm`: the compact tier (28 points with a pointer, still 44 on a touch
   * screen). */
  size?: "md" | "sm";
  /** A chip that is on: it takes the accent fill, whatever the kind. */
  on?: boolean | (() => boolean);
  /** Where it sits in a column of a desktop layout (`alignSelf`): buttons
   * are as wide as their labels there, so the default is `flex-start`;
   * `stretch` fills the column. On a touch screen it fills the column. */
  align?: "flex-start" | "center" | "flex-end" | "stretch";
  /** More style (a margin, a width, a flex), over the button's. */
  style?: object | (() => object);
}

const __read = <T,>(v: T | (() => T)): T => (typeof v === "function" ? (v as () => T)() : v);
const __kind = (kind: ButtonKind, o?: ButtonOptions): ButtonKind => (__read<boolean | undefined>(o?.on) ? "accent" : kind);

/** A button's props (spread them: `<Button {...button("primary")}>`): its
 * style and its states, the same in every demo. Desktop density with a
 * pointer (28 points, 24 compact, radius 7, label 13); 40-point targets
 * (36 compact) and a radius of 10 on a touch screen. States: hover (a
 * raised button lightens, a ghost gets a fill, a filled one a touch of
 * transparency), pressed (a raised button sinks into an inner shade, a
 * filled one dims), keyboard focus (`focusRing()`, one ring for every
 * control) and disabled (opacity 0.4). Pair it with `buttonText` for the
 * label. */
export function button(kind: ButtonKind = "secondary", o?: ButtonOptions) {
  return {
    get style() {
      const k = __kind(kind, o);
      const fill = k === "primary" ? ui().primary : k === "accent" ? ui().accentFill : k === "secondary" ? ui().raised : k === "danger" ? { backgroundColor: ui().down, borderWidth: 1, borderColor: "rgba(0,0,0,0)" } : { borderWidth: 1, borderColor: "rgba(0,0,0,0)" };
      const compact = o?.size === "sm";
      return {
        ...fill,
        height: desktop ? (compact ? 24 : 28) : compact ? 36 : 40,
        paddingHorizontal: desktop ? (compact ? 8 : 12) : 16,
        borderRadius: desktop ? 7 : 10,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        transitionProperty: "background-color, border-color, box-shadow, opacity",
        transitionDuration: 120,
        ...(desktop ? { alignSelf: o?.align ?? ("flex-start" as const) } : o?.align ? { alignSelf: o.align } : {}),
        ...(__read<object | undefined>(o?.style) ?? {}),
      };
    },
    get hoverStyle() {
      const k = __kind(kind, o);
      return k === "ghost" ? hoverFill() : k === "secondary" ? finish.hover : { opacity: 0.94 };
    },
    get activeStyle() {
      return __kind(kind, o) === "secondary" ? finish.pressed : { opacity: 0.85 };
    },
    get focusStyle() {
      return focusRing();
    },
    disabledStyle: { opacity: 0.4 },
  };
}

/** The label of a `button` of the same kind and options. */
export function buttonText(kind: ButtonKind = "secondary", o?: ButtonOptions) {
  return {
    get color() {
      const k = __kind(kind, o);
      return k === "primary" ? ui().onPrimary : k === "accent" ? ui().onAccent : k === "danger" ? "#ffffff" : ui().text;
    },
    fontSize: desktop ? 13 : size.label,
    fontWeight: "500" as const,
  };
}

/** Options of `field`. */
export interface FieldOptions {
  /** The value fails its check: a border of `down`. */
  invalid?: boolean | (() => boolean);
  /** More style (a height for a multiline field, a margin), over the field's. */
  style?: object | (() => object);
}

/** A text field's props (spread them: `<Input {...field()} />`): a field
 * on the surface, a hair sunk, desktop density with a pointer (text 13,
 * radius 7, 28 points high), touch density otherwise (16, radius 10, about
 * 40). States: hover
 * (a stronger border), keyboard focus (`focusRing()`, as every control's),
 * invalid (a `down` border) and disabled (opacity 0.5). */
export function field(o?: FieldOptions) {
  return {
    get style() {
      return {
        backgroundColor: colors.field,
        borderWidth: 1,
        borderColor: colors.fieldBorder,
        ...finish.field,
        fontSize: desktop ? 13 : 16,
        color: ui().text,
        placeholderColor: ui().faint,
        borderRadius: desktop ? 7 : 10,
        paddingHorizontal: desktop ? 8 : 12,
        paddingVertical: desktop ? 5 : 9,
        ...(__read<boolean | undefined>(o?.invalid) ? { borderColor: ui().down } : {}),
        ...(__read<object | undefined>(o?.style) ?? {}),
      };
    },
    get hoverStyle() {
      return __read<boolean | undefined>(o?.invalid) ? {} : { borderColor: ui().faint };
    },
    get focusStyle() {
      return focusRing();
    },
    disabledStyle: { opacity: 0.5 },
  };
}

/** The subject in a wide window: a bordered stage that takes the room and
 * centers its content, at most `width` across (440). */
export function Stage(props: { children?: __JSX.Element; width?: number; gap?: number }) {
  return __View({
    get style() {
      return {
        flex: 1,
        minWidth: 0,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: ui().line,
        backgroundColor: tint(ui().text, 0.02),
        padding: 24,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      };
    },
    get children() {
      return __View({
        get style() {
          return { width: "100%" as const, maxWidth: props.width ?? 440, gap: props.gap ?? 14 };
        },
        get children() {
          return props.children;
        },
      });
    },
  });
}

/** The column beside a stage: the subject's state, its event log and the
 * options that tune it. */
export function Inspector(props: { children?: __JSX.Element }) {
  return __View({
    style: { width: 300, gap: 12 },
    get children() {
      return props.children;
    },
  });
}

/** The subject and its inspector: a stage beside an inspector column in a
 * wide window, one column `gap` apart otherwise (`grow`: the column fills
 * the page's height). */
export function Split(props: { children?: __JSX.Element; inspector?: __JSX.Element; gap?: number; width?: number; grow?: boolean }) {
  return __View({
    get style() {
      return wide() ? { flex: 1, flexDirection: "row" as const, gap: 16 } : { flex: props.grow ? 1 : undefined, gap: props.gap ?? 14 };
    },
    get children() {
      if (!wide()) return [props.children, props.inspector];
      return [
        Stage({
          get width() {
            return props.width;
          },
          get gap() {
            return props.gap;
          },
          get children() {
            return props.children;
          },
        }),
        Inspector({
          get children() {
            return props.inspector;
          },
        }),
      ];
    },
  });
}

/** A recessed panel of state under a small title (`grow`: it takes the
 * column's free height). */
export function Panel(props: { title: string; children?: __JSX.Element; minHeight?: number; grow?: boolean }) {
  const title = __Text({
    get style() {
      return { fontSize: 12, color: ui().muted };
    },
    get children() {
      return props.title;
    },
  });
  return __View({
    get style() {
      return { ...ui().inset, borderRadius: 12, padding: 12, gap: 4, minHeight: props.minHeight, flex: props.grow ? 1 : undefined };
    },
    get children() {
      return [title, props.children];
    },
  });
}

/** An event log, newest first: the newest line in the text color, older
 * ones faint. In a wide window it takes the inspector's free height. */
export function Log(props: { title: string; lines: string[]; minHeight?: number; grow?: boolean }) {
  return Panel({
    get title() {
      return props.title;
    },
    get minHeight() {
      return props.minHeight;
    },
    get grow() {
      return props.grow ?? wide();
    },
    get children() {
      return props.lines.map((line, i) =>
        __Text({
          get style() {
            return { fontSize: 12, color: i === 0 ? ui().text : ui().faint };
          },
          children: line,
        }),
      );
    },
  });
}

/** A labelled demo option row using the shared segmented control. */
export function Segmented<T extends string | number>(props: { label?: string; options: readonly T[]; value: T; onChange: (value: T) => void }) {
  return __View({
    style: { gap: 6 },
    get children() {
      return [
        props.label ? __Text({ style: { fontSize: 12, color: ui().muted }, children: props.label }) : null,
        GallerySegmented({
          get options() { return props.options.map((value) => ({ value: String(value), label: String(value) })); },
          get value() { return String(props.value); },
          onChange: (value) => props.onChange(props.options.find((option) => String(option) === value)!),
          size: desktop ? "small" : "regular",
        }),
      ];
    },
  });
}

export { dataTableClasses, dataTableFitPadding } from "./data-table";
export { sliderFill, sliderLook, sliderValueClass, sliderValueStyle, type SliderLookOptions } from "./slider";
