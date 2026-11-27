//! `Slider`: dragging a thumb reports each new value, snapped to the step,
//! then the end of the change once; a range's thumbs never cross, and two
//! at one value part the way a drag starting on them goes; the keyboard moves the
//! focused thumb by WAI-ARIA's slider keys, and a screen reader's
//! increment and decrement step it; a disabled slider takes none of it; the
//! app owns a controlled value, and an uncontrolled slider keeps its own. In
//! a right-to-left layout a horizontal slider runs from the right: its
//! `min` at the right, drags and Left raising it. Content drawn in a thumb
//! follows that thumb's hover, drag and keyboard focus through its
//! `group-*:` classes.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use nsh_base::{SliderThumbContext, SliderValue, slider};
use nsh_core::{
    EventKind, EventPayload, MountItem, NodeId, PayloadValue, PointerType, ROOT_ID, Size,
    TouchEvent, TouchPhase, TouchPoint,
    geometry::{Axis, point},
    platform::Os,
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::{DragOptions, Headless};

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
    start_in(props, false)
}

/// [`start`] in a right-to-left layout with `rtl`.
fn start_in(props: HarnessProps, rtl: bool) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Harness>(move || {
            props.clone()
        }))
    };
    config.environment.os = Os::MacOs;
    config.environment.rtl = rtl;
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
    app.drag(
        "label:Volume",
        point(px(40.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Value 60").unwrap();
    app.wait_for("text:Changes 45, 50, 55, 60").unwrap();
    app.wait_for("text:Ends 60").unwrap();
    // Past the end: held at the maximum, each value reported once.
    app.drag(
        "label:Volume",
        point(px(150.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Value 100").unwrap();
    app.wait_for("text:Ends 60, 100").unwrap();
    assert!(app.shows("Changes 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100"));
}

#[test]
fn a_vertical_slider_has_its_minimum_at_the_bottom() {
    let mut props = controlled(40.0);
    props.vertical = true;
    let mut app = start(props);
    app.drag(
        "label:Volume",
        point(px(0.0), px(-40.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Value 60").unwrap();
    app.wait_for("text:Ends 60").unwrap();
}

#[test]
fn a_ranges_thumbs_never_cross_and_part_the_way_the_pointer_goes() {
    let mut app = start(controlled((20.0, 60.0)));
    assert_eq!(app.screen().count("role:adjustable").unwrap(), 2);
    // The start stops at the end.
    app.drag(
        "label:Low",
        point(px(100.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Value 60-60").unwrap();
    app.wait_for("text:Ends 60-60").unwrap();
    // Two thumbs at one value: dragging the end's toward the minimum moves
    // the start, which can go there.
    app.drag(
        "label:High",
        point(px(-40.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Value 40-60").unwrap();
    // And the start's toward the maximum moves itself, up to the end.
    app.drag(
        "label:Low",
        point(px(60.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Value 60-60").unwrap();
    app.drag(
        "label:Low",
        point(px(30.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
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
fn right_to_left_left_raises_a_horizontal_slider() {
    let mut app = start_in(controlled(40.0), true);
    app.press_key("tab").unwrap();
    app.press_key("left").unwrap();
    app.wait_for("text:Value 45").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("text:Value 40").unwrap();
    // Up and Down, Home and End keep their meaning.
    app.press_key("up").unwrap();
    app.wait_for("text:Value 45").unwrap();
    app.press_key("down").unwrap();
    app.wait_for("text:Value 40").unwrap();
    app.press_key("end").unwrap();
    app.wait_for("text:Value 100").unwrap();
    assert!(app.shows("Ends 45, 40, 45, 40, 100"));
}

#[test]
fn right_to_left_a_vertical_slider_keeps_its_keys() {
    let mut props = controlled(40.0);
    props.vertical = true;
    let mut app = start_in(props, true);
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("text:Value 45").unwrap();
    app.press_key("left").unwrap();
    app.wait_for("text:Value 40").unwrap();
    // A drag up raises it, as in a left-to-right layout.
    app.drag(
        "label:Volume",
        point(px(0.0), px(-40.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Value 60").unwrap();
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
    app.drag(
        "label:Volume",
        point(px(40.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
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
    app.drag(
        "label:Volume",
        point(px(40.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
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
    app.drag(
        "label:Volume",
        point(px(40.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Ends 60").unwrap();
    // The next drag starts where the last ended.
    app.drag(
        "label:Volume",
        point(px(20.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Ends 60, 70").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("right").unwrap();
    app.wait_for("text:Ends 60, 70, 75").unwrap();
}

/// What the thumb `Volume` was sent: where its frame starts along the
/// track, and the values screen readers were given, in order.
#[derive(Default)]
struct Sent {
    lefts: Vec<f32>,
    said: Vec<Option<f32>>,
}

/// The harness of `props`, recording what its thumb is sent.
fn start_watching(props: HarnessProps) -> (Headless, Arc<Mutex<Sent>>) {
    start_watching_in(props, false)
}

/// [`start_watching`] in a right-to-left layout with `rtl`.
fn start_watching_in(props: HarnessProps, rtl: bool) -> (Headless, Arc<Mutex<Sent>>) {
    let mut app = start_in(props, rtl);
    let thumb = app
        .screen()
        .press_target("label:Volume")
        .unwrap()
        .expect("a thumb");
    let sent = Arc::new(Mutex::new(Sent::default()));
    let into = sent.clone();
    app.observe(move |_, batch| {
        let mut sent = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Frame { id, frame } if *id == thumb => sent.lefts.push(frame.origin.x.0),
                MountItem::ViewProps { id, props } if *id == thumb => sent
                    .said
                    .push(props.accessibility.value.as_ref().and_then(|v| v.now)),
                _ => {}
            }
        }
    });
    (app, sent)
}

#[test]
fn a_drag_moves_the_thumb_natively_before_the_app_answers() {
    // An app that keeps 40: the thumb still follows the pointer during the
    // drag (no wait for `onChange` to come back as `value`), and goes back
    // to the app's value when the drag ends.
    let mut props = controlled(40.0);
    props.refusing = true;
    let (mut app, sent) = start_watching(props);
    // 40 points of 200 from 40%: 60%, 120 points along the indicator.
    app.drag_and_hold(
        "label:Volume",
        point(px(40.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Changes 45, 50, 55, 60").unwrap();
    assert_eq!(sent.lock().unwrap().lefts.last(), Some(&120.0));
    assert!(app.shows("Value 40"));
    app.drop_held().unwrap();
    app.wait_for("text:Ends 60").unwrap();
    assert_eq!(sent.lock().unwrap().lefts.last(), Some(&80.0));
}

#[test]
fn right_to_left_the_thumb_sits_from_the_right_and_a_drag_left_raises_it() {
    let mut props = controlled(40.0);
    props.refusing = true;
    let (mut app, sent) = start_watching_in(props, true);
    // 40% from the right end of 200: 80 from it, 120 from the left.
    app.drag_and_hold(
        "label:Volume",
        point(px(-40.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Changes 45, 50, 55, 60").unwrap();
    // 60% from the right: 80 from the left.
    assert_eq!(sent.lock().unwrap().lefts.last(), Some(&80.0));
    app.drop_held().unwrap();
    app.wait_for("text:Ends 60").unwrap();
    assert_eq!(sent.lock().unwrap().lefts.last(), Some(&120.0));
}

#[test]
fn screen_readers_hear_a_drags_value_at_its_end() {
    let (mut app, sent) = start_watching(controlled(40.0));
    app.drag_and_hold(
        "label:Volume",
        point(px(40.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Value 60").unwrap();
    // No screen reader runs: the moves send the thumb no value.
    assert!(
        sent.lock()
            .unwrap()
            .said
            .iter()
            .all(|now| *now == Some(40.0)),
    );
    app.drop_held().unwrap();
    app.wait_for("text:Ends 60").unwrap();
    assert_eq!(sent.lock().unwrap().said.last(), Some(&Some(60.0)));
}

/// How many times each run of [`Bubbles`] drew its thumbs' content, by
/// its `run`.
static DRAWN: Mutex<Vec<Arc<AtomicUsize>>> = Mutex::new(Vec::new());

#[derive(Clone, PartialEq, Props)]
struct BubblesProps {
    /// Its counter in [`DRAWN`].
    run: u32,
}

/// The states a thumb's content follows, by the `group-*:` variant that
/// marks each.
const STATES: &[(&str, &str)] = &[
    ("hover", "group-hover"),
    ("dragging", "group-data-dragging"),
    ("focus", "group-focus-visible"),
];

/// A range slider from 0 to 100 by 5 on a track 200 long (thumbs `Low` and
/// `High`, 10 square), each thumb drawing a mark per state its `group-*:`
/// class colors (`start-hover`, `end-dragging`, ...); the app's value.
#[component]
fn Bubbles(props: BubblesProps) -> impl IntoElement {
    let value = signal(SliderValue::Range(20.0, 60.0));
    let drawn = DRAWN.lock().unwrap()[props.run as usize].clone();
    let el = slider()
        .step(5.0)
        .accessibility_label("High")
        .start_accessibility_label("Low")
        .track_style(|s| s.w(px(200.0)).h(px(20.0)).justify_center())
        .indicator_style(|s| s.h(px(4.0)))
        .thumb_style(|s| s.size(px(10.0)))
        .value(move || value.get())
        .on_change(move |v: &SliderValue| value.set(*v))
        .render_thumb(move |thumb: &SliderThumbContext| {
            drawn.fetch_add(1, Ordering::Relaxed);
            let name = if thumb.start { "start" } else { "end" };
            let mut content = view();
            for (state, variant) in STATES {
                content = content.child(
                    view()
                        .test_id(&format!("{name}-{state}"))
                        .size(px(2.0))
                        .app_class(SharedString::from(format!("{variant}:bg-[#0000ff]"))),
                );
            }
            content
        });
    view()
        .child(view().p(px(20.0)).child(el))
        .child(text(move || format!("Value {}", show(value.get()))))
}

/// [`Bubbles`] on a headless surface of `os`, and how many times it drew
/// its thumbs' content.
fn start_bubbles(os: Os) -> (Headless, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let run = {
        let mut drawn = DRAWN.lock().unwrap();
        drawn.push(count.clone());
        drawn.len() as u32 - 1
    };
    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(844.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Bubbles>(move || {
            BubblesProps { run }
        }))
    };
    config.environment.os = os;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Value 20-60").unwrap();
    (app, count)
}

/// The thumbs' marks their states color now, as `start-hover`, ...
fn marked(app: &mut Headless) -> Vec<String> {
    app.wait(Duration::from_millis(50)).unwrap();
    let mut on = Vec::new();
    for thumb in ["start", "end"] {
        for (state, _) in STATES {
            let id = format!("{thumb}-{state}");
            let style = app.screen().view_style(&format!("id:{id}")).unwrap();
            if style.and_then(|s| s.background_color).is_some() {
                on.push(id);
            }
        }
    }
    on
}

#[test]
fn a_thumbs_content_follows_the_pointer_over_it_and_its_drag() {
    let (mut app, drawn) = start_bubbles(Os::MacOs);
    assert!(marked(&mut app).is_empty());
    // The mouse over the start thumb: its content alone.
    app.hover("label:Low").unwrap();
    assert_eq!(marked(&mut app), ["start-hover"]);
    app.hover("text:Value 20-60").unwrap();
    assert!(marked(&mut app).is_empty());
    // Pressed on the end thumb: dragging from the press, before it moves.
    app.drag_and_hold(
        "label:High",
        point(px(0.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    assert!(marked(&mut app).contains(&"end-dragging".to_owned()));
    assert!(!marked(&mut app).contains(&"start-dragging".to_owned()));
    app.drop_held().unwrap();
    assert!(!marked(&mut app).iter().any(|m| m.ends_with("-dragging")));
    // Drawn once per thumb: the states are classes, nothing drawn again.
    app.drag(
        "label:High",
        point(px(20.0), px(0.0)),
        DragOptions::default(),
    )
    .unwrap();
    app.wait_for("text:Value 20-70").unwrap();
    assert_eq!(drawn.load(Ordering::Relaxed), 2);
}

/// A finger's `phase` on the track, `x` along it. A selector's drag goes to
/// the view it names and the views around it, so naming the slider never
/// reaches the track inside it: the track is the view around the
/// indicator around the thumbs.
fn touch_track(app: &mut Headless, phase: TouchPhase, x: f32) {
    let nodes = app.screen().layout_nodes();
    let parent = |id: NodeId| {
        nodes
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.parent)
            .expect("on screen")
    };
    let thumb = app.screen().id("label:High").unwrap();
    let track = parent(parent(thumb));
    let bounds = nodes
        .iter()
        .find(|n| n.id == track)
        .expect("on screen")
        .bounds;
    // The view found is the track [`Bubbles`] makes 200 long: the slider's
    // parts were laid out otherwise.
    assert_eq!(bounds.size.width, px(200.0), "the track");
    let origin = bounds.origin;
    let location = point(px(x), px(10.0));
    let payload = EventPayload::Touch(Box::new(TouchEvent {
        phase,
        timestamp: 0.0,
        modifiers: Default::default(),
        activated: None,
        points: vec![TouchPoint {
            id: 1,
            target: track,
            path: if phase == TouchPhase::Start {
                vec![track]
            } else {
                Vec::new()
            },
            page: origin + location,
            location,
            changed: true,
            pointer_type: PointerType::Touch,
            pressure: 0.5,
            tilt_x: 0.0,
            tilt_y: 0.0,
            coalesced: Vec::new(),
            eraser: false,
            barrel: false,
        }],
    }));
    app.engine()
        .control()
        .dispatch_event(ROOT_ID, EventKind::Touch, payload);
}

#[test]
fn a_press_on_the_track_marks_the_thumb_it_moves() {
    let (mut app, _) = start_bubbles(Os::Ios);
    // At 75% of the track: past the middle of the two thumbs (40%), so the
    // end's thumb jumps there, dragging until the finger lifts.
    touch_track(&mut app, TouchPhase::Start, 150.0);
    app.wait_for("text:Value 20-75").unwrap();
    assert_eq!(marked(&mut app), ["end-dragging"]);
    touch_track(&mut app, TouchPhase::End, 150.0);
    assert!(marked(&mut app).is_empty());
}

#[test]
fn a_finger_on_a_thumb_marks_it_before_it_moves() {
    let (mut app, _) = start_bubbles(Os::Ios);
    app.drag_and_hold("label:Low", point(px(0.0), px(0.0)), DragOptions::default())
        .unwrap();
    assert_eq!(marked(&mut app), ["start-dragging"]);
    assert!(app.shows("Value 20-60"));
    app.drop_held().unwrap();
    assert!(marked(&mut app).is_empty());
}

#[test]
fn a_ranges_content_shows_the_focus_of_the_thumb_the_keyboard_is_on() {
    let (mut app, _) = start_bubbles(Os::MacOs);
    // Tab reaches the start thumb, then the end's: one shows the focus.
    app.press_key("tab").unwrap();
    assert_eq!(marked(&mut app), ["start-focus"]);
    app.press_key("tab").unwrap();
    assert_eq!(marked(&mut app), ["end-focus"]);
    app.press_key("right").unwrap();
    app.wait_for("text:Value 20-65").unwrap();
    assert_eq!(marked(&mut app), ["end-focus"]);
}
