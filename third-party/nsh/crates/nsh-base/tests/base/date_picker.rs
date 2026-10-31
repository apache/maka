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
    CalendarItemKind, CalendarItemState, DatePickerEvent, DateRangePreset, DateTime, PickedDate,
    TimeFieldSegmentState, TimePrecision, date_picker,
};
use nsh_core::{
    AccessibilityRole, MountItem, NodeId, Size, ViewKind, element::Root, platform::Os, prelude::*,
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

/// A picker under a 160 × 30 trigger `Pick`, days drawn as `M-D` (`*`
/// selected), segments as their label; what it heard as `Log: …`.
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
        .render_item(|s: &CalendarItemState| {
            text(match s.kind {
                CalendarItemKind::Day => {
                    format!(
                        "{}-{}{}{}",
                        s.month,
                        s.value,
                        if s.active { "*" } else { "" },
                        if s.focused { "^" } else { "" }
                    )
                }
                CalendarItemKind::MonthToggle => format!("M{}", s.value),
                CalendarItemKind::Previous => "prev".into(),
                CalendarItemKind::Next => "next".into(),
                _ => s.value.to_string(),
            })
        })
        .render_segment(|s: &TimeFieldSegmentState| text(format!("seg{}", s.label)))
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

/// The app, and what screen readers last heard as the picker's value.
struct App(Headless, Arc<Mutex<Option<String>>>);

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

    fn see(&mut self, text: &str) {
        if let Err(e) = self.0.wait_for(&format!("text:{text}")) {
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
    app.observe(move |_, batch| {
        for item in &batch.items {
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
    App(app, heard)
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
