//! `Calendar`: a month's days to pick a date or a range of dates from, with
//! no look of its own (`gpui-base`'s `Calendar` and `CalendarState`).
//!
//! - **The value** is a [`Date`]: one date, or with `range` a start and an
//!   end. JS passes ISO dates (`"2026-10-28"`, `[start, end]`). A press on
//!   a day selects it (`CalendarState::select_date`): with `range` the
//!   first press starts a range and the second ends it (an earlier day
//!   starts it again). `onChange({ value })` reports a complete value only
//!   (`CalendarEvent::Selected`); a half range shows until it completes.
//! - **Views**: the days of `numberOfMonths` months side by side, the
//!   twelve months of the shown year (`monthToggle`) or a page of twenty
//!   years of `yearRange` (`yearToggle`); picking a month or a year goes
//!   back to the days. Previous and Next turn the month, or the page of
//!   years.
//! - **Disabled dates** (`disabledMatcher`, `gpui-base`'s `Matcher`): days
//!   of the week, before and after an interval, inside a range, or the
//!   app's function, asked about each shown day once, in the next JS turn:
//!   a turn of the months asks only the days it brings (a new function is
//!   asked again).
//! - **The keys** (beyond `gpui-base`, whose days take presses only): the
//!   days are one stop of Tab, on the selected day, else today, else the
//!   first; the arrows move a day or a week, Home and End to the week's
//!   ends, Page Up and Down a month (with Shift a year), Return and Space
//!   select. Moving past the shown months turns them.
//! - **Items**: every control is an item the app draws (`renderItem`,
//!   [`CalendarItemState`]: its kind, value, date and state) or styles
//!   (`itemClass`: `selected:` on the selected days, the shown month and
//!   year, `disabled:` on the dates that cannot be picked). Without
//!   `renderItem` an item shows its number, and Previous / Next `‹` / `›`,
//!   as `gpui-base`'s default labels.
//! - **Layout**: the grid fills the width it is given, as a table's
//!   columns do: the months share the body, and the weekdays, the days and
//!   the months and years to pick share their rows equally (`flex: 1`), so
//!   a calendar in a sheet as wide as a phone spans it, and one in a popup
//!   that fits its content keeps the items' own widths. The app's
//!   `itemClass` / `monthClass` (`flex-none`) take that back.

use std::{collections::HashSet, rc::Rc};

use chrono::{Datelike, Days, Months, NaiveDate};
use nsh_core::{
    element::{
        Arg, Callback, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, Style, TextPartStyle,
        TsTypes,
    },
    keymap::When,
    prelude::*,
};

/// How many years a page of the year view shows (`gpui-base`'s 20).
const YEARS_PER_PAGE: usize = 20;
/// How many months a row of the month view has (`gpui-base`'s grid).
const MONTHS_PER_ROW: usize = 3;
/// How many years a row of the year view has.
const YEARS_PER_ROW: usize = 5;
/// The most weeks a month shows: a month's grid has this many rows, those
/// it does not use hidden, so that a turn changes what the cells show and
/// makes none.
const WEEKS: usize = 6;
/// The fewest weeks a month shows (a February from the week's first day).
const MIN_WEEKS: usize = 4;
/// The day cells of a month's grid.
const CELLS: usize = WEEKS * 7;
/// How many signals the days' stop of Tab is spread over for the days to
/// read ([`Grid::is_stop`]): more than the days two months show.
const LIT: usize = 96;

/// A calendar's value (`gpui-base`'s `Date`): one date, or a range's start
/// and end. TS `CalendarValue`: an ISO date (`"2026-10-28"`), `[start,
/// end]` for a range (either `null` while unset), `null` for none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Date {
    /// One date, or none.
    Single(Option<NaiveDate>),
    /// A range: its start and its end, each inclusive.
    Range(Option<NaiveDate>, Option<NaiveDate>),
}

impl Default for Date {
    fn default() -> Self {
        Self::Single(None)
    }
}

impl From<NaiveDate> for Date {
    fn from(value: NaiveDate) -> Self {
        Self::Single(Some(value))
    }
}

impl From<(NaiveDate, NaiveDate)> for Date {
    fn from((start, end): (NaiveDate, NaiveDate)) -> Self {
        Self::Range(Some(start), Some(end))
    }
}

impl Date {
    /// A date is set: the single one, or a range's start.
    pub fn is_some(&self) -> bool {
        matches!(self, Self::Single(Some(_)) | Self::Range(Some(_), _))
    }

    /// The value is whole: the single date, or both ends of a range.
    pub fn is_complete(&self) -> bool {
        matches!(self, Self::Single(Some(_)) | Self::Range(Some(_), Some(_)))
    }

    /// The single date, or a range's start.
    pub fn start(&self) -> Option<NaiveDate> {
        match self {
            Self::Single(v) | Self::Range(v, _) => *v,
        }
    }

    /// A range's end.
    pub fn end(&self) -> Option<NaiveDate> {
        match self {
            Self::Range(_, v) => *v,
            Self::Single(_) => None,
        }
    }

    /// One date, not a range.
    pub fn is_single(&self) -> bool {
        matches!(self, Self::Single(_))
    }

    /// `value` is the date, or an end of the range.
    pub fn is_active(&self, value: &NaiveDate) -> bool {
        match self {
            Self::Single(v) => *v == Some(*value),
            Self::Range(a, b) => *a == Some(*value) || *b == Some(*value),
        }
    }

    /// `value` is inside the complete range, its ends included.
    pub fn is_in_range(&self, value: &NaiveDate) -> bool {
        matches!(self, Self::Range(Some(a), Some(b)) if value >= a && value <= b)
    }

    /// A complete value in `format` (`chrono`'s, `"%Y/%m/%d"`), a range's
    /// ends joined by ` - `.
    pub fn format(&self, format: &str) -> Option<SharedString> {
        match self {
            Self::Single(Some(v)) => Some(v.format(format).to_string().into()),
            Self::Range(Some(a), Some(b)) => {
                Some(format!("{} - {}", a.format(format), b.format(format)).into())
            }
            _ => None,
        }
    }

    /// The same dates as a single date (`range == false`: a range's start)
    /// or as a range (a single date its start).
    pub(crate) fn shaped(self, range: bool) -> Self {
        match (self, range) {
            (Self::Single(v), true) => Self::Range(v, None),
            (Self::Range(v, _), false) => Self::Single(v),
            (date, _) => date,
        }
    }

    /// The value once `day` is picked (`CalendarState::select_date`): a
    /// range starts at it, or ends at it from an earlier start.
    pub(crate) fn picked(self, day: NaiveDate) -> Self {
        match self {
            Self::Single(_) => Self::Single(Some(day)),
            Self::Range(Some(start), None) if day >= start => Self::Range(Some(start), Some(day)),
            Self::Range(..) => Self::Range(Some(day), None),
        }
    }
}

/// An ISO date (`2026-10-28`).
pub(crate) fn parse_date(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d").ok()
}

/// `date` as an ISO date.
pub(crate) fn iso(date: NaiveDate) -> SharedString {
    date.format("%Y-%m-%d").to_string().into()
}

/// A JS date: an ISO string, or `null` / `undefined` for none.
fn date_from_js(value: JsIn<'_>) -> Result<Option<NaiveDate>, PropError> {
    if value.is_nullish() {
        return Ok(None);
    }
    value
        .as_string()
        .and_then(|s| parse_date(&s))
        .map(Some)
        .ok_or_else(|| value.expected("an ISO date (`2026-10-28`) or null"))
}

impl JsValue for Date {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("CalendarValue", |_| {
            "/** A calendar's value: an ISO date (`\"2026-10-28\"`), `[start, end]` for a range (either `null` while unset), `null` for none. */\nexport type CalendarValue = string | [string | null, string | null] | null;\n".to_owned()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if let Some(len) = value.array_len()? {
            if len != 2 {
                return Err(value.expected("`[start, end]`"));
            }
            let start = date_from_js(value.index(0)?.get())?;
            let end = date_from_js(value.index(1)?.get())?;
            return Ok(Self::Range(start, end));
        }
        date_from_js(value).map(Self::Single)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match *self {
            Self::Single(v) => v.map(iso).to_js(host),
            Self::Range(a, b) => vec![a.map(iso), b.map(iso)].to_js(host),
        }
    }
}

/// A calendar's `value` prop: left out, it keeps its own value; set, the
/// app's ([`Date`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CalendarValue {
    /// Not set: the calendar keeps its own value (from `defaultValue`).
    #[default]
    Uncontrolled,
    /// Set by the app.
    Controlled(Date),
}

impl<T: Into<Date>> From<T> for CalendarValue {
    fn from(value: T) -> Self {
        Self::Controlled(value.into())
    }
}

impl JsValue for CalendarValue {
    fn ts_type(types: &mut TsTypes) -> String {
        <Date as JsValue>::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::Undefined => Ok(Self::Uncontrolled),
            _ => <Date as JsValue>::from_js(value).map(Self::Controlled),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Self::Uncontrolled => Ok(JsOwned::new(host, host.undefined())),
            Self::Controlled(date) => date.to_js(host),
        }
    }
}

/// The dates a calendar does not let the user pick (`gpui-base`'s
/// `Matcher`). TS `DateMatcher`: days of the week (`[0, 6]`, Sunday 0),
/// `{ before, after }` (the days before `before` and after `after`), `{
/// from, to }` (the days from `from` to `to`, inclusive), or the app's
/// function of an ISO date, called once per shown date in the next JS
/// turn, and not again for it while it is the matcher (so it is pure: the
/// same date, the same answer).
#[derive(Clone)]
pub enum Matcher {
    /// The days of the week, `0` Sunday to `6` Saturday.
    DayOfWeek(Vec<u32>),
    /// The days before `before` and after `after`.
    Interval {
        /// The days before it.
        before: Option<NaiveDate>,
        /// The days after it.
        after: Option<NaiveDate>,
    },
    /// The days from `from` to `to`, inclusive (an unset end is open).
    Range {
        /// The first day.
        from: Option<NaiveDate>,
        /// The last day.
        to: Option<NaiveDate>,
    },
    /// A Rust function.
    Custom(Rc<dyn Fn(&NaiveDate) -> bool>),
    /// The app's JS function, asked in the next JS turn.
    Js(Callback<SharedString, bool>),
}

impl Matcher {
    /// The days before `before` and after `after`.
    pub fn interval(before: Option<NaiveDate>, after: Option<NaiveDate>) -> Self {
        Self::Interval { before, after }
    }

    /// The days from `from` to `to`, inclusive.
    pub fn range(from: Option<NaiveDate>, to: Option<NaiveDate>) -> Self {
        Self::Range { from, to }
    }

    /// The days `f` says.
    pub fn custom(f: impl Fn(&NaiveDate) -> bool + 'static) -> Self {
        Self::Custom(Rc::new(f))
    }

    /// Whether `date` is disabled; `None` for the app's JS function, which
    /// answers later.
    pub fn matched(&self, date: &NaiveDate) -> Option<bool> {
        Some(match self {
            Self::DayOfWeek(days) => days.contains(&date.weekday().num_days_from_sunday()),
            Self::Interval { before, after } => {
                before.is_some_and(|x| *date < x) || after.is_some_and(|x| *date > x)
            }
            Self::Range { from, to } => {
                !from.is_some_and(|x| *date < x) && !to.is_some_and(|x| *date > x)
            }
            Self::Custom(f) => f(date),
            Self::Js(_) => return None,
        })
    }
}

impl From<Vec<u32>> for Matcher {
    fn from(days: Vec<u32>) -> Self {
        Self::DayOfWeek(days)
    }
}

impl std::fmt::Debug for Matcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DayOfWeek(days) => f.debug_tuple("DayOfWeek").field(days).finish(),
            Self::Interval { before, after } => f
                .debug_struct("Interval")
                .field("before", before)
                .field("after", after)
                .finish(),
            Self::Range { from, to } => f
                .debug_struct("Range")
                .field("from", from)
                .field("to", to)
                .finish(),
            Self::Custom(_) => f.write_str("Custom"),
            Self::Js(_) => f.write_str("Js"),
        }
    }
}

/// Functions are told apart by what they answer, so a function set again
/// (an arrow function in JSX is a new one at each render) is asked again.
impl PartialEq for Matcher {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::DayOfWeek(a), Self::DayOfWeek(b)) => a == b,
            (
                Self::Interval {
                    before: a,
                    after: b,
                },
                Self::Interval {
                    before: c,
                    after: d,
                },
            ) => a == c && b == d,
            (Self::Range { from: a, to: b }, Self::Range { from: c, to: d }) => a == c && b == d,
            (Self::Custom(a), Self::Custom(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}

impl JsValue for Matcher {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("DateMatcher", |_| {
            "/** The dates a calendar does not let the user pick: days of the week (`[0, 6]`, Sunday 0), the days before `before` and after `after`, the days `from` `to` (inclusive), or a function of an ISO date (called once per shown date, in the next JS turn, and not again for that date: the same date, the same answer). */\nexport type DateMatcher = number[] | { before?: string | null; after?: string | null } | { from?: string | null; to?: string | null } | ((date: string) => boolean);\n".to_owned()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::Function => {
                return <Callback<SharedString, bool> as Arg>::from_js(value).map(Self::Js);
            }
            JsKind::Array | JsKind::Object => {}
            _ => return Err(value.expected("a `DateMatcher`")),
        }
        if let Some(len) = value.array_len()? {
            let mut days = Vec::with_capacity(len);
            for i in 0..len {
                let day = value.index(i)?;
                match day.get().as_number() {
                    Some(d) if (0.0..7.0).contains(&d) && d.fract() == 0.0 => days.push(d as u32),
                    _ => return Err(value.expected("days of the week, 0 (Sunday) to 6")),
                }
            }
            return Ok(Self::DayOfWeek(days));
        }
        let date = |key: &str| -> Result<Option<NaiveDate>, PropError> {
            let field = value.field(key)?;
            date_from_js(field.get())
        };
        let (from, to) = (date("from")?, date("to")?);
        if from.is_some() || to.is_some() {
            return Ok(Self::Range { from, to });
        }
        Ok(Self::Interval {
            before: date("before")?,
            after: date("after")?,
        })
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let object =
            || -> Result<JsOwned<'a>, PropError> { Ok(JsOwned::new(host, host.new_object()?)) };
        let set = |o: &JsOwned<'a>, key: &str, date: Option<NaiveDate>| -> Result<(), PropError> {
            let v = date.map(iso).to_js(host)?;
            host.set_field(o.get().raw(), key, v.into_raw())
        };
        match self {
            Self::DayOfWeek(days) => days.to_js(host),
            Self::Interval { before, after } => {
                let o = object()?;
                set(&o, "before", *before)?;
                set(&o, "after", *after)?;
                Ok(o)
            }
            Self::Range { from, to } => {
                let o = object()?;
                set(&o, "from", *from)?;
                set(&o, "to", *to)?;
                Ok(o)
            }
            // A function stays the app's: it is not handed back.
            Self::Custom(_) | Self::Js(_) => Ok(JsOwned::new(host, host.undefined())),
        }
    }
}

/// The years a calendar's year view pages through (TS `[start, end]`):
/// `start` included, `end` not (`gpui-base`'s `year_range`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct YearRange {
    /// The first year.
    pub start: i32,
    /// The year after the last.
    pub end: i32,
}

impl YearRange {
    /// The years from `start` to the one before `end`.
    pub fn new(start: i32, end: i32) -> Self {
        Self { start, end }
    }
}

impl JsValue for YearRange {
    fn ts_type(_types: &mut TsTypes) -> String {
        "[number, number]".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let year = |i: usize| -> Result<Option<i32>, PropError> {
            let v = value.index(i)?;
            Ok(v.get()
                .as_number()
                .filter(|n| n.fract() == 0.0 && n.abs() < 1e6)
                .map(|n| n as i32))
        };
        match (value.array_len()?, year(0)?, year(1)?) {
            (Some(2), Some(start), Some(end)) if start < end => Ok(Self { start, end }),
            _ => Err(value.expected("`[start, end]`, two years, the end after the start")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        vec![self.start, self.end].to_js(host)
    }
}

/// What a calendar's item is (`gpui-base`'s `CalendarItemKind`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum CalendarItemKind {
    /// The previous month, or page of years.
    Previous,
    /// The shown month: shows the month view (with several months, each
    /// month's title, which takes no press).
    MonthToggle,
    /// The shown year: shows the year view.
    YearToggle,
    /// The next month, or page of years.
    Next,
    /// A day of the week over the days.
    Weekday,
    /// A day.
    #[default]
    Day,
    /// A month of the month view.
    Month,
    /// A year of the year view.
    Year,
}

/// An item as `renderItem` draws it (`gpui-base`'s `CalendarItemState`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct CalendarItemState {
    /// What it is.
    pub kind: CalendarItemKind,
    /// Its number: the day of the month, the month (1 to 12), the year,
    /// the day of the week (`0` Sunday to `6`); `0` for Previous and Next.
    pub value: i32,
    /// A day's ISO date.
    #[prop(skip_none)]
    pub date: Option<SharedString>,
    /// The year of the month it belongs to (a day, a weekday, a toggle),
    /// else the shown one.
    pub year: i32,
    /// The month it belongs to, 1 to 12, else the shown one.
    pub month: u32,
    /// It is selected: the date or an end of the range, the shown month or
    /// year, the open view's toggle.
    pub active: bool,
    /// A day inside the complete range, its ends included.
    pub in_range: bool,
    /// Secondary: a weekday, a day of the month before or after, a disabled
    /// day.
    pub muted: bool,
    /// It takes no press: a disabled date, a weekday, Previous and Next in
    /// the month view or at the ends of the years.
    pub disabled: bool,
    /// The day is today.
    pub today: bool,
    /// The keyboard is on the day.
    pub focused: bool,
}

/// The props of [`Calendar`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CalendarProps {
    /// The value (controlled): the app owns it and sets it in `onChange`.
    /// Without it the calendar keeps its own value.
    #[prop(default)]
    pub value: Prop<CalendarValue>,
    /// The value at first, while `value` is not set.
    #[prop(default)]
    pub default_value: Prop<Date>,
    /// Pick a range: the first press starts it, the second ends it.
    #[prop(default)]
    pub range: Prop<bool>,
    /// How many months show side by side (`gpui-base`'s
    /// `number_of_months`), at least 1.
    #[prop(default = 1)]
    pub number_of_months: Prop<u32>,
    /// The day the weeks start on, `0` Sunday (the default) to `6`
    /// Saturday (`gpui-base`'s `first_day_of_week`).
    #[prop(default)]
    pub first_day_of_week: Prop<u32>,
    /// The dates that cannot be picked (`gpui-base`'s `disabled_matcher`).
    pub disabled_matcher: Prop<Option<Matcher>>,
    /// The years the year view pages through, `[start, end)` (default: 50
    /// years before this one to 50 after).
    pub year_range: Prop<Option<YearRange>>,
    /// What screen readers say for Previous.
    pub previous_accessibility_label: Prop<Option<SharedString>>,
    /// What screen readers say for Next.
    pub next_accessibility_label: Prop<Option<SharedString>>,
    /// The classes of the header: Previous, the toggles (or the months'
    /// titles), Next, in a row.
    pub header_class: Prop<Option<SharedString>>,
    /// The inline style of the header, over its classes.
    #[prop(default)]
    pub header_style: Prop<Style>,
    /// The classes of the body: the months side by side, or the month or
    /// year view's rows.
    pub body_class: Prop<Option<SharedString>>,
    /// The inline style of the body, over its classes.
    #[prop(default)]
    pub body_style: Prop<Style>,
    /// The classes of each month of the day view: its weekdays and weeks.
    pub month_class: Prop<Option<SharedString>>,
    /// The inline style of each month, over its classes.
    #[prop(default)]
    pub month_style: Prop<Style>,
    /// The classes of each row: the weekdays, a week, a row of months or
    /// years.
    pub row_class: Prop<Option<SharedString>>,
    /// The inline style of each row, over its classes.
    #[prop(default)]
    pub row_style: Prop<Style>,
    /// The classes of each item: `selected:` while active, `disabled:`
    /// while it takes no press, `focus:` with the keyboard on it.
    pub item_class: Prop<Option<SharedString>>,
    /// The inline style of each item, over its classes: its text styles
    /// too, which its number inherits.
    #[prop(default)]
    pub item_style: Prop<TextPartStyle>,
    /// Draws each item's content (`gpui-base`'s item slot): month and
    /// weekday names, today's mark, the range's band.
    pub render_item: Prop<Option<Renderer<CalendarItemState>>>,
}

/// The events of a [`Calendar`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum CalendarEvent {
    /// The user picked a complete value (`gpui-base`'s `Selected`): a day,
    /// or a range's end. A `value` the app passes is never reported.
    #[args(value)]
    Change(Date),
}

/// Which view the calendar shows (`gpui-base`'s `CalendarView`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Day,
    Month,
    Year,
}

/// The first day the weeks of `month` (the first of it) show, the weeks
/// starting on `first_day` (`0` Sunday).
fn first_shown(month: NaiveDate, first_day: u32) -> NaiveDate {
    let offset = (month.weekday().num_days_from_sunday() + 7 - first_day % 7) % 7;
    month - Days::new(offset as u64)
}

/// How many weeks show `month` (the first of it), starting on `first_day`:
/// four to six.
fn week_count(month: NaiveDate, first_day: u32) -> usize {
    let next = month + Months::new(1);
    (((next - first_shown(month, first_day)).num_days() + 6) / 7) as usize
}

/// The weeks that show `month` (the first of it), starting on
/// `first_day` (`0` Sunday): whole weeks, the days of the months around
/// it filling the first and the last.
pub(crate) fn weeks(month: NaiveDate, first_day: u32) -> Vec<[NaiveDate; 7]> {
    let start = first_shown(month, first_day);
    (0..week_count(month, first_day))
        .map(|w| std::array::from_fn(|d| start + Days::new((w * 7) as u64 + d as u64)))
        .collect()
}

/// Today where the app runs: the engine's clock in the local time zone.
pub(crate) fn today() -> NaiveDate {
    let ms = nsh_core::time::unix_ms();
    let utc = chrono::DateTime::from_timestamp_millis(ms as i64).unwrap_or_default();
    #[cfg(not(target_arch = "wasm32"))]
    {
        use chrono::TimeZone;
        chrono::Local
            .from_utc_datetime(&utc.naive_utc())
            .date_naive()
    }
    #[cfg(target_arch = "wasm32")]
    {
        #[link(wasm_import_module = "nsh")]
        unsafe extern "C" {
            /// The offset of local time at `ms` in seconds east of UTC
            /// (`nsh.js` `localOffset`, the browser's).
            fn local_offset(ms: f64) -> f64;
        }
        // SAFETY: a pure host function.
        let east = unsafe { local_offset(ms) };
        let east = if east.is_finite() { east as i64 } else { 0 };
        (utc + chrono::TimeDelta::try_seconds(east).unwrap_or_default()).date_naive()
    }
}

/// What a calendar's grid takes: the props of a `Calendar`, or the ones a
/// `DatePicker` passes on.
#[derive(Clone, Copy)]
pub(crate) struct Config {
    pub(crate) number_of_months: Prop<u32>,
    pub(crate) first_day_of_week: Prop<u32>,
    pub(crate) disabled_matcher: Prop<Option<Matcher>>,
    pub(crate) year_range: Prop<Option<YearRange>>,
    pub(crate) previous_accessibility_label: Prop<Option<SharedString>>,
    pub(crate) next_accessibility_label: Prop<Option<SharedString>>,
    pub(crate) header_class: Prop<Option<SharedString>>,
    pub(crate) header_style: Prop<Style>,
    pub(crate) body_class: Prop<Option<SharedString>>,
    pub(crate) body_style: Prop<Style>,
    pub(crate) month_class: Prop<Option<SharedString>>,
    pub(crate) month_style: Prop<Style>,
    pub(crate) row_class: Prop<Option<SharedString>>,
    pub(crate) row_style: Prop<Style>,
    pub(crate) item_class: Prop<Option<SharedString>>,
    pub(crate) item_style: Prop<TextPartStyle>,
    pub(crate) render_item: Prop<Option<Renderer<CalendarItemState>>>,
}

/// Where a key moves the keyboard from a day, the week starting on the
/// given day (`0` Sunday).
type Step = fn(NaiveDate, u32) -> Option<NaiveDate>;

/// A calendar's state (`gpui-base`'s `CalendarState`): what it shows and
/// the value as the user left it.
#[derive(Clone, Copy)]
pub(crate) struct Grid {
    config: Config,
    /// The value shown: the app's or the own one, and a half range the
    /// user started.
    pub(crate) shown: Signal<Date>,
    view: Signal<Mode>,
    /// The first shown month (its first day).
    page: Signal<NaiveDate>,
    /// The first year of the shown page of years.
    year_page: Signal<i32>,
    today: NaiveDate,
    /// The day the keyboard is on while the days have the focus.
    cursor: Signal<Option<NaiveDate>>,
    /// The day to give the focus to once it is made.
    focus_to: Signal<Option<NaiveDate>>,
    /// The days' stop of Tab as each day reads it ([`Grid::is_stop`]).
    stop_lit: Stored<[Signal<Option<NaiveDate>>; LIT]>,
    /// A day has the keyboard focus.
    days_focused: Signal<bool>,
    /// The cell with the keyboard focus (its month's offset times
    /// [`CELLS`], plus its place).
    focused_cell: Stored<Option<usize>>,
    /// A day asked for the focus while another has it: the other's blur is
    /// the keyboard moving, not leaving the days.
    moving: Stored<bool>,
    /// The days the app's JS function disabled (of every month it was
    /// asked about), read after [`Grid::js_answered`].
    js_disabled: Stored<HashSet<NaiveDate>>,
    /// Changes when the app's JS function's answers change.
    js_answered: Signal<u64>,
}

impl Grid {
    /// A grid showing `value` (tracked: a value the app sets turns the
    /// page to it, as `CalendarState::set_date`).
    pub(crate) fn new(config: Config, value: impl Fn() -> Date + 'static) -> Self {
        let today = today();
        let start = untracked(&value);
        let shown_month = start.start().unwrap_or(today).with_day(1).unwrap_or(today);
        let grid = Self {
            config,
            shown: signal(start),
            view: signal(Mode::Day),
            page: signal(shown_month),
            year_page: signal(0),
            today,
            cursor: signal(None),
            focus_to: signal(None),
            stop_lit: stored(std::array::from_fn(|_| signal(None))),
            days_focused: signal(false),
            focused_cell: stored(None),
            moving: stored(false),
            js_disabled: stored(HashSet::new()),
            js_answered: signal(0),
        };
        let first = stored(true);
        effect(move || {
            let date = value();
            if first.replace(false) {
                return;
            }
            untracked(|| grid.show(date));
        });
        grid.light_stop();
        grid.ask_js();
        grid
    }

    /// Keeps [`Grid::stop_lit`] on the stop: a move of it notifies the two
    /// days it leaves and reaches, not every day (Solid's
    /// `createSelector`).
    fn light_stop(self) {
        let stop = untracked(|| self.stop());
        self.lit_of(stop).set(Some(stop));
        let was = stored(stop);
        effect(move || {
            let stop = self.stop();
            let old = was.replace(stop);
            if old != stop {
                untracked(|| {
                    batch(|| {
                        self.lit_of(old).set(None);
                        self.lit_of(stop).set(Some(stop));
                    })
                });
            }
        });
    }

    /// The signal of [`Grid::stop_lit`] that holds `day` while it is the
    /// stop.
    fn lit_of(self, day: NaiveDate) -> Signal<Option<NaiveDate>> {
        let at = day.num_days_from_ce().rem_euclid(LIT as i32) as usize;
        self.stop_lit.with(|lit| lit[at])
    }

    /// Whether `day` is the days' stop of Tab (tracked: a move of the stop
    /// notifies only the days it leaves and reaches, with the days shown
    /// fewer than [`LIT`] apart).
    fn is_stop(self, day: NaiveDate) -> bool {
        self.lit_of(day).get() == Some(day)
    }

    /// Shows `date` as the value and turns to its month.
    pub(crate) fn show(self, date: Date) {
        self.shown.set(date);
        if let Some(start) = date.start() {
            self.page.set(start.with_day(1).unwrap_or(start));
        }
    }

    fn months(self) -> u32 {
        self.config.number_of_months.get().max(1)
    }

    fn years(self) -> YearRange {
        self.config.year_range.get().unwrap_or(YearRange {
            start: self.today.year() - 50,
            end: self.today.year() + 50,
        })
    }

    /// Whether `date` cannot be picked (tracked).
    fn disabled(self, date: NaiveDate) -> bool {
        self.config.disabled_matcher.with(|m| match m {
            None => false,
            Some(m) => m.matched(&date).unwrap_or_else(|| {
                self.js_answered.with(|_| ());
                self.js_disabled.with(|d| d.contains(&date))
            }),
        })
    }

    /// Asks the app's JS function about the shown days it was not asked
    /// about yet, all in the next JS turn: a turn of the months asks only
    /// the days that came. The function is pure, so its answers stay while
    /// it does; a new function is asked again.
    fn ask_js(self) {
        effect(move || {
            let Some(Matcher::Js(f)) = self.config.disabled_matcher.get() else {
                self.js_disabled.with(HashSet::clear);
                return;
            };
            // What this function was asked, and whether it answered yet:
            // its first answers replace the last function's.
            let asked = stored(HashSet::<NaiveDate>::new());
            let fresh = stored(true);
            // Its answers come in even once the months turned on.
            let owner = Owner::current();
            effect(move || {
                let page = self.page.get();
                let months = self.months();
                let first = self.config.first_day_of_week.get();
                let days: Vec<NaiveDate> = asked.with(|asked| {
                    (0..months)
                        .flat_map(|m| weeks(page + Months::new(m), first))
                        .flatten()
                        .filter(|d| asked.insert(*d))
                        .collect()
                });
                if days.is_empty() {
                    return;
                }
                let answers: Vec<_> = days.iter().map(|d| f.call_async(iso(*d))).collect();
                owner.run(|| {
                    spawn(async move {
                        let mut disabled = Vec::new();
                        for (day, answer) in days.into_iter().zip(answers) {
                            if answer.await.unwrap_or(false) {
                                disabled.push(day);
                            }
                        }
                        let cleared = fresh.replace(false)
                            && !self.js_disabled.with(std::mem::take).is_empty();
                        if cleared || !disabled.is_empty() {
                            self.js_disabled.with(|d| d.extend(disabled));
                            self.js_answered.update(|n| *n += 1);
                        }
                    });
                });
            });
        });
    }

    /// The user picked `day`: the new value, reported to `changed` once
    /// complete (`CalendarState::activate_date`).
    fn pick(self, day: NaiveDate, changed: &dyn Fn(Date)) {
        if untracked(|| self.disabled(day)) {
            return;
        }
        let next = self.shown.get_untracked().picked(day);
        self.show(next);
        if next.is_complete() {
            changed(next);
        }
    }

    /// The days are on screen: their month is shown.
    fn shows(self, day: NaiveDate) -> bool {
        let first = self.page.get_untracked();
        let last = first + Months::new(untracked(|| self.months()));
        day >= first && day < last
    }

    /// The day the days' stop of Tab is on: the keyboard's, else the
    /// selected one shown, else today, else the first shown.
    fn stop(self) -> NaiveDate {
        if let Some(day) = self.cursor.get() {
            return day;
        }
        let page = self.page.get();
        let last = page + Months::new(self.months());
        let shown = |d: &NaiveDate| *d >= page && *d < last;
        self.shown
            .with(|v| v.start())
            .filter(shown)
            .or(Some(self.today).filter(shown))
            .unwrap_or(page)
    }

    /// Gives the days' stop the keyboard focus once it is made (a date
    /// picker's popup opening on the desktops).
    pub(crate) fn focus_days(self) {
        self.focus_to.set(Some(untracked(|| self.stop())));
    }

    /// Moves the keyboard to `day`, turning the months to it.
    fn move_to(self, day: NaiveDate) {
        batch(|| {
            if !self.shows(day) {
                let first = self.page.get_untracked();
                let month = day.with_day(1).unwrap_or(day);
                self.page.set(if day < first {
                    month
                } else {
                    month - Months::new(untracked(|| self.months()) - 1)
                });
            }
            self.cursor.set(Some(day));
            self.focus_to.set(Some(day));
        });
    }

    /// The day keys while a day has the focus: bound when the focus comes
    /// to the days and kept while it moves among them.
    fn bind_keys(self, changed: Rc<dyn Fn(Date)>) {
        effect(move || {
            if !self.days_focused.get() {
                return;
            }
            let by = move |f: Step| {
                move |_: &str| {
                    let first_day = self.config.first_day_of_week.get_untracked();
                    let from = untracked(|| self.stop());
                    if let Some(day) = f(from, first_day) {
                        self.move_to(day);
                    }
                }
            };
            let keys: [(&str, Step); 10] = [
                ("left", |d, _| d.pred_opt()),
                ("right", |d, _| d.succ_opt()),
                ("up", |d, _| d.checked_sub_days(Days::new(7))),
                ("down", |d, _| d.checked_add_days(Days::new(7))),
                ("home", |d, f| {
                    let back = (d.weekday().num_days_from_sunday() + 7 - f % 7) % 7;
                    d.checked_sub_days(Days::new(back as u64))
                }),
                ("end", |d, f| {
                    let back = (d.weekday().num_days_from_sunday() + 7 - f % 7) % 7;
                    d.checked_add_days(Days::new(6 - back as u64))
                }),
                ("pageup", |d, _| d.checked_sub_months(Months::new(1))),
                ("pagedown", |d, _| d.checked_add_months(Months::new(1))),
                ("shift+pageup", |d, _| d.checked_sub_months(Months::new(12))),
                ("shift+pagedown", |d, _| {
                    d.checked_add_months(Months::new(12))
                }),
            ];
            for (key, f) in keys {
                on_key_with(
                    key,
                    KeyOptions {
                        when: When::NotEditing,
                        repeat: true,
                    },
                    by(f),
                );
            }
            for key in ["enter", "space"] {
                let changed = changed.clone();
                on_key_with(
                    key,
                    KeyOptions {
                        when: When::NotEditing,
                        repeat: false,
                    },
                    move |_| {
                        let day = untracked(|| self.stop());
                        self.pick(day, &*changed);
                    },
                );
            }
        });
    }
}

/// Makes a calendar: the header and the body of `grid`, reporting complete
/// values to `changed`.
pub(crate) fn calendar_view(grid: Grid, changed: Rc<dyn Fn(Date)>) -> Vec<AnyElement> {
    let config = grid.config;
    grid.bind_keys(changed.clone());
    // Leaving the days for the rest of the calendar forgets where the
    // keyboard was: the stop goes back to the selected day.
    effect(move || {
        if !grid.days_focused.get() {
            untracked(|| grid.cursor.set(None));
        }
    });

    let header = view()
        .flex_row()
        .items_center()
        .justify_between()
        .app_class(config.header_class)
        .inline_style(config.header_style)
        .child(nav(grid, CalendarItemKind::Previous))
        .child(dynamic(move || {
            let months = grid.months();
            if months == 1 {
                return vec![
                    toggle(grid, CalendarItemKind::MonthToggle),
                    toggle(grid, CalendarItemKind::YearToggle),
                ];
            }
            (0..months).map(|m| title(grid, m)).collect()
        }))
        .child(nav(grid, CalendarItemKind::Next));

    // Made again only when the view or the number of months changes: a
    // turn of the months or of the years changes what the items show.
    let body = dynamic(move || match grid.view.get() {
        Mode::Day => {
            let months = grid.months();
            let changed = changed.clone();
            view()
                .flex_row()
                .app_class(config.body_class)
                .inline_style(config.body_style)
                .children(
                    (0..months)
                        .map(|m| month(grid, m, changed.clone()))
                        .collect::<Vec<_>>(),
                )
                .into_element()
        }
        Mode::Month => rows(
            grid,
            (1..=12)
                .map(|m| picker_item(grid, CalendarItemKind::Month, m as usize))
                .collect(),
            MONTHS_PER_ROW,
        ),
        Mode::Year => year_view(grid),
    });
    vec![header.into_element(), body]
}

/// `items` in rows of `per_row`: the month view.
fn rows(grid: Grid, items: Vec<AnyElement>, per_row: usize) -> AnyElement {
    let config = grid.config;
    let mut rows = Vec::new();
    let mut items = items.into_iter().peekable();
    while items.peek().is_some() {
        let mut row: Vec<_> = items.by_ref().take(per_row).collect();
        // A short last row keeps the columns of the others.
        while row.len() < per_row {
            row.push(view().flex_1().into_element());
        }
        rows.push(
            view()
                .flex_row()
                .app_class(config.row_class)
                .inline_style(config.row_style)
                .children(row)
                .into_element(),
        );
    }
    view()
        .app_class(config.body_class)
        .inline_style(config.body_style)
        .children(rows)
        .into_element()
}

/// The year view: a page of years in rows of [`YEARS_PER_ROW`], each place
/// showing the year it holds on the page (a turn of the pages changes the
/// numbers); places past the last year are empty, and rows of them go.
fn year_view(grid: Grid) -> AnyElement {
    let config = grid.config;
    let end = computed(move || grid.years().end);
    let holds = move |at: usize| grid.year_page.get() + (at as i32) < end.get();
    let row = move |r: usize| {
        let first = r * YEARS_PER_ROW;
        view()
            .flex_row()
            .app_class(config.row_class)
            .inline_style(config.row_style)
            .children(
                (first..first + YEARS_PER_ROW)
                    .map(|at| {
                        // A short last row keeps the columns of the others.
                        when(
                            move || holds(at),
                            move || picker_item(grid, CalendarItemKind::Year, at),
                        )
                        .otherwise(|| view().flex_1())
                        .into_element()
                    })
                    .collect::<Vec<_>>(),
            )
    };
    view()
        .app_class(config.body_class)
        .inline_style(config.body_style)
        .children(
            (0..YEARS_PER_PAGE / YEARS_PER_ROW)
                .map(|r| match r {
                    // A page starts at a year of the range.
                    0 => row(r).into_element(),
                    _ => when(move || holds(r * YEARS_PER_ROW), move || row(r)).into_element(),
                })
                .collect::<Vec<_>>(),
        )
        .into_element()
}

/// The shown year and month, `offset` months on.
fn page_at(grid: Grid, offset: u32) -> NaiveDate {
    grid.page.get() + Months::new(offset)
}

/// An item that screen readers call `label`: the app's `renderItem` with
/// `state`, else `content` (the label when `None`). The app's function
/// draws nothing while `shown` says the item is hidden (a row of days the
/// month does not use).
fn item(
    grid: Grid,
    key: SharedString,
    state: Memo<CalendarItemState>,
    label: impl Fn() -> SharedString + 'static,
    content: Option<Rc<dyn Fn() -> SharedString>>,
    shown: Option<Memo<bool>>,
) -> View {
    let config = grid.config;
    let custom = computed(move || config.render_item.with(Option::is_some));
    let label = Rc::new(label);
    let content = content.unwrap_or_else(|| label.clone());
    view()
        .role(AccessibilityRole::Button)
        .disabled(move || state.with(|s| s.disabled))
        .accessibility_state(move || {
            state.with(|s| AccessibilityState {
                selected: s.active,
                disabled: s.disabled,
                ..AccessibilityState::default()
            })
        })
        .label(move || label())
        .app_class(config.item_class)
        .inline_style(move || config.item_style.get())
        .child(dynamic(move || {
            if custom.get() {
                let key = key.clone();
                return dynamic(move || {
                    if !shown.is_none_or(|shown| shown.get()) {
                        return None;
                    }
                    let render = config.render_item.get()?;
                    Some(render.render(key.clone(), state.get()))
                });
            }
            let content = content.clone();
            text(move || content()).into_element()
        }))
}

/// Previous or Next.
fn nav(grid: Grid, kind: CalendarItemKind) -> AnyElement {
    let config = grid.config;
    let previous = kind == CalendarItemKind::Previous;
    let disabled = computed(move || match grid.view.get() {
        Mode::Day => false,
        Mode::Month => true,
        Mode::Year => {
            let years = grid.years();
            let page = grid.year_page.get();
            if previous {
                page <= years.start
            } else {
                page + YEARS_PER_PAGE as i32 >= years.end
            }
        }
    });
    let state = computed(move || {
        let page = grid.page.get();
        CalendarItemState {
            kind,
            year: page.year(),
            month: page.month(),
            disabled: disabled.get(),
            ..CalendarItemState::default()
        }
    });
    let label = if previous {
        config.previous_accessibility_label
    } else {
        config.next_accessibility_label
    };
    let key: SharedString = if previous { "previous" } else { "next" }.into();
    item(
        grid,
        key,
        state,
        move || {
            label
                .get()
                .unwrap_or_else(|| if previous { "‹" } else { "›" }.into())
        },
        None,
        None,
    )
    .on_press(move || {
        if disabled.get_untracked() {
            return;
        }
        let step = |forward: bool| match grid.view.get_untracked() {
            Mode::Day => grid.page.update(|p| {
                *p = if forward {
                    *p + Months::new(1)
                } else {
                    *p - Months::new(1)
                }
            }),
            _ => grid.year_page.update(|p| {
                *p += if forward {
                    YEARS_PER_PAGE as i32
                } else {
                    -(YEARS_PER_PAGE as i32)
                }
            }),
        };
        step(!previous);
    })
    .into_element()
}

/// The month or the year toggle of a one-month calendar.
fn toggle(grid: Grid, kind: CalendarItemKind) -> AnyElement {
    let month = kind == CalendarItemKind::MonthToggle;
    let opens = if month { Mode::Month } else { Mode::Year };
    let state = computed(move || {
        let page = grid.page.get();
        CalendarItemState {
            kind,
            value: if month {
                page.month() as i32
            } else {
                page.year()
            },
            year: page.year(),
            month: page.month(),
            active: grid.view.get() == opens,
            ..CalendarItemState::default()
        }
    });
    let key: SharedString = if month { "month-toggle" } else { "year-toggle" }.into();
    item(
        grid,
        key,
        state,
        move || state.with(|s| s.value.to_string().into()),
        None,
        None,
    )
    .on_press(move || {
        let next = if grid.view.get_untracked() == opens {
            Mode::Day
        } else {
            opens
        };
        if next == Mode::Year {
            // The page of years with the shown one.
            let years = grid.years();
            let year = grid
                .page
                .get_untracked()
                .year()
                .clamp(years.start, years.end - 1);
            let page =
                years.start + (year - years.start) / YEARS_PER_PAGE as i32 * YEARS_PER_PAGE as i32;
            grid.year_page.set(page);
        }
        grid.view.set(next);
    })
    .into_element()
}

/// The title of month `offset` of a calendar of several: a month toggle
/// that takes no press (`gpui-base` shows each month's label there).
fn title(grid: Grid, offset: u32) -> AnyElement {
    let state = computed(move || {
        let page = page_at(grid, offset);
        CalendarItemState {
            kind: CalendarItemKind::MonthToggle,
            value: page.month() as i32,
            year: page.year(),
            month: page.month(),
            disabled: true,
            ..CalendarItemState::default()
        }
    });
    item(
        grid,
        format!("title-{offset}").into(),
        state,
        move || state.with(|s| format!("{} {}", s.month, s.year).into()),
        None,
        None,
    )
    .into_element()
}

/// A month of the month view (`at` its number), or the year at place `at`
/// of the year view's page.
fn picker_item(grid: Grid, kind: CalendarItemKind, at: usize) -> AnyElement {
    let is_month = kind == CalendarItemKind::Month;
    let value = move || {
        if is_month {
            at as i32
        } else {
            grid.year_page.get() + at as i32
        }
    };
    let state = computed(move || {
        let page = grid.page.get();
        let value = value();
        CalendarItemState {
            kind,
            value,
            year: if is_month { page.year() } else { value },
            month: if is_month { value as u32 } else { page.month() },
            active: if is_month {
                page.month() as i32 == value
            } else {
                page.year() == value
            },
            ..CalendarItemState::default()
        }
    });
    let key: SharedString = format!("{}-{at}", if is_month { "month" } else { "year" }).into();
    item(
        grid,
        key,
        state,
        move || state.with(|s| s.value.to_string().into()),
        None,
        None,
    )
    .flex_1()
    .on_press(move || {
        let value = untracked(value);
        grid.page.update(|p| {
            let (year, month) = if is_month {
                (p.year(), value as u32)
            } else {
                (value, p.month())
            };
            *p = NaiveDate::from_ymd_opt(year, month, 1).unwrap_or(*p);
        });
        grid.view.set(Mode::Day);
    })
    .into_element()
}

/// Month `offset` of the day view: the weekdays over [`WEEKS`] rows of
/// cells. A turn of the months changes the dates the cells show (and hides
/// the rows past the month's weeks): it makes and drops no view.
fn month(grid: Grid, offset: u32, changed: Rc<dyn Fn(Date)>) -> AnyElement {
    let config = grid.config;
    let first_day = config.first_day_of_week;
    // The month (its first day), and the first day its weeks show.
    let page = computed(move || page_at(grid, offset));
    let start = computed(move || first_shown(page.get(), first_day.get()));
    let count = computed(move || week_count(page.get(), first_day.get()));
    let row = move || {
        view()
            .flex_row()
            .app_class(config.row_class)
            .inline_style(config.row_style)
    };
    let weekdays = row().children(
        (0..7)
            .map(|at| weekday(grid, page, offset, at))
            .collect::<Vec<_>>(),
    );
    let weeks = (0..WEEKS)
        .map(|w| {
            let shown = (w >= MIN_WEEKS).then(|| computed(move || w < count.get()));
            let week = row().children(
                (0..7)
                    .map(|d| {
                        let at = w * 7 + d;
                        let cell = Cell {
                            page,
                            start,
                            at,
                            id: offset as usize * CELLS + at,
                            shown,
                        };
                        day(grid, cell, changed.clone())
                    })
                    .collect::<Vec<_>>(),
            );
            match shown {
                Some(shown) => week.style_when(move || !shown.get(), |s| s.hidden()),
                None => week,
            }
            .into_element()
        })
        .collect::<Vec<_>>();
    view()
        .flex_1()
        .app_class(config.month_class)
        .inline_style(config.month_style)
        .child(weekdays)
        .children(weeks)
        .into_element()
}

/// The weekday at place `at` of month `offset`'s weekdays.
fn weekday(grid: Grid, page: Memo<NaiveDate>, offset: u32, at: u32) -> AnyElement {
    let first_day = grid.config.first_day_of_week;
    let day = computed(move || ((first_day.get() + at) % 7) as i32);
    let state = computed(move || {
        let page = page.get();
        CalendarItemState {
            kind: CalendarItemKind::Weekday,
            value: day.get(),
            year: page.year(),
            month: page.month(),
            muted: true,
            disabled: true,
            ..CalendarItemState::default()
        }
    });
    item(
        grid,
        format!("weekday-{offset}-{at}").into(),
        state,
        move || day.get().to_string().into(),
        None,
        None,
    )
    .flex_1()
    .into_element()
}

/// Where a day cell is: its month, the first day the month's weeks show,
/// its place among the month's cells and its id among the calendar's.
#[derive(Clone, Copy)]
struct Cell {
    page: Memo<NaiveDate>,
    start: Memo<NaiveDate>,
    at: usize,
    id: usize,
    /// Whether its row shows, for a row a month may not use.
    shown: Option<Memo<bool>>,
}

/// A day cell: the date at its place of its month's weeks, whichever month
/// shows.
fn day(grid: Grid, cell: Cell, changed: Rc<dyn Fn(Date)>) -> AnyElement {
    let Cell {
        page,
        start,
        at,
        id,
        shown,
    } = cell;
    let date = computed(move || start.get() + Days::new(at as u64));
    // Not a day of the month around it, which that month shows as its own.
    let own = computed(move || date.get().month() == page.with(NaiveDate::month));
    let label = computed(move || iso(date.get()));
    let disabled = computed(move || grid.disabled(date.get()));
    let is_stop = computed(move || own.get() && grid.is_stop(date.get()));
    // What the value makes of the day: a pick checks every day, and makes
    // the state again only of those it changed.
    let marks = computed(move || {
        let date = date.get();
        grid.shown
            .with(|v| (v.is_active(&date), v.is_in_range(&date)))
    });
    let state = computed(move || {
        let (active, in_range) = marks.get();
        let (date, page, disabled) = (date.get(), page.get(), disabled.get());
        CalendarItemState {
            kind: CalendarItemKind::Day,
            value: date.day() as i32,
            date: Some(label.get()),
            year: page.year(),
            month: page.month(),
            active,
            in_range,
            muted: !own.get() || disabled,
            disabled,
            today: date == grid.today,
            focused: grid.days_focused.get() && is_stop.get(),
        }
    });
    let me = element_ref();
    let laid_out = signal(false);
    // The keyboard comes here once the day is laid out: a ref reaches its
    // view only once it is made, and a popup's only once it is placed.
    // Only the stop reads the request.
    effect(move || {
        if !laid_out.get() || !is_stop.get() || grid.focus_to.get() != Some(date.get_untracked()) {
            return;
        }
        untracked(|| {
            grid.focus_to.set(None);
            let held = grid.focused_cell.get();
            if held == Some(id) {
                // The months turned under the cell with the focus.
                return;
            }
            if held.is_some() && !disabled.get() {
                grid.moving.replace(true);
            }
            me.focus();
        });
    });
    // Screen readers hear the whole date (`gpui-base`'s `aria_label`).
    item(
        grid,
        format!("day-{id}").into(),
        state,
        move || label.get(),
        Some(Rc::new(move || date.get().day().to_string().into())),
        shown,
    )
    .flex_1()
    .element_ref(&me)
    .on_layout(move |_: &Bounds<Points>| {
        if !laid_out.get_untracked() {
            laid_out.set(true);
        }
    })
    .focusable(move || is_stop.get() && !disabled.get())
    .on_focus(move || {
        grid.moving.replace(false);
        grid.focused_cell.replace(Some(id));
        batch(|| {
            grid.days_focused.set(true);
            grid.cursor.set(Some(date.get_untracked()));
        });
    })
    .on_blur(move || {
        match grid.focused_cell.get() {
            // Another day has the focus already.
            Some(held) if held != id => return,
            _ => grid.focused_cell.replace(None),
        };
        // The keyboard moves to another day, whose focus comes next: the
        // keys stay bound.
        if grid.moving.replace(false) {
            return;
        }
        grid.days_focused.set(false);
    })
    .on_press(move || grid.pick(date.get_untracked(), &*changed))
    .into_element()
}
/// A month's days to pick a date or a range from (`gpui-base`'s
/// `Calendar`): a header with Previous, the month and year toggles (or the
/// months' titles) and Next over the weekdays and weeks of
/// `numberOfMonths` months; the toggles show the months of the year or a
/// page of years to pick from. The value is `value` and `onChange` (or the
/// calendar's own, from `defaultValue`): one date, or with `range` a start
/// and an end; `disabledMatcher` says which dates cannot be picked. The
/// arrows, Home, End and Page Up / Down move among the days, Return and
/// Space pick. It looks like nothing: the app styles the parts or draws the
/// items (`renderItem`).
#[component]
pub fn Calendar(props: CalendarProps, cx: Scope<CalendarEvent>) -> impl IntoElement {
    let own = signal(
        props
            .default_value
            .get_untracked()
            .shaped(props.range.get_untracked()),
    );
    let value = move || {
        match props.value.get() {
            CalendarValue::Controlled(date) => date,
            CalendarValue::Uncontrolled => own.get(),
        }
        .shaped(props.range.get())
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
    let grid = Grid::new(config, value);
    let changed: Rc<dyn Fn(Date)> = Rc::new(move |date| {
        if matches!(props.value.get_untracked(), CalendarValue::Uncontrolled) {
            own.set(date);
        }
        cx.emit(CalendarEvent::Change(date));
    });
    view().children(calendar_view(grid, changed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn a_range_starts_ends_and_starts_again() {
        let (a, b) = (d(2025, 2, 10), d(2025, 2, 12));
        let v = Date::Range(None, None).picked(a);
        assert_eq!(v, Date::Range(Some(a), None));
        let v = v.picked(b);
        assert_eq!(v, Date::Range(Some(a), Some(b)));
        assert_eq!(v.picked(a), Date::Range(Some(a), None));
        // An earlier day than the start starts the range there.
        assert_eq!(
            Date::Range(Some(b), None).picked(a),
            Date::Range(Some(a), None)
        );
    }

    #[test]
    fn six_week_months_are_whole_and_weeks_start_on_the_first_day() {
        // August 2025 starts on a Friday: six weeks from Sunday.
        let w = weeks(d(2025, 8, 1), 0);
        assert_eq!(w.len(), 6);
        assert_eq!(w[0][0], d(2025, 7, 27));
        assert_eq!(w[5][0], d(2025, 8, 31));
        // From Monday the same month takes five.
        let w = weeks(d(2025, 8, 1), 1);
        assert_eq!(w.len(), 5);
        assert_eq!(w[0][0], d(2025, 7, 28));
        assert_eq!(w[4][6], d(2025, 8, 31));
    }

    #[test]
    fn matchers_disable_what_they_say() {
        let sunday = d(2026, 10, 25);
        assert_eq!(Matcher::DayOfWeek(vec![0, 6]).matched(&sunday), Some(true));
        assert_eq!(Matcher::DayOfWeek(vec![6]).matched(&sunday), Some(false));
        let i = Matcher::interval(Some(d(2026, 10, 10)), Some(d(2026, 10, 20)));
        assert_eq!(i.matched(&d(2026, 10, 9)), Some(true));
        assert_eq!(i.matched(&d(2026, 10, 10)), Some(false));
        assert_eq!(i.matched(&d(2026, 10, 21)), Some(true));
        let r = Matcher::range(Some(d(2026, 10, 10)), None);
        assert_eq!(r.matched(&d(2026, 10, 9)), Some(false));
        assert_eq!(r.matched(&d(2030, 1, 1)), Some(true));
    }
}
