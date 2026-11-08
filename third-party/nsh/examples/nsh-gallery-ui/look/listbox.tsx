// What lists of choices look like, shared by the gallery's select, combobox
// and date picker demos and the website's (through `demo.ts`): a trigger on
// the raised finish with a chevron that turns, a popup that extends it (the
// raised finish again, corners of 10, 6 points of padding; a sheet on a touch
// screen), rows lit in the brand tint where the keys or the pointer are, the
// chosen one bolder with a check, sentence-case group headings, a search
// well, and the calendar's days, months and time segments.
import type { InputStyle, JSX, ViewStyle } from "nsh";
import { platform, reduceMotion, Text, View, windowSize } from "nsh";
import type { CalendarEntry, SelectEntry, SelectGroup } from "nsh/base";
import { Icon } from "../icons";
import { alpha, colors, finish, radius, terminal, TERMINAL_COLUMN, tints } from "../theme";
import { edgeClass, timeFieldClass } from "./field";
import { backdrop } from "./overlay";
import { controlSize } from "./surface";

const pointer = platform.desktop;

/** A value, or a function reading it where the look is applied (a signal). */
type Live<T> = T | (() => T);

const read = <T,>(v: Live<T> | undefined): T | undefined => (typeof v === "function" ? (v as () => T)() : v);

/** Options of `listboxPopup` and `listboxProps`. */
export interface ListboxPopupOptions {
  /** With a pointer, at least this wide (the titles whole); a sheet spans the window anyway. */
  minWidth?: number;
}

/**
 * The list's surface: with a pointer a popup at the trigger that extends
 * it (the raised finish, corners of 10, 6 points of padding); on a touch
 * screen a sheet at the bottom, its top corners rounded, at most 70% of the
 * window high.
 */
export function listboxPopup(o?: ListboxPopupOptions): ViewStyle {
  return pointer
    ? { backgroundColor: colors.raised, borderRadius: radius.inset, borderWidth: 1, borderColor: colors.border, padding: 6, ...finish.raised, ...(o?.minWidth ? { minWidth: o.minWidth } : {}) }
    : { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 34, maxHeight: "70%" };
}

/**
 * A row of the list, its look on the row (`itemClass`): lit in the brand
 * tint while highlighted (`focus:`, the keys or the pointer on it), the fill
 * and edge fading between rows as the highlight moves, dimmed while
 * disabled. Every state is the row's class (`group`), so the list draws a
 * row's content once per item and the highlight moves without drawing.
 */
export const optionClass =
  "group rounded-[7px] border border-transparent transition-colors duration-100 motion-reduce:transition-none focus:border-brand/30 focus:bg-brand-tint active:opacity-70 disabled:opacity-35";

/**
 * What a select's or combobox's list takes besides its items (spread it):
 * 4 points from the trigger, 8 from the window's edges, the popup or sheet,
 * the scrim behind a sheet, the rows' look.
 */
export function listboxProps(o?: ListboxPopupOptions) {
  return {
    offset: 4,
    margin: 8,
    get popupStyle() {
      return listboxPopup(o);
    },
    get backdropStyle() {
      return backdrop();
    },
    itemClass: optionClass,
  };
}

/**
 * The chevron of a trigger: its icon box takes only the room of its stroke
 * (half the box) in the row, so it turns about its own center; it points
 * down, and up while the list is open.
 */
export function Chevron(props: { open: boolean; hidden?: boolean }) {
  return (
    <View
      class="transition-transform duration-150 motion-reduce:transition-none"
      style={{ display: props.hidden ? "none" : "flex", marginHorizontal: -controlSize.check / 4, transform: [{ rotate: props.open ? "-90deg" : "90deg" }] }}
    >
      <Icon name="chevron" size={controlSize.check} tint={colors.muted} />
    </View>
  );
}

/** The clear button's inset from a trigger's end: centered where the chevron's lane is. The button is in the
 * select's view, outside the trigger, so its inset counts the trigger's 1-point border too. */
const clearInset = 1 + 10 + controlSize.check / 4 - controlSize.clear / 2;

/** Options of `pickerLook`. */
export interface PickerLookOptions {
  /** The list is open: the edge stays lit. */
  open?: Live<boolean>;
  /** Dimmed, and no hover (the select is disabled, not the trigger's view). */
  disabled?: Live<boolean>;
  /** Edged in the danger tone, its focus edge too. */
  invalid?: Live<boolean>;
  /** A clear button lies over the end in place of the chevron: room for it. */
  clearable?: Live<boolean>;
  /** Layout over the look (a width), or a function reading it. */
  style?: Live<ViewStyle>;
}

/**
 * A select's or date picker's trigger (spread it on the trigger's view): a
 * row on the raised finish, its edge stronger under the pointer and while
 * the list is open, the danger tone while invalid (each after the finish,
 * which has an edge of its own), the fields' focus edge while it has the
 * keys, sunk to 70% while pressed, 40% while disabled.
 */
export function pickerLook(o?: PickerLookOptions) {
  const invalid = () => !!read(o?.invalid);
  return {
    get style(): ViewStyle {
      const clearable = !!read(o?.clearable);
      return {
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        height: controlSize.line,
        // Room for the list's rows, which are as wide as the trigger.
        minWidth: pointer ? 180 : undefined,
        // With a pointer its title truncates before a row's label is squeezed.
        flexShrink: pointer ? 1 : undefined,
        paddingLeft: 10,
        // Room for the clear button, which goes over the trigger's end in place of the chevron. In the terminal the
        // select's own marks go over the end, each in a slot of three Cells: ` ▾ `, or ` ×  ▾ `.
        paddingRight: terminal ? (clearable ? 6 : 3) * TERMINAL_COLUMN : clearable ? clearInset + controlSize.clear + 8 : 10,
        borderRadius: radius.control,
        borderWidth: 1,
        backgroundColor: colors.raised,
        ...finish.raised,
        borderColor: invalid() ? colors.danger : read(o?.open) ? colors.faint : colors.border,
        ...(terminal ? {} : { outlineStyle: "solid", outlineWidth: 2, outlineOffset: -1, outlineColor: alpha(invalid() ? colors.danger : colors.accent, 0) }),
        // Dimmed while the select is: the app knows, as it passes `disabled`.
        opacity: read(o?.disabled) ? 0.4 : 1,
        transitionProperty: "border-color, outline-color, opacity",
        transitionDuration: reduceMotion() ? 0 : 120,
        ...read(o?.style),
      };
    },
    get hoverStyle(): ViewStyle | undefined {
      return read(o?.disabled) || invalid() ? undefined : { borderColor: colors.faint };
    },
    activeStyle: { opacity: 0.7 } as ViewStyle,
    // The border with the outline, which not every platform draws over it; `focus` is above `hover` in the states' order.
    get focusStyle(): ViewStyle {
      const tone = invalid() ? colors.danger : colors.accent;
      return terminal ? { borderColor: tone } : { borderColor: tone, outlineColor: tone };
    },
    disabledStyle: { opacity: 0.4 } as ViewStyle,
  };
}

/**
 * A trigger (`Select`'s or `DatePicker`'s `trigger`): `pickerLook` with the
 * title (faint while it is a placeholder) and the chevron; `lead` goes before
 * the title (a flag, a status's dot, faces). The terminal's select draws its
 * own `▾`.
 */
export function Picker(props: {
  title: string;
  open: boolean;
  disabled?: boolean;
  placeholder?: boolean;
  clearable?: boolean;
  invalid?: boolean;
  lead?: JSX.Element;
  style?: ViewStyle;
}) {
  return (
    <View
      {...pickerLook({
        open: () => props.open,
        disabled: () => !!props.disabled,
        invalid: () => !!props.invalid,
        clearable: () => !!props.clearable,
        style: () => props.style ?? {},
      })}
    >
      {props.lead}
      <Text style={{ flex: 1, numberOfLines: 1, fontSize: controlSize.label, color: props.placeholder ? colors.faint : colors.text }}>{props.title}</Text>
      <Chevron open={props.open} hidden={props.clearable || terminal} />
    </View>
  );
}

/** Options of `clearButtonLook`. */
export interface ClearButtonOptions {
  /** Over a `Picker`'s end, where its chevron was (a select's, a date picker's); in the row otherwise (a combobox's). */
  over?: boolean;
}

/**
 * A clear button's look (spread it with `cleanable` and the app's
 * `clearButtonAccessibilityLabel`): a round target lit under the pointer, an
 * × in the muted color (a terminal's text ×, set after the value).
 */
export function clearButtonLook(o?: ClearButtonOptions) {
  return {
    clearButtonClass: "items-center justify-center rounded-full enabled:hover:bg-accent active:bg-track",
    clearButtonStyle: terminal
      ? undefined
      : o?.over
        ? { position: "absolute" as const, top: (controlSize.line - controlSize.clear) / 2, right: clearInset, width: controlSize.clear, height: controlSize.clear }
        : { width: controlSize.clear, height: controlSize.clear },
    get clearButton() {
      return terminal ? <Text style={{ color: colors.muted }}>×</Text> : <Icon name="close" size={controlSize.clear - 6} tint={colors.muted} />;
    },
  };
}

/**
 * A row's content (`renderItem`): the title, bolder with a check while
 * chosen (`group-selected:`); `lead` before it (a flag, a dot, a face, an
 * icon), `detail` under it, `note` after it.
 */
export function OptionRow(props: { item: SelectEntry; note?: string; lead?: JSX.Element; detail?: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        // The row's 1-point border on each side.
        height: props.detail ? (pointer ? 38 : 52) : pointer ? 30 : 44,
        // With its border and the popup's padding, the trigger's inset: a select's chosen row lies over the trigger, title on title.
        paddingHorizontal: pointer ? 3 : 7,
      }}
    >
      {props.lead}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text class="font-normal group-selected:font-semibold" style={{ numberOfLines: 1, fontSize: 14, color: colors.text }}>
          {props.item.title}
        </Text>
        <If when={props.detail}>
          <Text style={{ numberOfLines: 1, fontSize: 12, color: colors.muted }}>{props.detail}</Text>
        </If>
      </View>
      <If when={props.note}>
        <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.note}</Text>
      </If>
      <View class="opacity-0 group-selected:opacity-100" style={{ width: 16, alignItems: "center" }}>
        <Icon name="check" size={14} tint={colors.accent} />
      </View>
    </View>
  );
}

/** A group's heading in a list (`renderGroup`): quiet, in sentence case. */
export function ListboxHeader(props: { group: SelectGroup }) {
  return <Text style={{ fontSize: 12, fontWeight: "600", color: colors.muted, paddingHorizontal: 9, paddingTop: 8, paddingBottom: 4 }}>{props.group.title}</Text>;
}

/** What a list shows while its search matches nothing (`empty`). */
export function ListboxEmpty(props: { label: string }) {
  return <Text style={{ paddingVertical: 20, textAlign: "center", fontSize: 14, color: colors.muted }}>{props.label}</Text>;
}

/** A list's footer under a hairline (`footerStyle`), and its text. */
export const listboxFooter = {
  get style(): ViewStyle {
    return { marginTop: 6, paddingTop: 6, paddingHorizontal: terminal ? 0 : 9, borderTopWidth: 1, borderColor: colors.border };
  },
  get text() {
    return { fontSize: 12, color: colors.muted };
  },
};

/**
 * The search well at the top of a list (spread it on a searchable
 * `Select`): the field color in a recess, 32 high with a pointer, 40 on a
 * touch screen, 6 points above the rows; the text and a faint placeholder
 * as token classes, so they follow the theme.
 */
export function listboxSearch() {
  return {
    searchClass: `${pointer ? "text-sm" : "text-base"} text-foreground placeholder:text-faint`,
    get searchStyle(): ViewStyle {
      return {
        height: pointer ? 32 : 40,
        paddingHorizontal: 9,
        marginBottom: 6,
        borderRadius: radius.control,
        borderWidth: 1,
        backgroundColor: colors.field,
        ...finish.field,
        borderColor: colors.fieldBorder,
      };
    },
  };
}

/** Options of `comboboxLook`. */
export interface ComboboxLookOptions {
  /** Layout over the look, or a function reading it. */
  style?: Live<ViewStyle>;
}

/**
 * A combobox's field, shadcn's input group (spread it on `Combobox`): the
 * root draws the well, its edge stronger under the pointer and while the
 * list is open, the fields' focus edge while its input has the keys; the
 * input types inside it in the label size, the toggle (`ComboToggle`) at
 * its end. As wide as a select's trigger with a pointer, the row's on a
 * touch screen.
 */
export function comboboxLook(open: Live<boolean>, o?: ComboboxLookOptions) {
  return {
    get style(): ViewStyle {
      return {
        flexDirection: "row",
        alignItems: "center",
        // Narrower in a narrow window, beside a row's label (`RowLabel` keeps its own least width).
        ...(pointer ? { width: 260, flexShrink: 1, minWidth: 160 } : { alignSelf: "stretch" }),
        minHeight: controlSize.line,
        paddingLeft: 10,
        paddingRight: 4,
        borderRadius: radius.control,
        borderWidth: 1,
        backgroundColor: colors.field,
        ...finish.field,
        ...read(o?.style),
      };
    },
    // The edge's states are classes, the fields' (`edgeClass`): the focus edge over the hover's.
    get class(): string {
      return edgeClass({ rest: read(open) ? "border-faint" : "border-input", hover: "border-faint" });
    },
    inputClass: `${pointer ? "text-sm" : "text-base"} text-foreground placeholder:text-faint`,
    get inputStyle(): InputStyle {
      return { flex: 1, minWidth: 40, height: controlSize.line - 2 };
    },
  };
}

/** A combobox's toggle (`triggerButton`): the chevron in a square that lights under the pointer. */
export function ComboToggle(props: { open: boolean; id?: string }) {
  return (
    <View testID={props.id} style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 6 }} hoverStyle={{ backgroundColor: colors.track }}>
      <Chevron open={props.open} />
    </View>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** A day's cell: seven across the popup with a pointer, across a phone's sheet otherwise. */
const cell = pointer ? 30 : 42;
/** The gap between the months of a calendar of two. */
const monthGap = 16;
/**
 * On a touch screen the calendar spans the sheet (the window less the
 * sheet's padding), its columns sharing it: the header's titles split what
 * Previous and Next leave, so the month and the year meet in the middle,
 * and each month's title of two is over its month.
 */
const toggleWidth = () => Math.floor((windowSize().width - 2 * 10) / 2 - cell);

/**
 * An item of the calendar (`renderItem`), drawn once from what it is, its
 * states the item's classes: Previous and Next as chevrons (faint while they
 * take no press), the month and year toggles (or each month's title, with
 * `months` over one) by name, the open view's toggle in the accent, the
 * weekdays' initials, and the days: today on the theme's quiet `accent`
 * fill, the selected date and a range's ends on the accent's, the days of a
 * complete range on a band from end to end (`data-range-*`), the other
 * months' days and the disabled ones faint, the keyboard's day ringed.
 */
export function CalendarItem(props: { item: CalendarEntry; months?: number }) {
  const kind = props.item.kind;
  if (terminal) {
    // The terminal's calendar draws its days, years and arrows itself, on its grid of two-Cell columns: the
    // labels are plain text at their own size (the painter bands the open view's toggle, from its state).
    if (kind === "weekday") return <Text style={{ color: colors.faint }}>{WEEKDAYS[props.item.value]}</Text>;
    if (kind === "month") return <Text>{MONTHS[props.item.value - 1].slice(0, 3)}</Text>;
    const title = kind === "monthToggle" && (props.months ?? 1) > 1;
    return (
      <Text style={{ fontWeight: "600" }}>
        {title ? `${MONTHS[props.item.value - 1]} ${props.item.year}` : kind === "monthToggle" ? MONTHS[props.item.value - 1] : String(props.item.value)}
      </Text>
    );
  }
  if (kind === "previous" || kind === "next") {
    return (
      <View class="group-disabled:opacity-30" style={{ width: cell, height: cell, alignItems: "center", justifyContent: "center" }}>
        <View style={{ transform: [{ rotate: kind === "previous" ? "180deg" : "0deg" }] }}>
          <Icon name="chevron" size={controlSize.check} tint={colors.muted} />
        </View>
      </View>
    );
  }
  if (kind === "monthToggle" || kind === "yearToggle") {
    // A month's title in a calendar of several takes no press: the month and its year, over the month.
    const title = kind === "monthToggle" && (props.months ?? 1) > 1;
    return (
      <Text
        class="text-foreground group-selected:text-brand"
        style={{
          width: !pointer ? toggleWidth() : title ? 6 * cell + monthGap / 2 : kind === "monthToggle" ? 3 * cell : 2 * cell,
          paddingHorizontal: 3,
          textAlign: title ? "center" : kind === "monthToggle" ? "right" : "left",
          fontSize: controlSize.label,
          fontWeight: "600",
        }}
      >
        {title ? `${MONTHS[props.item.value - 1]} ${props.item.year}` : kind === "monthToggle" ? MONTHS[props.item.value - 1] : String(props.item.value)}
      </Text>
    );
  }
  if (kind === "weekday") {
    return <Text style={{ minWidth: cell, paddingVertical: 4, textAlign: "center", fontSize: 11, fontWeight: "600", color: colors.faint }}>{WEEKDAYS[props.item.value]}</Text>;
  }
  if (kind === "month" || kind === "year") {
    // The month view's months (rows of 3) and the year view's years (rows of 5), as wide as a month; the shown one
    // filled.
    return (
      <View
        class="group-selected:bg-brand-fill"
        style={{ minWidth: (7 * cell) / (kind === "month" ? 3 : 5), height: cell + 6, alignItems: "center", justifyContent: "center", borderRadius: radius.control }}
      >
        <Text class="text-foreground group-selected:text-on-brand" style={{ fontSize: controlSize.label }}>
          {kind === "month" ? MONTHS[props.item.value - 1].slice(0, 3) : String(props.item.value)}
        </Text>
      </View>
    );
  }
  // A day, as wide as its column (the calendar's columns share its width). The band spans a range's middle days
  // and reaches from its ends' middles; a range of one day has none. The circle fills for the selected date and a
  // range's ends (not its middle days), else for today.
  const own = props.item.outside ? "text-faint" : "text-foreground";
  return (
    <View style={{ minWidth: cell, height: cell, alignItems: "center", justifyContent: "center" }}>
      <View
        class={
          "absolute inset-y-0.5 left-0 right-0 hidden group-data-range-middle:flex group-data-range-start:flex group-data-range-start:left-1/2 " +
          "group-data-range-end:flex group-data-range-end:right-1/2 group-data-range-start:group-data-range-end:hidden"
        }
        style={{ backgroundColor: tints.accent }}
      />
      <View
        class={`${props.item.today ? "bg-accent" : ""} border-[1.5px] border-transparent group-focus:border-brand group-selected:bg-brand-fill group-data-range-middle:bg-transparent`}
        style={{ width: cell - 4, height: cell - 4, borderRadius: (cell - 4) / 2, alignItems: "center", justifyContent: "center" }}
      >
        <Text
          class={
            `${own} ${props.item.today ? "font-semibold" : "font-normal"} group-selected:font-semibold group-selected:text-on-brand ` +
            `group-data-range-middle:${own} group-disabled:text-faint group-disabled:opacity-50`
          }
          style={{ fontSize: pointer ? 13 : 15, fontVariant: ["tabular-nums"] }}
        >
          {String(props.item.value)}
        </Text>
      </View>
    </View>
  );
}

/**
 * A time segment's digits or AM / PM (`renderSegment`), in the color on
 * the fill while it has the keys (`group-focus:`), so moving between the
 * segments draws nothing.
 */
export function TimeSegment(props: { label: string }) {
  return (
    <Text class="text-foreground group-focus:text-on-brand" style={{ paddingHorizontal: 3, fontSize: controlSize.label, fontVariant: ["tabular-nums"] }}>
      {props.label}
    </Text>
  );
}

/**
 * The calendar's parts, besides its popup: `itemClass` its items (pressed
 * at 70%, `group` for what they draw), `segmentClass` the time's segments
 * (filled while they have the keys), the popup's layout (`content`: the
 * presets beside the calendar with a pointer, above it on a phone), the
 * presets' column or chips, the header's gap, the calendar's padding, the
 * time's row under a hairline, its well (`timeFieldClass`, the number
 * inputs'), and `cell` / `monthGap`, a day's side and the gap between two
 * months.
 */
export const calendarLook = {
  cell,
  monthGap,
  itemClass: "group active:opacity-70",
  segmentClass: "group rounded-[4px] active:opacity-70 focus:bg-brand-fill",
  timeFieldClass,
  content: pointer ? { flexDirection: "row" as const, gap: 10 } : { gap: 12 },
  get presets(): ViewStyle {
    return pointer
      ? { gap: 2, minWidth: 110, paddingRight: 10, borderRightWidth: 1, borderColor: colors.border }
      : { flexDirection: "row", flexWrap: "wrap", gap: 6 };
  },
  get preset() {
    return pointer
      ? { height: 28, paddingHorizontal: 8, borderRadius: radius.control, justifyContent: "center" as const, fontSize: 13, color: colors.text }
      : { height: 34, paddingHorizontal: 12, borderRadius: 17, borderWidth: 1, borderColor: colors.border, justifyContent: "center" as const, fontSize: 14, color: colors.text };
  },
  presetClass: "enabled:hover:bg-accent active:opacity-70",
  header: { marginBottom: 4 },
  calendar: pointer ? { padding: 4 } : {},
  get time(): ViewStyle {
    return { gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderColor: colors.border, ...(pointer ? { paddingHorizontal: 4 } : {}) };
  },
  get separator() {
    return { color: colors.faint, fontSize: controlSize.label };
  },
};

/** Options of `datePickerLook`. */
export interface DatePickerLookOptions {
  /** Months side by side (`numberOfMonths`), or a function reading it: each month's title over its month. */
  months?: Live<number>;
}

/**
 * What a `DatePicker` takes besides its value and trigger (spread it): the
 * list's popup or sheet and scrim, the calendar's padding, header and
 * items (`CalendarItem`), the presets and the time's row, segments and
 * well. Parts a picker does not show (presets, the time) are unused.
 */
export function datePickerLook(o?: DatePickerLookOptions) {
  return {
    offset: 4,
    margin: 8,
    get popupStyle() {
      return listboxPopup();
    },
    get backdropStyle() {
      return backdrop();
    },
    contentStyle: calendarLook.content,
    get presetsStyle() {
      return calendarLook.presets;
    },
    get presetStyle() {
      return calendarLook.preset;
    },
    presetClass: calendarLook.presetClass,
    calendarStyle: calendarLook.calendar,
    headerStyle: calendarLook.header,
    bodyStyle: terminal ? undefined : { gap: monthGap },
    itemClass: calendarLook.itemClass,
    renderItem: (item: CalendarEntry) => <CalendarItem item={item} months={read(o?.months)} />,
    get timeStyle() {
      return calendarLook.time;
    },
    timeFieldClass,
    segmentClass: calendarLook.segmentClass,
    get separatorStyle() {
      return calendarLook.separator;
    },
    renderSegment: (segment: { label: string }) => <TimeSegment label={segment.label} />,
  };
}
