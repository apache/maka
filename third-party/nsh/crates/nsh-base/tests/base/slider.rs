//! `Slider`: dragging a thumb reports each new value, snapped to the step,
//! then the end of the change once; a range's thumbs never cross, and two
//! at one value part the way a drag starting on them goes; the keyboard moves the
//! focused thumb by WAI-ARIA's slider keys, and a screen reader's
//! increment and decrement step it; a disabled slider takes none of it; the
//! app owns a controlled value, and an uncontrolled slider keeps its own.

use nsh_base::{SliderValue, slider};
use nsh_core::{
    EventKind, EventPayload, PayloadValue, Size,
    element::Root,
    geometry::{Axis, point},
    platform::Os,
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// The value at first.
    value: SliderValue,
    /// The app keeps its value whatever the user asks.
    refusing: bool,
    /// The slider owns the value, from `defaultValue`.
    uncontrolled: bool,
    disabled: bool,
    vertical: bool,
}

/// The app owns `value` and sets the one `onChange` reports.
fn controlled(value: impl Into<SliderValue>) -> HarnessProps {
    HarnessProps {
        value: value.into(),
        refusing: false,
        uncontrolled: false,
        disabled: false,
        vertical: false,
    }
}

/// `40`, `20-60`.
fn show(value: SliderValue) -> String {
    match value {
        SliderValue::Single(v) => format!("{v}"),
        SliderValue::Range(a, b) => format!("{a}-{b}"),
    }
}

/// A slider from 0 to 100 by 5 on a track 200 long (its thumb 10 square,
/// its indicator 4 thick), labelled `Volume` (a range's start `Low`, its end
/// `High`); the app's value, the values `onChange` reported and the ends
/// `onChangeEnd` reported.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let value = signal(props.value);
    let changes = signal(Vec::<String>::new());
    let ends = signal(Vec::<String>::new());
    let follows = !props.refusing && !props.uncontrolled;
    let axis = if props.vertical {
        Axis::Vertical
    } else {
        Axis::Horizontal
    };
    let range = props.value.is_range();
    let el = slider()
        .step(5.0)
        .axis(axis)
        .disabled(props.disabled)
        .accessibility_label(if range { "High" } else { "Volume" })
        .start_accessibility_label("Low")
        .track_style(move |s| match axis {
            Axis::Horizontal => s.w(px(200.0)).h(px(20.0)).justify_center(),
            Axis::Vertical => s.h(px(200.0)).w(px(20.0)).items_center(),
        })
        .indicator_style(move |s| match axis {
            Axis::Horizontal => s.h(px(4.0)),
            Axis::Vertical => s.w(px(4.0)).h_full(),
        })
        .thumb_style(|s| s.size(px(10.0)))
        .on_change(move |v: &SliderValue| {
            changes.update(|c| c.push(show(*v)));
            if follows {
                value.set(*v);
            }
        })
        .on_change_end(move |v: &SliderValue| ends.update(|e| e.push(show(*v))));
    let el = if props.uncontrolled {
        el.default_value(props.value)
    } else {
        el.value(move || value.get())
    };
    view()
        .child(view().p(px(20.0)).child(el))
        .child(text(move || format!("Value {}", show(value.get()))))
        .child(text(move || {
            format!("Changes {}", changes.get().join(", "))
        }))
        .child(text(move || format!("Ends {}", ends.get().join(", "))))
}

/// The harness of `props` on a headless macOS surface (Tab stops at the
/// thumbs there).
fn start(props: HarnessProps) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ends").unwrap();
    app
}

/// A screen reader's `action` (`increment`, `decrement`) on the thumb
/// `selector` names.
fn accessibility_action(app: &mut Headless, selector: &str, action: &str) {
    let thumb = app
        .screen()
        .press_target(selector)
        .unwrap()
        .expect("a thumb");
    app.engine().control().dispatch_event(
        thumb,
        EventKind::AccessibilityAction,
        EventPayload::Map(vec![("actionName", PayloadValue::Str(action.into()))]),
    );
}

#[test]
fn a_drag_reports_each_value_on_the_step_then_its_end_once() {
    let mut app = start(controlled(40.0));
    assert!(app.shows("Value 40"));
    assert_eq!(app.screen().count("role:adjustable").unwrap(), 1);
    // 40 points of 200: a fifth of the range, by steps of 5.
    app.drag("label:Volume", point(px(40.0), px(0.0))).unwrap();
    app.wait_for("text:Value 60").unwrap();
    app.wait_for("text:Changes 45, 50, 55, 60").unwrap();
    app.wait_for("text:Ends 60").unwrap();
    // Past the end: held at the maximum, each value reported once.
    app.drag("label:Volume", point(px(150.0), px(0.0))).unwrap();
    app.wait_for("text:Value 100").unwrap();
    app.wait_for("text:Ends 60, 100").unwrap();
    assert!(app.shows("Changes 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100"));
}

#[test]
fn a_vertical_slider_has_its_minimum_at_the_bottom() {
    let mut props = controlled(40.0);
    props.vertical = true;
    let mut app = start(props);
    app.drag("label:Volume", point(px(0.0), px(-40.0))).unwrap();
    app.wait_for("text:Value 60").unwrap();
    app.wait_for("text:Ends 60").unwrap();
}

#[test]
fn a_ranges_thumbs_never_cross_and_part_the_way_the_pointer_goes() {
    let mut app = start(controlled((20.0, 60.0)));
    assert_eq!(app.screen().count("role:adjustable").unwrap(), 2);
    // The start stops at the end.
    app.drag("label:Low", point(px(100.0), px(0.0))).unwrap();
    app.wait_for("text:Value 60-60").unwrap();
    app.wait_for("text:Ends 60-60").unwrap();
    // Two thumbs at one value: dragging the end's toward the minimum moves
    // the start, which can go there.
    app.drag("label:High", point(px(-40.0), px(0.0))).unwrap();
    app.wait_for("text:Value 40-60").unwrap();
    // And the start's toward the maximum moves itself, up to the end.
    app.drag("label:Low", point(px(60.0), px(0.0))).unwrap();
    app.wait_for("text:Value 60-60").unwrap();
    app.drag("label:Low", point(px(30.0), px(0.0))).unwrap();
    app.wait_for("text:Value 60-75").unwrap();
}

#[test]
fn keys_move_the_focused_thumb_and_each_is_a_whole_change() {
    let mut app = start(controlled((20.0, 60.0)));
    // Tab reaches the start thumb, then the end's.
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("text:Value 25-60").unwrap();
    app.wait_for("text:Ends 25-60").unwrap();
    app.press_key("up").unwrap();
    app.wait_for("text:Value 30-60").unwrap();
    app.press_key("down").unwrap();
    app.press_key("left").unwrap();
    app.wait_for("text:Value 20-60").unwrap();
    // A page is a tenth of the range.
    app.press_key("pageup").unwrap();
    app.wait_for("text:Value 30-60").unwrap();
    app.press_key("pagedown").unwrap();
    app.wait_for("text:Value 20-60").unwrap();
    // Home and End go as far as the thumb can: the start up to the end.
    app.press_key("end").unwrap();
    app.wait_for("text:Value 60-60").unwrap();
    app.press_key("home").unwrap();
    app.wait_for("text:Value 0-60").unwrap();
    assert!(app.shows("Ends 25-60, 30-60, 25-60, 20-60, 30-60, 20-60, 60-60, 0-60"));

    app.press_key("tab").unwrap();
    app.press_key("end").unwrap();
    app.wait_for("text:Value 0-100").unwrap();
    // Nothing changes at the maximum: nothing reported.
    app.press_key("right").unwrap();
    app.press_key("home").unwrap();
    app.wait_for("text:Value 0-0").unwrap();
    assert!(app.shows("Ends 25-60, 30-60, 25-60, 20-60, 30-60, 20-60, 60-60, 0-60, 0-100, 0-0"));
}

#[test]
fn a_screen_reader_steps_each_thumb() {
    let mut app = start(controlled((20.0, 60.0)));
    accessibility_action(&mut app, "label:Low", "increment");
    app.wait_for("text:Value 25-60").unwrap();
    app.wait_for("text:Ends 25-60").unwrap();
    accessibility_action(&mut app, "label:High", "decrement");
    app.wait_for("text:Value 25-55").unwrap();
    app.wait_for("text:Ends 25-60, 25-55").unwrap();
}

#[test]
fn a_disabled_slider_takes_no_drag_key_or_step() {
    let mut props = controlled(40.0);
    props.disabled = true;
    let mut app = start(props);
    assert!(!app.screen().enabled("label:Volume").unwrap());
    app.drag("label:Volume", point(px(40.0), px(0.0))).unwrap();
    // No thumb to Tab to.
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.idle(std::time::Duration::from_millis(100)).unwrap();
    assert!(app.shows("Value 40"));
    assert!(app.shows("Changes"));
    assert!(app.shows("Ends"));
}

#[test]
fn a_controlled_slider_shows_the_apps_value() {
    let mut props = controlled(40.0);
    props.refusing = true;
    let mut app = start(props);
    app.drag("label:Volume", point(px(40.0), px(0.0))).unwrap();
    // What the user asked for is reported, the app's value stays.
    app.wait_for("text:Ends 60").unwrap();
    assert!(app.shows("Changes 45, 50, 55, 60"));
    assert!(app.shows("Value 40"));
    // A key steps from the value shown.
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("text:Ends 60, 45").unwrap();
}

#[test]
fn an_uncontrolled_slider_keeps_its_own_value() {
    let mut props = controlled(40.0);
    props.uncontrolled = true;
    let mut app = start(props);
    app.drag("label:Volume", point(px(40.0), px(0.0))).unwrap();
    app.wait_for("text:Ends 60").unwrap();
    // The next drag starts where the last ended.
    app.drag("label:Volume", point(px(20.0), px(0.0))).unwrap();
    app.wait_for("text:Ends 60, 70").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("text:Ends 60, 70, 75").unwrap();
}
