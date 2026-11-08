//! `DatePicker`: the trigger opens a calendar in a popup (a sheet on touch
//! screens); a complete date is the value and closes it; a range takes two
//! days; with a time precision the popup stays open for the time and a
//! press on the selected day again closes it on a desktop, while on a phone
//! a tap on a day closes it; presets set the value; the
//! clear button and Delete clear it; Return opens and Escape closes;
//! screen readers hear the value in the display format; on a phone one
//! tap on a day closes the sheet, and the calendar spans it. Today is
//! 2026-10-28 (the engine's manual clock).

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use chrono::NaiveDate;
use nsh_base::{
    CalendarEntry, CalendarItemKind, DatePickerEvent, DateRangePreset, DateTime, PickedDate,
    TimeFieldSegmentEntry, TimePrecision, date_picker,
};
use nsh_core::{
    AccessibilityRole, MountItem, NodeId, Size, ViewKind,
    element::Root,
    platform::{Environment, Idiom, Os},
    prelude::*,
    time::Clock,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    controlled: bool,
    range: bool,
    time: bool,
    presets: bool,
}

fn props() -> HarnessProps {
    HarnessProps {
        controlled: false,
        range: false,
        time: false,
        presets: false,
    }
}

fn d(y: i32, m: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, day).unwrap()
}

/// What JS would get: dates, or dates and times with a precision.
fn show(p: &PickedDate) -> String {
    let one = |v: Option<chrono::NaiveDateTime>| match (v, p.time_precision) {
        (None, _) => "-".to_owned(),
        (Some(v), None) => v.date().to_string(),
        (Some(v), Some(_)) => v.format("%Y-%m-%dT%H:%M").to_string(),
    };
    match p.value {
        DateTime::Single(v) => one(v),
        DateTime::Range(a, b) => format!("{}..{}", one(a), one(b)),
    }
}

/// A picker under a 160 × 30 trigger `Pick`, days drawn as `M-D` and at
/// half opacity with the keyboard on them (`focus:`), segments as their
/// label; what it heard as `Log: …`.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let value = signal(DateTime::Single(None));
    let log = signal(Vec::<String>::new());
    let push = move |s: String| log.update(|l| l.push(s));
    let controlled = props.controlled;
    let mut el = date_picker()
        .range(props.range)
        .accessibility_label("Due")
        .cleanable(true)
        .clear_button(text("Clear"))
        .clear_button_accessibility_label("Clear the date")
        .time_label(text("Time"))
        .time_accessibility_label("Due time")
        .item_class("focus:opacity-50")
        .render_item(|e: &CalendarEntry| {
            text(match e.kind {
                CalendarItemKind::Day => format!("{}-{}", e.month, e.value),
                CalendarItemKind::MonthToggle => format!("M{}", e.value),
                CalendarItemKind::Previous => "prev".into(),
                CalendarItemKind::Next => "next".into(),
                _ => e.value.to_string(),
            })
        })
        .render_segment(|s: &TimeFieldSegmentEntry| text(format!("seg{}", s.label)))
        .trigger(
            view()
                .test_id("trigger")
                .w(px(160.0))
                .h(px(30.0))
                .child(text("Pick")),
        )
        .on_change(move |v: &PickedDate| {
            push(show(v));
            if controlled {
                value.set(v.value);
            }
        })
        .on_open_change(move |e: &DatePickerEvent| {
            if let DatePickerEvent::OpenChange(open, reason) = e {
                push(format!("open:{open}:{reason:?}"));
            }
        })
        .on_cancel(move || push("cancel".into()));
    if props.time {
        el = el.time_precision(Some(TimePrecision::Minute));
    }
    if props.presets {
        el = el.presets(vec![
            DateRangePreset::single("Today", d(2026, 10, 28)),
            DateRangePreset::range("Last week", d(2026, 10, 19), d(2026, 10, 25)),
        ]);
    }
    if props.controlled {
        el = el.value(move || value.get());
    }
    view()
        .pt(px(40.0))
        .pl(px(20.0))
        .child(el)
        .child(
            view()
                .test_id("elsewhere")
                .w(px(40.0))
                .h(px(40.0))
                .on_press(|| {}),
        )
        .child(text(move || format!("Log: {}", log.get().join(" "))))
}

/// The app, what screen readers last heard as the picker's value, and each
/// view's opacity as its styles set it (the day with the keyboard at 0.5).
struct App(
    Headless,
    Arc<Mutex<Option<String>>>,
    Arc<Mutex<HashMap<NodeId, f32>>>,
);

impl std::ops::Deref for App {
    type Target = Headless;
    fn deref(&self) -> &Headless {
        &self.0
    }
}

impl std::ops::DerefMut for App {
    fn deref_mut(&mut self) -> &mut Headless {
        &mut self.0
    }
}

impl App {
    fn log(&self) -> String {
        self.0
            .screen()
            .texts()
            .into_iter()
            .find_map(|t| t.strip_prefix("Log: ").map(str::to_owned))
            .unwrap_or_default()
    }

    /// Waits until `text` shows; a day of October 2026 (`10-14`) with
    /// the marks of its states after it, those and no others: `*`
    /// selected, `^` the keyboard's.
    fn see(&mut self, text: &str) {
        let day = text.trim_end_matches(['*', '^']);
        let marks = &text[day.len()..];
        let label = day
            .strip_prefix("10-")
            .and_then(|d| d.parse::<u32>().ok())
            .map(|d| format!("label:2026-10-{d:02}"));
        let opacities = self.2.clone();
        let found =
            self.0
                .wait_until(&format!("`{text}` shown"), Duration::from_secs(5), |s| {
                    if !s.shows(day) {
                        return false;
                    }
                    let Some(label) = &label else {
                        return marks.is_empty();
                    };
                    let selected = s.selected(label).unwrap_or(false);
                    let focused = s.press_target(label).ok().flatten().is_some_and(|id| {
                        opacities.lock().unwrap().get(&id).is_some_and(|o| *o < 1.0)
                    });
                    selected == marks.contains('*') && focused == marks.contains('^')
                });
        if let Err(e) = found {
            panic!("{e}; shown: {:?}", self.0.screen().texts());
        }
    }

    fn closed(&mut self) {
        self.0
            .wait_for_gone("text:prev", Duration::from_secs(5))
            .unwrap();
    }

    fn open(&mut self) {
        self.0.press("role:combobox").unwrap();
        self.see("prev");
    }

    fn heard(&self) -> Option<String> {
        self.1.lock().unwrap().clone()
    }
}

fn start_on(os: Os, props: HarnessProps) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = os;
    config.clock = Clock::manual(SystemTime::UNIX_EPOCH + Duration::from_secs(1_793_188_800));
    let mut app = Headless::start(config).expect("the engine starts");
    let heard = Arc::new(Mutex::new(None));
    let into = heard.clone();
    let opacities = Arc::new(Mutex::new(HashMap::new()));
    let styles = opacities.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { id, style } = item {
                styles.lock().unwrap().insert(*id, style.opacity);
            }
            if let MountItem::ViewProps { props, .. } = item
                && props.accessibility.role == AccessibilityRole::Combobox
            {
                *into.lock().unwrap() = props
                    .accessibility
                    .value
                    .as_ref()
                    .and_then(|v| v.text.as_deref().map(str::to_owned));
            }
        }
    });
    app.first_render().unwrap();
    app.wait_for("text:Pick").unwrap();
    App(app, heard, opacities)
}

fn start(props: HarnessProps) -> App {
    start_on(Os::MacOs, props)
}

#[test]
fn a_day_is_the_value_and_closes_the_popup() {
    for controlled in [false, true] {
        let mut app = start(HarnessProps {
            controlled,
            ..props()
        });
        app.open();
        app.see("M10");
        app.press("label:2026-10-14").unwrap();
        app.closed();
        assert_eq!(
            app.log(),
            "open:true:TriggerPress 2026-10-14 open:false:Select"
        );
        assert_eq!(app.heard().as_deref(), Some("2026/10/14"));
        // Open again: on the value's month, the keyboard on the selected
        // day (the desktops).
        app.open();
        app.see("10-14*^");
    }
}

#[test]
fn a_range_takes_two_days() {
    let mut app = start(HarnessProps {
        range: true,
        ..props()
    });
    app.open();
    app.press("label:2026-10-20").unwrap();
    app.see("10-20*");
    assert_eq!(
        app.log(),
        "open:true:TriggerPress",
        "half a range is no value"
    );
    app.press("label:2026-10-22").unwrap();
    app.closed();
    assert_eq!(
        app.log(),
        "open:true:TriggerPress 2026-10-20..2026-10-22 open:false:Select"
    );
    assert_eq!(app.heard().as_deref(), Some("2026/10/20 - 2026/10/22"));
}

#[test]
fn on_a_desktop_with_a_time_the_popup_stays_open_and_the_selected_day_again_closes_it() {
    for controlled in [false, true] {
        let mut app = start(HarnessProps {
            controlled,
            time: true,
            ..props()
        });
        app.open();
        app.see("Time");
        app.press("label:2026-10-14").unwrap();
        app.see("10-14*");
        assert_eq!(app.log(), "open:true:TriggerPress 2026-10-14T00:00");
        // The hour, typed.
        app.press("text:seg00 >> nth=0").unwrap();
        app.press_key("9").unwrap();
        app.see("seg09");
        assert_eq!(
            app.log(),
            "open:true:TriggerPress 2026-10-14T00:00 2026-10-14T09:00"
        );
        app.press("label:2026-10-14").unwrap();
        app.closed();
        assert_eq!(app.heard().as_deref(), Some("2026/10/14 09:00"));
    }
}

#[test]
fn the_time_row_has_its_label_at_the_start_and_the_field_at_the_end() {
    let mut app = start(HarnessProps {
        time: true,
        ..props()
    });
    // The views the popup makes: the time field's (the parent of its
    // native input), their parents and frames.
    #[derive(Default)]
    struct Seen {
        input: Option<NodeId>,
        parents: HashMap<NodeId, NodeId>,
        children: HashMap<NodeId, Vec<NodeId>>,
        frames: HashMap<NodeId, Bounds<Points>>,
    }
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Create {
                    id,
                    kind: ViewKind::Input,
                } => seen.input = Some(*id),
                MountItem::Insert { parent, child, .. } => {
                    seen.parents.insert(*child, *parent);
                    seen.children.entry(*parent).or_default().push(*child);
                }
                MountItem::Frame { id, frame } => {
                    seen.frames.insert(*id, *frame);
                }
                _ => {}
            }
        }
    });
    app.open();
    app.see("Time");
    app.wait(Duration::from_millis(100)).unwrap();
    let seen = seen.lock().unwrap();
    let field = seen.parents[&seen.input.expect("the time field's input")];
    let row = seen.parents[&field];
    let (row_frame, field_frame) = (seen.frames[&row], seen.frames[&field]);
    // The row is as wide as the calendar, far wider than its label and
    // field: the field ends where the row does, the label starts it.
    assert_eq!(
        field_frame.origin.x + field_frame.size.width,
        row_frame.size.width,
        "{field_frame:?} in {row_frame:?}"
    );
    let label = seen.children[&row]
        .iter()
        .find(|&&c| c != field)
        .expect("the label");
    assert_eq!(seen.frames[label].origin.x, px(0.0));
    assert!(seen.frames[label].size.height > px(0.0));
}

#[test]
fn a_preset_is_the_value_and_closes_the_popup() {
    let mut app = start(HarnessProps {
        presets: true,
        range: true,
        ..props()
    });
    app.open();
    app.press("label:Last week").unwrap();
    app.closed();
    assert_eq!(
        app.log(),
        "open:true:TriggerPress 2026-10-19..2026-10-25 open:false:Select"
    );
}

#[test]
fn the_clear_button_and_delete_clear_the_value() {
    let mut app = start(props());
    assert!(!app.shows("Clear"), "nothing to clear");
    app.open();
    app.press("label:2026-10-14").unwrap();
    app.closed();
    app.see("Clear");
    app.press("label:Clear the date").unwrap();
    app.wait_for_gone("text:Clear", Duration::from_secs(5))
        .unwrap();
    assert!(app.log().ends_with("open:false:Select -"), "{}", app.log());
    assert_eq!(app.heard(), None);
    // Delete on the focused trigger, too.
    app.open();
    app.press("label:2026-10-15").unwrap();
    app.closed();
    app.press_key("delete").unwrap();
    app.wait_for_gone("text:Clear", Duration::from_secs(5))
        .unwrap();
    assert!(
        app.log().ends_with("2026-10-15 open:false:Select -"),
        "{}",
        app.log()
    );
}

#[test]
fn return_opens_on_the_days_and_escape_closes() {
    let mut app = start(props());
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.see("prev");
    app.see("10-28^");
    // The keyboard is on today's day: the arrows move it.
    app.press_key("right").unwrap();
    app.press_key("enter").unwrap();
    app.closed();
    assert!(app.log().contains("2026-10-29"), "{}", app.log());
    app.press_key("enter").unwrap();
    app.see("prev");
    app.press_key("escape").unwrap();
    app.closed();
    assert!(
        app.log().ends_with("cancel open:false:Cancel"),
        "{}",
        app.log()
    );
}

#[test]
fn on_a_phone_one_tap_on_a_day_picks_it_and_closes_the_sheet() {
    for os in [Os::Ios, Os::Android] {
        let mut app = start_on(os, props());
        app.open();
        app.press("label:2026-10-14").unwrap();
        app.closed();
        assert_eq!(
            app.log(),
            "open:true:TriggerPress 2026-10-14 open:false:Select",
            "{os:?}"
        );
        assert_eq!(app.heard().as_deref(), Some("2026/10/14"), "{os:?}");
    }
    // A range closes on the tap on its second end.
    let mut app = start_on(
        Os::Ios,
        HarnessProps {
            range: true,
            ..props()
        },
    );
    app.open();
    app.press("label:2026-10-20").unwrap();
    app.see("10-20*");
    app.press("label:2026-10-22").unwrap();
    app.closed();
    assert_eq!(
        app.log(),
        "open:true:TriggerPress 2026-10-20..2026-10-22 open:false:Select"
    );
}

#[test]
fn on_a_phone_with_a_time_one_tap_on_a_day_picks_it_at_its_time_and_closes_the_sheet() {
    for controlled in [false, true] {
        let mut app = start_on(
            Os::Ios,
            HarnessProps {
                controlled,
                time: true,
                ..props()
            },
        );
        app.open();
        app.see("Time");
        app.press("label:2026-10-14").unwrap();
        app.closed();
        assert_eq!(
            app.log(),
            "open:true:TriggerPress 2026-10-14T00:00 open:false:Select"
        );
        // Open again for the time: the field edits the picked day's.
        app.open();
        app.see("10-14*");
        // The keyboard's digits: the hour, then the minute.
        app.type_text("label:Due time", "0900").unwrap();
        app.see("seg09");
        assert!(app.log().ends_with(" 2026-10-14T09:00"), "{}", app.log());
        // Another day keeps the time.
        app.press("label:2026-10-15").unwrap();
        app.closed();
        assert!(
            app.log()
                .ends_with("2026-10-14T09:00 2026-10-15T09:00 open:false:Select"),
            "{}",
            app.log()
        );
        assert_eq!(app.heard().as_deref(), Some("2026/10/15 09:00"));
    }
}

#[test]
fn on_a_phone_the_calendar_spans_the_sheet() {
    let mut app = start_on(Os::Ios, props());
    // The frames and parents of the views the sheet makes.
    #[derive(Default)]
    struct Seen {
        parents: HashMap<NodeId, NodeId>,
        frames: HashMap<NodeId, Bounds<Points>>,
    }
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Insert { parent, child, .. } => {
                    seen.parents.insert(*child, *parent);
                }
                MountItem::Frame { id, frame } => {
                    seen.frames.insert(*id, *frame);
                }
                _ => {}
            }
        }
    });
    app.open();
    app.wait(Duration::from_millis(100)).unwrap();
    let day = app
        .screen()
        .press_target("label:2026-10-14")
        .unwrap()
        .expect("the day's view");
    let seen = seen.lock().unwrap();
    // The sheet is as wide as the 800 pt screen, and so is a week: its
    // seven days share it, not their own widths.
    let week = seen.parents[&day];
    assert_eq!(seen.frames[&week].size.width, px(800.0));
    let width = seen.frames[&day].size.width;
    assert!((width.0 - 800.0 / 7.0).abs() <= 1.0, "a day {width:?} wide");
}

/// A date picker with a date chosen, cleanable, its trigger `Deadline` on
/// a band 14 Cells wide, which leaves six Cells free at its end for the
/// terminal's marks, a slot of three each. The band's width is its own (a
/// terminal keeps two Cells at most of a padding, so padding cannot leave
/// six), and the page holds it at that width rather than the window's.
#[component]
fn ClearableDate() -> impl IntoElement {
    view().items_start().child(
        date_picker()
            .accessibility_label("Deadline")
            .default_value(DateTime::Single(Some(
                d(2026, 11, 6).and_hms_opt(0, 0, 0).unwrap(),
            )))
            .cleanable(true)
            .clear_button(text("Clear"))
            .trigger(
                view()
                    .flex_row()
                    .w(px(112.0))
                    .bg(nsh_core::color::rgb(0x333333))
                    .child(text("Deadline")),
            ),
    )
}

#[test]
fn a_terminals_date_picker_shows_its_clear_and_arrow_at_its_band_s_end() {
    let viewport = Size::new(px(390.0), px(844.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            window: viewport,
            os: Os::Linux,
            idiom: Idiom::Terminal,
            cell: Some(Size::new(px(8.0), px(16.0))),
            ..Environment::default()
        },
        ..EngineConfig::new(Root::of::<ClearableDate>())
    };
    let mut app = Headless::start(config).unwrap();
    // The texts, frames and parents the batches set.
    #[derive(Default)]
    struct Seen {
        texts: HashMap<NodeId, String>,
        frames: HashMap<NodeId, Bounds<Points>>,
        parents: HashMap<NodeId, NodeId>,
    }
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Text { id, text, .. } => {
                    seen.texts.insert(*id, text.text.to_string());
                }
                MountItem::Frame { id, frame } => {
                    seen.frames.insert(*id, *frame);
                }
                MountItem::Insert { parent, child, .. } => {
                    seen.parents.insert(*child, *parent);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    let seen = seen.lock().unwrap();
    // Where the text `t` starts in the window.
    let at = |t: &str| {
        let (id, _) = seen
            .texts
            .iter()
            .find(|(_, s)| s.as_str() == t)
            .unwrap_or_else(|| panic!("no {t} in {:?}", seen.texts));
        let mut id = *id;
        let (mut x, mut y) = (0.0, 0.0);
        loop {
            if let Some(f) = seen.frames.get(&id) {
                x += f.origin.x.0;
                y += f.origin.y.0;
            }
            match seen.parents.get(&id) {
                Some(parent) => id = *parent,
                None => return (x, y),
            }
        }
    };
    // The terminal's own marks in place of the app's `Clear`, on the
    // band's row: `× ▾`, each the middle of a slot of three Cells, `▾` on
    // the Cell before the band's last (`Deadline` is 8 Cells, the band 14).
    assert!(
        !seen.texts.values().any(|t| t == "Clear"),
        "the terminal's × in place of the app's clear button: {:?}",
        seen.texts
    );
    let (value, clear, arrow) = (at("Deadline"), at("×"), at("▾"));
    // The bounds of each and of the views around them, for a failure.
    let chain = |t: &str| {
        let (id, _) = seen.texts.iter().find(|(_, s)| s.as_str() == t).unwrap();
        let mut id = *id;
        let mut out = format!("{t}:");
        loop {
            out += &format!(" {id:?}={:?}", seen.frames.get(&id));
            match seen.parents.get(&id) {
                Some(parent) => id = *parent,
                None => return out,
            }
        }
    };
    let bounds = format!("{}\n{}\n{}", chain("Deadline"), chain("×"), chain("▾"));
    assert_eq!(clear.1, value.1, "one row: {value:?} {clear:?}");
    assert_eq!(arrow.1, value.1, "one row: {value:?} {arrow:?}");
    assert_eq!(
        arrow.0 - value.0,
        12.0 * 8.0,
        "▾ before the band's last Cell\n{bounds}"
    );
    assert_eq!(
        arrow.0 - clear.0,
        3.0 * 8.0,
        "× three Cells before ▾\n{bounds}"
    );
}
