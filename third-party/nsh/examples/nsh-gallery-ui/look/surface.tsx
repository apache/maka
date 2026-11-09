// What sections, wells and rows look like, shared by the gallery's `Card`,
// its control demos' rows and the website's demos (through `demo.ts`): one
// flat surface per section, a sunk well inside it, and rows whose hover fill
// reaches past their content.
import type { ViewStyle } from "nsh";
import { platform, Text, token, View } from "nsh";
import { colors, finish, focusRing, radius, terminal, TERMINAL_COLUMN, TERMINAL_GAP, TERMINAL_ROW } from "../theme";

const pointer = platform.desktop;

/** A value, or a function reading it where the look is applied (a signal). */
type Live<T> = T | (() => T);

const read = <T,>(v: Live<T> | undefined): T | undefined => (typeof v === "function" ? (v as () => T)() : v);

/**
 * The page's density: compact with a pointer (desktops), roomier on a touch
 * screen. Section titles, surfaces, rows and their padding take these, so a
 * demo's sections read the same on every page.
 */
export const density = pointer
  ? { title: 13, note: 12, body: 13, row: 36, pad: 14, gap: 12, surface: 10 }
  : { title: 13, note: 13, body: 15, row: 48, pad: 16, gap: 12, surface: 16 };

/**
 * The sizes of a list of controls (a settings list, a filter, a plan
 * picker): a pointer's compact tier (40-point rows, 14-point labels,
 * 16-point boxes), a touch screen's (rows of at least 44 points, a finger's
 * target, 15-point labels, 22-point boxes). The terminal's rows are one Cell
 * row each, an indicator's box three Cells wide for its glyph (`[x]`).
 * `row` is a pressable row's least height, `line` a row of values', `tabs`
 * a tab strip's, `control` a checkbox's or radio's side, `check` its mark's
 * and an icon's size, `dot` a radio's dot, `corner` a box's corners, `clear`
 * a clear button's side, `switch` the switch size beside a row's label.
 */
export const controlSize = terminal
  ? { row: TERMINAL_ROW, padding: 0, gap: TERMINAL_COLUMN, label: 14, detail: 12, control: 3 * TERMINAL_COLUMN, corner: 0, check: 12, dot: 6, tabs: TERMINAL_ROW, line: TERMINAL_ROW, clear: 2 * TERMINAL_COLUMN, switch: "small" as const }
  : pointer
    ? { row: 40, padding: 6, gap: 10, label: 14, detail: 12, control: 16, corner: 5, check: 12, dot: 6, tabs: 30, line: 32, clear: 16, switch: "small" as const }
    : { row: 44, padding: 8, gap: 12, label: 15, detail: 13, control: 22, corner: 7, check: 16, dot: 8, tabs: 40, line: 44, clear: 20, switch: "regular" as const };

/** Options of `sectionSurface`. */
export interface SectionSurfaceOptions {
  /** Padded as a `Card`'s content (`density.pad`: 14 with a pointer, 16 on
   * a touch screen): rows (`listRow`) need it, their hover fill reaching
   * into it. Space other content with a `gap` (`density.gap`). */
  padded?: boolean;
}

/**
 * The flat surface a section's content sits on (the gallery's `Card`): the
 * card color, one hairline edge, no shadow, corners of `density.surface`
 * (10 with a pointer, 16 on a touch screen). In the terminal a border whose
 * row and column on each side the padding fills out, so the content starts
 * one Cell inside it. Spread it into a view's `style`, then add the layout
 * (`overflow: "hidden"` for content that reaches its edges).
 */
export function sectionSurface(o?: SectionSurfaceOptions): ViewStyle {
  if (terminal) {
    return { borderWidth: 1, borderColor: colors.border, paddingVertical: TERMINAL_ROW - 1, paddingHorizontal: 2 * TERMINAL_COLUMN - 1 };
  }
  return {
    backgroundColor: colors.surface,
    borderRadius: density.surface,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: colors.border,
    ...(o?.padded ? { padding: density.pad } : {}),
  };
}

/**
 * A well inside a section (a preview, a panel of state, an image's frame):
 * the inset color a hair below the card, its hairline and inner shade, the
 * theme's `radius` corners (10).
 */
export function insetSurface(): ViewStyle {
  return { backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line, borderRadius: radius.inset, borderCurve: "continuous", ...finish.inset };
}

/** How far a row's hover fill reaches past its content on each side, and its
 * corners: none in the terminal, where a negative margin rounds away but
 * the padding stays a column, pushing the label in. */
export const ROW_BLEED = terminal ? 0 : 8;

/** Options of `plainRow`. */
export interface PlainRowOptions {
  /** The first row of its list: no hairline above it. */
  first?: boolean;
  /** A row of values (`controlSize.line` high, no padding) rather than a control's. */
  dense?: boolean;
}

/**
 * A row of a list that takes no presses (a section's values, a row holding
 * a field): its items on one line, centered, a hairline above all but the
 * first (none in the terminal, whose rows are one row each).
 */
export function plainRow(o?: PlainRowOptions): ViewStyle {
  return {
    minHeight: o?.dense ? controlSize.line : controlSize.row,
    flexDirection: "row",
    alignItems: "center",
    gap: controlSize.gap,
    paddingVertical: o?.dense ? 0 : controlSize.padding,
    borderTopWidth: o?.first || terminal ? 0 : 1,
    borderTopColor: colors.line,
  };
}

/** Options of `listRow`. */
export interface ListRowOptions {
  /** The first row of its list: no `RowDivider` above it, so no room for one. */
  first?: boolean;
  /** More room before the content (a child row under a "Select all"). */
  start?: number;
  /** No hover; dimmed to 40% (`disabledStyle`). Pass the same value to the control's `disabled`. */
  disabled?: Live<boolean | undefined>;
  /** More style (`flexDirection: "row-reverse"` for a switch at the trailing edge, `alignItems`), over the row's. */
  style?: Live<ViewStyle | undefined>;
}

/** The props `listRow` gives a pressable row. */
export interface ListRowLook {
  readonly style: ViewStyle;
  readonly hoverStyle: ViewStyle | undefined;
  readonly activeStyle: ViewStyle;
  readonly focusStyle: ViewStyle;
  readonly disabledStyle: ViewStyle;
}

/**
 * A row that is a control (a `Switch`, `Checkbox`, `Radio` or an accordion's
 * trigger, its label included): spread it (`<Checkbox {...listRow()}>`).
 * At least `controlSize.row` high (40 with a pointer, 44 on a touch screen),
 * its items on one line. Under the pointer the theme's `accent` fills it,
 * reaching `ROW_BLEED` (8) past the content on both sides with rounded
 * corners, so the content stays where the section's padding puts it: put
 * rows on a padded surface (`sectionSurface({ padded: true })`). Pressed it
 * dims to 70%, natively; keyboard focus is `focusRing()`; disabled, 40% and
 * no hover. The hairline above a row that is not the first is a
 * `RowDivider` among its children; the point it takes stays in the padding,
 * so nothing moves.
 */
export function listRow(o?: ListRowOptions): ListRowLook {
  return {
    get style(): ViewStyle {
      return {
        minHeight: controlSize.row,
        flexDirection: "row",
        alignItems: "center",
        gap: controlSize.gap,
        paddingVertical: controlSize.padding,
        paddingTop: controlSize.padding + (o?.first || terminal ? 0 : 1),
        marginHorizontal: -ROW_BLEED,
        paddingStart: ROW_BLEED + (o?.start ?? 0),
        paddingEnd: ROW_BLEED,
        borderRadius: ROW_BLEED,
        ...(read(o?.style) ?? {}),
      };
    },
    get hoverStyle(): ViewStyle | undefined {
      return read(o?.disabled) ? undefined : { backgroundColor: token("accent") };
    },
    activeStyle: { opacity: 0.7 },
    get focusStyle(): ViewStyle {
      return focusRing();
    },
    disabledStyle: { opacity: 0.4 },
  };
}

/**
 * The hairline above a `listRow` that is not the first, among its children:
 * as long as the row's content, inset `ROW_BLEED` from the hover fill's
 * edge on both sides (none in the terminal, whose rows are one row each).
 */
export function RowDivider(props: { show: boolean }) {
  return (
    <If when={props.show && !terminal}>
      <View style={{ pointerEvents: "none", position: "absolute", top: 0, left: ROW_BLEED, right: ROW_BLEED, height: 1, backgroundColor: colors.line }} />
    </If>
  );
}

/** The terminal's labels' column, so the details after them line up. */
export const LABEL_WIDTH = 16 * TERMINAL_COLUMN;
/**
 * The least a label keeps, with a pointer, beside a wide control (a
 * combobox, a select), which gives way first in a narrow window. A touch
 * screen's controls take their content's width, so the label takes the rest.
 */
const LABEL_MIN = 96;
/** The least a terminal's detail keeps beside its label: narrower, it wraps under it. */
const DETAIL_WIDTH = 24 * TERMINAL_COLUMN;

/** A terminal's name column for `names`: the longest of them (at least `LABEL_WIDTH`), so the details after it line up. */
export const labelColumn = (names: readonly string[]) => Math.max(LABEL_WIDTH, ...names.map((n) => n.length * TERMINAL_COLUMN));

/**
 * A row's label and a quieter line under it (after it in the terminal):
 * `controlSize.label` in the text color, regular weight (`strong`: 600, the
 * row that leads others, as a "Select all"), the detail 12 points with a
 * pointer, 13 on a touch screen, muted, on one line. `width`: the
 * terminal's label column (`labelColumn`).
 */
export function RowLabel(props: { label: string; detail?: string; strong?: boolean; width?: number }) {
  return (
    // A terminal's gap is in the label's column: a row's gaps give first
    // when its detail wraps, which would move the details off their column.
    <View style={terminal ? { flex: 1, flexDirection: "row", flexWrap: "wrap" } : { flex: 1, minWidth: pointer ? LABEL_MIN : undefined, gap: 2 }}>
      <Text
        style={{
          minWidth: terminal ? (props.width ?? LABEL_WIDTH) + TERMINAL_GAP : undefined,
          flexShrink: 0,
          fontSize: controlSize.label,
          fontWeight: props.strong ? "600" : "400",
          color: colors.text,
        }}
      >
        {props.label}
      </Text>
      <If when={props.detail}>
        {/* Beside the label in a terminal, it wraps rather than lose its end to `…`;
            with less than DETAIL_WIDTH beside it, it goes under the label, as on a phone. */}
        <Text
          style={{
            numberOfLines: terminal ? undefined : 1,
            flexShrink: 1,
            ...(terminal ? { flexGrow: 1, flexBasis: DETAIL_WIDTH } : {}),
            fontSize: controlSize.detail,
            color: colors.muted,
          }}
        >
          {props.detail}
        </Text>
      </If>
    </View>
  );
}
