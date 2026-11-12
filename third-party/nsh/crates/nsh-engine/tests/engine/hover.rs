//! `onMouseEnter` / `onMouseLeave` / `onMouseMove` in a TSX app: the
//! views' event masks tell the platform which views listen (it raises the
//! events from its hover tracking), the events reach the handlers with
//! where the mouse is, and moves come merged, before the events after
//! them, with or without a button down.

use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, EventKind, EventMask, EventPayload, MountBatch, MountItem, MouseButton,
    MouseEvent, NodeId, ROOT_ID, Size, TouchEvent, TouchPhase, TouchPoint, geometry::px,
    keymap::Modifiers,
};
use nsh_engine::{Bundle, Engine, EngineConfig};

use crate::ChannelSink;

const APP: &str = r#"import { mount, signal, Text, View } from "nsh";

function App() {
  const log = signal<string[]>([]);
  const note = (s: string) => log.update((l) => [...l, s]);
  return (
    <View>
      <View
        testID="outer"
        onMouseEnter={(e) => note(`in outer ${e.position.x},${e.position.y}`)}
        onMouseLeave={(e) => note(`out outer ${e.position.x},${e.position.y}`)}
        onWheel={(e) => note(`wheel ${e.position.x},${e.pagePosition.y} ${e.delta.x},${e.delta.y} ${e.deltaMode}${e.modifiers.control ? " ctrl" : ""}`)}
        onPinch={(e) => note(`pinch ${e.position.x},${e.pagePosition.y} ${e.delta} ${e.phase}${e.modifiers.shift ? " shift" : ""}`)}
      >
        <View
          testID="inner"
          style={{ height: 40 }}
          onMouseEnter={() => note("in inner")}
          onMouseMove={(e) => note(`move ${e.position.x},${e.position.y} ${e.pagePosition.x},${e.pagePosition.y}${e.modifiers.shift ? " shift" : ""}${e.pressedButton ? " " + e.pressedButton : ""}`)}
        />
      </View>
      <Text>{"log " + log().join("|")}</Text>
    </View>
  );
}

mount(App);
"#;

/// The app on an engine; `name` keeps the tests' directories apart.
fn start(name: &str) -> (Engine, Receiver<MountBatch>) {
    let dir = std::env::temp_dir().join(format!("nsh-hover-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("App.tsx"), APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: dir.join("App.tsx"),
        minify: false,
        ui_sets: vec![nsh_base::registry().into()],
        split: false,
        ..Default::default()
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        content_culling: false,
        network: None,
        websocket: None,
        refuse_connections: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Default::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
        speech: None,
        audio: None,
        windows: None,
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// Waits until the log text is `want`, within a few seconds.
fn until_log(rx: &Receiver<MountBatch>, want: &str) {
    until(rx, want, |log| log == want);
}

/// Waits until the log text satisfies `done`; returns it.
fn until(rx: &Receiver<MountBatch>, what: &str, done: impl Fn(&str) -> bool) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut last = String::new();
    while let Ok(batch) = rx.recv_deadline(deadline) {
        if let Some(text) = batch.items.iter().find_map(|i| match i {
            MountItem::Text { text, .. } if text.text.starts_with("log ") => Some(&text.text),
            _ => None,
        }) {
            last = text.clone();
        }
        if done(&last) {
            return last;
        }
    }
    panic!("the log never became {what}: {last:?}");
}

/// The first frame and the ids of the views `outer` and `inner` in it.
fn first_frame(rx: &Receiver<MountBatch>) -> (MountBatch, NodeId, NodeId) {
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let id = |wanted: &str| -> NodeId {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(wanted) => {
                    Some(*id)
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("{wanted} is mounted"))
    };
    let (outer, inner) = (id("outer"), id("inner"));
    (first, outer, inner)
}

/// The mouse at `x` of `inner` (10 points in from the root view), with
/// Shift held or not and `button` down.
fn at(x: f32, shift: bool, button: Option<MouseButton>) -> EventPayload {
    EventPayload::Mouse(MouseEvent::new(
        nsh_core::geometry::point(px(x), px(2.0)),
        nsh_core::geometry::point(px(x + 10.0), px(12.0)),
        Modifiers {
            shift,
            ..Default::default()
        },
        button,
    ))
}

#[test]
fn mouse_handlers_are_in_the_event_masks_and_hear_their_events() {
    let (engine, rx) = start("events");
    let (first, outer, inner) = first_frame(&rx);
    let events = |id: NodeId| {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id: i, events } if *i == id => Some(*events),
                _ => None,
            })
            .unwrap_or_default()
    };
    let mask = |kinds: &[EventKind]| {
        let mut m = EventMask::default();
        for &k in kinds {
            m.set(k, true);
        }
        m
    };
    assert_eq!(
        events(outer),
        mask(&[
            EventKind::MouseEnter,
            EventKind::MouseLeave,
            EventKind::Wheel,
            EventKind::Pinch
        ])
    );
    assert_eq!(
        events(inner),
        mask(&[EventKind::MouseEnter, EventKind::MouseMove])
    );

    // As a desktop raises them: out from the inside, in from the outside.
    let control = engine.control();
    control.dispatch_event(outer, EventKind::MouseEnter, at(0.0, false, None));
    control.dispatch_event(inner, EventKind::MouseEnter, at(0.0, false, None));
    until_log(&rx, "log in outer 0,2|in inner");
    // Moves sent faster than frames are merged (how many depends on the
    // engine thread's timing): the last one always arrives, and before
    // the event after it.
    for x in 1..=20 {
        control.dispatch_event(inner, EventKind::MouseMove, at(x as f32, x == 20, None));
    }
    control.dispatch_event(outer, EventKind::MouseLeave, at(21.0, false, None));
    let log = until(&rx, "ending with the out", |l| {
        l.ends_with("out outer 21,2")
    });
    let moves: Vec<&str> = log.split('|').filter(|e| e.starts_with("move ")).collect();
    assert!(moves.len() < 20, "moves are merged: {log}");
    assert_eq!(moves.last(), Some(&"move 20,2 30,12 shift"), "{log}");
    assert!(log.starts_with("log in outer 0,2|in inner|move "), "{log}");
}

#[test]
fn a_move_with_a_button_down_reaches_on_mouse_move_with_the_button() {
    let (engine, rx) = start("drag");
    let (_, outer, inner) = first_frame(&rx);
    let control = engine.control();
    control.dispatch_event(outer, EventKind::MouseEnter, at(0.0, false, None));
    control.dispatch_event(inner, EventKind::MouseEnter, at(0.0, false, None));
    until_log(&rx, "log in outer 0,2|in inner");
    // A drag: on the desktops each move with a button down also sends a
    // touch move for any touch listener or responder; `onMouseMove` is
    // still merged across them, each with the button held.
    for x in 1..=20 {
        control.dispatch_event(
            inner,
            EventKind::MouseMove,
            at(x as f32, false, Some(MouseButton::Left)),
        );
        control.dispatch_event(
            ROOT_ID,
            EventKind::Touch,
            EventPayload::Touch(Box::new(TouchEvent {
                phase: TouchPhase::Move,
                timestamp: x as f64,
                activated: None,
                points: vec![TouchPoint {
                    id: 1,
                    target: inner,
                    path: Vec::new(),
                    page: nsh_core::geometry::point(px(x as f32 + 10.0), px(12.0)),
                    location: nsh_core::geometry::point(px(x as f32), px(2.0)),
                    changed: true,
                    pointer_type: nsh_core::PointerType::Mouse,
                }],
            })),
        );
    }
    control.dispatch_event(outer, EventKind::MouseLeave, at(21.0, false, None));
    let log = until(&rx, "the drag's moves followed by the out", |l| {
        l.ends_with("out outer 21,2")
    });
    let moves: Vec<&str> = log.split('|').filter(|e| e.starts_with("move ")).collect();
    assert!(moves.len() < 20, "moves are merged: {log}");
    assert!(moves.iter().all(|m| m.ends_with(" left")), "{log}");
    assert_eq!(moves.last(), Some(&"move 20,2 30,12 left"), "{log}");
}

#[test]
fn wheels_reach_on_wheel_with_their_delta_and_unit() {
    let (engine, rx) = start("wheel");
    let (_, outer, _) = first_frame(&rx);
    let control = engine.control();
    let wheel = |delta, ctrl| {
        EventPayload::Wheel(nsh_core::WheelEvent::new(
            nsh_core::geometry::point(px(3.0), px(4.0)),
            nsh_core::geometry::point(px(13.0), px(14.0)),
            delta,
            Modifiers {
                ctrl,
                ..Default::default()
            },
        ))
    };
    control.dispatch_event(
        outer,
        EventKind::Wheel,
        wheel(
            nsh_core::WheelDelta::Lines(nsh_core::geometry::point(0.0, -1.0)),
            true,
        ),
    );
    control.dispatch_event(
        outer,
        EventKind::Wheel,
        wheel(
            nsh_core::WheelDelta::Points(nsh_core::geometry::point(px(2.5), px(7.0))),
            false,
        ),
    );
    until_log(
        &rx,
        "log wheel 3,14 0,-1 lines ctrl|wheel 3,14 2.5,7 points",
    );
}

#[test]
fn pinches_reach_on_pinch_with_their_delta_and_phase() {
    let (engine, rx) = start("pinch");
    let (_, outer, _) = first_frame(&rx);
    let control = engine.control();
    let pinch = |delta, phase, shift| {
        EventPayload::Pinch(nsh_core::PinchEvent::new(
            nsh_core::geometry::point(px(3.0), px(4.0)),
            nsh_core::geometry::point(px(13.0), px(14.0)),
            nsh_core::geometry::Percentage(delta),
            phase,
            Modifiers {
                shift,
                ..Default::default()
            },
        ))
    };
    control.dispatch_event(
        outer,
        EventKind::Pinch,
        pinch(0.25, nsh_core::PinchPhase::Start, true),
    );
    control.dispatch_event(
        outer,
        EventKind::Pinch,
        pinch(-0.5, nsh_core::PinchPhase::End, false),
    );
    until_log(&rx, "log pinch 3,14 0.25 start shift|pinch 3,14 -0.5 end");
}
