//! `focusable` in a TSX app: a view that takes no presses is a stop of the
//! keyboard focus with `focusable={true}`, without taking the presses of
//! the pressable around it; it hears `onFocus` / `onBlur` and takes its
//! `focusStyle` while the platform reports it focused.

use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, EventKind, EventMask, EventPayload, MountBatch, MountItem, NodeId, ViewProps,
    tailwind::state,
};
use nsh_engine::{Bundle, Engine, EngineConfig};

use crate::ChannelSink;

const APP: &str = r#"import { mount, signal, Text, View } from "nsh";

function App() {
  const log = signal<string[]>([]);
  const note = (s: string) => log.update((l) => [...l, s]);
  return (
    <View>
      <View testID="card" onPress={() => note("open")}>
        <View
          testID="chart"
          focusable
          style={{ height: 40 }}
          focusStyle={{ opacity: 0.5 }}
          onFocus={() => note("focus")}
          onBlur={() => note("blur")}
        />
      </View>
      <View testID="plain" style={{ height: 20 }} />
      <View testID="backdrop" focusable={false} onPress={() => note("close")} />
      <Text>{"log " + log().join("|")}</Text>
    </View>
  );
}

mount(App);
"#;

fn start() -> (Engine, Receiver<MountBatch>) {
    let dir = crate::temporary_root().join(format!("nsh-focus-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode(&bundle.code, false).unwrap();
    // SAFETY: compiled just now by this runtime.
    let config = EngineConfig::new(nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }));
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
    panic!("the log never became {want}: {last:?}");
}

/// The opacity the batches last gave view `id`.
fn opacity(batches: &[MountBatch], id: NodeId) -> Option<f32> {
    batches
        .iter()
        .flat_map(|b| &b.items)
        .filter_map(|i| match i {
            MountItem::ViewStyle { id: i, style } if *i == id => Some(style.opacity),
            _ => None,
        })
        .next_back()
}

#[test]
fn a_focusable_view_is_a_stop_without_taking_presses() {
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
    let stop = |(id, props): &(NodeId, ViewProps)| {
        props.focus_stop(events(*id).contains(EventKind::Press))
    };
    let (card, chart, plain, backdrop) = (
        props("card"),
        props("chart"),
        props("plain"),
        props("backdrop"),
    );
    // `focusable` makes the chart a stop; it takes no presses, so a press
    // on it is still the card's.
    assert_eq!(chart.1.focusable, Some(true));
    assert!(stop(&chart));
    let chart_events = events(chart.0);
    assert!(!chart_events.contains(EventKind::Press));
    assert!(chart_events.contains(EventKind::Focus) && chart_events.contains(EventKind::Blur));
    assert!(stop(&card), "a pressable is one by default");
    assert!(!stop(&plain), "a view that takes no presses is not");
    assert!(
        !stop(&backdrop),
        "`focusable={{false}}` keeps a pressable out"
    );
    // Its `focusStyle` follows the focus the platform reports.
    let tracked = items()
        .filter_map(|i| match i {
            MountItem::TrackStates { id, states } if *id == chart.0 => Some(*states),
            _ => None,
        })
        .next_back()
        .unwrap_or_default();
    assert_ne!(tracked & state::FOCUSED, 0, "it reports its focus");

    // As a platform reports the keyboard focus reaching it, then leaving.
    let control = engine.control();
    control.set_states(chart.0, state::FOCUSED);
    control.dispatch_event(chart.0, EventKind::Focus, EventPayload::None);
    let focused = until_log(&rx, "log focus");
    assert_eq!(opacity(&focused, chart.0), Some(0.5));
    control.set_states(chart.0, 0);
    control.dispatch_event(chart.0, EventKind::Blur, EventPayload::None);
    let blurred = until_log(&rx, "log focus|blur");
    assert_eq!(opacity(&blurred, chart.0), Some(1.0));
}
