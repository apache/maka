---
title: Calendar
description: "The Calendar component: a date or a range of dates picked from months of days, with month and year views and the keyboard, styled by the app."
group: base
demo: el-date-picker
---

# Calendar

A calendar picks a date, or with `range` a range of dates, from months of days laid out in weeks: a due date in a
form, the nights of a stay, the days of a report. It shows one month or several side by side, turns the months with
Previous and Next, and switches to a view of the year's months or a page of years to go far. It is the calendar in
[DatePicker](./date-picker.md)'s popup, on its own in the page.

The calendar owns the behavior: the value (the app's, or its own), the shown month, the views, the days that cannot
be picked, the keyboard and what screen readers hear. The look is the app's: it styles the header, the body, each
month, each row and each item, and draws the items' content (the months' and weekdays' names, today's mark, the
range's band). The grid fills the width it is given, as a table's columns do: the months share it and the items of a
row share the row equally, so a calendar in a phone's sheet spans the screen and one in a popup sized to its content
keeps its items' widths (`flex-none` in `itemClass` or `monthClass` keeps an item or a month at its own width).

```rust tabs
use nsh_base::{CalendarEntry, CalendarItemKind, Date, Matcher, calendar};
use nsh_core::prelude::*;

const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS: [&str; 7] = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

fn due_date() -> impl IntoElement {
    let due = signal(Date::default());
    calendar()
        .value(move || due.get())
        .on_change(move |next: &Date| due.set(*next))
        .disabled_matcher(Matcher::DayOfWeek(vec![0, 6]))
        .previous_accessibility_label("Previous month")
        .next_accessibility_label("Next month")
        .item_class("rounded-md selected:bg-primary selected:text-primary-foreground disabled:opacity-50")
        .render_item(|item: &CalendarEntry| {
            let label = match item.kind {
                CalendarItemKind::Previous => "‹".to_string(),
                CalendarItemKind::Next => "›".to_string(),
                CalendarItemKind::Weekday => WEEKDAYS[item.value as usize].to_string(),
                CalendarItemKind::MonthToggle | CalendarItemKind::Month => {
                    MONTHS[item.value as usize - 1].to_string()
                }
                _ => item.value.to_string(),
            };
            view()
                .w_8()
                .h_8()
                .items_center()
                .justify_center()
                .child(text(label).text_sm())
        })
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Calendar, type CalendarValue } from "nsh/base";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function App() {
  const due = signal<CalendarValue>(null);
  return (
    <Calendar
      value={due()}
      onChange={({ value }) => due.set(value)}
      disabledMatcher={[0, 6]}
      previousAccessibilityLabel="Previous month"
      nextAccessibilityLabel="Next month"
      class="w-72 gap-2 rounded-lg border border-border p-3"
      headerClass="flex-row items-center justify-between"
      rowClass="flex-row justify-between"
      itemClass="group h-8 min-w-8 items-center justify-center rounded-md text-sm focus:ring-2 focus:ring-ring selected:bg-primary selected:text-primary-foreground data-range-middle:rounded-none data-range-middle:bg-accent data-range-middle:text-accent-foreground data-outside:text-muted-foreground disabled:opacity-50"
      renderItem={(item) => (
        <Text class={item.today ? "font-semibold" : ""}>
          {item.kind === "weekday"
            ? WEEKDAYS[item.value]
            : item.kind === "month" || item.kind === "monthToggle"
              ? MONTHS[item.value - 1]
              : item.kind === "previous"
                ? "‹"
                : item.kind === "next"
                  ? "›"
                  : String(item.value)}
        </Text>
      )}
    />
  );
}

mount(App);
```

`Calendar` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `calendar()` makes
one with a setter per prop (`.value(..)`, `.range(..)`, `.number_of_months(..)`) and a listener per event
(`.on_change(..)`). Its value is a `Date` (`Date::Single`, `Date::Range`, from a `chrono::NaiveDate` or a pair of
them), the days it disables a `Matcher`.

## Value

The value is an ISO date, `"2026-10-28"`, as an HTML `<input type="date">`'s; with `range` it is `[start, end]`, and
`null` is no date. With `value`, the app owns it: the calendar shows it as selected and reports a pick with
`onChange({ value })`; the app sets `value` to follow it. Left out, the calendar keeps its own value, from
`defaultValue` at first.

`onChange` reports complete values only, as `gpui-base`'s `Selected`: a pressed day, or a range's end.

- Without `range`, a press on a day picks it.
- With `range`, the first press starts the range and the second ends it, the days between them in the range (each
  `selected`, its ends included, see [Items](#items)). A second press on an earlier day starts the range over from it,
  as does a press once the range is complete. A half range shows until it is complete and only then is reported.

The calendar opens on the month of the value (a range's start), else today's.

## Months and views

`numberOfMonths` shows that many months side by side, from the shown one on; Previous and Next turn them one month at
a time. `firstDayOfWeek` is the day the weeks start on, `0` Sunday (the default) to `6` Saturday; the user's is
`localeSettings().firstDayOfWeek % 7` ([Regional preferences](../docs/device-and-environment.md#regional-preferences)).

The header holds Previous, two toggles and Next:

- The day view shows the months' days, each month a column of its weekdays' row and its weeks; the days of the
  months before and after fill the weeks (`outside`, `data-outside`).
- The month toggle (`monthToggle`) opens the month view: the twelve months, in rows of three. Picking one shows it in
  the day view.
- The year toggle (`yearToggle`) opens the year view: a page of 20 years, in rows of five, Previous and Next turning
  the page. Picking one shows that year in the day view. `yearRange` is the years the pages run through,
  `[start, end)` (default: 50 years before this one to 50 after).

With several months, the header shows each month's title instead of the toggles (a `monthToggle` item that takes no
press), as `gpui-base`'s.

## Disabled dates

`disabledMatcher` is the days the user cannot pick, `gpui-base`'s `Matcher`, in one of four forms:

| Form | Disables |
|---|---|
| `[0, 6]` | Those days of the week, `0` Sunday to `6` Saturday. |
| `{ before, after }` | The days before `before` and after `after` (either left out). |
| `{ from, to }` | The days from `from` to `to`, inclusive (either left out is open). |
| `(date) => boolean` | The days for which the function returns `true`, given each shown day's ISO date. |

The function is asked once per shown day, in the next JS turn, and not again for a day it answered: turning the
months asks only about the days they bring, so its answer is a pure function of the date. Passing another function
asks again. A disabled day is `disabled:`: it takes no press, and Return and Space do not pick it.

## Items

Every press target and label of the calendar is an item: Previous, the toggles, Next, the weekdays, the days, the
months and the years. Each is drawn in a part styled by `itemClass` and `itemStyle`, whose variants follow its state:

| Variant | The item |
|---|---|
| `selected:` | Is selected: the date, every day of a complete range (its ends included, as React Aria's range calendar), a half range's start, the shown month or year, the open view's toggle. Screen readers hear it selected. |
| `disabled:` | Is unavailable: a disabled date, Previous and Next in the month view or at the ends of the years. The weekdays and the months' titles are labels, which screen readers hear as column headers and headers: they take no press and keep their own look. |
| `focus:` | Has the keyboard. |
| `data-range-start:`, `data-range-end:` | Is a complete range's first or last day (a range of one day is both). |
| `data-range-middle:` | Is a day inside a complete range, not an end. |
| `data-today:` | Is today. |
| `data-outside:` | Is a day of the month before or after, filling its weeks. |

The `data-*` variants are Tailwind's (`data-range-start:` matches `[data-range-start]`), as shadcn's calendar styles
its days; with `group` in `itemClass`, the content follows them with `group-selected:`, `group-data-range-middle:`,
and so on. `selected:` means every day of a range, so a range's ends take their look over it (later variants win:
`data-*` comes after `selected:`), and its middle days theirs:

```tsx
<Calendar
  range
  itemClass="group rounded-md selected:bg-primary selected:text-primary-foreground data-range-middle:rounded-none data-range-middle:bg-accent data-range-middle:text-accent-foreground data-range-start:rounded-r-none data-range-end:rounded-l-none data-range-start:data-range-end:rounded-md"
/>
```

`renderItem` draws an item's content from what it is, a `CalendarEntry`, never from its state: the drawing is made
once and kept while the item is selected, focused or put in a range, so the keys, a pick and the focus draw nothing
again, and a turn of the months draws the days it brings once each (a day keeps its drawing by its month and date:
with several months, the months still shown keep theirs).

| Field | Meaning |
|---|---|
| `kind` | `"previous"`, `"monthToggle"`, `"yearToggle"`, `"next"`, `"weekday"`, `"day"`, `"month"` or `"year"`. |
| `value` | Its number: the day of the month, the month (1 to 12), the year, the day of the week (`0` Sunday to `6`); `0` for Previous and Next. |
| `date` | A day's ISO date. |
| `year`, `month` | The year and month it belongs to: a day's (the month whose weeks show it), a month toggle's or title's, a month's of the month view; a year toggle's and a year's own year. `0` for Previous, Next and the weekdays (and `month` for the year toggle and the years). |
| `today` | The day is today. |
| `outside` | The day is of the month before or after. |

Without `renderItem`, an item shows its number, and Previous and Next show `‹` and `›`, as `gpui-base`'s; a weekday
shows its number too, `0` to `6`, since the names of the months and weekdays are the app's words in the app's
language.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `CalendarValue` | none | The value, owned by the app. |
| `defaultValue` | `.default_value(..)` | `CalendarValue` | `null` | The value at first, without `value`. |
| `range` | `.range(..)` | `boolean` | `false` | Pick a range: the first press starts it, the second ends it. |
| `numberOfMonths` | `.number_of_months(..)` | `number` | `1` | How many months show side by side. |
| `firstDayOfWeek` | `.first_day_of_week(..)` | `number` | `0` | The day the weeks start on, `0` Sunday to `6` Saturday. |
| `disabledMatcher` | `.disabled_matcher(..)` | `DateMatcher` | none | The dates that cannot be picked. |
| `yearRange` | `.year_range(..)` | `[number, number]` | 50 years either way | The years the year view pages through, `[start, end)`. |
| `previousAccessibilityLabel` | `.previous_accessibility_label(..)` | `string` | none | What screen readers say for Previous. |
| `nextAccessibilityLabel` | `.next_accessibility_label(..)` | `string` | none | What screen readers say for Next. |
| `headerClass`, `headerStyle` | `.header_class(..)`, `.header_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The header: Previous, the toggles (or the months' titles), Next. |
| `bodyClass`, `bodyStyle` | `.body_class(..)`, `.body_style(..)` | `string`, `StyleProp<ViewStyle>` | none | The body: the months side by side, or the month or year view's rows. |
| `monthClass`, `monthStyle` | `.month_class(..)`, `.month_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Each month of the day view. |
| `rowClass`, `rowStyle` | `.row_class(..)`, `.row_style(..)` | `string`, `StyleProp<ViewStyle>` | none | Each row: the weekdays, a week, a row of months or years. |
| `itemClass`, `itemStyle` | `.item_class(..)`, `.item_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each item: `selected:`, `disabled:`, `focus:`; a day's `data-range-start:`, `data-range-end:`, `data-range-middle:`, `data-today:`, `data-outside:` ([Items](#items)). |
| `renderItem` | `.render_item(..)` | `(item: CalendarEntry) => JSX.Element` | none | An item's content, drawn by the app from what the item is; its number otherwise. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The calendar: the header above the body. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | The user picked a complete value: `{ value }`, a day or a range. Set `value` to follow it. A `value` the app passes is never reported. |

## Parts

| Part | Where | Styled with |
|---|---|---|
| The calendar | the root | `class`, `style` |
| The header | the calendar, first | `headerClass`, `headerStyle` |
| The body | the calendar, after the header | `bodyClass`, `bodyStyle` |
| A month | the body (day view) | `monthClass`, `monthStyle` |
| A row | a month, or the body (month and year views) | `rowClass`, `rowStyle` |
| An item | the header and the rows | `itemClass`, `itemStyle`, `renderItem` (`group-selected:`, `group-data-range-middle:`, ... inside, under `group` in `itemClass`) |

## Keyboard

The days are one stop of Tab: it lands on the selected day, else today, else the first shown day, passing over
disabled days, which take no focus. Then:

| Key | Action |
|---|---|
| Left / Right | The day before or after. |
| Up / Down | The same day a week before or after. |
| Home / End | The first or last day of the week. |
| Page Up / Page Down | The same day a month before or after. |
| Shift+Page Up / Shift+Page Down | The same day a year before or after. |
| Return, Space | Picks the day. |

In a right-to-left layout the weeks run from the right, so Left is the day after and Right the day before; Up and Down
keep the weeks. A key that reaches a disabled day goes on to the next day that is not, in the direction it moves (Home
and End back toward the day they left). Moving past the shown months turns them. Previous, the toggles, Next, the months and the years take
presses.
`gpui-base`'s days take presses only; the keys are NSH's, after the WAI-ARIA date picker dialog.

## Accessibility

- Each day is a button named by its ISO date, selected while it is the date or a day of the range (its ends included, as
  React Aria's range calendar), dimmed while disabled.
- Previous and Next are buttons named by `previousAccessibilityLabel` and `nextAccessibilityLabel`; the toggles,
  months and years are buttons named by what they show.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.
