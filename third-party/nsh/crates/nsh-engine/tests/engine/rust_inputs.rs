//! A Rust component's input on the engine: its bar over the keyboard is an
//! input accessory holding its content, and the selection, keys and text
//! the platform reports reach the listeners decoded. A rich editor's bar is
//! its typing input's.

use std::{collections::HashMap, time::Duration};

use crossbeam_channel::Receiver;
use nsh_base::{input, rich_editor::view::rich_editor};
use nsh_core::{
    ApproxTextEngine, EventKind, EventPayload, MountBatch, MountItem, NodeId, PayloadValue,
    ViewKind,
    element::{Root, Selection},
    prelude::*,
};
use nsh_engine::{Engine, EngineConfig};

use crate::ChannelSink;

/// An input with a counter over the keyboard, and what it reported.
#[component]
fn Field() -> impl IntoElement {
    let content = signal(String::new());
    let selected = signal(String::from("no selection"));
    let keys = signal(Vec::<String>::new());
    view()
        .flex_1()
        .child(
            input()
                .placeholder("Type")
                .input_accessory("counter")
                .on_change(move |v: &str| content.set(v.to_owned()))
                .on_selection_change(move |s: &Selection| {
                    selected.set(format!("selected {}–{}", s.start, s.end))
                })
                .on_key_press(move |key: &str| keys.update(|k| k.push(key.to_owned()))),
        )
        .child(input_accessory_view("counter").child(text(move || {
            format!("{} characters", content.with(|c| c.len()))
        })))
        .child(text(move || selected.get()))
        .child(text(move || {
            format!("keys: {}", keys.with(|k| k.join(" ")))
        }))
}

/// A rich editor with a formatting bar over the keyboard, named once the
/// editor first takes the focus, and one without a bar.
#[component]
fn Notes() -> impl IntoElement {
    let bar = signal(None::<SharedString>);
    view()
        .flex_1()
        .child(
            rich_editor()
                .h(px(120.0))
                .accessibility_label("Notes")
                .input_accessory(Prop::bind(move || bar.get()))
                .on_focus(move || bar.set(Some("format".into()))),
        )
        .child(rich_editor().h(px(120.0)).accessibility_label("Plain"))
        .child(input_accessory_view("format").child(text("Bold")))
}

/// The views made, their parents, the texts and the inputs' accessories.
#[derive(Default)]
struct Seen {
    created: Vec<(NodeId, ViewKind)>,
    parents: HashMap<NodeId, NodeId>,
    texts: Vec<(NodeId, String)>,
    accessories: HashMap<NodeId, Option<NodeId>>,
    labels: HashMap<NodeId, String>,
}

impl Seen {
    fn drain(&mut self, rx: &Receiver<MountBatch>) {
        while let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
            for item in batch.items {
                match item {
                    MountItem::Create { id, kind } => self.created.push((id, kind)),
                    MountItem::Insert { parent, child, .. } => {
                        self.parents.insert(child, parent);
                    }
                    MountItem::Text { id, text, .. } => {
                        self.texts.retain(|t| t.0 != id);
                        self.texts.push((id, text.text.clone()));
                    }
                    MountItem::Input { id, config } => {
                        self.accessories.insert(id, config.accessory);
                    }
                    MountItem::ViewProps { id, props } => {
                        if let Some(label) = &props.accessibility.label {
                            self.labels.insert(id, label.to_string());
                        }
                    }
                    MountItem::AccessibilityLabel {
                        id,
                        label: Some(label),
                    } => {
                        self.labels.insert(id, label.to_string());
                    }
                    _ => {}
                }
            }
        }
    }

    fn of(&self, kind: ViewKind) -> NodeId {
        self.created
            .iter()
            .find(|c| c.1 == kind)
            .unwrap_or_else(|| panic!("no {kind:?}: {:?}", self.created))
            .0
    }

    /// The input screen readers call `label`.
    fn input(&self, label: &str) -> NodeId {
        self.created
            .iter()
            .find(|(id, kind)| {
                *kind == ViewKind::Input && self.labels.get(id).is_some_and(|l| l == label)
            })
            .unwrap_or_else(|| panic!("no input {label}: {:?}", self.labels))
            .0
    }

    fn text(&self, text: &str) -> NodeId {
        self.texts
            .iter()
            .find(|t| t.1 == text)
            .unwrap_or_else(|| panic!("no {text}: {:?}", self.texts))
            .0
    }

    fn shows(&self, text: &str) -> bool {
        self.texts.iter().any(|t| t.1 == text)
    }

    /// Whether `id` is inside `ancestor`.
    fn inside(&self, mut id: NodeId, ancestor: NodeId) -> bool {
        while let Some(&parent) = self.parents.get(&id) {
            if parent == ancestor {
                return true;
            }
            id = parent;
        }
        false
    }
}

fn start() -> (Engine, Receiver<MountBatch>, Seen) {
    start_on(nsh_core::platform::Os::Ios)
}

fn start_on(os: nsh_core::platform::Os) -> (Engine, Receiver<MountBatch>, Seen) {
    start_root(Root::of::<Field>(), os)
}

fn start_root(root: Root, os: nsh_core::platform::Os) -> (Engine, Receiver<MountBatch>, Seen) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut config = EngineConfig::new(root);
    config.environment.os = os;
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let mut seen = Seen::default();
    seen.drain(&rx);
    (engine, rx, seen)
}

#[test]
fn a_rust_inputs_accessory_holds_its_content() {
    let (_engine, _rx, seen) = start();
    let input = seen.of(ViewKind::Input);
    let accessory = seen.of(ViewKind::InputAccessory);
    assert_eq!(seen.accessories.get(&input), Some(&Some(accessory)));
    assert!(seen.inside(seen.text("0 characters"), accessory));
}

#[test]
fn a_rust_inputs_accessory_stays_empty_off_ios() {
    let (_engine, _rx, seen) = start_on(nsh_core::platform::Os::Android);
    assert!(
        !seen
            .created
            .iter()
            .any(|(_, kind)| *kind == ViewKind::InputAccessory)
    );
    assert!(!seen.shows("0 characters"));
}

#[test]
fn a_rust_input_hears_its_selection_keys_and_text() {
    let (engine, rx, mut seen) = start();
    let input = seen.of(ViewKind::Input);
    let control = engine.control();
    control.dispatch_event(
        input,
        EventKind::SelectionChange,
        EventPayload::Map(vec![
            ("start", PayloadValue::Number(0.0)),
            ("end", PayloadValue::Number(6.0)),
        ]),
    );
    control.dispatch_event(
        input,
        EventKind::KeyPress,
        EventPayload::Map(vec![("key", PayloadValue::Str("a".into()))]),
    );
    control.dispatch_event(
        input,
        EventKind::ChangeText,
        EventPayload::Text {
            text: "Hello".into(),
            count: 1,
        },
    );
    seen.drain(&rx);
    for text in ["selected 0–6", "keys: a", "5 characters"] {
        assert!(seen.shows(text), "{text}: {:?}", seen.texts);
    }
}

#[test]
fn a_rich_editors_accessory_is_its_typing_inputs() {
    let (engine, rx, mut seen) = start_root(Root::of::<Notes>(), nsh_core::platform::Os::Ios);
    let notes = seen.input("Notes");
    let plain = seen.input("Plain");
    let accessory = seen.of(ViewKind::InputAccessory);
    assert!(seen.inside(seen.text("Bold"), accessory));
    assert_eq!(seen.accessories.get(&notes), Some(&None));
    // Named later, the bar follows.
    engine
        .control()
        .dispatch_event(notes, EventKind::Focus, EventPayload::None);
    seen.drain(&rx);
    assert_eq!(seen.accessories.get(&notes), Some(&Some(accessory)));
    assert_eq!(seen.accessories.get(&plain), Some(&None));
}

#[test]
fn a_rich_editors_accessory_stays_empty_off_ios() {
    let (engine, rx, mut seen) = start_root(Root::of::<Notes>(), nsh_core::platform::Os::Android);
    let notes = seen.input("Notes");
    engine
        .control()
        .dispatch_event(notes, EventKind::Focus, EventPayload::None);
    seen.drain(&rx);
    assert!(
        !seen
            .created
            .iter()
            .any(|(_, kind)| *kind == ViewKind::InputAccessory)
    );
    assert!(!seen.shows("Bold"));
    assert_eq!(seen.accessories.get(&notes), Some(&None));
}
