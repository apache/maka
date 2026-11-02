---
title: DatePicker
description: "The DatePicker component: a date, a range of dates or a date and time picked from a calendar in a popup at its trigger on desktops and a sheet on phones, styled by the app."
group: base
demo: el-date-picker
---

# DatePicker

A date picker sets a date from a [Calendar](./calendar.md) that opens from the app's trigger: a due date, a birthday,
with `range` the days of a trip, with `timePrecision` a date and a time of day. Like [Select](./select.md), it opens as
each device expects:

- On the desktops and in desktop browsers, a popup at the trigger; opening it puts the keyboard on the days.
- On phones and tablets, a sheet at the bottom of the screen over a backdrop.

The picker owns the behavior: the value (the app's, or its own), the open state, the calendar, the time, the presets,
the keyboard and what screen readers hear. The look is the app's: it draws the trigger (with the value, a
placeholder, an icon) and styles the popup, the calendar's parts, the presets and the time field.

```rust tabs
use chrono::NaiveDate;
use nsh_base::{DateRangePreset, DateTime, PickedDate, date_picker, theme};
use nsh_core::prelude::*;

fn trip_dates() -> impl IntoElement {
    let trip = signal(DateTime::Range(None, None));
    let title = move || {
        trip.get()
            .format("%b %-d")
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Pick dates".to_string())
    };
    let day = |m, d| NaiveDate::from_ymd_opt(2026, m, d).unwrap();
    date_picker()
        .range(true)
        .number_of_months(2)
        .value(move || trip.get())
        .on_change(move |next: &PickedDate| trip.set(next.value))
        .presets(vec![
            DateRangePreset::range("This week", day(10, 25), day(10, 31)),
            DateRangePreset::range("Next week", day(11, 1), day(11, 7)),
        ])
        .accessibility_label("Trip")
        .offset(px(4.0))
        .popup_style(|s| {
            s.p_3()
                .rounded_lg()
                .border_1()
                .border_color(move || theme().border)
                .bg(move || theme().popover)
                .shadow_md()
        })
        .trigger(
            view()
                .h_9()
                .w_56()
                .px_3()
                .justify_center()
                .rounded_md()
                .border_1()
                .border_color(move || theme().input)
                .child(text(title)),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { DatePicker, type DatePickerValue } from "nsh/base";

function App() {
  const due = signal<DatePickerValue>(null);
  return (
    <DatePicker
      value={due()}
      onChange={({ value }) => due.set(value)}
      timePrecision="minute"
      cleanable
      clearButton={<Text>×</Text>}
      clearButtonAccessibilityLabel="Clear the due date"
      presets={[{ label: "Tomorrow 9:00", value: "2026-10-29T09:00" }]}
      accessibilityLabel="Due"
      offset={4}
      popupClass="rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"
      backdropClass="bg-black/40"
      contentClass="flex-row gap-3"
      presetClass="rounded-md px-2 py-1.5 text-sm hover:bg-accent"
      headerClass="flex-row items-center justify-between"
      rowClass="flex-row justify-between"
      itemClass="h-8 min-w-8 items-center justify-center rounded-md text-sm focus:ring-2 focus:ring-ring selected:bg-primary selected:text-primary-foreground disabled:opacity-50"
      timeClass="mt-2 gap-3"
      timeLabel={<Text class="text-sm">Time</Text>}
      timeAccessibilityLabel="Due time"
      timeFieldClass="flex-row rounded-md border border-input px-2 py-1"
      segmentClass="text-sm tabular-nums focus:bg-accent"
      trigger={
        <View class="h-9 w-56 justify-center rounded-md border border-input px-3 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <Text>{typeof due() === "string" ? (due() as string).replace("T", " ") : "Pick a date"}</Text>
        </View>
      }
    />
  );
}

mount(App);
```

`DatePicker` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `date_picker()`
makes one with a setter per prop (`.value(..)`, `.range(..)`, `.time_precision(..)`) and a listener per event
(`.on_change(..)`). Its value is a `DateTime` (`DateTime::Single`, `DateTime::Range`, from `chrono` dates or dates and
times); `onChange` gives a `PickedDate`, the value with the picker's time precision.

## Value

The value is in the forms of the HTML inputs: an ISO date, `"2026-10-28"`, as `<input type="date">`'s; with `range`
`[start, end]`; with `timePrecision` a date and time, `"2026-10-28T09:30"` (`"2026-10-28T09:30:15"` at seconds), as
`<input type="datetime-local">`'s; `null` is none. With `value`, the app owns it: the picker shows it and reports each
change with `onChange({ value })`; the app sets `value` to follow it. Left out, the picker keeps its own value, from
`defaultValue` at first.

- A single date: a press on a day sets the value and closes the popup.
- With `range`, the first press starts the range and the second ends it, as a [calendar's](./calendar.md#value); the
  complete range sets the value and closes the popup.
- With `timePrecision` (a single date only), a time field shows under the calendar and every edit of the time is
  reported. On the desktops, picking a day keeps the popup open for the time and reports the date with its time; a
  press on the selected day again closes the popup. On phones and tablets, a tap on a day picks it at its time and
  closes the sheet, as a single date does; the sheet opens again for the time. A day picked before any time gets
  `defaultTime` (default `00:00`). `hourCycle` is how the field counts the hours.

`cleanable` adds a clear button while there is a value: a press clears it (`onChange({ value: null })`). It comes
after the trigger, not inside it, so a press on it never opens the popup; the app places it and fills it
(`clearButton`), as a [select's clear button](./select.md#value).

## Presets

`presets` are buttons beside the calendar that set the value: "Today", "Last 7 days", "Tomorrow at 9". Each is
`{ label, value }`, `value` a date, a range or dates and times, kept as given; a press sets it and closes the popup.
`contentClass` lays out the presets' column and the calendar with the time (a row, `flex-row`); `presetsClass` styles
the column, `presetClass` each button.

## The calendar

Every prop of [Calendar](./calendar.md) but its value passes on to the picker's: `numberOfMonths`, `firstDayOfWeek`,
`disabledMatcher`, `yearRange`, `previousAccessibilityLabel`, `nextAccessibilityLabel`, the parts (`headerClass` to
`itemStyle`) and `renderItem`. `calendarClass` and `calendarStyle` style the calendar itself. Its views and keys are a
calendar's.

The time row (`timeClass`, `timeStyle`) holds `timeLabel`, the app's words for it ("Time"), at its start and the time
field (`timeFieldClass`, `timeFieldStyle`, `timeAccessibilityLabel`) at its end: a row with its items centered and
spread apart (`flex-row items-center justify-between`, as `gpui-component`'s). The field's segments are a
[TimeField](./time-field.md)'s (`segmentClass`, `separatorClass`, `renderSegment`).

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `DatePickerValue` | none | The value, owned by the app. |
| `defaultValue` | `.default_value(..)` | `DatePickerValue` | `null` | The value at first, without `value`. |
| `range` | `.range(..)` | `boolean` | `false` | Pick a range of dates. |
| `open`, `defaultOpen` | `.open(..)`, `.default_open(..)` | `boolean` | `false` | The open state, the app's or the picker's own. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | It stays closed and takes no presses or keyboard focus. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call it. |
| `dateFormat` | `.date_format(..)` | `string` | `"%Y/%m/%d"` and the time | How screen readers hear the value, in `chrono`'s format. |
| `timePrecision` | `.time_precision(..)` | `"minute" \| "second"` | none | Edit the time of day too, down to this. |
| `hourCycle` | `.hour_cycle(..)` | `"h23" \| "h12"` | `"h23"` | How the time field counts the hours. |
| `defaultTime` | `.default_time(..)` | `string` | `"00:00"` | The time a date gets before the user sets one. |
| `cleanable` | `.cleanable(..)` | `boolean` | `false` | A clear button while there is a value. |
| `presets` | `.presets(..)` | `DateRangePreset[]` | `[]` | Buttons in the popup that set the value. |
| `numberOfMonths`, `firstDayOfWeek`, `disabledMatcher`, `yearRange` | as `Calendar`'s | as `Calendar`'s | as `Calendar`'s | The calendar's months, weeks, disabled dates and years. |
| `previousAccessibilityLabel`, `nextAccessibilityLabel` | as `Calendar`'s | `string` | none | What screen readers say for the calendar's Previous and Next. |
| `placement`, `align`, `offset`, `margin` | `.placement(..)`, ... | as `Select`'s | `"bottom"`, `"start"`, 0, 0 | Desktops: where the popup goes against the trigger. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup (desktops) or the sheet (touch screens). |
| `backdropClass`, `backdropStyle` | `.backdrop_class(..)`, `.backdrop_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The backdrop behind the sheet. |
| `contentClass`, `contentStyle` | `.content_class(..)`, `.content_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup's content: the presets beside the calendar and the time. |
| `presetsClass`, `presetsStyle` | `.presets_class(..)`, `.presets_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The presets' column. |
| `presetClass`, `presetStyle` | `.preset_class(..)`, `.preset_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each preset's button. |
| `calendarClass`, `calendarStyle` | `.calendar_class(..)`, `.calendar_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The calendar. |
| `headerClass` … `itemStyle` | as `Calendar`'s | as `Calendar`'s | none | The calendar's header, body, months, rows and items. |
| `renderItem` | `.render_item(..)` | `(item: CalendarItemState) => JSX.Element` | none | Each item of the calendar, drawn by the app. |
| `timeClass`, `timeStyle` | `.time_class(..)`, `.time_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The time's row: its label at the start, the field at the end. |
| `timeLabel` | `.time_label(..)` | `JSX.Element` | none | What the time's row shows before the field. |
| `timeFieldClass`, `timeFieldStyle` | `.time_field_class(..)`, `.time_field_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The time field. |
| `timeAccessibilityLabel` | `.time_accessibility_label(..)` | `string` | none | What screen readers call the time field. |
| `segmentClass`, `segmentStyle`, `separatorClass`, `separatorStyle`, `renderSegment` | as `TimeField`'s | as `TimeField`'s | none | The time field's segments and `:`. |
| `clearButtonClass`, `clearButtonStyle` | `.clear_button_class(..)`, `.clear_button_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The clear button (`cleanable`). |
| `clearButton` | `.clear_button(..)` | `JSX.Element` | none | The content of the clear button. |
| `clearButtonAccessibilityLabel` | `.clear_button_accessibility_label(..)` | `string` | none | What screen readers call the clear button. |
| `trigger` | `.trigger(..)` | `JSX.Element` | none | What opens the popup when pressed; the popup is placed against it. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The view around the trigger. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | The value changed (a day, a range's end, a preset, the time, the clear button): `{ value }`. Set `value` to follow it. |
| `onOpenChange` | `.on_open_change(\|e\| ..)` | The popup opened or closed, with why (`{ open, reason }`). Set `open` to follow it. |
| `onOpen`, `onClose` | `.on_open(..)`, `.on_close(..)` | The popup is shown, or gone. |
| `onCancel` | `.on_cancel(..)` | The user closed the popup without a choice (Escape or back, a press outside or on the backdrop). |

## Parts

| Part | Where | Styled with |
|---|---|---|
| The trigger | the picker's view | the app's own element (`trigger`) |
| The clear button | the picker's view, after the trigger (`cleanable`, while there is a value) | `clearButtonClass`, `clearButtonStyle`; its content `clearButton` |
| The popup or sheet | over everything, at the trigger (desktops) or at the bottom (touch screens) | `popupClass`, `popupStyle` |
| The backdrop | behind the sheet (touch screens) | `backdropClass`, `backdropStyle` |
| The content | the popup | `contentClass`, `contentStyle` |
| The presets | the content, first (`presets`) | `presetsClass`, `presetsStyle`; each `presetClass`, `presetStyle` |
| The calendar | the content | `calendarClass`, `calendarStyle`, and [Calendar](./calendar.md#parts)'s parts |
| The time's row | under the calendar (`timePrecision`) | `timeClass`, `timeStyle`; its label `timeLabel` |
| The time field | the time's row | `timeFieldClass`, `timeFieldStyle`, and [TimeField](./time-field.md#parts)'s parts |

## Keyboard

| Key | Action |
|---|---|
| Return (on the trigger) | Opens the popup, or closes it. |
| Delete, Backspace (on the trigger) | Clears the value while the popup is closed. |
| Escape | Closes the popup without a choice. |

In the popup, the calendar's keys move between days and pick one (see [Keyboard](./calendar.md#keyboard)) and the
time field's edit the time (see [Keyboard](./time-field.md#keyboard)).

## Accessibility

- The trigger is a combobox for screen readers: its label is `accessibilityLabel`, its value the date as `dateFormat`
  writes it (by default `2026/10/28`, with the time at `timePrecision`), and it says whether the popup is expanded.
  `disabled` dims it.
- The calendar's days are buttons named by their ISO dates (see [Accessibility](./calendar.md#accessibility)); the
  presets are buttons named by their labels; the time field is named by `timeAccessibilityLabel`.
- The clear button is a button named by `clearButtonAccessibilityLabel`.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.
