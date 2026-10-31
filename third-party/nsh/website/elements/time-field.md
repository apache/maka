---
title: TimeField
description: "The TimeField component: a time of day edited segment by segment, hours, minutes and seconds, with the keyboard or a phone's number pad, styled by the app."
group: base
demo: el-date-picker
---

# TimeField

A time field edits a time of day, a segment at a time: the hour, the minute, with `precision="second"` the second,
and with `hourCycle="h12"` AM or PM. A reminder's time, a meeting's start, the hours a shop opens. It is the time
under [DatePicker](./date-picker.md)'s calendar with `timePrecision`, on its own in the page.

The field owns the behavior: the time (the app's, or its own), which segment the keys edit, typing and stepping
digits, and what screen readers hear. The look is the app's: it styles the segments and the `:` between them, or
draws the segments itself.

```rust tabs
use chrono::NaiveTime;
use nsh_base::{HourCycle, TimeFieldSegmentState, TimeOfDay, time_field, theme};
use nsh_core::prelude::*;

fn reminder_time() -> impl IntoElement {
    let at = signal(TimeOfDay(NaiveTime::from_hms_opt(9, 30, 0).unwrap()));
    time_field()
        .value(move || Some(at.get()))
        .on_change(move |next: &TimeOfDay| at.set(*next))
        .hour_cycle(HourCycle::H12)
        .accessibility_label("Reminder time")
        .render_segment(|segment: &TimeFieldSegmentState| {
            view()
                .px_1()
                .rounded_sm()
                .when(segment.selected, |v| v.bg(move || theme().accent))
                .child(text(segment.label.clone()))
        })
}
```

```tsx tabs
import { mount, signal } from "nsh";
import { TimeField } from "nsh/base";

function App() {
  const at = signal("09:30");
  return (
    <TimeField
      value={at()}
      onChange={({ value }) => at.set(value)}
      hourCycle="h12"
      accessibilityLabel="Reminder time"
      class="h-9 w-32 flex-row items-center rounded-md border border-input px-2"
      segmentClass="rounded-sm px-0.5 text-sm tabular-nums focus:bg-accent focus:text-accent-foreground"
      separatorClass="text-sm text-muted-foreground"
    />
  );
}

mount(App);
```

`TimeField` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `time_field()`
makes one with a setter per prop (`.value(..)`, `.precision(..)`, `.hour_cycle(..)`) and a listener per event
(`.on_change(..)`). Its time is a `TimeOfDay`, a `chrono::NaiveTime`.

## Value

The value is a time of day on a 24-hour clock, as an HTML `<input type="time">`'s: `"HH:MM"`, or `"HH:MM:SS"` with
`precision="second"`, whatever `hourCycle` the field shows. With `value`, the app owns it: the field shows it and
reports each edit with `onChange({ value })`; the app sets `value` to follow it. Left out, the field keeps its own
time, from `defaultValue` at first (default `00:00`).

`precision` is the smallest unit the field edits, `"minute"` (the default) or `"second"`. `hourCycle` is how it counts
the hours: `"h23"` (the default) from 00 to 23, `"h12"` from 12 to 11 with an AM/PM segment after the numbers.

## Editing

One segment is selected; the keys edit it, as `gpui-base`'s time field:

- Up and Down step the segment by one and wrap around (59 to 00) without carrying into the next segment.
- Digits type into it, two at a time: a digit that cannot start a longer value (a `7` in the hour) completes the
  segment and moves to the next.
- `a` and `p` set AM and PM.
- Backspace and Delete reset the segment.

A press on a segment selects it. A press on the selected AM/PM segment switches it, since phones have no `a` and `p`
keys. The keys go to one native text field behind the segments, transparent, as an [OtpInput](./otp-input.md)'s: on
phones and tablets it brings up the number pad.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `string` | none | The time, owned by the app. |
| `defaultValue` | `.default_value(..)` | `string` | `"00:00"` | The time at first, without `value`. |
| `precision` | `.precision(..)` | `"minute" \| "second"` | `"minute"` | The smallest unit it edits. |
| `hourCycle` | `.hour_cycle(..)` | `"h23" \| "h12"` | `"h23"` | How it counts the hours; `"h12"` adds an AM/PM segment. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No focus and no editing; `disabled:` styles apply to the field and its segments. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the field. |
| `segmentClass`, `segmentStyle` | `.segment_class(..)`, `.segment_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each segment: `focus:` on the selected one while the field has the focus, `disabled:` with the field. |
| `separatorClass`, `separatorStyle` | `.separator_class(..)`, `.separator_style(..)` | `string`, `StyleProp<TextStyle>` | none | Each `:` between the numbers. |
| `renderSegment` | `.render_segment(..)` | `(segment: TimeFieldSegmentState) => JSX.Element` | none | A segment's content, drawn by the app; its label otherwise. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The field, around its segments (a row). |

`renderSegment` gets a `TimeFieldSegmentState`: `segment` (`"hour"`, `"minute"`, `"second"` or `"period"`), `value`
(the hour on the field's clock, the minute or the second; `0` for AM and `1` for PM), `label` (two digits, or `AM` /
`PM`), `selected` (the keys edit it) and `disabled`.

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | The user changed the time: `{ value }`. Set `value` to follow it. A `value` the app passes is never reported. |

## Parts

| Part | Where | Styled with |
|---|---|---|
| The field | the root, a row | `class`, `style` |
| A segment | the field: hour, minute, second, AM/PM | `segmentClass`, `segmentStyle`, `renderSegment` |
| A separator | the field, between two numbers | `separatorClass`, `separatorStyle` |

## Keyboard

Tab reaches the field with its selected segment. Then:

| Key | Action |
|---|---|
| Left / Right | The segment before or after. |
| Tab / Shift+Tab | The segment after or before; Tab from the last one and Shift+Tab from the first leave the field. |
| Up / Down | Steps the segment by one, wrapping around. |
| 0 to 9 | Types into the segment. |
| A / P | AM or PM. |
| Backspace, Delete | Resets the segment. |

## Accessibility

- The field is a text field named by `accessibilityLabel`; screen readers read the time it shows. `disabled` dims it.
- Phones and tablets show the number pad.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.
