//! `onHoverIn` / `onHoverOut` / `onHoverMove` in a TSX app: the views'
//! event masks tell the platform which views listen (it raises the events
//! from its hover tracking), the payload-less events reach the handlers,
//! and moves come merged, before the events after them.

use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, EventKind, EventMask, EventPayload, HoverEvent, MountBatch, MountItem,
    NodeId, Size, geometry::px, keymap::Modifiers,
};
use nsh_engine::{Bundle, Engine, EngineConfig};

use crate::ChannelSink;

const APP: &str = r#"import { mount, signal, Text, View } from "nsh";

function App() {
  const log = signal<string[]>([]);
  const note = (s: string) => log.update((l) => [...l, s]);
  return (
    <View>
      <View testID="outer" onHoverIn={() => note("in outer")} onHoverOut={() => note("out outer")}>
        <View
          testID="inner"
          style={{ height: 40 }}
          onHoverIn={() => note("in inner")}
          onMouseMove={(e) => note(`mouse ${e.x},${e.y}`)}
          onHoverMove={(e) => note(`move ${e.position.x},${e.position.y} ${e.pagePosition.x},${e.pagePosition.y}${e.modifiers.shift ? " shift" : ""}`)}
        />
      </View>
      <Text>{"log " + log().join("|")}</Text>
    </View>
  );
}

mount(App);
"#;

fn start() -> (Engine, Receiver<MountBatch>) {
    let dir = std::env::temp_dir().join(format!("nsh-hover-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("App.tsx"), APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: dir.join("App.tsx"),
        minify: false,
        ui_sets: vec![nsh_base::registry().into()],
        split: false,
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
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

#[test]
fn hover_handlers_are_in_the_event_masks_and_hear_their_events() {
    let (engine, rx) = start();
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
    let (outer, inner) = (id("outer"), id("inner"));
    let mask = |kinds: &[EventKind]| {
        let mut m = EventMask::default();
        for &k in kinds {
            m.set(k, true);
        }
        m
    };
    assert_eq!(
        events(outer),
        mask(&[EventKind::HoverIn, EventKind::HoverOut])
    );
    assert_eq!(
        events(inner),
        mask(&[
            EventKind::HoverIn,
            EventKind::HoverMove,
            EventKind::MouseMove
        ])
    );

    // As a desktop raises them: out from the inside, in from the outside.
    let control = engine.control();
    control.dispatch_event(outer, EventKind::HoverIn, EventPayload::None);
    control.dispatch_event(inner, EventKind::HoverIn, EventPayload::None);
    until_log(&rx, "log in outer|in inner");
    let at = |x: f32, shift: bool| {
        EventPayload::Hover(HoverEvent {
            position: nsh_core::geometry::point(px(x), px(2.0)),
            page_position: nsh_core::geometry::point(px(x + 10.0), px(12.0)),
            modifiers: Modifiers {
                shift,
                ..Default::default()
            },
        })
    };
    // Moves sent faster than frames are merged (how many depends on the
    // engine thread's timing): the last one always arrives, and before
    // the event after it.
    for x in 1..=20 {
        control.dispatch_event(inner, EventKind::HoverMove, at(x as f32, x == 20));
    }
    control.dispatch_event(outer, EventKind::HoverOut, EventPayload::None);
    let log = until(&rx, "ending with the out", |l| l.ends_with("out outer"));
    let moves: Vec<&str> = log.split('|').filter(|e| e.starts_with("move ")).collect();
    assert!(moves.len() < 20, "moves are merged: {log}");
    assert_eq!(moves.last(), Some(&"move 20,2 30,12 shift"), "{log}");
    assert!(log.starts_with("log in outer|in inner|move "), "{log}");
    for x in 1..=20 {
        control.dispatch_event(
            inner,
            EventKind::MouseMove,
            EventPayload::Map(vec![
                ("x", nsh_core::PayloadValue::Number(f64::from(x))),
                ("y", nsh_core::PayloadValue::Number(7.0)),
            ]),
        );
    }
    control.dispatch_event(outer, EventKind::HoverOut, EventPayload::None);
    let log = until(&rx, "mouse moves followed by the out", |l| {
        l.contains("mouse 20,7") && l.ends_with("out outer")
    });
    let moves: Vec<_> = log.split('|').filter(|e| e.starts_with("mouse ")).collect();
    assert!(moves.len() < 20, "mouse moves are merged: {log}");
    assert_eq!(moves.last(), Some(&"mouse 20,7"));
}
