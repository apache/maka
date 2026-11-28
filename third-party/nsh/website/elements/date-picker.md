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

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { DatePicker, type DatePickerValue } from "nsh/base";
import { Window } from "nsh/desktop";

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
      itemClass="h-8 min-w-8 items-center justify-center rounded-md text-sm focus-visible:ring-2 focus-visible:ring-ring selected:bg-primary selected:text-primary-foreground disabled:opacity-50"
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

mount(() => (
  <Window id="main">
    <App />
  </Window>
));
```

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

`DatePicker` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `date_picker()`
makes one with a setter per prop (`.value(..)`, `.range(..)`, `.time_precision(..)`) and a listener per event
(`.on_change(..)`). Its value is a `DateTime` (`DateTime::Single`, `DateTime::Range`, from `chrono` dates or dates and
times); `onChange` gives a `PickedDate`, the value with the picker's time precision.

## Value

The value is in the forms of the HTML inputs:

- A date is an ISO date, `"2026-10-28"`, as in `<input type="date">`.
- With `range`, it is `[start, end]`.
- With `timePrecision`, it is a date and time, `"2026-10-28T09:30"` (`"2026-10-28T09:30:15"` at seconds), as in
  `<input type="datetime-local">`.
- `null` is none.

With `value`, the app owns it: the picker shows it and reports each
change with `onChange({ value })`; the app sets `value` to follow it. Left out, the picker keeps its own value, from
`defaultValue` at first.

- A single date: a press on a day sets the value and closes the popup.
- With `range`, the first press starts the range and the second ends it, as a [calendar's](./calendar.md#value); the
  complete range sets the value and closes the popup. `onChangeStart({ value })` reports the start, `[start, null]`,
  while the popup stays open for the end. A start that you don't set as `value` is dropped when the popup closes; one
  that you set stays, so the popup opens on it again and the next press ends the range, as in a [calendar that keeps its
  start](./calendar.md#value).
- With `timePrecision` (a single date only), a time field shows under the calendar and every edit of the time is
  reported. On the desktops, picking a day keeps the popup open for the time and reports the date with its time; a
  press on the selected day again closes the popup. On phones and tablets, a tap on a day picks it at its time and
  closes the sheet, as a single date does; the sheet opens again for the time. An app that keeps the sheet open on a
  pick (see [Apply and Cancel](#apply-and-cancel)) has the time set in the same sheet. A day picked before any time
  gets `defaultTime` (default `00:00`). `hourCycle` is how the field counts the hours, as
  [TimeField](./time-field.md)'s, the user's included.

`cleanable` adds a clear button while there is a value: a press clears it (`onChange({ value: null })`). It comes
after the trigger, not inside it, so a press on it never opens the popup; the app places it and fills it
(`clearButton`), as a [select's clear button](./select.md#value).

## Presets

`presets` are buttons beside the calendar that set the value: "Today", "Last 7 days", "Tomorrow at 9". Each is
`{ label, value, description }`, `value` a date, a range or dates and times, kept as given; a press sets it and closes
the popup. `description` is an optional second line under the label, such as the dates a preset stands for ("Last
month" over "Sep 1 – Sep 30"). `contentClass` lays out the presets' column and the calendar with the time (a row,
`flex-row`); `presetsClass` styles the column, `presetClass` each button, and `presetDescriptionClass` each
description, which takes the button's text styles until its own class changes them (a smaller, muted line). The
button stacks the two lines in a column; a `presetClass` with `flex` makes it a row, so add `flex-col` with it
(`flex flex-col gap-0.5`).

```tsx
<DatePicker
  range
  presets={[
    { label: "Last month", value: ["2026-09-01", "2026-09-30"], description: "Sep 1 – Sep 30" },
    { label: "This month", value: ["2026-10-01", "2026-10-31"], description: "Oct 1 – Oct 31" },
  ]}
  presetClass="rounded-md px-2 py-1.5 text-sm hover:bg-accent"
  presetDescriptionClass="text-xs text-muted-foreground"
  trigger={<Text>Pick a range</Text>}
/>
```

## Apply and Cancel

Many pickers commit on Apply: the user picks, adjusts, and only Apply sets the value, while Cancel leaves it as it
was. `header` and `footer` are the app's content in the popup (the sheet on touch screens), above the presets
and the calendar and below them and the time: typed start and end fields, a title, Cancel and Apply. Their keyboard
stops come before the calendar's and after it.

A complete pick (a day, a range's end, a preset) is reported with `onChange`, then asks to close the popup with
`onOpenChange({ open: false, reason: "select" })`. With `open` controlled, the app keeps the popup open by not
following a `"select"`: it holds the pick as a pending value and commits it from its `footer`, closing the popup
through `open`. Escape, a press outside and the backdrop still ask to close it, with `onCancel`.

`value` is then the pending value: the calendar, the clear button and what screen readers hear on the trigger follow
it, while the trigger's content shows the applied one. The clear button and Delete on the trigger clear the value while
the popup is closed, with no Apply to press, so `onChange` commits a change made while it is closed at once.

A range's first press is reported with `onChangeStart({ value })`, `[start, null]`, and asks for no close: keep it as
the pending value, so the calendar keeps showing the start and Apply has no complete range to commit yet. Enable Apply
only while the pending value is complete, as below.

```tsx
function Stay() {
  const stay = signal<DatePickerValue>(null);
  const pending = signal<DatePickerValue>(null);
  const open = signal(false);
  const complete = () => {
    const value = pending();
    return Array.isArray(value) && value[0] !== null && value[1] !== null;
  };
  const discard = () => {
    pending.set(stay());
    open.set(false);
  };
  return (
    <DatePicker
      range
      cleanable
      value={pending()}
      onChange={({ value }) => {
        pending.set(value);
        // The clear button and Delete act while it is closed.
        if (!open()) stay.set(value);
      }}
      onChangeStart={({ value }) => pending.set(value)}
      open={open()}
      onOpenChange={({ open: next, reason }) => {
        // A pick stays pending until Apply.
        if (reason === "select") return;
        next ? open.set(true) : discard();
      }}
      header={<Text class="text-sm font-medium">Stay</Text>}
      footer={
        <View class="flex-row justify-end gap-2 pt-2">
          <Button onPress={discard}>
            <Text>Cancel</Text>
          </Button>
          <Button
            disabled={!complete()}
            onPress={() => {
              stay.set(pending());
              open.set(false);
            }}
          >
            <Text>Apply</Text>
          </Button>
        </View>
      }
      trigger={<DateTrigger value={stay()} />}
    />
  );
}
```

## The calendar

Every prop of [Calendar](./calendar.md) but its value passes on to the picker's: `numberOfMonths`, `firstDayOfWeek`,
`disabledMatcher`, `yearRange`, `previousAccessibilityLabel`, `nextAccessibilityLabel`, the parts (`headerClass` to
`itemStyle`) and `renderItem`. `calendarClass` and `calendarStyle` style the calendar itself. Its views and keys are a
calendar's.

The time row (`timeClass`, `timeStyle`) holds `timeLabel`, the app's words for it ("Time"), at its start and the time
field (`timeFieldClass`, `timeFieldStyle`, `timeAccessibilityLabel`) at its end: a row with its items centered and
spread apart (`flex-row items-center justify-between`, as `gpui-component`'s). The field's segments are a
[TimeField](./time-field.md)'s (`segmentClass`, `separatorClass`, `renderSegment`).

## Entrance and exit

On the desktops the popup comes and goes with your transitions, as a [Popover](./popover.md#entrance-and-exit)'s:
`popupStartingClass` is its look in its first frame, and the `transition-*` classes of `popupClass` carry it to its own
look; `popupEndingClass` is its look once closed, which it keeps, taking no presses, while those transitions run, and
`onClose` follows. The keyboard focus is back on the trigger as it closes (on macOS and iOS, where it was before it opened,
when a pointer opened it), unless the choice's `onChange` focused another view (the next field of a form), which keeps it. Opened again on its way out, it returns to its look from where
it is. `popupStartingStyle` and `popupEndingStyle` do the same with inline styles. When the user asks for less motion it
appears and goes at once; the sheet of touch screens slides in and out on its own.

```tsx
<DatePicker
  popupClass="rounded-lg bg-popover p-3 shadow-md transition-all duration-150 ease-out"
  popupStartingClass="opacity-0 -translate-y-1"
  popupEndingClass="opacity-0"
  trigger={<DateTrigger />}
/>
```

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
| `timePrecision` | `.time_precision(..)` | `"minute" \| "second"` | none | Edit the time of day too, down to this; on touch screens a tap on a day closes the sheet. |
| `hourCycle` | `.hour_cycle(..)` | `"h23" \| "h12"` | `"h23"` | How the time field counts the hours. |
| `defaultTime` | `.default_time(..)` | `string` | `"00:00"` | The time a date gets before the user sets one. |
| `cleanable` | `.cleanable(..)` | `boolean` | `false` | A clear button while there is a value. |
| `presets` | `.presets(..)` | `DateRangePreset[]` | `[]` | Buttons in the popup that set the value. |
| `numberOfMonths`, `firstDayOfWeek`, `disabledMatcher`, `yearRange` | as `Calendar`'s | as `Calendar`'s | as `Calendar`'s | The calendar's months, weeks, disabled dates and years. |
| `previousAccessibilityLabel`, `nextAccessibilityLabel` | as `Calendar`'s | `string` | none | What screen readers say for the calendar's Previous and Next. |
| `placement`, `align`, `offset`, `margin` | `.placement(..)`, ... | as `Select`'s | `"bottom"`, `"start"`, 0, 0 | Desktops: where the popup goes against the trigger. |
| `popupClass`, `popupStyle` | `.popup_class(..)`, `.popup_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup (desktops) or the sheet (touch screens). |
| `popupStartingClass`, `popupStartingStyle` | `.popup_starting_class(..)`, `.popup_starting_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Desktops: the popup's look in its first frame, over its own: its transitions run from it. |
| `popupEndingClass`, `popupEndingStyle` | `.popup_ending_class(..)`, `.popup_ending_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Desktops: the popup's look once closed, over its own: it stays while its transitions run. |
| `backdropClass`, `backdropStyle` | `.backdrop_class(..)`, `.backdrop_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The backdrop behind the sheet. |
| `contentClass`, `contentStyle` | `.content_class(..)`, `.content_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The popup's content: the presets beside the calendar and the time. |
| `presetsClass`, `presetsStyle` | `.presets_class(..)`, `.presets_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The presets' column. |
| `presetClass`, `presetStyle` | `.preset_class(..)`, `.preset_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each preset's button. |
| `presetDescriptionClass`, `presetDescriptionStyle` | `.preset_description_class(..)`, `.preset_description_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each preset's description, its second line. |
| `calendarClass`, `calendarStyle` | `.calendar_class(..)`, `.calendar_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The calendar. |
| `headerClass` … `itemStyle` | as `Calendar`'s | as `Calendar`'s | none | The calendar's header, body, months, rows and items. |
| `renderItem` | `.render_item(..)` | `(item: CalendarEntry) => JSX.Element` | none | Each item of the calendar, drawn by the app from what it is; its states are the items' classes, as `Calendar`'s. |
| `timeClass`, `timeStyle` | `.time_class(..)`, `.time_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The time's row: its label at the start, the field at the end. |
| `timeLabel` | `.time_label(..)` | `JSX.Element` | none | What the time's row shows before the field. |
| `timeFieldClass`, `timeFieldStyle` | `.time_field_class(..)`, `.time_field_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The time field. |
| `timeAccessibilityLabel` | `.time_accessibility_label(..)` | `string` | none | What screen readers call the time field. |
| `segmentClass`, `segmentStyle`, `separatorClass`, `separatorStyle`, `renderSegment` | as `TimeField`'s | as `TimeField`'s | none | The time field's segments and `:`. |
| `clearButtonClass`, `clearButtonStyle` | `.clear_button_class(..)`, `.clear_button_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The clear button (`cleanable`). |
| `clearButton` | `.clear_button(..)` | `JSX.Element` | none | The content of the clear button. |
| `clearButtonAccessibilityLabel` | `.clear_button_accessibility_label(..)` | `string` | none | What screen readers call the clear button. |
| `trigger` | `.trigger(..)` | `JSX.Element` | none | What opens the popup when pressed; the popup is placed against it. |
| `header` | `.header(..)` | `JSX.Element` | none | What the popup shows above the presets and the calendar (`headerClass` styles the calendar's header, not this). |
| `footer` | `.footer(..)` | `JSX.Element` | none | What the popup shows below the presets, the calendar and the time: Cancel, Apply. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The view around the trigger. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | The value changed (a day, a range's end, a preset, the time, the clear button): `{ value }`. Set `value` to follow it. |
| `onChangeStart` | `.on_change_start(\|value\| ..)` | With `range`, the user started a range in the popup: `{ value }`, `[start, null]`. The popup stays open for the end, which `onChange` reports. |
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
| The popup's header | the popup, first (`header`) | the app's own element |
| The content | the popup | `contentClass`, `contentStyle` |
| The presets | the content, first (`presets`) | `presetsClass`, `presetsStyle`; each `presetClass`, `presetStyle` |
| A preset's description | its button, under the label (`description`) | `presetDescriptionClass`, `presetDescriptionStyle` |
| The calendar | the content | `calendarClass`, `calendarStyle`, and [Calendar](./calendar.md#parts)'s parts |
| The time's row | under the calendar (`timePrecision`) | `timeClass`, `timeStyle`; its label `timeLabel` |
| The time field | the time's row | `timeFieldClass`, `timeFieldStyle`, and [TimeField](./time-field.md#parts)'s parts |
| The popup's footer | the popup, last (`footer`) | the app's own element |

## Keyboard

| Key | Action |
|---|---|
| Return (on the trigger) | Opens the popup, or closes it. |
| Delete, Backspace (on the trigger) | Clears the value while the popup is closed. |
| Escape | Closes the popup without a choice. |

In the popup, the calendar's keys move between days and pick one (see [Keyboard](./calendar.md#keyboard)) and the
time field's edit the time (see [Keyboard](./time-field.md#keyboard)). Tab goes through `header`'s controls, the
calendar, the time and `footer`'s controls, in that order.

## Accessibility

- The trigger is a combobox for screen readers: its label is `accessibilityLabel`, its value the date as `dateFormat`
  writes it (by default `2026/10/28`, with the time at `timePrecision`), and it says whether the popup is expanded.
  `disabled` dims it.
- The calendar's days are buttons named by their ISO dates (see [Accessibility](./calendar.md#accessibility)); the
  presets are buttons named by their labels, which screen readers follow with their descriptions; the time field is
  named by `timeAccessibilityLabel`.
- The clear button is a button named by `clearButtonAccessibilityLabel`.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.
