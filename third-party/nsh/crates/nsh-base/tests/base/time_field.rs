//! `TimeField`: a press selects a segment and focuses the field; digits
//! fill the selected segment and move on; Up / Down step it; Tab walks the
//! segments and leaves from the last; on a 12-hour clock a press on the
//! selected AM / PM switches it and `p` sets PM; the value is the app's or
//! the field's own, reported in 24 hours.

use chrono::NaiveTime;
use nsh_base::{HourCycle, TimeFieldSegmentState, TimeOfDay, TimePrecision, time_field};
use nsh_core::{Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    controlled: bool,
    seconds: bool,
    h12: bool,
}

fn props() -> HarnessProps {
    HarnessProps {
        controlled: false,
        seconds: false,
        h12: false,
    }
}

/// A field at 09:30 whose segments show their label and `^` while
/// selected, after a pressable `Before`; the app's value as `Value: …`,
/// what it heard as `Log: …`.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let start = TimeOfDay(NaiveTime::from_hms_opt(9, 30, 0).unwrap());
    let value = signal(start);
    let log = signal(Vec::<String>::new());
    let controlled = props.controlled;
    let mut el = time_field()
        .accessibility_label("Start time")
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
        .render_segment(|s: &TimeFieldSegmentState| {
            text(format!("{}{}", s.label, if s.selected { "^" } else { "" }))
        })
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

fn start(props: HarnessProps) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app.wait_for("text:09").unwrap();
    app
}

fn see(app: &mut Headless, text: &str) {
    if let Err(e) = app.wait_for(&format!("text:{text}")) {
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
    app.wait_until(
        "no segment selected",
        std::time::Duration::from_secs(5),
        |s| !s.texts().iter().any(|t| t.ends_with('^')),
    )
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
    app.press("text:AM^").unwrap();
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
        ..EngineConfig::new(Root::of::<Plain>())
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
    see(&mut app, "00");
    app.idle(std::time::Duration::from_millis(50)).unwrap();
    assert_eq!(
        made.load(Ordering::Relaxed),
        0,
        "views created or deleted while editing"
    );
}
