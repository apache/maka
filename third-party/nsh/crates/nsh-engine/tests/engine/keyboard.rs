//! `captureKeys`, `onKeyDown` and `onKeyUp` in a TSX app: the mounted rule
//! decodes to canonical keystrokes once, and one platform event on the
//! focused view reaches the view and its listening ancestors, for down and
//! up alike, exactly once each.

use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, EventKind, EventMask, EventPayload, KeyCapture, KeyEvent, MountBatch,
    MountItem, NodeId, ViewProps,
    keymap::{Keystroke, Modifiers},
    platform::Os,
};
use nsh_engine::{Bundle, Engine, EngineConfig};

use crate::ChannelSink;

const APP: &str = r#"import { mount, signal, Text, View } from "nsh";

const log = signal<string[]>([]);
const note = (s: string) => log.update((l) => [...l, s]);

function App() {
  return (
    <View
      testID="outer"
      captureKeys={["mod+k"]}
      onKeyDown={(e) =>
        note(`outer down ${e.key} ${e.code} ${e.defaultPrevented}`)
      }
      onKeyUp={(e) => note(`outer up ${e.key} ${e.defaultPrevented}`)}
    >
      <View testID="mid" onKeyDown={(e) => note(`mid down ${e.key}`)}>
        <View
          testID="inner"
          focusable
          onKeyDown={(e) => note(`inner down ${e.key}`)}
          onKeyUp={(e) => note(`inner up ${e.key}`)}
        />
      </View>
      <Text>{"log " + log().join("|")}</Text>
    </View>
  );
}

mount(App);
"#;

fn start() -> (Engine, Receiver<MountBatch>) {
    let dir = std::env::temp_dir().join(format!("nsh-keyboard-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
        ..Default::default()
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    let mut config = EngineConfig::new(nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }));
    config.environment.os = Os::MacOs;
    let (tx, rx) = crossbeam_channel::unbounded();
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// Waits until the log text is `want`; returns the batches seen meanwhile.
fn until_log(rx: &Receiver<MountBatch>, want: &str) -> Vec<MountBatch> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut seen = Vec::new();
    let mut last = String::new();
    while let Ok(batch) = rx.recv_deadline(deadline) {
        if let Some(text) = batch.items.iter().find_map(|i| match i {
            MountItem::Text { text, .. } if text.text.starts_with("log ") => Some(&text.text),
            _ => None,
        }) {
            last = text.clone();
        }
        seen.push(batch);
        if last == want {
            return seen;
        }
    }
    panic!("the log never became {want:?}: {last:?}");
}

#[test]
fn one_key_event_bubbles_once_with_its_capture() {
    let (engine, rx) = start();
    let first = until_log(&rx, "log ");
    let items = || first.iter().flat_map(|b| &b.items);
    let props = |wanted: &str| -> (NodeId, ViewProps) {
        items()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(wanted) => {
                    Some((*id, (**props).clone()))
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("{wanted} is mounted"))
    };
    let events = |id: NodeId| -> EventMask {
        items()
            .filter_map(|i| match i {
                MountItem::Events { id: i, events } if *i == id => Some(*events),
                _ => None,
            })
            .next_back()
            .unwrap_or_default()
    };
    let (outer, mid, inner) = (props("outer"), props("mid"), props("inner"));
    // The rule parsed once, with this platform's `mod` (Command here).
    assert_eq!(
        outer.1.key_capture,
        KeyCapture::keys([Keystroke::parse_with("mod+k", true).unwrap()])
    );
    assert_eq!(mid.1.key_capture, KeyCapture::None);
    assert!(events(inner.0).contains(EventKind::KeyDown));
    assert!(events(inner.0).contains(EventKind::KeyUp));

    let control = engine.control();
    let modifiers = Modifiers {
        cmd: true,
        ..Default::default()
    };
    let mut down = KeyEvent::default();
    down.key = "k".into();
    down.code = "KeyK".into();
    down.modifiers = modifiers;
    down.default_prevented = true;
    control.dispatch_event(inner.0, EventKind::KeyDown, EventPayload::Key(down));
    // One platform event, one delivery per listening ancestor: the exact
    // log would repeat a view that heard it twice.
    until_log(&rx, "log inner down k|mid down k|outer down k KeyK true");

    let mut up = KeyEvent::default();
    up.key = "k".into();
    up.code = "KeyK".into();
    up.modifiers = modifiers;
    up.default_prevented = true;
    control.dispatch_event(inner.0, EventKind::KeyUp, EventPayload::Key(up));
    until_log(
        &rx,
        "log inner down k|mid down k|outer down k KeyK true|inner up k|outer up k true",
    );
}
