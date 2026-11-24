//! `TimeField`: a press selects a segment and focuses the field; digits
//! fill the selected segment and move on; Up / Down step it; Tab walks the
//! segments and leaves from the last; on a 12-hour clock a press on the
//! selected AM / PM switches it and `p` sets PM; the value is the app's or
//! the field's own, reported in 24 hours; and a move between segments or
//! of the focus draws no segment again.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::NaiveTime;
use nsh_base::{HourCycle, TimeFieldSegmentEntry, TimeOfDay, TimePrecision, time_field};
use nsh_core::{MountItem, NodeId, Size, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, Screen};

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    controlled: bool,
    seconds: bool,
    h12: bool,
    min: Option<TimeOfDay>,
    max: Option<TimeOfDay>,
}

fn props() -> HarnessProps {
    HarnessProps {
        controlled: false,
        seconds: false,
        h12: false,
        min: None,
        max: None,
    }
}

fn at(h: u32, m: u32) -> Option<TimeOfDay> {
    Some(TimeOfDay(NaiveTime::from_hms_opt(h, m, 0).unwrap()))
}

/// A field at 09:30 whose segments show their label (`renderSegment`) and
/// are at half opacity while selected (`focus:`), after a pressable
/// `Before`; the app's value as `Value: …`, what it heard as `Log: …`.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let start = TimeOfDay(NaiveTime::from_hms_opt(9, 30, 0).unwrap());
    let value = signal(start);
    let log = signal(Vec::<String>::new());
    let controlled = props.controlled;
    let mut el = time_field()
        .accessibility_label("Start time")
        .min(props.min)
        .max(props.max)
        .precision(if props.seconds {
            TimePrecision::Second
        } else {
            TimePrecision::Minute
        })
        .hour_cycle(if props.h12 {
            HourCycle::H12
        } else {
            HourCycle::H23
        })
        .segment_class("focus:opacity-50")
        .render_segment(|s: &TimeFieldSegmentEntry| text(s.label.clone()))
        .on_change(move |t: &TimeOfDay| {
            log.update(|l| l.push(t.0.format("%H:%M:%S").to_string()));
            if controlled {
                value.set(*t);
            }
        })
        .w(px(200.0))
        .h(px(30.0));
    if props.controlled {
        el = el.value(move || Some(value.get()));
    } else {
        el = el.default_value(start);
    }
    view()
        .child(
            view()
                .test_id("before")
                .w(px(40.0))
                .h(px(40.0))
                .on_press(|| {}),
        )
        .child(el)
        .child(text(move || {
            format!("Value: {}", value.get().0.format("%H:%M:%S"))
        }))
        .child(text(move || format!("Log: {}", log.get().join(" "))))
}

/// The app, and each view's opacity as its styles set it (a selected
/// segment at 0.5).
struct App {
    app: Headless,
    opacities: Arc<Mutex<HashMap<NodeId, f32>>>,
}

impl std::ops::Deref for App {
    type Target = Headless;
    fn deref(&self) -> &Headless {
        &self.app
    }
}

impl std::ops::DerefMut for App {
    fn deref_mut(&mut self) -> &mut Headless {
        &mut self.app
    }
}

fn start(props: HarnessProps) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(move || {
            props.clone()
        }))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    let opacities = Arc::new(Mutex::new(HashMap::new()));
    let into = opacities.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { id, style } = item {
                into.lock().unwrap().insert(*id, style.opacity);
            }
        }
    });
    app.first_render().unwrap();
    app.wait_for("text:09").unwrap();
    App { app, opacities }
}

/// Whether the segment showing `label` is the selected one.
fn selected(screen: &Screen, opacities: &Mutex<HashMap<NodeId, f32>>, label: &str) -> bool {
    let Ok(Some(segment)) = screen.press_target(&format!("text:{label}")) else {
        return false;
    };
    opacities
        .lock()
        .unwrap()
        .get(&segment)
        .is_some_and(|o| *o < 1.0)
}

/// Waits until a segment shows `text`, selected (`focus:`) when it ends
/// with `^`.
fn see(app: &mut App, text: &str) {
    let (label, caret) = match text.strip_suffix('^') {
        Some(label) => (label, true),
        None => (text, false),
    };
    let opacities = app.opacities.clone();
    let found = app.app.wait_until(
        &format!("a segment showing `{text}`"),
        Duration::from_secs(5),
        |s| s.shows(label) && (!caret || selected(s, &opacities, label)),
    );
    if let Err(e) = found {
        panic!("{e}; shown: {:?}", app.screen().texts());
    }
}

fn log(app: &Headless) -> String {
    app.screen()
        .texts()
        .into_iter()
        .find_map(|t| t.strip_prefix("Log: ").map(str::to_owned))
        .unwrap_or_default()
}

#[test]
fn digits_fill_the_selected_segment_and_move_on() {
    for controlled in [false, true] {
        let mut app = start(HarnessProps {
            controlled,
            ..props()
        });
        app.press("text:09").unwrap();
        see(&mut app, "09^");
        app.press_key("1").unwrap();
        see(&mut app, "01^");
        app.press_key("4").unwrap();
        see(&mut app, "14");
        see(&mut app, "30^");
        app.press_key("5").unwrap();
        see(&mut app, "05^");
        assert_eq!(log(&app), "01:30:00 14:30:00 14:05:00");
        if controlled {
            see(&mut app, "Value: 14:05:00");
        }
    }
}

#[test]
fn up_and_down_step_the_segment_and_backspace_resets_it() {
    let mut app = start(props());
    app.press("text:30").unwrap();
    see(&mut app, "30^");
    app.press_key("up").unwrap();
    see(&mut app, "31^");
    app.press_key("down").unwrap();
    app.press_key("down").unwrap();
    see(&mut app, "29^");
    app.press_key("left").unwrap();
    see(&mut app, "09^");
    app.press_key("down").unwrap();
    see(&mut app, "08^");
    app.press_key("backspace").unwrap();
    see(&mut app, "00^");
    assert_eq!(log(&app), "09:31:00 09:30:00 09:29:00 08:29:00 00:29:00");
}

#[test]
fn steps_land_on_and_stop_at_the_bounds() {
    let mut app = start(HarnessProps {
        min: at(9, 0),
        max: at(17, 45),
        ..props()
    });
    app.press("text:09").unwrap();
    see(&mut app, "09^");
    // An hour down from 09:30 would be 08:30: on the minimum's 09:00.
    app.press_key("down").unwrap();
    see(&mut app, "09^");
    see(&mut app, "00");
    // Already on the minimum: nothing more down, not even a minute that
    // would wrap to 09:59.
    app.press_key("down").unwrap();
    app.press_key("right").unwrap();
    app.press_key("down").unwrap();
    app.press_key("left").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    // Up to 17:00, then an hour up lands on the maximum's 17:45; another
    // one stays there.
    for _ in 0..9 {
        app.press_key("up").unwrap();
    }
    see(&mut app, "17^");
    see(&mut app, "45");
    app.press_key("up").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    assert_eq!(
        log(&app),
        "09:00:00 10:00:00 11:00:00 12:00:00 13:00:00 14:00:00 15:00:00 16:00:00 17:00:00 17:45:00"
    );
}

#[test]
fn typed_digits_outside_the_bounds_are_held_to_them() {
    let mut app = start(HarnessProps {
        min: at(9, 15),
        max: at(17, 45),
        ..props()
    });
    app.press("text:09").unwrap();
    // 08:30 is before the minimum: held to 09:15 when the hour completes.
    app.press_key("0").unwrap();
    app.press_key("8").unwrap();
    see(&mut app, "09");
    see(&mut app, "15");
    app.press("text:09").unwrap();
    // 18:15 is after the maximum: held to 17:45 when the hour completes.
    app.press_key("1").unwrap();
    app.press_key("8").unwrap();
    see(&mut app, "17");
    see(&mut app, "45");
    // The minute, now selected, is held too: 17:50 is after 17:45.
    app.press_key("5").unwrap();
    app.press_key("0").unwrap();
    see(&mut app, "17");
    see(&mut app, "45");
    assert_eq!(
        log(&app),
        "00:30:00 09:15:00 01:15:00 17:45:00 17:05:00 17:45:00"
    );
}

#[test]
fn without_bounds_steps_and_typed_digits_are_unchanged() {
    let mut app = start(props());
    app.press("text:09").unwrap();
    app.press_key("down").unwrap();
    see(&mut app, "08^");
    app.press_key("0").unwrap();
    app.press_key("7").unwrap();
    see(&mut app, "07");
    assert_eq!(log(&app), "08:30:00 00:30:00 07:30:00");
}

#[test]
fn a_min_after_max_leaves_both_out() {
    let mut app = start(HarnessProps {
        min: at(17, 45),
        max: at(9, 15),
        ..props()
    });
    app.press("text:09").unwrap();
    app.press_key("down").unwrap();
    see(&mut app, "08^");
    assert_eq!(log(&app), "08:30:00");
}

#[test]
fn tab_walks_the_segments_and_leaves_from_the_last() {
    let mut app = start(HarnessProps {
        seconds: true,
        ..props()
    });
    app.press("text:09").unwrap();
    see(&mut app, "09^");
    app.press_key("tab").unwrap();
    see(&mut app, "30^");
    app.press_key("tab").unwrap();
    see(&mut app, "00^");
    app.press_key("shift+tab").unwrap();
    see(&mut app, "30^");
    app.press_key("tab").unwrap();
    app.press_key("tab").unwrap();
    // Gone from the field: no segment is selected.
    let opacities = app.opacities.clone();
    app.app
        .wait_until("no segment selected", Duration::from_secs(5), |s| {
            ["09", "30", "00"]
                .iter()
                .all(|label| !selected(s, &opacities, label))
        })
        .unwrap();
}

#[test]
fn a_twelve_hour_clock_switches_am_and_pm() {
    let mut app = start(HarnessProps {
        h12: true,
        ..props()
    });
    see(&mut app, "AM");
    app.press("text:AM").unwrap();
    see(&mut app, "AM^");
    // Pressed again while selected: PM.
    app.press("text:AM").unwrap();
    see(&mut app, "PM^");
    app.press_key("a").unwrap();
    see(&mut app, "AM^");
    app.press_key("p").unwrap();
    see(&mut app, "PM^");
    assert_eq!(log(&app), "21:30:00 09:30:00 21:30:00");
}

/// A field at 09:30 with its own labels (no `renderSegment`).
#[component]
fn Plain() -> impl IntoElement {
    view().child(
        time_field()
            .accessibility_label("Start time")
            .default_value(TimeOfDay(NaiveTime::from_hms_opt(9, 30, 0).unwrap()))
            .w(px(200.0))
            .h(px(30.0)),
    )
}

#[test]
fn editing_makes_no_views() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use nsh_core::MountItem;

    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(nsh_testing::windowed_root::<Plain>())
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    let made = Arc::new(AtomicUsize::new(0));
    let seen = made.clone();
    app.observe(move |_, batch| {
        let n = batch
            .items
            .iter()
            .filter(|i| matches!(i, MountItem::Create { .. } | MountItem::Delete { .. }))
            .count();
        seen.fetch_add(n, Ordering::Relaxed);
    });
    app.first_render().unwrap();
    app.wait_for("text:09").unwrap();
    app.press("text:09").unwrap();
    app.idle(std::time::Duration::from_millis(50)).unwrap();
    made.store(0, Ordering::Relaxed);
    // Digits, steps, moves between segments and Tab: the segments stay, their
    // texts change.
    for key in [
        "1",
        "4",
        "up",
        "left",
        "down",
        "tab",
        "shift+tab",
        "backspace",
    ] {
        app.press_key(key).unwrap();
    }
    app.wait_for("text:00").unwrap();
    app.idle(std::time::Duration::from_millis(50)).unwrap();
    assert_eq!(
        made.load(Ordering::Relaxed),
        0,
        "views created or deleted while editing"
    );
}

/// The `renderSegment` calls of each app (by its `run`): tests run side by
/// side, each app on an engine thread of its own.
static RENDERS: Mutex<Vec<usize>> = Mutex::new(Vec::new());

#[derive(Clone, PartialEq, Props)]
struct CountedProps {
    /// Where its `renderSegment` calls count ([`RENDERS`]).
    run: u32,
}

/// A field at 09:30:15 whose segments a counting `renderSegment` draws,
/// after a pressable `Before`.
#[component]
fn Counted(props: CountedProps) -> impl IntoElement {
    let run = props.run as usize;
    view()
        .child(
            view()
                .test_id("before")
                .w(px(40.0))
                .h(px(40.0))
                .on_press(|| {}),
        )
        .child(
            time_field()
                .accessibility_label("Start time")
                .precision(TimePrecision::Second)
                .default_value(TimeOfDay(NaiveTime::from_hms_opt(9, 30, 15).unwrap()))
                .segment_class("focus:opacity-50")
                .render_segment(move |s: &TimeFieldSegmentEntry| {
                    RENDERS.lock().unwrap()[run] += 1;
                    text(s.label.clone())
                })
                .w(px(200.0))
                .h(px(30.0)),
        )
}

#[test]
fn moving_between_segments_and_the_focus_draws_no_segment_again() {
    let run = {
        let mut renders = RENDERS.lock().unwrap();
        renders.push(0);
        (renders.len() - 1) as u32
    };
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Counted>(move || {
            CountedProps { run }
        }))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    let made = Arc::new(Mutex::new(0usize));
    let into = made.clone();
    app.observe(move |_, batch| {
        let n = batch
            .items
            .iter()
            .filter(|i| matches!(i, MountItem::Create { .. } | MountItem::Delete { .. }))
            .count();
        *into.lock().unwrap() += n;
    });
    app.first_render().unwrap();
    app.wait_for("text:09").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    let renders = || RENDERS.lock().unwrap()[run as usize];
    // Each segment drawn once.
    assert_eq!(renders(), 3);
    *made.lock().unwrap() = 0;
    // The focus coming (a press), moves between the segments (Right, Left,
    // Tab, Shift+Tab, presses) and the focus going (Tab past the last).
    app.press("text:09").unwrap();
    for key in ["right", "right", "left", "shift+tab", "tab"] {
        app.press_key(key).unwrap();
    }
    app.press("text:15").unwrap();
    app.press_key("tab").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    assert_eq!(renders(), 3, "no segment is drawn again");
    assert_eq!(*made.lock().unwrap(), 0, "no view made or deleted");
    // A step draws the segment it changes, and only it.
    app.press("text:30").unwrap();
    app.press_key("up").unwrap();
    app.wait_for("text:31").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    assert_eq!(renders(), 4, "the minute drawn again");
}
