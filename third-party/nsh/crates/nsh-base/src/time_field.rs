//! `TimeField`: a time of day edited a segment at a time (the hour, the
//! minute, the second, AM / PM), with no look of its own (`gpui-base`'s
//! `TimeField` and `TimeFieldState`).
//!
//! - **The editing rules** are `gpui-base`'s (`SegmentEditor`): one segment
//!   is selected; Up / Down step it and wrap within it (no carry into the
//!   next unit); Left / Right and Tab / Shift+Tab move between segments (Tab
//!   leaves the field from the last one); digits are typed with a two-digit
//!   buffer that moves to the next segment once no further digit could fit;
//!   `a` / `p` set AM / PM; Backspace and Delete reset the segment.
//! - **One native text field**, transparent and behind the segments, owns
//!   the keyboard, as `OtpInput`'s does: the platforms' typing, the numeric
//!   keypad on phones and the field screen readers know, its text the time
//!   as it shows. What the field gains (digits, `a`, `p`) or loses goes to
//!   the selected segment; then the field holds the time again.
//! - **A press** on a segment selects it and focuses the field; on the
//!   selected AM / PM it switches them (a phone's keypad has no `a` / `p`).
//!   A press elsewhere on the field selects the first.
//! - **The value** is `value` and `onChange({ value })`, `"HH:MM"` or
//!   `"HH:MM:SS"` (24-hour, whatever the field shows), or the field's own
//!   from `defaultValue`. A value the app sets is shown unless it is the
//!   user's change coming back (a key or more behind, as `OtpInput`'s).

use std::rc::Rc;

use chrono::{NaiveTime, Timelike};
use nsh_core::{
    element::{JsHost, JsIn, JsOwned, JsValue, PropError, TextPartStyle, TsTypes, input},
    keymap::When,
    prelude::*,
};

use crate::otp_input::{diff, digit, echoed, utf16_len};

/// The smallest unit a [`TimeField`] edits (`gpui-base`'s
/// `TimePrecision`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum TimePrecision {
    /// Hours and minutes, `09:30`.
    #[default]
    Minute,
    /// Hours, minutes and seconds, `09:30:15`.
    Second,
}

impl TimePrecision {
    /// The `chrono` format that shows a time at this precision and cycle.
    pub fn format(self, hour_cycle: HourCycle) -> &'static str {
        match (self, hour_cycle) {
            (Self::Minute, HourCycle::H23) => "%H:%M",
            (Self::Second, HourCycle::H23) => "%H:%M:%S",
            (Self::Minute, HourCycle::H12) => "%I:%M %p",
            (Self::Second, HourCycle::H12) => "%I:%M:%S %p",
        }
    }

    /// `time` without the parts finer than this precision.
    pub fn truncate(self, time: NaiveTime) -> NaiveTime {
        let second = match self {
            Self::Minute => 0,
            Self::Second => time.second(),
        };
        NaiveTime::from_hms_opt(time.hour(), time.minute(), second).unwrap_or(time)
    }
}

/// How a [`TimeField`] counts the hours (`gpui-base`'s `HourCycle`, the
/// Unicode `hourCycle` values).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum HourCycle {
    /// `00` to `23`.
    #[default]
    H23,
    /// `12` to `11`, with an AM / PM segment.
    H12,
}

/// One segment of a [`TimeField`] (`gpui-base`'s `TimeSegment`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum TimeSegment {
    /// The hour.
    #[default]
    Hour,
    /// The minute.
    Minute,
    /// The second.
    Second,
    /// AM or PM, with [`HourCycle::H12`].
    Period,
}

/// A time of day as JS passes it (TS `string`): `"HH:MM"` or
/// `"HH:MM:SS"`, 24-hour.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TimeOfDay(pub NaiveTime);

impl From<NaiveTime> for TimeOfDay {
    fn from(time: NaiveTime) -> Self {
        Self(time)
    }
}

/// `"HH:MM"` or `"HH:MM:SS"`.
pub(crate) fn parse_time(text: &str) -> Option<NaiveTime> {
    let text = text.trim();
    NaiveTime::parse_from_str(text, "%H:%M:%S")
        .or_else(|_| NaiveTime::parse_from_str(text, "%H:%M"))
        .ok()
}

/// `time` as `"HH:MM"`, with its seconds at [`TimePrecision::Second`].
pub(crate) fn format_time(time: NaiveTime, precision: TimePrecision) -> SharedString {
    let format = match precision {
        TimePrecision::Minute => "%H:%M",
        TimePrecision::Second => "%H:%M:%S",
    };
    time.format(format).to_string().into()
}

impl JsValue for TimeOfDay {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        value
            .as_string()
            .and_then(|s| parse_time(&s))
            .map(Self)
            .ok_or_else(|| value.expected("a time of day (`09:30`, `09:30:15`)"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let precision = if self.0.second() == 0 {
            TimePrecision::Minute
        } else {
            TimePrecision::Second
        };
        format_time(self.0, precision).to_js(host)
    }
}

/// A segment as `renderSegment` draws it (`gpui-base`'s
/// `TimeFieldSegmentState`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct TimeFieldSegmentState {
    /// Which segment it is.
    pub segment: TimeSegment,
    /// Its value: the hour on the field's clock, the minute or the second,
    /// `0` for AM and `1` for PM.
    pub value: u32,
    /// What it shows: two digits, or `AM` / `PM`.
    pub label: SharedString,
    /// The keys edit it: it is the selected segment and the field has the
    /// focus.
    pub selected: bool,
    /// The field is disabled.
    pub disabled: bool,
}

/// The editing rules of a time field (`gpui-base`'s `SegmentEditor`),
/// apart from the focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SegmentEditor {
    pub(crate) time: NaiveTime,
    precision: TimePrecision,
    hour_cycle: HourCycle,
    pub(crate) segment: TimeSegment,
    /// The first digit typed into the selected segment, awaiting a second.
    pending_digit: Option<u32>,
}

impl SegmentEditor {
    pub(crate) fn new(time: NaiveTime, precision: TimePrecision, hour_cycle: HourCycle) -> Self {
        Self {
            time: precision.truncate(time),
            precision,
            hour_cycle,
            segment: TimeSegment::Hour,
            pending_digit: None,
        }
    }

    /// The segments shown, in reading order.
    pub(crate) fn segments(&self) -> &'static [TimeSegment] {
        use TimeSegment::*;
        match (self.precision, self.hour_cycle) {
            (TimePrecision::Minute, HourCycle::H23) => &[Hour, Minute],
            (TimePrecision::Second, HourCycle::H23) => &[Hour, Minute, Second],
            (TimePrecision::Minute, HourCycle::H12) => &[Hour, Minute, Period],
            (TimePrecision::Second, HourCycle::H12) => &[Hour, Minute, Second, Period],
        }
    }

    /// The range a segment's shown value takes, inclusive.
    fn bounds(&self, segment: TimeSegment) -> (u32, u32) {
        match (segment, self.hour_cycle) {
            (TimeSegment::Hour, HourCycle::H23) => (0, 23),
            (TimeSegment::Hour, HourCycle::H12) => (1, 12),
            (TimeSegment::Minute | TimeSegment::Second, _) => (0, 59),
            (TimeSegment::Period, _) => (0, 1),
        }
    }

    /// A segment's shown value: the hour on the cycle, `0` AM and `1` PM.
    pub(crate) fn value(&self, segment: TimeSegment) -> u32 {
        let hour = self.time.hour();
        match (segment, self.hour_cycle) {
            (TimeSegment::Hour, HourCycle::H23) => hour,
            (TimeSegment::Hour, HourCycle::H12) => (hour + 11) % 12 + 1,
            (TimeSegment::Minute, _) => self.time.minute(),
            (TimeSegment::Second, _) => self.time.second(),
            (TimeSegment::Period, _) => hour / 12,
        }
    }

    pub(crate) fn label(&self, segment: TimeSegment) -> SharedString {
        match segment {
            TimeSegment::Period if self.value(segment) == 0 => "AM".into(),
            TimeSegment::Period => "PM".into(),
            _ => format!("{:02}", self.value(segment)).into(),
        }
    }

    fn with_value(&self, segment: TimeSegment, value: u32) -> NaiveTime {
        let time = self.time;
        let pm_offset = time.hour() / 12 * 12;
        match (segment, self.hour_cycle) {
            (TimeSegment::Hour, HourCycle::H23) => time.with_hour(value),
            // 12 AM is midnight and 12 PM is noon.
            (TimeSegment::Hour, HourCycle::H12) => time.with_hour(value % 12 + pm_offset),
            (TimeSegment::Minute, _) => time.with_minute(value),
            (TimeSegment::Second, _) => time.with_second(value),
            (TimeSegment::Period, _) => time.with_hour(time.hour() % 12 + value * 12),
        }
        .unwrap_or(time)
    }

    pub(crate) fn set_format(&mut self, precision: TimePrecision, hour_cycle: HourCycle) {
        self.precision = precision;
        self.hour_cycle = hour_cycle;
        self.time = precision.truncate(self.time);
        if !self.segments().contains(&self.segment) {
            self.segment = TimeSegment::Hour;
        }
        self.pending_digit = None;
    }

    /// Shows `time`; a half-typed segment stays when it is the same.
    pub(crate) fn set_time(&mut self, time: NaiveTime) -> bool {
        let time = self.precision.truncate(time);
        if self.time == time {
            return false;
        }
        self.time = time;
        self.pending_digit = None;
        true
    }

    pub(crate) fn select_segment(&mut self, segment: TimeSegment) -> bool {
        if !self.segments().contains(&segment) {
            return false;
        }
        self.segment = segment;
        self.pending_digit = None;
        true
    }

    /// Moves the selection by `offset`; `false` at either end.
    pub(crate) fn move_segment(&mut self, offset: isize) -> bool {
        let segments = self.segments();
        let ix = segments
            .iter()
            .position(|s| *s == self.segment)
            .unwrap_or(0);
        let Some(next) = ix
            .checked_add_signed(offset)
            .and_then(|ix| segments.get(ix))
        else {
            return false;
        };
        self.select_segment(*next)
    }

    /// Steps the selected segment by `delta`, wrapping within it.
    pub(crate) fn step(&mut self, delta: i32) -> bool {
        self.pending_digit = None;
        let (min, max) = self.bounds(self.segment);
        let span = (max - min + 1) as i32;
        let value = (self.value(self.segment) as i32 - min as i32 + delta).rem_euclid(span);
        self.replace_segment(value as u32 + min)
    }

    pub(crate) fn input_digit(&mut self, digit: u32) -> bool {
        if self.segment == TimeSegment::Period {
            return false;
        }
        let (min, max) = self.bounds(self.segment);
        let (value, complete) = match self.pending_digit.take() {
            Some(first) if (min..=max).contains(&(first * 10 + digit)) => {
                (first * 10 + digit, true)
            }
            // The two digits make no valid value: the new one starts over.
            _ => (digit, digit * 10 > max),
        };
        if !complete {
            self.pending_digit = Some(digit);
        }
        let changed = self.replace_segment(value);
        if complete {
            self.move_segment(1);
        }
        changed
    }

    /// `a` or `p` typed into the AM / PM segment.
    pub(crate) fn input_period(&mut self, pm: bool) -> bool {
        if self.segment != TimeSegment::Period {
            return false;
        }
        self.replace_segment(pm as u32)
    }

    /// Resets the selected segment: zero, or `12` / AM on a 12-hour clock.
    pub(crate) fn clear_segment(&mut self) -> bool {
        self.pending_digit = None;
        self.replace_segment(0)
    }

    fn replace_segment(&mut self, value: u32) -> bool {
        let time = self.with_value(self.segment, value);
        let changed = time != self.time;
        self.time = time;
        changed
    }
}

/// The props of [`TimeField`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TimeFieldProps {
    /// The time (controlled): the app owns it and sets it in `onChange`.
    /// Without it the field keeps its own.
    pub value: Prop<Option<TimeOfDay>>,
    /// The time at first, while `value` is not set (default `00:00`).
    #[prop(default)]
    pub default_value: Prop<TimeOfDay>,
    /// The smallest unit it edits (default `"minute"`).
    #[prop(default)]
    pub precision: Prop<TimePrecision>,
    /// How it counts the hours (default `"h23"`).
    #[prop(default)]
    pub hour_cycle: Prop<HourCycle>,
    /// No focus and no editing; `disabled:` styles apply to the field and
    /// its segments, and screen readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers call the field.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The classes of each segment: `focus:` on the selected one while the
    /// field has the focus, `disabled:` with the field.
    pub segment_class: Prop<Option<SharedString>>,
    /// The inline style of each segment, over its classes: its text styles
    /// too, which its label inherits.
    #[prop(default)]
    pub segment_style: Prop<TextPartStyle>,
    /// The classes of the `:` between the numbers.
    pub separator_class: Prop<Option<SharedString>>,
    /// The inline style of each `:`, over its classes.
    #[prop(default)]
    pub separator_style: Prop<TextPartStyle>,
    /// Draws each segment's content (`gpui-base`'s `render_segment`).
    pub render_segment: Prop<Option<Renderer<TimeFieldSegmentState>>>,
}

/// The events of a [`TimeField`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum TimeFieldEvent {
    /// The user changed the time (`gpui-base`'s `Change`). A `value` the
    /// app passes is never reported.
    #[args(value)]
    Change(TimeOfDay),
}

/// What a time field takes: the props of a `TimeField`, or the ones a
/// `DatePicker` passes on.
#[derive(Clone, Copy)]
pub(crate) struct FieldConfig {
    pub(crate) precision: Prop<TimePrecision>,
    pub(crate) hour_cycle: Prop<HourCycle>,
    pub(crate) disabled: Prop<bool>,
    pub(crate) accessibility_label: Prop<Option<SharedString>>,
    pub(crate) segment_class: Prop<Option<SharedString>>,
    pub(crate) segment_style: Prop<TextPartStyle>,
    pub(crate) separator_class: Prop<Option<SharedString>>,
    pub(crate) separator_style: Prop<TextPartStyle>,
    pub(crate) render_segment: Prop<Option<Renderer<TimeFieldSegmentState>>>,
}

/// Applies an edit to the shown time, reporting it when it changed it.
type Edit = Rc<dyn Fn(&dyn Fn(&mut SegmentEditor) -> bool)>;

/// How many reported times the field waits to see come back as `value`.
const ECHOES: usize = 16;

/// A time field's content: its segments over its native field, showing
/// `time` (tracked; the app's) and reporting the user's edits to
/// `changed`.
pub(crate) fn field(
    config: FieldConfig,
    time: impl Fn() -> NaiveTime + 'static,
    changed: Rc<dyn Fn(NaiveTime)>,
) -> Vec<AnyElement> {
    let editor = signal(SegmentEditor::new(
        untracked(&time),
        config.precision.get_untracked(),
        config.hour_cycle.get_untracked(),
    ));
    let shown =
        move || editor.with(|e| e.time.format(e.precision.format(e.hour_cycle)).to_string());
    // What the native field holds: the time as it shows, or what the user
    // just typed until it is taken back to that.
    let text_now = signal(untracked(shown));
    let correction = stored(None::<Spawned<()>>);
    let echoes = stored(Vec::<String>::new());
    let focused = signal(false);
    let field_ref = element_ref();

    effect(move || {
        let (precision, cycle) = (config.precision.get(), config.hour_cycle.get());
        untracked(|| editor.update(|e| e.set_format(precision, cycle)));
    });
    // A time the app sets shows unless it is the user's own coming back.
    effect(move || {
        let t = time();
        untracked(|| {
            let key = t.to_string();
            if echoes.with(|e| echoed(e, &key)) {
                return;
            }
            echoes.with(Vec::clear);
            editor.update(|e| {
                e.set_time(t);
            });
        });
    });
    // The field's text follows the time shown.
    effect(move || {
        let now = shown();
        untracked(|| {
            if text_now.get() != now {
                text_now.set(now);
            }
        });
    });

    let edit: Edit = Rc::new(move |f| {
        let mut e = editor.get_untracked();
        let did = f(&mut e);
        editor.set(e);
        if did {
            let key = e.time.to_string();
            echoes.with(|echoes| {
                if echoes.len() == ECHOES {
                    echoes.remove(0);
                }
                echoes.push(key);
            });
            changed(e.time);
        }
    });

    // What the user typed into the native field goes to the segment.
    let typed = {
        let edit = edit.clone();
        move |text: &str| {
            if let Some(task) = correction.replace(None) {
                task.cancel();
            }
            let before = text_now.get_untracked();
            let (deleted, inserted) = diff(&before, text);
            if inserted.is_empty() && deleted > 0 {
                edit(&SegmentEditor::clear_segment);
            }
            for c in inserted.chars() {
                if let Some(d) = digit(c) {
                    let d = d as u32 - '0' as u32;
                    edit(&move |e: &mut SegmentEditor| e.input_digit(d));
                } else if matches!(c, 'a' | 'A' | 'p' | 'P') {
                    let pm = matches!(c, 'p' | 'P');
                    edit(&move |e: &mut SegmentEditor| e.input_period(pm));
                }
            }
            // Back to the time as it shows: through the typed text first, in a
            // run of its own, so the binding sends it even when the time is
            // the same.
            let now = untracked(shown);
            text_now.set(text.to_owned());
            let task = spawn(async move {
                text_now.set(now.clone());
                field_ref.set_selection(utf16_len(&now), utf16_len(&now));
            });
            correction.replace(Some(task));
        }
    };

    // The keys while the field has the focus: bound again only when the
    // focus or `disabled` change, not on every edit.
    let keys_edit = edit.clone();
    effect(move || {
        if !focused.get() || config.disabled.get() {
            return;
        }
        let up = keys_edit.clone();
        bind_key("up", true, move || up(&|e| e.step(1)));
        let down = keys_edit.clone();
        bind_key("down", true, move || down(&|e| e.step(-1)));
        bind_key("left", true, move || {
            editor.update(|e| {
                e.move_segment(-1);
            })
        });
        bind_key("right", true, move || {
            editor.update(|e| {
                e.move_segment(1);
            })
        });
    });
    // Tab walks the segments, and leaves the field from the last one (the
    // first one for Shift+Tab): unbound there. Bound again only when the
    // selection reaches or leaves an end.
    let ends = computed(move || {
        editor.with(|e| {
            let segments = e.segments();
            (
                segments.first() == Some(&e.segment),
                segments.last() == Some(&e.segment),
            )
        })
    });
    effect(move || {
        if !focused.get() || config.disabled.get() {
            return;
        }
        let (first, last) = ends.get();
        if !last {
            bind_key("tab", false, move || {
                editor.update(|e| {
                    e.move_segment(1);
                })
            });
        }
        if !first {
            bind_key("shift+tab", false, move || {
                editor.update(|e| {
                    e.move_segment(-1);
                })
            });
        }
    });

    let native = input()
        .element_ref(&field_ref)
        .absolute()
        .inset_0()
        .p_0()
        .border(px(0.0))
        .bg(AdaptiveColor::TRANSPARENT)
        .text_color(AdaptiveColor::TRANSPARENT)
        .selection_color(transparent_black())
        .caret(false)
        .keyboard_type(KeyboardType::Number)
        .auto_correct(false)
        .auto_capitalize(AutoCapitalize::None)
        .disabled(config.disabled)
        .optional_label(config.accessibility_label)
        .value(move || text_now.get())
        .on_change(move |text: &str| typed(text))
        .on_selection_change(move |selection: &Selection| {
            let end = utf16_len(&text_now.get_untracked());
            if (selection.start, selection.end) != (end, end) {
                field_ref.set_selection(end, end);
            }
        })
        .on_focus(move || focused.set(true))
        .on_blur(move || focused.set(false))
        .into_element();

    // The segments change with the precision and the hour cycle only: an
    // edit updates their texts, it makes no views.
    let list = computed(move || editor.with(|e| e.segments()));
    let segments = dynamic(move || {
        let edit = edit.clone();
        let list = list.get();
        let mut out = Vec::with_capacity(list.len() * 2);
        for (ix, &segment) in list.iter().enumerate() {
            if ix > 0 && segment != TimeSegment::Period {
                out.push(
                    text(":")
                        .accessibility_elements_hidden(true)
                        .project_disabled(config.disabled)
                        .app_class(config.separator_class)
                        .inline_style(move || config.separator_style.get())
                        .into_element(),
                );
            }
            out.push(segment_view(
                config,
                editor,
                focused,
                field_ref,
                segment,
                edit.clone(),
            ));
        }
        out
    });
    vec![native, segments]
}

/// Binds `key` while the current owner lives, firing on any focus.
fn bind_key(key: &str, repeat: bool, f: impl Fn() + 'static) {
    on_key_with(
        key,
        KeyOptions {
            when: When::Always,
            repeat,
        },
        move |_| f(),
    );
}

/// A segment: the app's `renderSegment`, else its label.
fn segment_view(
    config: FieldConfig,
    editor: Signal<SegmentEditor>,
    focused: Signal<bool>,
    field_ref: ElementRef,
    segment: TimeSegment,
    edit: Edit,
) -> AnyElement {
    let state = computed(move || {
        editor.with(|e| TimeFieldSegmentState {
            segment,
            value: e.value(segment),
            label: e.label(segment),
            selected: focused.get() && e.segment == segment,
            disabled: config.disabled.get(),
        })
    });
    let custom = computed(move || config.render_segment.with(Option::is_some));
    view()
        // The field tells screen readers the time.
        .accessibility_elements_hidden(true)
        .focusable(false)
        .project_disabled(config.disabled)
        .project_focused(move || state.with(|s| s.selected))
        .app_class(config.segment_class)
        .inline_style(move || config.segment_style.get())
        .on_press(move || {
            if config.disabled.get_untracked() {
                return;
            }
            let selected = state.with_untracked(|s| s.selected);
            if selected && segment == TimeSegment::Period {
                edit(&|e| {
                    let pm = e.value(TimeSegment::Period) == 0;
                    e.input_period(pm)
                });
            } else {
                editor.update(|e| {
                    e.select_segment(segment);
                });
            }
            field_ref.focus();
        })
        .child(dynamic(move || {
            if custom.get() {
                return dynamic(move || {
                    let render = config.render_segment.get()?;
                    Some(render.render(format!("segment-{segment:?}"), state.get()))
                });
            }
            text(move || state.with(|s| s.label.clone())).into_element()
        }))
        .into_element()
}

/// A time of day edited a segment at a time (`gpui-base`'s `TimeField`):
/// the hour, the minute, with `precision="second"` the second, with
/// `hourCycle="h12"` AM / PM, separated by `:`. The keys edit the selected
/// segment (digits, Up / Down, `a` / `p`, Backspace) and move between them
/// (Left / Right, Tab); a press selects one. The time is `value` and
/// `onChange` (or the field's own, from `defaultValue`). It looks like
/// nothing: the app's `class` and `style` lay out the field (`flex-row`),
/// the parts style the segments and separators, or `renderSegment` draws
/// them.
#[component]
pub fn TimeField(props: TimeFieldProps, cx: Scope<TimeFieldEvent>) -> impl IntoElement {
    let own = signal(props.default_value.get_untracked().0);
    let time = move || props.value.get().map(|t| t.0).unwrap_or_else(|| own.get());
    let changed: Rc<dyn Fn(NaiveTime)> = Rc::new(move |t| {
        if props.value.get_untracked().is_none() {
            own.set(t);
        }
        cx.emit(TimeFieldEvent::Change(TimeOfDay(t)));
    });
    let config = FieldConfig {
        precision: props.precision,
        hour_cycle: props.hour_cycle,
        disabled: props.disabled,
        accessibility_label: props.accessibility_label,
        segment_class: props.segment_class,
        segment_style: props.segment_style,
        separator_class: props.separator_class,
        separator_style: props.separator_style,
        render_segment: props.render_segment,
    };
    view()
        .flex_row()
        .disabled(props.disabled)
        .children(field(config, time, changed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(h: u32, m: u32, s: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, m, s).unwrap()
    }

    fn editor(precision: TimePrecision, cycle: HourCycle) -> SegmentEditor {
        SegmentEditor::new(t(9, 30, 0), precision, cycle)
    }

    #[test]
    fn digits_fill_a_segment_and_move_on_once_no_digit_fits() {
        // `gpui-base`'s `typing_digits_advances_segments`.
        let mut e = editor(TimePrecision::Minute, HourCycle::H23);
        assert!(e.input_digit(1));
        assert_eq!((e.time, e.segment), (t(1, 30, 0), TimeSegment::Hour));
        e.input_digit(4);
        assert_eq!((e.time, e.segment), (t(14, 30, 0), TimeSegment::Minute));
        // No minute is 7x: 7 completes it (the last segment: it stays).
        e.input_digit(7);
        assert_eq!((e.time, e.segment), (t(14, 7, 0), TimeSegment::Minute));
        // An hour digit above 2 completes the hour at once.
        e.select_segment(TimeSegment::Hour);
        e.input_digit(5);
        assert_eq!((e.time, e.segment), (t(5, 7, 0), TimeSegment::Minute));
    }

    #[test]
    fn steps_wrap_within_a_segment_without_carrying() {
        let mut e = SegmentEditor::new(t(23, 59, 0), TimePrecision::Minute, HourCycle::H23);
        e.select_segment(TimeSegment::Minute);
        e.step(1);
        assert_eq!(e.time, t(23, 0, 0));
        e.select_segment(TimeSegment::Hour);
        e.step(1);
        assert_eq!(e.time, t(0, 0, 0));
        e.step(-1);
        assert_eq!(e.time, t(23, 0, 0));
    }

    #[test]
    fn a_twelve_hour_clock_keeps_noon_and_midnight_apart() {
        let mut e = SegmentEditor::new(t(0, 15, 0), TimePrecision::Minute, HourCycle::H12);
        assert_eq!(e.label(TimeSegment::Hour), "12");
        assert_eq!(e.label(TimeSegment::Period), "AM");
        e.select_segment(TimeSegment::Period);
        e.input_period(true);
        assert_eq!(e.time, t(12, 15, 0));
        e.select_segment(TimeSegment::Hour);
        e.input_digit(1);
        e.input_digit(1);
        assert_eq!(e.time, t(23, 15, 0));
        e.select_segment(TimeSegment::Hour);
        e.clear_segment();
        assert_eq!(e.time, t(12, 15, 0), "12 PM: the hour resets, PM stays");
    }

    #[test]
    fn segments_follow_the_precision_and_the_cycle() {
        let mut e = editor(TimePrecision::Second, HourCycle::H12);
        assert_eq!(
            e.segments(),
            [
                TimeSegment::Hour,
                TimeSegment::Minute,
                TimeSegment::Second,
                TimeSegment::Period
            ]
        );
        e.select_segment(TimeSegment::Second);
        e.set_format(TimePrecision::Minute, HourCycle::H23);
        assert_eq!(
            e.segment,
            TimeSegment::Hour,
            "a segment gone selects the hour"
        );
        assert!(!e.move_segment(2));
        assert!(e.move_segment(1));
        assert!(!e.move_segment(1));
    }
}
