//! `DatePicker`: a date, a range of dates or a date and time, picked from a
//! calendar in a popup at the app's trigger, with no look of its own
//! (`gpui-base`'s `DatePicker` root, `gpui-component`'s `DatePicker` and
//! `DatePickerState`).
//!
//! - **The popup** is `Select`'s (`popup::dropdown`): at the trigger on
//!   the desktops, a sheet at the bottom on touch screens; a press outside,
//!   the backdrop, Escape and back close it, the trigger and Return open
//!   and close it. It holds the presets (`presets`, a column of buttons),
//!   the calendar (`calendar.rs`'s grid, every prop of `Calendar`'s passed
//!   on) and, with `timePrecision` for a single date, a time field
//!   (`time_field.rs`) under it.
//! - **Picking** (`DatePickerState::select_date`): a complete date (a day,
//!   a range's end) is the value and closes the popup; with `timePrecision`
//!   the popup stays open for the time on the desktops, every change is
//!   reported, and a press on the selected day again closes it, while on
//!   touch screens (the sheet) a tap on a day picks it at its time and
//!   closes the sheet, as without a time. A preset is the value and
//!   closes it. The clear button (`cleanable`) and Delete / Backspace on
//!   the trigger clear it.
//! - **The value** is `value` and `onChange({ value })`: ISO dates, as
//!   HTML's `<input type="date">` (`"2026-10-28"`, `[start, end]`), or with
//!   `timePrecision` dates and times as `datetime-local`'s
//!   (`"2026-10-28T09:30"`). A date without a time takes `defaultTime`.
//! - **Screen readers** hear the trigger as a combobox, its value the
//!   value in `dateFormat` (`gpui-component`'s display format).

use std::rc::Rc;

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use nsh_core::{
    AccessibilityValue,
    element::{JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, Style, TextPartStyle, TsTypes},
    keymap::When,
    prelude::*,
};

use crate::{
    calendar::{self, CalendarItemState, Config, Date, Grid, Matcher, YearRange, iso, parse_date},
    popup::{self, DropdownFrame, OpenChangeReason, OpenState, Presence},
    time_field::{self, FieldConfig, HourCycle, TimeFieldSegmentState, TimeOfDay, TimePrecision},
};

/// A date picker's value (`gpui-component`'s `DateTime`): its date or
/// dates with their times of day. TS `DatePickerValue`: ISO dates
/// (`"2026-10-28"`) or dates and times (`"2026-10-28T09:30"`), `[start,
/// end]` for a range, `null` for none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateTime {
    /// One date and time, or none.
    Single(Option<NaiveDateTime>),
    /// A range's start and end.
    Range(Option<NaiveDateTime>, Option<NaiveDateTime>),
}

impl Default for DateTime {
    fn default() -> Self {
        Self::Single(None)
    }
}

impl From<NaiveDateTime> for DateTime {
    fn from(value: NaiveDateTime) -> Self {
        Self::Single(Some(value))
    }
}

impl From<(NaiveDateTime, NaiveDateTime)> for DateTime {
    fn from((start, end): (NaiveDateTime, NaiveDateTime)) -> Self {
        Self::Range(Some(start), Some(end))
    }
}

impl From<NaiveDate> for DateTime {
    fn from(value: NaiveDate) -> Self {
        Self::Single(Some(value.and_time(NaiveTime::MIN)))
    }
}

impl From<(NaiveDate, NaiveDate)> for DateTime {
    fn from((start, end): (NaiveDate, NaiveDate)) -> Self {
        Self::Range(
            Some(start.and_time(NaiveTime::MIN)),
            Some(end.and_time(NaiveTime::MIN)),
        )
    }
}

impl DateTime {
    /// The single date and time, or a range's start.
    pub fn start(&self) -> Option<NaiveDateTime> {
        match self {
            Self::Single(v) | Self::Range(v, _) => *v,
        }
    }

    /// A range's end.
    pub fn end(&self) -> Option<NaiveDateTime> {
        match self {
            Self::Range(_, v) => *v,
            Self::Single(_) => None,
        }
    }

    /// The dates of this value.
    pub fn date(&self) -> Date {
        match self {
            Self::Single(v) => Date::Single(v.map(|v| v.date())),
            Self::Range(a, b) => Date::Range(a.map(|v| v.date()), b.map(|v| v.date())),
        }
    }

    /// A complete value in `format` (`chrono`'s), a range's ends joined by
    /// ` - `.
    pub fn format(&self, format: &str) -> Option<SharedString> {
        match self {
            Self::Single(Some(v)) => Some(v.format(format).to_string().into()),
            Self::Range(Some(a), Some(b)) => {
                Some(format!("{} - {}", a.format(format), b.format(format)).into())
            }
            _ => None,
        }
    }

    /// `date` with the times `start` and `end`.
    fn of(date: Date, start: NaiveTime, end: NaiveTime) -> Self {
        match date {
            Date::Single(d) => Self::Single(d.map(|d| d.and_time(start))),
            Date::Range(a, b) => {
                Self::Range(a.map(|d| d.and_time(start)), b.map(|d| d.and_time(end)))
            }
        }
    }
}

/// An ISO date, or a date and time (`2026-10-28T09:30[:15]`): `None` for
/// neither.
fn parse_date_time(text: &str) -> Option<NaiveDateTime> {
    let text = text.trim();
    if let Some((date, time)) = text.split_once(['T', ' ']) {
        return Some(parse_date(date)?.and_time(time_field::parse_time(time)?));
    }
    parse_date(text).map(|d| d.and_time(NaiveTime::MIN))
}

fn date_time_from_js(value: JsIn<'_>) -> Result<Option<NaiveDateTime>, PropError> {
    if value.is_nullish() {
        return Ok(None);
    }
    value
        .as_string()
        .and_then(|s| parse_date_time(&s))
        .map(Some)
        .ok_or_else(|| {
            value.expected(
                "an ISO date (`2026-10-28`), a date and time (`2026-10-28T09:30`) or null",
            )
        })
}

/// `value` as JS shows it: an ISO date, or with `precision` a date and
/// time.
fn date_time_text(value: NaiveDateTime, precision: Option<TimePrecision>) -> SharedString {
    match precision {
        None => iso(value.date()),
        Some(p) => format!(
            "{}T{}",
            value.date().format("%Y-%m-%d"),
            time_field::format_time(value.time(), p)
        )
        .into(),
    }
}

/// `value` in JS (a string, `[start, end]` or `null`).
fn date_time_to_js<'a>(
    value: &DateTime,
    precision: Option<TimePrecision>,
    host: &'a dyn JsHost,
) -> Result<JsOwned<'a>, PropError> {
    let text = |v: Option<NaiveDateTime>| v.map(|v| date_time_text(v, precision));
    match *value {
        DateTime::Single(v) => text(v).to_js(host),
        DateTime::Range(a, b) => vec![text(a), text(b)].to_js(host),
    }
}

impl JsValue for DateTime {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("DatePickerValue", |_| {
            "/** A date picker's value: an ISO date (`\"2026-10-28\"`) or a date and time (`\"2026-10-28T09:30\"`), `[start, end]` for a range (either `null` while unset), `null` for none. */\nexport type DatePickerValue = string | [string | null, string | null] | null;\n".to_owned()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if let Some(len) = value.array_len()? {
            if len != 2 {
                return Err(value.expected("`[start, end]`"));
            }
            let start = date_time_from_js(value.index(0)?.get())?;
            let end = date_time_from_js(value.index(1)?.get())?;
            return Ok(Self::Range(start, end));
        }
        date_time_from_js(value).map(Self::Single)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let precision = [self.start(), self.end()]
            .into_iter()
            .flatten()
            .any(|v| v.time() != NaiveTime::MIN)
            .then_some(TimePrecision::Second);
        date_time_to_js(self, precision, host)
    }
}

/// A date picker's `value` prop: left out, it keeps its own value; set,
/// the app's ([`DateTime`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum DatePickerValue {
    /// Not set: the picker keeps its own value (from `defaultValue`).
    #[default]
    Uncontrolled,
    /// Set by the app.
    Controlled(DateTime),
}

impl<T: Into<DateTime>> From<T> for DatePickerValue {
    fn from(value: T) -> Self {
        Self::Controlled(value.into())
    }
}

impl JsValue for DatePickerValue {
    fn ts_type(types: &mut TsTypes) -> String {
        <DateTime as JsValue>::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::Undefined => Ok(Self::Uncontrolled),
            _ => <DateTime as JsValue>::from_js(value).map(Self::Controlled),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Self::Uncontrolled => Ok(JsOwned::new(host, host.undefined())),
            Self::Controlled(v) => v.to_js(host),
        }
    }
}

/// What `onChange` reports: the value, and the precision of the times it
/// shows (JS gets dates without `timePrecision`, dates and times with it).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct PickedDate {
    /// The value.
    pub value: DateTime,
    /// The picker's `timePrecision`.
    pub time_precision: Option<TimePrecision>,
}

impl JsValue for PickedDate {
    fn ts_type(types: &mut TsTypes) -> String {
        <DateTime as JsValue>::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        <DateTime as JsValue>::from_js(value).map(|value| Self {
            value,
            time_precision: None,
        })
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        date_time_to_js(&self.value, self.time_precision, host)
    }
}

/// A preset of a date picker's popup (`gpui-component`'s
/// `DateRangePreset`): a button that sets the value.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DateRangePreset {
    /// What the button shows and screen readers say.
    pub label: SharedString,
    /// What it sets: a date, a range or dates and times (kept as given).
    pub value: DateTime,
}

impl DateRangePreset {
    /// A preset of one date.
    pub fn single(label: impl Into<SharedString>, date: NaiveDate) -> Self {
        Self {
            label: label.into(),
            value: date.into(),
        }
    }

    /// A preset of a range.
    pub fn range(label: impl Into<SharedString>, start: NaiveDate, end: NaiveDate) -> Self {
        Self {
            label: label.into(),
            value: (start, end).into(),
        }
    }

    /// A preset of a date and time, or a range of them.
    pub fn date_time(label: impl Into<SharedString>, value: impl Into<DateTime>) -> Self {
        Self {
            label: label.into(),
            value: value.into(),
        }
    }
}

/// The props of [`DatePicker`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct DatePickerProps {
    /// The value (controlled): the app owns it and sets it in `onChange`.
    /// Without it the picker keeps its own value.
    #[prop(default)]
    pub value: Prop<DatePickerValue>,
    /// The value at first, while `value` is not set.
    #[prop(default)]
    pub default_value: Prop<DateTime>,
    /// Pick a range of dates (`DatePickerState::range`).
    #[prop(default)]
    pub range: Prop<bool>,
    /// Open (controlled): the app owns it and changes it in
    /// `onOpenChange`. Without it the picker keeps its own state.
    pub open: Prop<Option<bool>>,
    /// Open at first, while `open` is not set.
    #[prop(default)]
    pub default_open: Prop<bool>,
    /// It does not open: no presses, no keyboard focus, `disabled:` styles
    /// apply to the trigger and screen readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers call it.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// How screen readers hear the value (`chrono`'s format, default
    /// `"%Y/%m/%d"` and the time at `timePrecision`: `gpui-component`'s
    /// `date_format`).
    pub date_format: Prop<Option<SharedString>>,
    /// Edit the time of day too, down to this (`gpui-component`'s
    /// `time_precision`): a time field under the calendar of a single
    /// date. Picking a day then keeps the popup open on the desktops (the
    /// selected day again closes it); on touch screens a tap on a day
    /// still closes the sheet, which opens again for the time.
    pub time_precision: Prop<Option<TimePrecision>>,
    /// How the time field counts the hours (default `"h23"`).
    #[prop(default)]
    pub hour_cycle: Prop<HourCycle>,
    /// The time a date gets before the user sets one (default `00:00`).
    pub default_time: Prop<Option<TimeOfDay>>,
    /// A clear button while there is a value (`gpui-component`'s
    /// `cleanable`): a press clears it, reported by `onChange(null)`.
    #[prop(default)]
    pub cleanable: Prop<bool>,
    /// Buttons in the popup that set the value (`gpui-component`'s
    /// `presets`): today, the last seven days.
    #[prop(default)]
    pub presets: Prop<Vec<DateRangePreset>>,
    /// How many months the calendar shows side by side, at least 1.
    #[prop(default = 1)]
    pub number_of_months: Prop<u32>,
    /// The day the calendar's weeks start on, `0` Sunday to `6` Saturday.
    #[prop(default)]
    pub first_day_of_week: Prop<u32>,
    /// The dates that cannot be picked.
    pub disabled_matcher: Prop<Option<Matcher>>,
    /// The years the calendar's year view pages through, `[start, end)`.
    pub year_range: Prop<Option<YearRange>>,
    /// Desktops: the side of the trigger the popup goes on (default
    /// `"bottom"`).
    #[prop(default)]
    pub placement: Prop<Placement>,
    /// Desktops: how it lines up with the trigger (default `"start"`).
    #[prop(default = Align::Start)]
    pub align: Prop<Align>,
    /// Desktops: the gap between the trigger and the popup.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// Desktops: the distance it keeps from the edges of the safe area.
    #[prop(default)]
    pub margin: Prop<Points>,
    /// The classes of the popup (desktops) or sheet (touch screens).
    pub popup_class: Prop<Option<SharedString>>,
    /// The inline style of the popup or sheet, over its classes.
    #[prop(default)]
    pub popup_style: Prop<Style>,
    /// Touch screens: the classes of the backdrop behind the sheet.
    pub backdrop_class: Prop<Option<SharedString>>,
    /// The inline style of the backdrop, over its classes.
    #[prop(default)]
    pub backdrop_style: Prop<Style>,
    /// The classes of the popup's content: the presets beside the calendar
    /// and the time (`flex-row`).
    pub content_class: Prop<Option<SharedString>>,
    /// The inline style of the content, over its classes.
    #[prop(default)]
    pub content_style: Prop<Style>,
    /// The classes of the presets' column.
    pub presets_class: Prop<Option<SharedString>>,
    /// The inline style of the presets' column, over its classes.
    #[prop(default)]
    pub presets_style: Prop<Style>,
    /// The classes of each preset's button.
    pub preset_class: Prop<Option<SharedString>>,
    /// The inline style of each preset, over its classes: its text styles
    /// too, which its label inherits.
    #[prop(default)]
    pub preset_style: Prop<TextPartStyle>,
    /// The classes of the calendar.
    pub calendar_class: Prop<Option<SharedString>>,
    /// The inline style of the calendar, over its classes.
    #[prop(default)]
    pub calendar_style: Prop<Style>,
    /// What screen readers say for the calendar's Previous.
    pub previous_accessibility_label: Prop<Option<SharedString>>,
    /// What screen readers say for the calendar's Next.
    pub next_accessibility_label: Prop<Option<SharedString>>,
    /// The calendar's header classes (`Calendar`'s `headerClass`).
    pub header_class: Prop<Option<SharedString>>,
    /// The calendar's header style.
    #[prop(default)]
    pub header_style: Prop<Style>,
    /// The calendar's body classes.
    pub body_class: Prop<Option<SharedString>>,
    /// The calendar's body style.
    #[prop(default)]
    pub body_style: Prop<Style>,
    /// The classes of each month of the calendar.
    pub month_class: Prop<Option<SharedString>>,
    /// The style of each month.
    #[prop(default)]
    pub month_style: Prop<Style>,
    /// The classes of each row of the calendar.
    pub row_class: Prop<Option<SharedString>>,
    /// The style of each row.
    #[prop(default)]
    pub row_style: Prop<Style>,
    /// The classes of each item of the calendar (`selected:`, `disabled:`,
    /// `focus:` as `Calendar`'s).
    pub item_class: Prop<Option<SharedString>>,
    /// The style of each item, its text styles too.
    #[prop(default)]
    pub item_style: Prop<TextPartStyle>,
    /// Draws each item of the calendar.
    pub render_item: Prop<Option<Renderer<CalendarItemState>>>,
    /// The classes of the time's row: its label at the start and the field
    /// at the end (`flex-row items-center justify-between`, `gpui-component`'s).
    pub time_class: Prop<Option<SharedString>>,
    /// The inline style of the time's row, over its classes.
    #[prop(default)]
    pub time_style: Prop<Style>,
    /// What the time's row shows before the field (`gpui-component`'s
    /// "Time"): the app's words.
    pub time_label: Prop<Option<Slot>>,
    /// The classes of the time field (`flex-row`).
    pub time_field_class: Prop<Option<SharedString>>,
    /// The inline style of the time field, over its classes.
    #[prop(default)]
    pub time_field_style: Prop<Style>,
    /// What screen readers call the time field.
    pub time_accessibility_label: Prop<Option<SharedString>>,
    /// The classes of each segment of the time field.
    pub segment_class: Prop<Option<SharedString>>,
    /// The style of each segment, its text styles too.
    #[prop(default)]
    pub segment_style: Prop<TextPartStyle>,
    /// The classes of each `:` of the time field.
    pub separator_class: Prop<Option<SharedString>>,
    /// The style of each `:`.
    #[prop(default)]
    pub separator_style: Prop<TextPartStyle>,
    /// Draws each segment of the time field.
    pub render_segment: Prop<Option<Renderer<TimeFieldSegmentState>>>,
    /// The classes of the clear button, a sibling after the trigger.
    pub clear_button_class: Prop<Option<SharedString>>,
    /// The inline style of the clear button, over its classes.
    #[prop(default)]
    pub clear_button_style: Prop<Style>,
    /// The content of the clear button.
    pub clear_button: Prop<Option<Slot>>,
    /// What screen readers call the clear button.
    pub clear_button_accessibility_label: Prop<Option<SharedString>>,
    /// What opens the popup when pressed: the app's element (showing the
    /// value, a placeholder, an icon), which the popup is placed against.
    pub trigger: Prop<Option<Slot>>,
}

/// The events of a [`DatePicker`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum DatePickerEvent {
    /// The user changed the value (a day, a range's end, a preset, the
    /// time, the clear button). With `timePrecision`, every edit while the
    /// popup is open.
    #[args(value)]
    Change(PickedDate),
    /// The popup opened or closed, with why: set `open` to follow it.
    #[args(open, reason)]
    OpenChange(bool, OpenChangeReason),
    /// The popup is shown (a sheet once it came in).
    Open,
    /// The popup is gone.
    Close,
    /// The user tried to close the popup without a choice (Escape or back,
    /// a press outside or on the backdrop).
    Cancel,
}

/// The format screen readers hear the value in by default
/// (`gpui-component`'s `display_format`).
fn display_format(precision: Option<TimePrecision>, cycle: HourCycle) -> String {
    match precision {
        None => "%Y/%m/%d".to_owned(),
        Some(p) => format!("%Y/%m/%d {}", p.format(cycle)),
    }
}

/// A date, a range of dates or a date and time picked from a calendar in a
/// popup at the app's `trigger` (`gpui-component`'s `DatePicker`): on the
/// desktops at the trigger, on phones and tablets a sheet at the bottom.
/// Picking a complete date sets the value and closes it; with
/// `timePrecision` a time field under the calendar edits the time, and on
/// the desktops the popup stays open after a day is picked (the selected
/// day again closes it), while on touch screens a tap on a day closes it.
/// `presets` add buttons that set the value, `cleanable` a button that
/// clears it. The value is `value` and `onChange` (or the
/// picker's own, from `defaultValue`). Every prop of `Calendar` passes on
/// to its calendar. It looks like nothing: the app styles every part.
#[component]
pub fn DatePicker(props: DatePickerProps, cx: Scope<DatePickerEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, props.default_open);
    let own = signal(props.default_value.get_untracked());
    let current = computed(move || match props.value.get() {
        DatePickerValue::Controlled(v) => v,
        DatePickerValue::Uncontrolled => own.get(),
    });
    let default_time = move || props.default_time.get().map_or(NaiveTime::MIN, |t| t.0);
    // The times of the start and end, as the user left them: a value's
    // own, else the default. A time the user set that the value does not
    // hold (no day picked yet, or the app keeps its value) shows until the
    // value changes: derived, not copied by an effect.
    let edited = signal(None::<(DateTime, (NaiveTime, NaiveTime))>);
    let times = computed(move || {
        let v = current.get();
        if let Some(times) = edited.with(|e| e.filter(|(at, _)| *at == v).map(|(_, t)| t)) {
            return times;
        }
        let fallback = default_time();
        let start = v.start().map_or(fallback, |v| v.time());
        let end = v.end().map_or(start, |v| v.time());
        (start, end)
    });
    let set_times = move |t: (NaiveTime, NaiveTime)| {
        edited.set(Some((current.get_untracked(), t)));
    };
    let date = computed(move || current.with(DateTime::date).shaped(props.range.get()));
    // The popup edits the time: a single date with a precision.
    let edits_time = computed(move || props.time_precision.get().is_some() && !props.range.get());

    let anchor = element_ref();
    let width = signal(None::<Points>);
    let focused = signal(false);
    let closed_by = stored(None::<OpenChangeReason>);
    let change: Rc<dyn Fn(bool, OpenChangeReason)> = Rc::new(move |next, reason| {
        if next && props.disabled.get_untracked() {
            return;
        }
        if open.get_untracked() == next {
            return;
        }
        if !next {
            closed_by.replace(Some(reason));
        }
        open.request(next, || cx.emit(DatePickerEvent::OpenChange(next, reason)));
    });
    let report = move |next: DateTime| {
        if matches!(props.value.get_untracked(), DatePickerValue::Uncontrolled) {
            own.set(next);
        }
        cx.emit(DatePickerEvent::Change(PickedDate {
            value: next,
            time_precision: props.time_precision.get_untracked(),
        }));
    };
    let with_times = move |d: Date| {
        let (start, end) = times.get_untracked();
        DateTime::of(d, start, end)
    };
    let clear = {
        let change = change.clone();
        Rc::new(move || {
            let t = untracked(default_time);
            set_times((t, t));
            let none = Date::Single(None).shaped(props.range.get_untracked());
            report(DateTime::of(none, t, t));
            change(false, OpenChangeReason::Select);
        })
    };

    // The trigger's keys while it has the focus: Return opens and closes
    // (`gpui-base`'s `Confirm`), Delete and Backspace clear.
    {
        let (change, clear) = (change.clone(), clear.clone());
        effect(move || {
            if !focused.get() || props.disabled.get() {
                return;
            }
            let change = change.clone();
            on_key_with(
                "enter",
                KeyOptions {
                    when: When::NotEditing,
                    repeat: false,
                },
                move |_| change(!open.get_untracked(), OpenChangeReason::TriggerPress),
            );
            for key in ["delete", "backspace"] {
                let clear = clear.clone();
                on_key_with(
                    key,
                    KeyOptions {
                        when: When::NotEditing,
                        repeat: false,
                    },
                    move |_| {
                        if !open.get_untracked() {
                            clear();
                        }
                    },
                );
            }
        });
    }

    let dismiss: Rc<dyn Fn(OpenChangeReason)> = {
        let change = change.clone();
        Rc::new(move |reason| {
            cx.emit(DatePickerEvent::Cancel);
            change(false, reason);
        })
    };
    let presence = Presence {
        open: Rc::new(move || open.get()),
        dismiss,
        shown: Rc::new(move |shown| {
            if shown {
                cx.emit(DatePickerEvent::Open);
                return;
            }
            cx.emit(DatePickerEvent::Close);
            if is_desktop() && closed_by.replace(None) != Some(OpenChangeReason::PressOutside) {
                anchor.focus();
            }
        }),
    };
    let frame = DropdownFrame {
        placement: props.placement,
        align: props.align,
        offset: props.offset,
        margin: props.margin,
        popup_class: props.popup_class,
        popup_style: props.popup_style,
        backdrop_class: props.backdrop_class,
        backdrop_style: props.backdrop_style,
    };
    let config = Config {
        number_of_months: props.number_of_months,
        first_day_of_week: props.first_day_of_week,
        disabled_matcher: props.disabled_matcher,
        year_range: props.year_range,
        previous_accessibility_label: props.previous_accessibility_label,
        next_accessibility_label: props.next_accessibility_label,
        header_class: props.header_class,
        header_style: props.header_style,
        body_class: props.body_class,
        body_style: props.body_style,
        month_class: props.month_class,
        month_style: props.month_style,
        row_class: props.row_class,
        row_style: props.row_style,
        item_class: props.item_class,
        item_style: props.item_style,
        render_item: props.render_item,
    };
    let field_config = FieldConfig {
        precision: Prop::bind(move || props.time_precision.get().unwrap_or_default()),
        hour_cycle: props.hour_cycle,
        disabled: props.disabled,
        accessibility_label: props.time_accessibility_label,
        segment_class: props.segment_class,
        segment_style: props.segment_style,
        separator_class: props.separator_class,
        separator_style: props.separator_style,
        render_segment: props.render_segment,
    };

    let content = {
        let change = change.clone();
        Rc::new(move |sheet: bool| -> Vec<AnyElement> {
            let grid = Grid::new(config, move || date.get());
            if !sheet {
                grid.focus_days();
            }
            let picked: Rc<dyn Fn(Date)> = {
                let change = change.clone();
                Rc::new(move |d: Date| {
                    // On the desktops the popup stays for the time and a
                    // press on the selected day again confirms it
                    // (`gpui-component`'s double click). A touch screen
                    // has no double click to close with: a tap picks the
                    // day at its time and closes the sheet, which opens
                    // again for the time.
                    if edits_time.get_untracked() && !sheet {
                        if d == date.get_untracked() {
                            change(false, OpenChangeReason::Select);
                            return;
                        }
                        report(with_times(d));
                        return;
                    }
                    report(with_times(d));
                    change(false, OpenChangeReason::Select);
                })
            };
            let presets = {
                let change = change.clone();
                dynamic(move || {
                    let presets = props.presets.get();
                    if presets.is_empty() {
                        return None;
                    }
                    let change = change.clone();
                    let buttons = presets
                        .into_iter()
                        .map(|p| {
                            let change = change.clone();
                            let label = p.label.clone();
                            view()
                                .role(AccessibilityRole::Button)
                                .label(label.clone())
                                // Not a stop of Tab (`gpui-component`'s
                                // `tab_stop(false)`).
                                .focusable(false)
                                .app_class(props.preset_class)
                                .inline_style(move || props.preset_style.get())
                                .on_press(move || {
                                    let v = p.value;
                                    let (start, end) = (
                                        v.start().map_or(untracked(default_time), |v| v.time()),
                                        v.end().map_or(untracked(default_time), |v| v.time()),
                                    );
                                    set_times((start, end));
                                    report(v);
                                    change(false, OpenChangeReason::Select);
                                })
                                .child(text(label))
                                .into_element()
                        })
                        .collect::<Vec<_>>();
                    Some(
                        view()
                            .app_class(props.presets_class)
                            .inline_style(props.presets_style)
                            .children(buttons)
                            .into_element(),
                    )
                })
            };
            let time = when(
                move || edits_time.get(),
                move || {
                    let field_time = move || times.get().0;
                    let changed: Rc<dyn Fn(NaiveTime)> = Rc::new(move |t| {
                        set_times((t, times.get_untracked().1));
                        let d = date.get_untracked();
                        if d.is_complete() {
                            report(with_times(d));
                        }
                    });
                    view()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .app_class(props.time_class)
                        .inline_style(props.time_style)
                        .child(props.time_label.place(|l| l))
                        .child(
                            view()
                                .flex_row()
                                .disabled(props.disabled)
                                .app_class(props.time_field_class)
                                .inline_style(props.time_field_style)
                                .children(time_field::field(field_config, field_time, changed)),
                        )
                },
            );
            let calendar = view()
                .app_class(props.calendar_class)
                .inline_style(props.calendar_style)
                .children(calendar::calendar_view(grid, picked));
            vec![
                view()
                    .app_class(props.content_class)
                    .inline_style(props.content_style)
                    .child(presets)
                    .child(view().child(calendar).child(time))
                    .into_element(),
            ]
        })
    };

    let toggle = change;
    let trigger = props.trigger.place(move |t| {
        let toggle = toggle.clone();
        t.element_ref(&anchor)
            .role(AccessibilityRole::Combobox)
            .optional_label(props.accessibility_label)
            .disabled(props.disabled)
            .focusable(move || !props.disabled.get())
            .accessibility_state(move || AccessibilityState {
                expanded: Some(open.get()),
                disabled: props.disabled.get(),
                ..AccessibilityState::default()
            })
            .accessibility_value(move || {
                let format = props
                    .date_format
                    .get()
                    .map(|f| f.to_string())
                    .unwrap_or_else(|| {
                        display_format(props.time_precision.get(), props.hour_cycle.get())
                    });
                let (start, end) = times.get();
                DateTime::of(date.get(), start, end)
                    .format(&format)
                    .map(|text| AccessibilityValue {
                        text: Some(text.as_str().into()),
                        ..AccessibilityValue::default()
                    })
            })
            .on_layout(move |frame: &Bounds<Points>| width.set(Some(frame.size.width)))
            .on_focus(move || focused.set(true))
            .on_blur(move || focused.set(false))
            .on_press(move || toggle(!open.get_untracked(), OpenChangeReason::TriggerPress))
    });
    let clear_button = when(
        move || props.cleanable.get() && date.with(Date::is_some),
        move || {
            let clear = clear.clone();
            view()
                .role(AccessibilityRole::Button)
                .optional_label(props.clear_button_accessibility_label)
                .focusable(false)
                .disabled(props.disabled)
                .on_press(move || clear())
                .app_class(props.clear_button_class)
                .inline_style(props.clear_button_style)
                .child(props.clear_button.place(|c| c))
        },
    );
    view()
        .child(trigger)
        .child(clear_button)
        .child(popup::dropdown(anchor, width, frame, presence, content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_dates_with_times_parse() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 28).unwrap();
        assert_eq!(
            parse_date_time("2026-10-28"),
            Some(d.and_hms_opt(0, 0, 0).unwrap())
        );
        assert_eq!(
            parse_date_time("2026-10-28T09:30"),
            Some(d.and_hms_opt(9, 30, 0).unwrap())
        );
        assert_eq!(
            parse_date_time("2026-10-28 09:30:15"),
            Some(d.and_hms_opt(9, 30, 15).unwrap())
        );
        assert_eq!(parse_date_time("2026-10-28T25:00"), None);
        assert_eq!(parse_date_time("tomorrow"), None);
    }

    #[test]
    fn values_show_as_dates_or_dates_and_times() {
        let v = NaiveDate::from_ymd_opt(2026, 10, 28)
            .unwrap()
            .and_hms_opt(9, 5, 0)
            .unwrap();
        assert_eq!(date_time_text(v, None), "2026-10-28");
        assert_eq!(
            date_time_text(v, Some(TimePrecision::Minute)),
            "2026-10-28T09:05"
        );
        assert_eq!(
            date_time_text(v, Some(TimePrecision::Second)),
            "2026-10-28T09:05:00"
        );
    }
}
