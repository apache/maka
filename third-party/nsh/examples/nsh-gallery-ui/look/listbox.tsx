// What lists of choices look like, shared by the gallery's select, combobox
// and date picker demos and the website's (through `demo.ts`): a trigger on
// the raised finish with a chevron that turns (a date picker's leads with a
// calendar instead), a popup that extends it (the raised finish again,
// corners of 10, 6 points of padding; a sheet on a touch screen), rows lit
// in the brand tint where the keys or the pointer are, the chosen one bolder
// with a check, sentence-case group headings, a search well, and the
// calendar's days, months and time segments after shadcn/ui's calendar.
import type { InputStyle, JSX, ViewStyle } from "nsh";
import { platform, reduceMotion, Text, View } from "nsh";
import type { CalendarEntry, SelectEntry, SelectGroup } from "nsh/base";
import { Icon, type IconName } from "../icons";
import { alpha, colors, finish, radius, terminal, TERMINAL_COLUMN, tints } from "../theme";
import { edgeClass, fieldSize, timeFieldClass } from "./field";
import { backdrop } from "./overlay";
import { controlSize, narrowWindow } from "./surface";

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
  "group rounded-[7px] border border-transparent transition-colors duration-100 motion-reduce:transition-none focus:border-brand/30 focus:bg-brand-tint active:opacity-70 disabled:opacity-50";

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
  /**
   * `field` (the default): a select's trigger as shadcn's, the input's well
   * (the field fill, the input's edge), so it lines up with the text fields
   * of its form (a date picker's and a color picker's too: in dark
   * shadcn's outline button is the input's fill and edge as well); `outline`:
   * an outline button on the raised finish, for a trigger that is not a
   * form's field.
   */
  kind?: "field" | "outline";
}

/**
 * A select's or date picker's trigger (spread it on the trigger's view): a
 * row as high as a text field, on the field's well (`kind: "field"`) or the
 * raised finish (`outline`), its edge stronger under the pointer and while
 * the list is open, the danger tone while invalid (each after the finish,
 * which has an edge of its own), the fields' focus edge while it has the
 * keys, sunk to 70% while pressed, 50% while disabled.
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
        ...(o?.kind === "outline" ? { backgroundColor: colors.raised, ...finish.raised } : { backgroundColor: colors.field, ...finish.field }),
        borderColor: invalid() ? colors.danger : read(o?.open) ? colors.faint : o?.kind === "outline" ? colors.border : colors.fieldBorder,
        ...(terminal ? {} : { outlineStyle: "solid", outlineWidth: 2, outlineOffset: -1, outlineColor: alpha(invalid() ? colors.danger : colors.accent, 0) }),
        // Dimmed while the select is: the app knows, as it passes `disabled`.
        opacity: read(o?.disabled) ? 0.5 : 1,
        transitionProperty: "border-color, outline-color, opacity",
        transitionDuration: reduceMotion() ? 0 : 120,
        ...read(o?.style),
      };
    },
    get hoverStyle(): ViewStyle | undefined {
      return read(o?.disabled) || invalid() ? undefined : { borderColor: colors.faint };
    },
    activeStyle: { opacity: 0.7 } as ViewStyle,
    // The border with the outline, which not every platform draws over it; `focus-visible` is above `hover` in the
    // states' order. Only for the keyboard: a click's focus, and the focus a closing list gives back, draw nothing.
    get focusVisibleStyle(): ViewStyle {
      const tone = invalid() ? colors.danger : colors.accent;
      return terminal ? { borderColor: tone } : { borderColor: tone, outlineColor: tone };
    },
    disabledStyle: { opacity: 0.5 } as ViewStyle,
  };
}

/** The props of `Picker`. */
export interface PickerProps {
  title: string;
  open: boolean;
  disabled?: boolean;
  /** The title stands in for a value (`"No due date"`): in the muted color, as shadcn's placeholders. */
  placeholder?: boolean;
  clearable?: boolean;
  invalid?: boolean;
  /** An icon before the title, in the muted color (none in the terminal). */
  icon?: IconName;
  lead?: JSX.Element;
  /** The chevron at the end (the default); a date picker's trigger has none, its calendar says what opens. */
  chevron?: boolean;
  /** `pickerLook`'s `kind`: the field's well (a select's, a date picker's: the default) or an outline button. */
  kind?: "field" | "outline";
  style?: ViewStyle;
}

/** The icon of a trigger: 16 points with a pointer (shadcn's `size-4`), 18 on a touch screen. */
const triggerIcon = pointer ? 16 : 18;

/**
 * A trigger (`Select`'s or `DatePicker`'s `trigger`): `pickerLook` with the
 * title (muted while it is a placeholder) and the chevron; `icon` and `lead`
 * go before the title (a calendar; a flag, a status's dot, faces). The
 * terminal's select draws its own `▾`.
 */
export function Picker(props: PickerProps) {
  return (
    <View
      {...pickerLook({
        open: () => props.open,
        disabled: () => !!props.disabled,
        invalid: () => !!props.invalid,
        clearable: () => !!props.clearable,
        kind: props.kind,
        style: () => props.style ?? {},
      })}
    >
      <If when={props.icon && !terminal}>
        <Icon name={props.icon!} size={triggerIcon} tint={colors.muted} />
      </If>
      {props.lead}
      <Text style={{ flex: 1, numberOfLines: 1, fontSize: fieldSize.font, color: props.placeholder ? colors.muted : colors.text }}>{props.title}</Text>
      <Chevron open={props.open} hidden={props.clearable || props.chevron === false || terminal} />
    </View>
  );
}

/**
 * A date picker's trigger (`DatePicker`'s `trigger`), shadcn's: `Picker`
 * led by a calendar in the muted color, the value in the text color or a
 * muted placeholder, and no chevron (a clear button goes over the end while
 * it has a value, `clearable`).
 */
export function DateTrigger(props: Omit<PickerProps, "icon" | "chevron" | "lead">) {
  return (
    <Picker
      title={props.title}
      open={props.open}
      disabled={props.disabled}
      placeholder={props.placeholder}
      clearable={props.clearable}
      invalid={props.invalid}
      icon="calendar"
      chevron={false}
      style={props.style}
    />
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
    clearButtonClass: "items-center justify-center rounded-full enabled:hover:bg-foreground/8 active:bg-track",
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
 * touch screen, 6 points above the rows; the text and a muted placeholder
 * as token classes, so they follow the theme.
 */
export function listboxSearch() {
  return {
    searchClass: `${pointer ? "text-sm" : "text-base"} text-foreground placeholder:text-muted-foreground`,
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
  /** The placeholder sums up the chosen values (`"Layout, iOS"`, `"2
   * people"`): drawn in the text color, as a value, rather than faint as
   * an empty field's prompt. */
  filled?: Live<boolean>;
}

/**
 * A combobox's field, shadcn's input group (spread it on `Combobox`): the
 * root draws the well, its edge stronger under the pointer and while the
 * list is open, the fields' focus edge while its input has the keys; the
 * input types inside it in the label size, the toggle (`ComboToggle`) at
 * its end. As wide as a select's trigger with a pointer, the row's on a
 * touch screen and in a narrow window (`narrowWindow`), where its row
 * puts it under the label (`plainRow`'s `wide`). A placeholder that sums up the chosen values (`filled`)
 * reads as a value, in the text color.
 */
export function comboboxLook(open: Live<boolean>, o?: ComboboxLookOptions) {
  return {
    get style(): ViewStyle {
      return {
        flexDirection: "row",
        alignItems: "center",
        // Narrower in a narrow window, beside a row's label (`RowLabel` keeps its own least width).
        ...(pointer && !narrowWindow() ? { width: 260, flexShrink: 1, minWidth: 160 } : { alignSelf: "stretch" }),
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
    get inputClass(): string {
      return `${pointer ? "text-sm" : "text-base"} text-foreground ${read(o?.filled) ? "placeholder:text-foreground" : "placeholder:text-muted-foreground"}`;
    },
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
/** The weekdays' initials in the terminal, one to its two-Cell column. */
const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
/** The weekdays over the days elsewhere, shadcn's two letters. */
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * A day's cell, shadcn's `--cell-size`: 32 with a pointer (the days, the
 * arrows and the header's height), 42 across a phone's sheet.
 */
const cell = pointer ? 32 : 42;
/** The gap between the months of a calendar of two (shadcn's `gap-4`). */
const monthGap = 16;
/** The gap over each week: rows of 36 with a pointer, as shadcn's Base UI calendar's (28-point cells, `mt-2`). */
const weekGap = 4;
/** The corners of the days, the arrows and the month view's items: the controls' (shadcn's `rounded-md`). */
const cellRadius = () => radius.control;
/**
 * The quiet fill of today, the hover, a range's band and the arrows' and
 * presets' hover (shadcn's `accent`): the text color at 8%, which stands
 * off the popup in both appearances as shadcn's does (the theme's `accent`
 * is all but the popup's own color in dark); `pressedFill` a step further.
 */
const quietFill = "bg-foreground/8";
const pressedFill = "bg-foreground/14";

/** The column of an ISO date in weeks that start on `firstDay` (`0` Sunday). */
function columnOf(date: string, firstDay: number) {
  const day = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))).getUTCDay();
  return (day - firstDay + 7) % 7;
}

/** Options of `CalendarItem`. */
export interface CalendarItemProps {
  item: CalendarEntry;
  /** Months side by side (`numberOfMonths`): each month's title over its month. */
  months?: number;
  /** The calendar's `firstDayOfWeek` (`0` Sunday, the default): a range's band rounds at its weeks' ends. */
  firstDayOfWeek?: number;
}

/**
 * An item of the calendar (`renderItem`), shadcn/ui's calendar: drawn once
 * from what it is, its states the item's classes. Previous and Next are
 * ghost buttons of a cell at the header's ends, lit in the quiet fill under
 * the pointer, at half opacity while they take no press; the month and
 * year toggles (or each month's title, with `months` over one) read
 * "November 2026" centered between them, the open view's toggle in the
 * brand color; the weekdays are two letters in the muted color. A day is a
 * square of a cell with the controls' corners: the quiet fill (shadcn's
 * `accent`) under the pointer and for today, `primary` with its foreground
 * for the selected date and a range's ends, the range's other days on a
 * band of the quiet fill from end to end (`data-range-*`) whose corners
 * round at the weeks' ends, the other months' days muted, the disabled ones
 * muted at half opacity, and the keyboard's day lit as a list's highlighted
 * row is (`optionClass`: the brand tint and edge), so Select, Combobox,
 * Command and the calendar move one kind of highlight.
 */
export function CalendarItem(props: CalendarItemProps) {
  const kind = props.item.kind;
  if (terminal) {
    // The terminal's calendar draws its days, years and arrows itself, on its grid of two-Cell columns: the
    // labels are plain text at their own size (the painter bands the open view's toggle, from its state).
    if (kind === "weekday") return <Text style={{ color: colors.faint }}>{WEEKDAY_INITIALS[props.item.value]}</Text>;
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
      <View
        class={`transition-colors duration-100 motion-reduce:transition-none group-hover:${quietFill} group-disabled:bg-transparent group-disabled:opacity-50`}
        // At its end of the header, which shares out what the items leave (`calendarLook.itemClass`'s `grow`).
        style={{ width: cell, height: cell, alignSelf: kind === "previous" ? "flex-start" : "flex-end", alignItems: "center", justifyContent: "center", borderRadius: cellRadius() }}
      >
        <View style={{ transform: [{ rotate: kind === "previous" ? "180deg" : "0deg" }] }}>
          <Icon name="chevron" size={triggerIcon} tint={colors.text} />
        </View>
      </View>
    );
  }
  if (kind === "monthToggle" || kind === "yearToggle") {
    // A month's title in a calendar of several takes no press: the month and its year, over the month. One month's
    // toggles are as wide as their words and grow alike with the arrows (`grow`), the month's name at the end of
    // its share and the year at the start of its: the two meet a word space apart, and "November 2026" is centered
    // between the arrows however wide the popup is.
    const title = kind === "monthToggle" && (props.months ?? 1) > 1;
    return (
      <Text
        class="text-foreground group-selected:text-brand"
        style={{
          minWidth: title ? 6 * cell + monthGap / 2 : undefined,
          paddingHorizontal: title ? 0 : 2,
          textAlign: title ? "center" : kind === "monthToggle" ? "right" : "left",
          fontSize: controlSize.label,
          fontWeight: "500",
        }}
      >
        {title ? `${MONTHS[props.item.value - 1]} ${props.item.year}` : kind === "monthToggle" ? MONTHS[props.item.value - 1] : String(props.item.value)}
      </Text>
    );
  }
  if (kind === "weekday") {
    return (
      <Text style={{ minWidth: cell, textAlign: "center", fontSize: pointer ? 12.8 : 13, color: colors.muted }}>{WEEKDAYS[props.item.value]}</Text>
    );
  }
  if (kind === "month" || kind === "year") {
    // The month view's months (rows of 3) and the year view's years (rows of 5), as wide as a month: ghost buttons
    // a week's gap apart, the shown one on `primary`.
    return (
      <View style={{ minWidth: (7 * cell) / (kind === "month" ? 3 : 5), paddingTop: weekGap, paddingHorizontal: 2 }}>
        <View
          class={`transition-colors duration-100 motion-reduce:transition-none group-hover:${quietFill} group-aria-selected:bg-primary group-disabled:opacity-50`}
          style={{ height: cell, alignItems: "center", justifyContent: "center", borderRadius: cellRadius() }}
        >
          <Text class="text-foreground group-aria-selected:text-primary-foreground" style={{ fontSize: controlSize.label }}>
            {kind === "month" ? MONTHS[props.item.value - 1].slice(0, 3) : String(props.item.value)}
          </Text>
        </View>
      </View>
    );
  }
  // A day, as wide as its column (the calendar's columns share its width), a week's gap over it. The band spans a
  // range's middle days and reaches from its ends' middles (a range of one day has none), rounded where a week
  // starts or ends. The square takes the quiet fill under the pointer and for today, `primary` for the selected
  // date and a range's ends (`aria-selected`, which ranks over the hover; a range's middle days keep the band). A
  // disabled day takes no hover fill, unless it is today. The keyboard's day takes the lists' highlight (the brand
  // tint and edge); on the selected day only the edge, over `primary`.
  const own = () => (props.item.outside ? "text-muted-foreground" : "text-foreground");
  const column = () => (props.item.date ? columnOf(props.item.date, props.firstDayOfWeek ?? 0) : -1);
  return (
    <View style={{ minWidth: cell, paddingTop: weekGap }}>
      <View style={{ height: cell, alignItems: "center", justifyContent: "center" }}>
        <View
          class={
            `absolute inset-y-0 left-0 right-0 hidden ${quietFill} group-data-range-middle:flex group-data-range-start:flex group-data-range-start:left-1/2 ` +
            "group-data-range-end:flex group-data-range-end:right-1/2 group-data-range-start:group-data-range-end:hidden"
          }
          style={{
            borderTopLeftRadius: column() === 0 ? cellRadius() : 0,
            borderBottomLeftRadius: column() === 0 ? cellRadius() : 0,
            borderTopRightRadius: column() === 6 ? cellRadius() : 0,
            borderBottomRightRadius: column() === 6 ? cellRadius() : 0,
          }}
        />
        <View
          class={
            `${props.item.today ? quietFill : "group-disabled:bg-transparent"} transition-colors duration-100 motion-reduce:transition-none ` +
            `group-hover:${quietFill} group-aria-selected:bg-primary group-data-range-middle:bg-transparent border border-transparent group-focus-visible:border-brand/30 group-focus-visible:bg-brand-tint group-aria-selected:group-focus-visible:bg-primary group-data-range-middle:group-focus-visible:bg-brand-tint`
          }
          style={{ width: cell, height: cell, borderRadius: cellRadius(), alignItems: "center", justifyContent: "center" }}
        >
          <Text
            class={
              `${own()} font-normal group-aria-selected:text-primary-foreground group-data-range-middle:${own()} ` +
              "group-disabled:text-muted-foreground group-disabled:opacity-50"
            }
            style={{ fontSize: pointer ? 14 : 16, fontVariant: ["tabular-nums"] }}
          >
            {String(props.item.value)}
          </Text>
        </View>
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
    <Text class="text-foreground group-focus:text-on-brand" style={{ paddingHorizontal: terminal ? 3 : 2, fontSize: controlSize.label, fontVariant: ["tabular-nums"] }}>
      {props.label}
    </Text>
  );
}

/**
 * The calendar's parts, besides its popup: `itemClass` its items (pressed
 * at 70%, `group` for what they draw), `segmentClass` the time's segments
 * (filled while they have the keys), the popup's layout (`content`: the
 * presets beside the calendar with a pointer, above it on a phone), the
 * presets' column of ghost buttons or chips, the header's gap over the
 * weekdays (shadcn's `gap-4`), the calendar's padding (with the popup's,
 * shadcn's `p-3`), the time's row under a hairline, its well
 * (`timeFieldClass`, the number inputs'), the time's `:` in the muted
 * color, and `cell` / `monthGap`, a day's side and the gap between two
 * months. The terminal keeps its own grid.
 */
export const calendarLook = {
  cell,
  monthGap,
  // `grow`: the header's arrows and toggles share out what their content leaves alike (the days' columns share the
  // width already), which keeps the title centered between the arrows at their ends.
  itemClass: terminal ? "group active:opacity-70" : "group grow active:opacity-70",
  segmentClass: "group rounded-[4px] active:opacity-70 focus:bg-brand-fill",
  timeFieldClass,
  content: terminal ? { flexDirection: "row" as const, gap: 10 } : pointer ? { flexDirection: "row" as const, gap: 6 } : { gap: 12 },
  get presets(): ViewStyle {
    if (terminal) return { gap: 2, minWidth: 110, paddingRight: 10, borderRightWidth: 1, borderColor: colors.border };
    // With a pointer a column of small ghost buttons beside the calendar, its first level with the header, parted
    // from the calendar by a hairline that holds in dark too.
    return pointer
      ? { gap: 2, paddingTop: 8, paddingRight: 8, borderRightWidth: 1, borderColor: alpha(colors.text, 0.1) }
      : { flexDirection: "row", flexWrap: "wrap", gap: 6 };
  },
  get preset() {
    if (terminal) return { height: 28, paddingHorizontal: 8, borderRadius: radius.control, justifyContent: "center" as const, fontSize: 13, color: colors.text };
    return pointer
      ? { height: 28, paddingHorizontal: 10, borderRadius: radius.control, justifyContent: "center" as const, fontSize: 13, color: colors.text }
      : { height: 34, paddingHorizontal: 12, borderRadius: 17, borderWidth: 1, borderColor: colors.border, justifyContent: "center" as const, fontSize: 14, color: colors.text };
  },
  presetClass: terminal ? "enabled:hover:bg-accent active:opacity-70" : `transition-colors duration-100 motion-reduce:transition-none enabled:hover:${quietFill} enabled:active:${pressedFill}`,
  header: { marginBottom: terminal ? 4 : pointer ? 12 : 8 },
  calendar: terminal ? { padding: 4 } : pointer ? { padding: 6 } : {},
  get time(): ViewStyle {
    if (terminal) return { gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderColor: colors.border, paddingHorizontal: 4 };
    // Under the calendar's last week, as far from the hairline as the calendar's padding is from the popup's edge.
    return { gap: 10, marginTop: pointer ? 6 : 12, paddingTop: 12, borderTopWidth: 1, borderColor: alpha(colors.text, 0.1), ...(pointer ? { paddingHorizontal: 6, paddingBottom: 6 } : {}) };
  },
  get separator() {
    // Tight to the digits, as a time input's: the segments' padding is the room on each side.
    return terminal ? { color: colors.faint, fontSize: controlSize.label } : { color: colors.muted, fontSize: controlSize.label, marginHorizontal: -1 };
  },
};

/** Options of `datePickerLook`. */
export interface DatePickerLookOptions {
  /** Months side by side (`numberOfMonths`), or a function reading it: each month's title over its month. */
  months?: Live<number>;
  /** The picker's `firstDayOfWeek` (`0` Sunday, the default), or a function reading it: the range's band rounds at its weeks' ends. */
  firstDayOfWeek?: Live<number>;
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
    renderItem: (item: CalendarEntry) => <CalendarItem item={item} months={read(o?.months)} firstDayOfWeek={read(o?.firstDayOfWeek)} />,
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
