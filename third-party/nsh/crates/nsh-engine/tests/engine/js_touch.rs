//! Touches in a TSX app: the responder negotiation's gesture state, a
//! view whose `panActivation` makes it the responder only when the
//! platform activates its pan (inside a scroll view, which keeps the
//! touches until then), and a pan turned off by a followed handler.

use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventMask, EventPayload, GestureValues, MountBatch,
    MountItem, NodeId, PanActivation, ROOT_ID, Size, TouchEvent, TouchPhase, TouchPoint,
    geometry::px, input::Candidate,
};
use nsh_engine::{Bundle, Engine, EngineConfig};

use crate::ChannelSink;

const APP: &str = r#"import { mount, signal, Scroll, Text, View } from "nsh";

function App() {
  const log = signal<string[]>([]);
  const note = (s: string) => log.update((l) => [...l, s]);
  return (
    <Scroll>
      <View
        testID="scrub"
        style={{ height: 100 }}
        panActivation={{ activeOffsetX: 10, failOffsetY: 10 }}
        onStartShouldSetResponder={() => true}
        onResponderGrant={(e) => {
          note(`grant ${e.locationX}`);
          return true;
        }}
        onResponderMove={(e) => note(`move ${e.locationX}`)}
        onResponderRelease={() => note("release")}
      />
      <View
        testID="swipe"
        style={{ height: 100 }}
        onMoveShouldSetResponder={(e, g) => {
          note(`ask ${g.dx},${g.dy} of ${g.numberActiveTouches}`);
          return Math.abs(g.dx) > 20 && Math.abs(g.dy) < 10;
        }}
        onResponderGrant={() => note("swipe grant")}
      />
      <Text>{"log " + log().join("|")}</Text>
    </Scroll>
  );
}

mount(App);
"#;

const PAN_APP: &str = r#"import { mount, signal, View } from "nsh";

function App() {
  const zoomed = signal(false);
  const close = () => {};
  return (
    <View>
      <View testID="zoom" onPress={() => zoomed.set(!zoomed())} />
      <View testID="viewer" onPanEnd={zoomed() ? undefined : close} />
    </View>
  );
}

mount(App);
"#;

fn start() -> (Engine, Receiver<MountBatch>) {
    start_app("touch", APP)
}

fn start_app(name: &str, app: &str) -> (Engine, Receiver<MountBatch>) {
    let dir = std::env::temp_dir().join(format!("nsh-js-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("App.tsx"), app).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: dir.join("App.tsx"),
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
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
        support_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
        audio: None,
        windows: None,
        login_item: None,
        data_dir: None,
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

fn touch(
    phase: TouchPhase,
    target: NodeId,
    x: f32,
    y: f32,
    t: f64,
    activated: Option<NodeId>,
) -> EventPayload {
    EventPayload::Touch(Box::new(TouchEvent {
        phase,
        timestamp: t,
        modifiers: Default::default(),
        activated,
        points: vec![TouchPoint {
            id: 1,
            target,
            path: if phase == TouchPhase::Start {
                vec![target]
            } else {
                Vec::new()
            },
            page: nsh_core::geometry::point(px(x), px(y + 100.0)),
            location: nsh_core::geometry::point(px(x), px(y)),
            changed: true,
            pointer_type: nsh_core::PointerType::Touch,
            pressure: 0.5,
            tilt_x: 0.0,
            tilt_y: 0.0,
            coalesced: Vec::new(),
            eraser: false,
            barrel: false,
        }],
    }))
}

/// The batches until the log text ends with `end`, within a few seconds.
fn until_log(rx: &Receiver<MountBatch>, end: &str) -> Vec<MountBatch> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut batches = Vec::new();
    let mut last = String::new();
    while let Ok(batch) = rx.recv_deadline(deadline) {
        if let Some(text) = batch.items.iter().find_map(|i| match i {
            MountItem::Text { text, .. } if text.text.starts_with("log ") => Some(&text.text),
            _ => None,
        }) {
            last = text.clone();
        }
        batches.push(batch);
        if last.ends_with(end) {
            return batches;
        }
    }
    panic!("the log never ended with {end:?}: {last:?}");
}

fn commands(batches: &[MountBatch]) -> Vec<(NodeId, Command)> {
    batches
        .iter()
        .flat_map(|b| &b.items)
        .filter_map(|i| match i {
            MountItem::Command { id, command } => Some((*id, command.clone())),
            _ => None,
        })
        .collect()
}

#[test]
fn a_js_view_waits_for_its_pan_and_negotiations_get_the_gesture() {
    let (engine, rx) = start();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let props = |wanted: &str| {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(wanted) => {
                    Some((*id, props.pan_activation))
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("{wanted} is mounted"))
    };
    let (scrub, activation) = props("scrub");
    assert_eq!(
        activation,
        Some(PanActivation {
            active_offset_x: Some(px(10.0)),
            fail_offset_y: Some(px(10.0)),
            ..PanActivation::default()
        }),
        "the platform gets the offsets"
    );
    let (swipe, none) = props("swipe");
    assert_eq!(none, None);
    let send = |phase, target, x, y, t, activated| {
        engine.control().dispatch_event(
            ROOT_ID,
            EventKind::Touch,
            touch(phase, target, x, y, t, activated),
        );
    };

    // Its start handler is not asked: the scroll view keeps the touches
    // until the platform activates the pan, which grants it.
    send(TouchPhase::Start, scrub, 10.0, 50.0, 0.0, None);
    send(TouchPhase::Move, scrub, 15.0, 50.0, 16.0, None);
    send(TouchPhase::Move, scrub, 25.0, 51.0, 32.0, Some(scrub));
    let batches = until_log(&rx, "grant 25|move 25");
    assert_eq!(
        commands(&batches),
        [(scrub, Command::SetJsResponder { block: true })]
    );
    send(TouchPhase::End, scrub, 25.0, 51.0, 48.0, None);
    let batches = until_log(&rx, "|release");
    assert_eq!(commands(&batches), [(ROOT_ID, Command::ClearJsResponder)]);

    // The move handler decides from the gesture since the finger went
    // down.
    send(TouchPhase::Start, swipe, 0.0, 0.0, 100.0, None);
    send(TouchPhase::Move, swipe, 10.0, 3.0, 116.0, None);
    until_log(&rx, "|ask 10,3 of 1");
    send(TouchPhase::Move, swipe, 30.0, 4.0, 132.0, None);
    until_log(&rx, "|ask 30,4 of 1|swipe grant");
}

/// The event mask of `id` in the first batch within a few seconds that
/// sends one.
fn next_events(rx: &Receiver<MountBatch>, id: NodeId) -> EventMask {
    let deadline = Instant::now() + Duration::from_secs(5);
    while let Ok(batch) = rx.recv_deadline(deadline) {
        if let Some(events) = batch.items.iter().find_map(|i| match i {
            MountItem::Events { id: v, events } if *v == id => Some(*events),
            _ => None,
        }) {
            return events;
        }
    }
    panic!("no events of {id} were sent");
}

#[test]
fn a_pan_handler_set_to_undefined_turns_the_pan_off() {
    let (engine, rx) = start_app("pan-off", PAN_APP);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let id = |wanted: &str| {
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
    let (zoom, viewer) = (id("zoom"), id("viewer"));
    let pans =
        |events: EventMask| Candidate::pan(&GestureValues::default(), events, None).is_some();
    let events = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Events { id, events } if *id == viewer => Some(*events),
            _ => None,
        })
        .expect("the viewer listens");
    assert!(events.contains(EventKind::PanEnd) && pans(events));

    engine
        .control()
        .dispatch_event(zoom, EventKind::Press, EventPayload::None);
    let events = next_events(&rx, viewer);
    assert!(
        !events.contains(EventKind::PanEnd) && !pans(events),
        "an undefined handler stops the pan, so the drags go to the content"
    );

    engine
        .control()
        .dispatch_event(zoom, EventKind::Press, EventPayload::None);
    let events = next_events(&rx, viewer);
    assert!(events.contains(EventKind::PanEnd) && pans(events));
}
