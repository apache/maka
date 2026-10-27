//! Rust components through the generated JS glue (the tests' own set,
//! `test/ui`): props, events, children, named slots, children placed one by
//! one, and a list of the app's rows; the runtime's modules (`Alert`), the
//! status bar of pages and dialogs and the environment (`env()` paddings
//! and margins of the safe area and the keyboard).

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventPayload, KeyboardAppearance, KeyboardType,
    MountBatch, MountItem, PayloadValue, Points, ROOT_ID, Size, StatusBarStyle, geometry::px,
};
use nsh_engine::{Bundle, Edges, Engine, EngineConfig, Environment};

use crate::ChannelSink;

fn start(app: &str) -> (Engine, Receiver<MountBatch>) {
    start_in(app, Environment::default())
}

/// The app, compiled by nsh and loaded as bytecode.
fn start_in(app: &str, environment: Environment) -> (Engine, Receiver<MountBatch>) {
    start_with(app, environment, None, None)
}

/// [`start_in`] with the capabilities the app declares (JSON, `nsh.json`'s
/// `capabilities` form) and an `nsh.json`.
pub(crate) fn start_with(
    app: &str,
    environment: Environment,
    capabilities: Option<&str>,
    config: Option<&str>,
) -> (Engine, Receiver<MountBatch>) {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "nsh-components-{}-{}",
        std::process::id(),
        APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    if let Some(config) = config {
        std::fs::write(dir.join("nsh.json"), config).unwrap();
    }
    let ui_sets = vec![nsh_base::registry(), crate::test_ui::registry()];
    // `nsh/base` with its submodules (`nsh/base/plot`).
    let described: Vec<nsh_core::element::description::SetDescription> = ui_sets
        .iter()
        .flat_map(nsh_core::element::Registry::sets)
        .map(Into::into)
        .collect();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: described.clone(),
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode_with(&bundle.code, false, &described).unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: nsh_engine::App::Js(
            unsafe { Bundle::bytecode(bytecode) }
                .with_capabilities_json(capabilities)
                .unwrap(),
        ),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment,
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets,
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

fn text_ids(batch: &MountBatch, wanted: &str) -> Option<u32> {
    batch.items.iter().find_map(|i| match i {
        MountItem::Text { id, text, .. } if text.text == wanted => Some(*id),
        _ => None,
    })
}

const INSET: &str = r#"import { mount, signal, Text } from "nsh";
import { ListView } from "test/ui";

const rows = signal(["A", "B", "C"]);
setTimeout(() => rows.update((r) => [...r, "D"]), 0);

mount(() => <ListView variant="inset" each={rows()}>{(row) => <Text>{row()}</Text>}</ListView>);
"#;

#[test]
fn rows_know_whether_they_are_last() {
    let (_engine, rx) = start(INSET);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let parent_of = |batch: &MountBatch, id| {
        batch.items.iter().find_map(|i| match i {
            MountItem::Insert { parent, child, .. } if *child == id => Some(*parent),
            _ => None,
        })
    };
    let corners = |batch: &MountBatch, id| {
        batch.items.iter().find_map(|i| match i {
            MountItem::ViewStyle { id: v, style } if *v == id => Some(style.corner_radius),
            _ => None,
        })
    };
    let rounded = |c: nsh_core::Corners<Option<nsh_core::Points>>| {
        c.to_array().iter().map(|r| r.is_some()).collect::<Vec<_>>()
    };
    let wrapper = |name| parent_of(&first, text_ids(&first, name).unwrap()).unwrap();
    let (a, b, c) = (wrapper("A"), wrapper("B"), wrapper("C"));
    // The first row rounds its top corners, the last its bottom ones.
    assert_eq!(
        corners(&first, a).map(rounded),
        Some(vec![true, true, false, false])
    );
    assert_eq!(
        corners(&first, b).map(rounded),
        Some(vec![false, false, false, false])
    );
    assert_eq!(
        corners(&first, c).map(rounded),
        Some(vec![false, false, true, true])
    );

    // A row appended: C is no longer the last, D is.
    let next = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the new row");
    let d = parent_of(&next, text_ids(&next, "D").expect("D")).unwrap();
    assert_eq!(
        corners(&next, c).map(rounded),
        Some(vec![false, false, false, false])
    );
    assert_eq!(
        corners(&next, d).map(rounded),
        Some(vec![false, false, true, true])
    );
}

#[test]
fn a_stateful_component_steps_while_held() {
    a_stateful_component_steps_while_held_on(start(STEPPER));
}

fn a_stateful_component_steps_while_held_on((engine, rx): (Engine, Receiver<MountBatch>)) {
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(text_ids(&first, "5").is_some(), "the default value");
    // The + button: the second view listening to presses.
    let plus = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::PressDown) => Some(*id),
            _ => None,
        })
        .nth(1)
        .expect("the + button");
    let control = engine.control();
    control.dispatch_event(plus, EventKind::PressDown, EventPayload::None);
    // One step at once, more after the hold (400ms, then every 80ms).
    std::thread::sleep(Duration::from_millis(700));
    control.dispatch_event(plus, EventKind::PressUp, EventPayload::None);
    std::thread::sleep(Duration::from_millis(200));
    let mut shown = Vec::new();
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(100)) {
        for item in batch.items {
            if let MountItem::Text { text, .. } = item {
                shown.push(text.text.clone());
            }
        }
    }
    let value: f64 = shown
        .iter()
        .rev()
        .find_map(|t| t.parse().ok())
        .expect("the value changed");
    assert!(value >= 8.0, "held: {value}");
    let changes: u32 = shown
        .iter()
        .rev()
        .find_map(|t| t.strip_prefix("changes ")?.parse().ok())
        .unwrap();
    assert_eq!(changes as f64, value - 5.0, "one onChange per step");
    // Released: no more steps.
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
}

/// The batches until `done` holds for one (or nothing came for 500ms).
pub(crate) fn until(
    rx: &Receiver<MountBatch>,
    mut done: impl FnMut(&MountBatch) -> bool,
) -> Vec<MountBatch> {
    let mut batches = Vec::new();
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(500)) {
        let stop = done(&batch);
        batches.push(batch);
        if stop {
            break;
        }
    }
    batches
}

pub(crate) fn shows(batch: &MountBatch, wanted: &str) -> bool {
    text_ids(batch, wanted).is_some()
}

const KEYED_CHILDREN: &str = r#"import { mount, signal, Text } from "nsh";
import { Group } from "test/ui";

const items = signal([{ id: "a", label: "A1" }, { id: "b", label: "B1" }]);
// New objects, the same keys: the rows are kept.
setTimeout(() => items.set([{ id: "a", label: "A2" }, { id: "b", label: "B2" }]), 50);

mount(() => (
  <Group>
    <Each of={items()} key={(i: { id: string }) => i.id}>
      {(item) => <Text>{item().label}</Text>}
    </Each>
  </Group>
));
"#;

/// A component's children made by a keyed `<Each>` keep their rows when
/// the items change: the children's expression is not made again.
#[test]
fn a_components_keyed_children_keep_their_rows() {
    let (_engine, rx) = start(KEYED_CHILDREN);
    let batches = until(&rx, |b| shows(b, "A2"));
    let first = &batches[0];
    let a = text_ids(first, "A1").expect("A1 shown");
    let last = batches.last().unwrap();
    assert_eq!(
        text_ids(last, "A2"),
        Some(a),
        "the row's text is updated in place"
    );
    let deleted = batches[1..]
        .iter()
        .flat_map(|b| &b.items)
        .any(|i| matches!(i, MountItem::Delete { id } if *id % 2 == 0));
    assert!(!deleted, "no row of the app's is made again");
    let removed = batches[1..]
        .iter()
        .flat_map(|b| &b.items)
        .any(|i| matches!(i, MountItem::Remove { id } if *id % 2 == 0));
    assert!(!removed, "the moved row stays in its wrapper");
}

const LAZY_SHEET: &str = r#"import { mount, signal, untracked, Text } from "nsh";
import { Sheet } from "test/ui";

const open = signal(false);
const count = signal(1);
// Made when the sheet opens: shows the count of that moment.
function Content() {
  const at = untracked(() => count());
  return <Text>{`opened at ${at}`}</Text>;
}
setTimeout(() => { count.set(3); open.set(true); }, 50);
setTimeout(() => open.set(false), 150);
setTimeout(() => { count.set(5); open.set(true); }, 250);

mount(() => <Sheet open={open()}><Content /></Sheet>);
"#;

/// A sheet's content (`#[prop(lazy)]` children) is made when it opens,
/// released when it closes, and made again on the next opening.
#[test]
fn a_sheet_makes_its_content_when_it_opens() {
    let (_engine, rx) = start(LAZY_SHEET);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(
        !first
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Text { .. })),
        "closed: no content"
    );
    let batches = until(&rx, |b| shows(b, "opened at 3"));
    assert!(
        batches.iter().any(|b| shows(b, "opened at 3")),
        "made on opening"
    );
    let batches = until(&rx, |b| shows(b, "opened at 5"));
    assert!(
        batches.iter().any(|b| shows(b, "opened at 5")),
        "made again"
    );
}

/// The status bar configs the app sends, until there are `count`.
fn status_bars(rx: &Receiver<MountBatch>, count: usize) -> Vec<(StatusBarStyle, bool)> {
    let mut configs = Vec::new();
    until(rx, |batch| {
        for item in &batch.items {
            if let MountItem::Command {
                id: ROOT_ID,
                command: Command::StatusBar(c),
            } = item
            {
                configs.push((c.style, c.hidden));
            }
        }
        configs.len() >= count
    });
    configs
}

#[test]
fn the_topmost_page_or_dialog_decides_the_status_bar() {
    let (_engine, rx) = start(STATUS_BAR);
    // One per turn that changes it: the first page's; a pushed page over
    // it (the first page changing its own stays under it); a dialog's
    // `hidden` over the pushed page's `foreground`; closed; popped, the
    // first page's as it is now.
    assert_eq!(
        status_bars(&rx, 5),
        [
            (StatusBarStyle::Dark, false),
            (StatusBarStyle::Light, false),
            (StatusBarStyle::Light, true),
            (StatusBarStyle::Light, false),
            (StatusBarStyle::Default, false),
        ]
    );
}

#[test]
fn nsh_json_gives_the_status_bar_its_default() {
    let (_engine, rx) = start_with(
        STATUS_BAR_DEFAULT,
        Environment::default(),
        None,
        Some(r#"{ "statusBar": { "foreground": "light", "hidden": true } }"#),
    );
    // The default; a dialog showing the bar over it, field by field;
    // closed, the default again.
    assert_eq!(
        status_bars(&rx, 3),
        [
            (StatusBarStyle::Light, true),
            (StatusBarStyle::Light, false),
            (StatusBarStyle::Light, true),
        ]
    );
}

fn frame_of(batches: &[MountBatch], id: u32) -> Option<nsh_core::Bounds<nsh_core::Points>> {
    batches.iter().rev().find_map(|b| {
        b.items.iter().rev().find_map(|i| match i {
            MountItem::Frame { id: f, frame } if *f == id => Some(*frame),
            _ => None,
        })
    })
}

#[test]
fn a_popover_follows_an_external_node_instead_of_its_trigger() {
    let (engine, rx) = start(
        r#"import { mount, signal, View, Text, type YNode } from "nsh";
import { Popover } from "nsh/base";

function Screen() {
  const anchor = signal<YNode | null>(null);
  let next: YNode;
  return (
    <View>
      <View ref={(node) => anchor.set(node)} style={{ position: "absolute", left: 40, top: 100, width: 200, height: 30 }} />
      <View ref={(node) => { next = node; }} style={{ position: "absolute", left: 80, top: 200, width: 200, height: 30 }} />
      <View testID="move-anchor" onPress={() => anchor.set(next)}><Text>Move</Text></View>
      <Popover open={anchor() !== null} anchor={anchor()} placement="bottom" align="start" offset={4}
        popupStyle={{ width: 120, height: 50 }} trigger={<Text>Separate trigger</Text>}>
        <Text>External popup</Text>
      </Popover>
    </View>
  );
}
mount(Screen);
"#,
    );
    let batches = until(&rx, |batch| shows(batch, "External popup"));
    let popup = batches
        .iter()
        .flat_map(|batch| &batch.items)
        .find_map(|item| match item {
            MountItem::ViewProps { id, props } if props.focus_return_parent == Some(ROOT_ID) => {
                Some(*id)
            }
            _ => None,
        })
        .expect("the popover keeps its native focus scope");
    let frame = frame_of(&batches, popup).expect("external popup frame");
    assert_eq!(frame.origin, nsh_core::geometry::point(px(40.0), px(134.0)));
    assert_eq!(frame.size, Size::new(px(120.0), px(50.0)));
    let move_anchor = batches
        .iter()
        .flat_map(|batch| &batch.items)
        .find_map(|item| match item {
            MountItem::ViewProps { id, props }
                if props.test_id.as_deref() == Some("move-anchor") =>
            {
                Some(*id)
            }
            _ => None,
        })
        .expect("move anchor control");
    engine
        .control()
        .dispatch_event(move_anchor, EventKind::Press, EventPayload::None);
    let moved = until(&rx, |batch| {
        batch.items.iter().any(|item| matches!(item,
            MountItem::Frame { id, frame }
                if *id == popup && frame.origin == nsh_core::geometry::point(px(80.0), px(234.0))
        ))
    });
    assert_eq!(
        frame_of(&moved, popup)
            .expect("the same popup follows the next anchor")
            .origin,
        nsh_core::geometry::point(px(80.0), px(234.0)),
    );
}

#[test]
fn unhandled_back_presses_go_back_natively() {
    unhandled_back_presses_go_back_natively_on(start(BACK));
}

fn unhandled_back_presses_go_back_natively_on((engine, rx): (Engine, Receiver<MountBatch>)) {
    until(&rx, |b| shows(b, "presses 0"));
    let backs = |batches: &[MountBatch]| {
        batches
            .iter()
            .flat_map(|b| &b.items)
            .filter(|i| {
                matches!(
                    i,
                    MountItem::Command {
                        id: ROOT_ID,
                        command: Command::Back
                    }
                )
            })
            .count()
    };
    let control = engine.control();
    control.dispatch_event(ROOT_ID, EventKind::BackPress, EventPayload::None);
    let first = until(&rx, |b| shows(b, "presses 1"));
    assert_eq!(backs(&first), 0, "handled");
    control.dispatch_event(ROOT_ID, EventKind::BackPress, EventPayload::None);
    let second = until(&rx, |b| backs(std::slice::from_ref(b)) > 0);
    assert_eq!(
        backs(&second),
        1,
        "not handled: the platform goes back (a stack pops, or the app exits)"
    );
}

#[test]
fn a_rust_text_field_clears_after_typing() {
    a_rust_text_field_clears_after_typing_on(start(FIELD));
}

fn a_rust_text_field_clears_after_typing_on((engine, rx): (Engine, Receiver<MountBatch>)) {
    let first = until(&rx, |b| shows(b, "name Ada"));
    let input = first
        .iter()
        .flat_map(|b| &b.items)
        .find_map(|i| match i {
            MountItem::Create {
                id,
                kind: nsh_core::ViewKind::Input,
            } => Some(*id),
            _ => None,
        })
        .expect("an input");
    let control = engine.control();
    // The user types: two edits.
    for (text, count) in [("Ada G", 1), ("Ada Gr", 2)] {
        control.dispatch_event(
            input,
            EventKind::ChangeText,
            EventPayload::Text {
                text: text.into(),
                count,
            },
        );
    }
    until(&rx, |b| shows(b, "name Ada Gr"));
    // The clear button: the field sends the empty text, based on the last
    // edit (else the platform drops it as stale).
    let clear = first
        .iter()
        .flat_map(|b| &b.items)
        .filter_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
            _ => None,
        })
        .next_back()
        .expect("the clear button");
    control.dispatch_event(clear, EventKind::Press, EventPayload::None);
    let after = until(&rx, |b| shows(b, "name "));
    let value = after.iter().flat_map(|b| &b.items).find_map(|i| match i {
        MountItem::InputValue { id, text, count } if *id == input => Some((text.clone(), *count)),
        _ => None,
    });
    assert_eq!(value, Some((String::new(), 2)));
}

#[test]
fn a_sibling_coming_back_does_not_move_a_rust_input() {
    a_sibling_coming_back_does_not_move_a_rust_input_on(start(FIELD));
}

fn a_sibling_coming_back_does_not_move_a_rust_input_on(
    (engine, rx): (Engine, Receiver<MountBatch>),
) {
    let first = until(&rx, |b| shows(b, "name Ada"));
    let items = || first.iter().flat_map(|b| &b.items);
    let input = items()
        .find_map(|i| match i {
            MountItem::Create {
                id,
                kind: nsh_core::ViewKind::Input,
            } => Some(*id),
            _ => None,
        })
        .expect("an input");
    let clear = items()
        .filter_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
            _ => None,
        })
        .next_back()
        .expect("the clear button");
    let control = engine.control();
    control.dispatch_event(clear, EventKind::Press, EventPayload::None);
    until(&rx, |b| shows(b, "name "));
    control.dispatch_event(
        input,
        EventKind::ChangeText,
        EventPayload::Text {
            text: "x".into(),
            count: 1,
        },
    );
    let after = until(&rx, |b| shows(b, "name x"));
    let inserts: Vec<_> = after
        .iter()
        .flat_map(|b| &b.items)
        .filter_map(|i| match i {
            MountItem::Insert { child, before, .. } => Some((*child, *before)),
            _ => None,
        })
        .collect();
    assert!(
        inserts.iter().all(|&(child, _)| child != input),
        "{inserts:?}"
    );
    // The new clear button goes after the input, at the end.
    assert!(
        inserts.iter().any(|&(_, before)| before.is_none()),
        "{inserts:?}"
    );
}

// --- Through the native modules ------------------------------------------------

const CARD: &str = r#"import { mount, signal, Text } from "nsh";
import { Button, Card } from "test/ui";

function App() {
  const titled = signal(true);
  return (
    <Card
      header={<If when={titled()}><Text>Title</Text></If>}
      footer={<Button title="Hide title" onPress={() => titled.set(false)} />}
    >
      <Text>Body</Text>
    </Card>
  );
}

mount(App);
"#;

#[test]
fn slots_children_and_events() {
    let (engine, rx) = start(CARD);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    for wanted in ["Title", "Body", "Hide title"] {
        assert!(text_ids(&first, wanted).is_some(), "{wanted} rendered");
    }
    let parent_of = |id| {
        first.items.iter().find_map(|i| match i {
            MountItem::Insert { parent, child, .. } if *child == id => Some(*parent),
            _ => None,
        })
    };
    let frame = |id| {
        first.items.iter().find_map(|i| match i {
            MountItem::Frame { id: f, frame } if *f == id => Some(*frame),
            _ => None,
        })
    };
    let title_parent = parent_of(text_ids(&first, "Title").unwrap()).unwrap();
    let body_parent = parent_of(text_ids(&first, "Body").unwrap()).unwrap();
    assert!(frame(title_parent).unwrap().origin.y.0 < frame(body_parent).unwrap().origin.y.0);
    let button = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
            _ => None,
        })
        .expect("a pressable button");
    engine
        .control()
        .dispatch_event(button, EventKind::Press, EventPayload::None);
    let batch = rx.recv_timeout(Duration::from_secs(5)).expect("a batch");
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { id } if *id == title_parent)),
        "{:?}",
        batch.items
    );
}

const METHODS: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Stepper, type StepperRef } from "test/ui";

const shown = signal("waiting");
let stepper!: StepperRef;
setTimeout(async () => {
  let refused = "";
  // A method returning nothing is a plain call: `undefined`, and a wrong
  // argument throws in the call.
  try { (stepper.setValue as any)("x"); refused = "no throw"; } catch (e) { refused = `${e.name}: ${e.message}`; }
  const set = stepper.setValue(42.4);
  if (set !== undefined) refused = `returned ${set}`;
  // One returning a value is a promise, settled after the call before it ran.
  const value = await stepper.value();
  shown.set(`got ${value} | ${refused}`);
}, 0);

mount(() => (
  <View>
    <Stepper ref={stepper} defaultValue={1} max={50} />
    <Text>{shown()}</Text>
  </View>
));
"#;

#[test]
fn calls_of_a_components_methods() {
    let (_engine, rx) = start(METHODS);
    let mut shown = Vec::new();
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(500)) {
        for item in batch.items {
            if let MountItem::Text { text, .. } = item {
                shown.push(text.text.clone());
            }
        }
        if shown.iter().any(|t| t.starts_with("got")) {
            break;
        }
    }
    assert!(shown.contains(&"42".to_owned()), "{shown:?}");
    // A wrong argument's error names the component.
    assert!(
        shown.contains(
            &"got 42 | TypeError: Stepper.setValue: `value`: expected a number, got \"x\""
                .to_owned()
        ),
        "{shown:?}"
    );
}

const ALERT: &str = r#"import { mount, signal, Text } from "nsh";
import { AlertDialog } from "nsh/base";

const shown = signal("waiting");
setTimeout(async () => {
  const a = await AlertDialog.show({
    title: "Delete the photo?",
    description: "It is gone then.",
    actions: [
      { label: "Cancel", role: "cancel" },
      { label: "Delete", role: "destructive", id: "delete" },
    ],
  });
  const b = await AlertDialog.show({
    presentation: "actionSheet",
    actions: [{ label: "Share" }, { label: "Copy" }],
  });
  const c = await AlertDialog.show({ actions: [{ label: "OK" }], closeOnEscape: true });
  let d = "resolved";
  try {
    await AlertDialog.show({ actions: [] });
  } catch (e) {
    d = "rejected";
  }
  shown.set(`answers ${a} ${b} ${c} ${d}`);
}, 0);

mount(() => <Text>{shown()}</Text>);
"#;

/// `AlertDialog.show` resolves with the chosen action's id, else its
/// label, and with null when it closed without one.
#[test]
fn alert_dialogs_resolve_with_the_action_chosen() {
    let (engine, rx) = start(ALERT);
    let next_dialog = || {
        let mut dialog = None;
        until(&rx, |batch| {
            dialog = dialog.take().or_else(|| {
                batch.items.iter().find_map(|i| match i {
                    MountItem::Command {
                        id: ROOT_ID,
                        command: Command::Dialog(d),
                    } => Some(d.clone()),
                    _ => None,
                })
            });
            dialog.is_some()
        });
        dialog.expect("a dialog")
    };
    let answer = |dialog: &nsh_core::Dialog, index: f64| {
        engine.control().dispatch_event(
            ROOT_ID,
            EventKind::Dialog,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(dialog.id as f64)),
                ("index", PayloadValue::Number(index)),
            ]),
        );
    };
    let alert = next_dialog();
    assert_eq!(alert.title.as_deref(), Some("Delete the photo?"));
    assert_eq!(alert.message.as_deref(), Some("It is gone then."));
    assert!(!alert.sheet && !alert.cancelable);
    assert_eq!(
        alert.buttons[1].style,
        nsh_core::DialogButtonStyle::Destructive
    );
    answer(&alert, 1.0);
    let sheet = next_dialog();
    assert!(sheet.sheet && sheet.cancelable);
    answer(&sheet, 0.0);
    let ok = next_dialog();
    assert!(ok.cancelable);
    answer(&ok, -1.0);
    let batches = until(&rx, |b| shows(b, "answers delete Share null rejected"));
    assert!(
        batches
            .iter()
            .any(|b| shows(b, "answers delete Share null rejected"))
    );
}

const SAFE_AREA: &str = r#"import { mount, Text, View } from "nsh";
import { safeArea } from "nsh";

mount(() => (
  <View style={{ flex: 1, marginBottom: "env(keyboard-inset-height)" }}>
    <View
      style={{
        flex: 1,
        padding: 4,
        paddingTop: "calc(env(safe-area-inset-top) + 4px)",
        paddingBottom: "calc(env(safe-area-inset-bottom) + 4px)",
      }}
    >
      <Text>inside</Text>
      <Text>{`top ${safeArea().top}`}</Text>
    </View>
  </View>
));
"#;

#[test]
fn safe_area_and_keyboard_env_insets() {
    let environment = Environment {
        window: Size::new(px(390.0), px(844.0)),
        safe_area: Edges {
            top: Points(47.0),
            right: Points(10.0),
            bottom: Points(34.0),
            left: Points(10.0),
        },
        ..Default::default()
    };
    let (engine, rx) = start_in(SAFE_AREA, environment);
    let first = until(&rx, |b| shows(b, "inside"));
    let text = first
        .iter()
        .find_map(|b| text_ids(b, "inside"))
        .expect("the text");
    let frame = frame_of(&first, text).expect("laid out");
    assert_eq!((frame.origin.x.0, frame.origin.y.0), (4.0, 51.0));
    assert!(
        first.iter().any(|b| shows(b, "top 47")),
        "the environment's accessor"
    );
    engine.control().set_environment(Environment {
        keyboard_height: px(300.0),
        safe_area: Edges {
            top: Points(20.0),
            ..environment.safe_area
        },
        ..environment
    });
    let after = until(&rx, |b| shows(b, "top 20"));
    assert!(
        after.iter().any(|b| shows(b, "top 20")),
        "the accessor follows"
    );
    assert!(
        after.iter().flat_map(|b| &b.items).any(
            |i| matches!(i, MountItem::Frame { frame, .. } if frame.size.height.0 == 844.0 - 300.0)
        ),
        "the view above the keyboard"
    );
}

const RUNTIME_MODULES: &str = r#"import { mount, signal, Text } from "nsh";
import { reduceMotion, setAccessibilityFocus } from "nsh";
import { platform } from "nsh";
import { Image } from "nsh";

const shown = signal("waiting");
let note: unknown;
setTimeout(async () => {
  setAccessibilityFocus(note);
  const size = await Image.getSize("https://example.com/a.png");
  let failed = "no";
  try {
    await Image.getSize("https://example.com/missing.png");
  } catch (e) {
    failed = String((e as Error).message);
  }
  shown.set(`${size.width}x${size.height} ${failed} ${platform.os} ${reduceMotion()}`);
}, 0);

mount(() => <Text ref={note}>{shown()}</Text>);
"#;

#[test]
fn runtime_modules() {
    let (engine, rx) = start(RUNTIME_MODULES);
    let note = rx
        .recv_timeout(Duration::from_secs(5))
        .ok()
        .and_then(|b| text_ids(&b, "waiting"))
        .expect("first frame");
    let mut focused = None;
    let mut requests = Vec::new();
    let control = engine.control();
    until(&rx, |batch| {
        for item in &batch.items {
            match item {
                MountItem::Command {
                    id,
                    command: Command::AccessibilityFocus,
                } => focused = Some(*id),
                MountItem::Command {
                    id: ROOT_ID,
                    command: Command::ImageInfo { id, uri },
                } => {
                    requests.push(uri.clone());
                    let payload = if requests.len() == 1 {
                        vec![
                            ("id", PayloadValue::Number(*id as f64)),
                            ("width", PayloadValue::Number(640.0)),
                            ("height", PayloadValue::Number(480.0)),
                        ]
                    } else {
                        vec![
                            ("id", PayloadValue::Number(*id as f64)),
                            ("error", PayloadValue::Str("not found".into())),
                        ]
                    };
                    control.dispatch_event(
                        ROOT_ID,
                        EventKind::ImageInfo,
                        EventPayload::Map(payload),
                    );
                }
                _ => {}
            }
        }
        shows(batch, "640x480 not found ios false")
    });
    assert_eq!(focused, Some(note));
}

const MEASURE: &str = r#"import { mount, signal, Scroll, Text, View, type YNode } from "nsh";

const shown = signal("waiting");
let box!: YNode;
let ghost!: YNode;
const detached = <View ref={(n: YNode) => (ghost = n)} />;
setTimeout(async () => {
  const m = (await box.measure())!;
  const none = await ghost.measure();
  const b = m.bounds;
  shown.set(`at ${b.origin.x},${b.origin.y} ${b.size.width}x${b.size.height} page ${m.pagePosition.x},${m.pagePosition.y} ${none}`);
}, 0);

mount(() => (
  <View>
    <Text>{shown()}</Text>
    <Scroll
      style={{ marginTop: 50, height: 300 }}
      onScroll={async () => shown.set(`scrolled ${(await box.measure())!.pagePosition.y}`)}
    >
      <View style={{ padding: 20, height: 1000 }}>
        <View ref={box} style={{ marginTop: 500, height: 30 }} />
      </View>
    </Scroll>
  </View>
));
void detached;
"#;

/// `ref.measure()` answers after layout, with the frame in the parent and
/// the position in the root view, following the scroll view's offset.
#[test]
fn measure_reports_frames_and_page_positions() {
    let (engine, rx) = start(MEASURE);
    let mut scroll = None;
    let batches = until(&rx, |batch| {
        for item in &batch.items {
            if let MountItem::Create {
                id,
                kind: nsh_core::ViewKind::Scroll,
            } = item
            {
                scroll = Some(*id);
            }
        }
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Text { text, .. } if text.text.starts_with("at ")))
    });
    let shown: Vec<_> = batches
        .iter()
        .flat_map(|b| &b.items)
        .filter_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.to_string()),
            _ => None,
        })
        .collect();
    // The text above the scroll view is one line (17 points with the approximate text engine) tall.
    assert!(
        shown
            .iter()
            .any(|t| t == "at 20,520 350x30 page 20,587 null"),
        "{shown:?}"
    );
    engine.control().scroll(
        scroll.expect("scroll view"),
        nsh_core::geometry::point(nsh_core::geometry::px(0.0), nsh_core::geometry::px(400.0)),
        0,
    );
    let after = until(&rx, |b| shows(b, "scrolled 187"));
    assert!(after.iter().any(|b| shows(b, "scrolled 187")));
}

const CLIPBOARD: &str = r#"import { mount, signal, Text } from "nsh";
import { Clipboard } from "nsh";

const shown = signal("waiting");
setTimeout(async () => {
  const before = await Clipboard.hasText();
  Clipboard.writeText("copied");
  const has = await Clipboard.hasText();
  const text = await Clipboard.readText();
  shown.set(`${before} ${has} ${text}`);
}, 0);

mount(() => <Text>{shown()}</Text>);
"#;

/// A platform's clipboard: answers the core's reads from what it set.
fn serve_clipboard(engine: &Engine, rx: &Receiver<MountBatch>, wanted: &str) -> Vec<Command> {
    let control = engine.control();
    let mut board: Option<String> = None;
    let mut commands = Vec::new();
    until(rx, |batch| {
        for item in &batch.items {
            let MountItem::Command {
                id: ROOT_ID,
                command,
            } = item
            else {
                continue;
            };
            match command {
                Command::SetClipboard(text) => board = Some(text.clone()),
                Command::ReadClipboard { id, has_only } => {
                    let mut payload = vec![
                        ("id", PayloadValue::Number(*id as f64)),
                        ("has", PayloadValue::Bool(board.is_some())),
                    ];
                    if let (false, Some(text)) = (has_only, &board) {
                        payload.push(("text", PayloadValue::Str(text.clone())));
                    }
                    control.dispatch_event(
                        ROOT_ID,
                        EventKind::Clipboard,
                        EventPayload::Map(payload),
                    );
                }
                _ => continue,
            }
            commands.push(command.clone());
        }
        shows(batch, wanted)
    });
    commands
}

#[test]
fn the_clipboard_round_trips_through_the_platform() {
    let (engine, rx) = start(CLIPBOARD);
    let commands = serve_clipboard(&engine, &rx, "false true copied");
    assert_eq!(
        commands,
        [
            Command::ReadClipboard {
                id: 1,
                has_only: true
            },
            Command::SetClipboard("copied".into()),
            Command::ReadClipboard {
                id: 2,
                has_only: true
            },
            Command::ReadClipboard {
                id: 3,
                has_only: false
            },
        ]
    );
}

#[test]
fn the_clipboard_needs_its_capability() {
    let (engine, rx) = start_with(CLIPBOARD, Environment::default(), Some("{}"), None);
    // Nothing reaches the platform, and reads find nothing.
    let commands = serve_clipboard(&engine, &rx, "false false ");
    assert!(commands.is_empty(), "{commands:?}");
    let (engine, rx) = start_with(
        CLIPBOARD,
        Environment::default(),
        Some(r#"{ "clipboard": true }"#),
        None,
    );
    serve_clipboard(&engine, &rx, "false true copied");
}

const CLIPBOARD_IMAGE: &str = r#"import { mount, signal, Text } from "nsh";
import { Clipboard } from "nsh";

const shown = signal("waiting");
setTimeout(async () => {
  const before = await Clipboard.hasImage();
  Clipboard.writeImage("data:image/png;base64,aGk=");
  const image = await Clipboard.readImage();
  const bytes = new Uint8Array(await (await fetch(image!.url)).arrayBuffer());
  const files = await Clipboard.readFiles();
  shown.set(`${before} ${image!.size.width}x${image!.size.height} ${bytes.join(",")} ${files.join(" ")}`);
}, 0);

mount(() => <Text>{shown()}</Text>);
"#;

#[test]
fn clipboard_images_and_files_reach_js() {
    let (engine, rx) = start(CLIPBOARD_IMAGE);
    let control = engine.control();
    let mut board: Option<String> = None;
    let mut commands = Vec::new();
    until(&rx, |batch| {
        for item in &batch.items {
            let MountItem::Command {
                id: ROOT_ID,
                command,
            } = item
            else {
                continue;
            };
            let payload = match command {
                Command::SetClipboardImage(uri) => {
                    board = Some(uri.clone());
                    None
                }
                Command::ReadClipboardImage { id, has_only } => {
                    let mut payload = vec![
                        ("id", PayloadValue::Number(*id as f64)),
                        ("has", PayloadValue::Bool(board.is_some())),
                    ];
                    if let (false, Some(uri)) = (has_only, &board) {
                        payload.push(("uri", PayloadValue::Str(uri.clone())));
                        payload.push(("width", PayloadValue::Number(2.0)));
                        payload.push(("height", PayloadValue::Number(1.0)));
                    }
                    Some(payload)
                }
                Command::ReadClipboardFiles { id } => Some(vec![
                    ("id", PayloadValue::Number(*id as f64)),
                    ("has", PayloadValue::Bool(true)),
                    (
                        "files",
                        PayloadValue::Str("file:///tmp/a%20b.txt\nfile:///tmp/c/".into()),
                    ),
                ]),
                _ => continue,
            };
            if let Some(payload) = payload {
                control.dispatch_event(ROOT_ID, EventKind::Clipboard, EventPayload::Map(payload));
            }
            commands.push(command.clone());
        }
        shows(
            batch,
            "false 2x1 104,105 file:///tmp/a%20b.txt file:///tmp/c/",
        )
    });
    assert_eq!(
        commands,
        [
            Command::ReadClipboardImage {
                id: 1,
                has_only: true
            },
            Command::SetClipboardImage("data:image/png;base64,aGk=".into()),
            Command::ReadClipboardImage {
                id: 2,
                has_only: false
            },
            Command::ReadClipboardFiles { id: 3 },
        ]
    );
}

const PICKER: &str = r#"import { mount, signal, Text } from "nsh";
import { Picker } from "nsh";

const shown = signal("");
setTimeout(async () => {
  const images = await Picker.pickImages({ multiple: true, limit: 3, maxDimension: 1024 });
  const [{ file, size }] = images;
  const bytes = await file.bytes();
  const url = URL.createObjectURL(file);
  shown.set(
    `${images.length} ${file instanceof File} ${file.name} ${file.type} ${file.size} ${size.width}x${size.height} ${bytes.slice(1, 4).join(",")} ${url.startsWith("blob:")} ${file.lastModified}`,
  );
}, 0);

mount(() => <Text>{shown()}</Text>);
"#;

#[test]
fn picked_images_reach_js_as_files() {
    let (engine, rx) = start(PICKER);
    let control = engine.control();
    let mut asked = None;
    until(&rx, |batch| {
        for item in &batch.items {
            if let MountItem::Command {
                id: ROOT_ID,
                command: Command::PickImages { id, request },
            } = item
            {
                asked = Some(*request);
                let mut file = nsh_core::picker::PickedFile::new(
                    "IMG_0042.HEIC",
                    "image/jpeg",
                    nsh_core::ImageData::new(vec![0xff, 0xd8, 0xff, 0xe0, 0, 0]),
                );
                file.size = Size::new(
                    nsh_core::geometry::DevicePixels(1024),
                    nsh_core::geometry::DevicePixels(768),
                );
                file.last_modified = Some(
                    std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_700_000_000_000),
                );
                control.dispatch_event(
                    ROOT_ID,
                    EventKind::Pick,
                    EventPayload::Picked {
                        id: *id,
                        files: vec![file],
                    },
                );
            }
        }
        shows(
            batch,
            "1 true IMG_0042.jpg image/jpeg 6 1024x768 216,255,224 true 1700000000000",
        )
    });
    let asked = asked.expect("a pick");
    assert_eq!(asked.limit, 3);
    assert_eq!(
        asked.max_dimension,
        Some(nsh_core::geometry::DevicePixels(1024))
    );
}

const INPUT_TRAITS: &str = r##"import { mount, Text } from "nsh";
import { Input } from "nsh/base";

mount(() => (
  <>
    <Input keyboardType="numeric" ios={{ keyboardAppearance: "dark" }} />
    <Input
      keyboardType="numbers-and-punctuation"
      masked
      readonly
      multiline
      style={{ placeholderColor: "#00ff00", selectionColor: "#0000ff" }}
    />
    <Input class="placeholder:text-white selection:bg-black" />
    <Text style={{ userSelect: "text", selectionColor: "#ff0000" }}>Pick me</Text>
  </>
));
"##;

#[test]
fn inputs_and_selectable_text_carry_their_traits() {
    let (_engine, rx) = start(INPUT_TRAITS);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let inputs: Vec<_> = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Input { config, .. } => Some(config.clone()),
            _ => None,
        })
        .collect();
    let traits: Vec<_> = inputs
        .iter()
        .map(|c| (c.keyboard, c.keyboard_appearance))
        .collect();
    assert_eq!(
        traits,
        [
            (KeyboardType::Numeric, KeyboardAppearance::Dark),
            (
                KeyboardType::NumbersAndPunctuation,
                KeyboardAppearance::Default
            ),
            (KeyboardType::Default, KeyboardAppearance::Default),
        ]
    );
    let c = &inputs[1];
    assert!(c.secure && !c.editable && c.multiline);
    assert_eq!(c.placeholder_color, nsh_core::Color::parse("#00ff00"));
    assert_eq!(c.selection_color, nsh_core::Color::parse("#0000ff"));
    assert!(!inputs[0].secure && inputs[0].editable && inputs[0].placeholder_color.is_none());
    assert_eq!(
        inputs[2].placeholder_color,
        nsh_core::Color::parse("#ffffff")
    );
    assert_eq!(inputs[2].selection_color, nsh_core::Color::parse("#000000"));
    let text = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Text { text, .. } if text.text == "Pick me" => Some(text.clone()),
            _ => None,
        })
        .expect("the text");
    assert!(text.is_selectable());
    assert_eq!(
        text.selection_color,
        Some(nsh_core::Color::rgba(255, 0, 0, 255))
    );
}

const ROWS: &str = r#"import { mount, Text } from "nsh";
import { Group, ListView } from "test/ui";

const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, label: `Row ${i}` }));

mount(() => (
  <ListView
    each={rows}
    header={() => (
      <Group>
        <Text>First</Text>
        <Text>Second</Text>
      </Group>
    )}
  >
    {(row) => <Text>{row().label}</Text>}
  </ListView>
));
"#;

#[test]
fn components_place_the_apps_children_and_rows() {
    let (_engine, rx) = start(ROWS);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let parent_of = |id| {
        first.items.iter().find_map(|i| match i {
            MountItem::Insert { parent, child, .. } if *child == id => Some(*parent),
            _ => None,
        })
    };
    let frame = |id| {
        first.items.iter().find_map(|i| match i {
            MountItem::Frame { id: f, frame } if *f == id => Some(*frame),
            _ => None,
        })
    };
    let top_border = |id| {
        first.items.iter().any(|i| {
            matches!(i, MountItem::ViewStyle { id: v, style } if *v == id && style.borders.widths.top.0 == 1.0)
        })
    };
    let a = parent_of(text_ids(&first, "First").expect("First")).unwrap();
    let b = parent_of(text_ids(&first, "Second").expect("Second")).unwrap();
    assert!(a % 2 == 1 && b % 2 == 1 && a != b);
    assert!(!top_border(a) && top_border(b));
    let row0 = parent_of(text_ids(&first, "Row 0").expect("Row 0")).unwrap();
    let row1 = parent_of(text_ids(&first, "Row 1").expect("Row 1")).unwrap();
    assert!(row0 % 2 == 1 && row1 % 2 == 1);
    assert_eq!(
        frame(text_ids(&first, "Row 0").unwrap()).map(|f| f.origin.x.0),
        Some(16.0)
    );
    assert!(!top_border(row0) && top_border(row1));
    assert!(text_ids(&first, "Row 99").is_none());
}

const STEPPER: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Stepper } from "test/ui";

const changes = signal(0);
mount(() => (
  <View>
    <Stepper defaultValue={5} min={0} max={100} onChange={() => changes.update((c) => c + 1)} />
    <Text>{`changes ${changes()}`}</Text>
  </View>
));
"#;

const STATUS_BAR: &str = r##"import { signal, mount, View } from "nsh";
import { Dialog, NavPage, NavStack, createNavStack } from "nsh/base";

type Route = { name: string };
const nav = createNavStack<Route>([{ name: "home" }]);
const home = signal<"auto" | "dark">("dark");
const open = signal(false);
setTimeout(() => nav.push({ name: "detail" }), 30);
setTimeout(() => home.set("auto"), 50);
setTimeout(() => open.set(true), 70);
setTimeout(() => open.set(false), 100);
setTimeout(() => nav.pop(), 130);

mount(() => (
  <View style={{ flex: 1 }}>
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage
          title={route.name}
          statusBar={route.name === "home" ? { foreground: home() } : { foreground: "light" }}
        >
          <View />
        </NavPage>
      )}
    </NavStack>
    <Dialog open={open()} statusBar={{ hidden: true }}>
      <View />
    </Dialog>
  </View>
));
"##;

const STATUS_BAR_DEFAULT: &str = r##"import { signal, mount, View } from "nsh";
import { Dialog } from "nsh/base";

const open = signal(false);
setTimeout(() => open.set(true), 30);
setTimeout(() => open.set(false), 60);

mount(() => (
  <View>
    <Dialog open={open()} statusBar={{ hidden: false }}>
      <View />
    </Dialog>
  </View>
));
"##;

const BACK: &str = r#"import { mount, signal, Text } from "nsh";
import { BackHandler } from "nsh/mobile";

const presses = signal(0);
BackHandler.onBackPress(() => {
  presses.update((p) => p + 1);
  // The first press is handled, the second one leaves the app.
  return presses() === 1;
});

mount(() => <Text>{`presses ${presses()}`}</Text>);
"#;

const FIELD: &str = r#"import { mount, signal, Text, View } from "nsh";
import { TextField } from "test/ui";

const name = signal("Ada");
mount(() => (
  <View>
    <TextField value={name()} onChange={(v: string) => name.set(v)} />
    <Text>{`name ${name()}`}</Text>
  </View>
));
"#;

const APPEARANCE: &str = r#"import { mount, Text, View } from "nsh";
import { colorScheme, setColorScheme } from "nsh";

setTimeout(() => setColorScheme("light"), 20);

mount(() => (
  <View class="bg-white dark:bg-black">
    <Text>{`scheme ${colorScheme()}`}</Text>
  </View>
));
"#;

#[test]
fn the_apps_appearance_overrides_the_systems() {
    let (_engine, rx) = start_with(
        APPEARANCE,
        Environment::default(),
        None,
        Some(r#"{ "appearance": "dark" }"#),
    );
    let background = |batches: &[MountBatch]| {
        batches
            .iter()
            .flat_map(|b| &b.items)
            .rev()
            .find_map(|i| match i {
                MountItem::ViewStyle { style, .. } if style.background_color.0 & 0xff == 0xff => {
                    Some(style.background_color)
                }
                _ => None,
            })
    };
    // Dark from the start, though the system is light.
    let first = until(&rx, |b| shows(b, "scheme dark"));
    assert!(first.iter().any(|b| shows(b, "scheme dark")));
    assert_eq!(background(&first), Some(nsh_core::Color(0x0000_00ff)));
    assert!(first.iter().flat_map(|b| &b.items).any(|i| matches!(
        i,
        MountItem::Appearance {
            appearance: nsh_core::platform::Appearance::Dark
        }
    )));
    // `setColorScheme` switches at once.
    let later = until(&rx, |b| shows(b, "scheme light"));
    assert!(later.iter().any(|b| shows(b, "scheme light")), "{later:?}");
    assert_eq!(background(&later), Some(nsh_core::Color(0xffff_ffff)));
}

const TOKENS: &str = r#"import { mount, Text, token } from "nsh";

mount(() => (
  <Text>{`up ${token("up")} radius ${token("radius")} font ${token("font-sans")} primary ${token("primary") !== undefined}`}</Text>
));
"#;

#[test]
fn token_reads_the_apps_theme_in_the_appearance_shown() {
    let shown = |appearance: &str| {
        let config = format!(
            r##"{{ "appearance": "{appearance}", "theme": {{ "cssVars": {{
                "theme": {{ "font-sans": "Inter, sans-serif", "radius": "0.5rem" }},
                "light": {{ "up": "#00ff00" }}, "dark": {{ "up": "#004400" }} }} }} }}"##
        );
        let (_engine, rx) = start_with(TOKENS, Environment::default(), None, Some(&config));
        let up = if appearance == "dark" {
            "#004400ff"
        } else {
            "#00ff00ff"
        };
        let wanted = format!("up {up} radius 8 font Inter primary true");
        let batches = until(&rx, |b| shows(b, &wanted));
        assert!(batches.iter().any(|b| shows(b, &wanted)), "{batches:?}");
    };
    shown("light");
    shown("dark");
}

const MENU: &str = r#"import { mount, signal, Text } from "nsh";
import { Menu } from "nsh/desktop";

const chosen = signal("none");
Menu.setApplicationMenu([
  false,
  {
    label: "File",
    submenu: [
      { label: "New", shortcut: "mod+n", onSelect: () => chosen.set("new") },
      { type: "separator" },
      { role: "quit" },
    ],
  },
]);

Menu.popup([{ label: "Copy link", onSelect: () => chosen.set("copied") }]).then(() =>
  chosen.set(`${chosen()} closed`),
);

mount(() => <Text>{chosen()}</Text>);
"#;

/// `Menu.setApplicationMenu` reaches the platform as items with ids and
/// shortcuts (a role's by default), and the platform's `onMenu` calls the
/// chosen item's function; mobile platforms get nothing.
#[test]
fn menus_reach_the_platform_and_call_back() {
    use nsh_core::desktop::{DesktopCommand, Key, MenuAction, MenuItem, MenuRole, Shortcut};

    let (engine, rx) = start_in(
        MENU,
        Environment {
            os: nsh_engine::Os::Windows,
            ..Environment::default()
        },
    );
    let mut menu = None;
    until(&rx, |batch| {
        for item in &batch.items {
            if let MountItem::Command {
                id: ROOT_ID,
                command: Command::Desktop(command),
            } = item
                && let DesktopCommand::SetMenu(Some(items)) = &**command
            {
                menu = Some(items.clone());
            }
        }
        shows(batch, "none")
    });
    let menu = menu.expect("the menu");
    let new = MenuAction {
        id: 1,
        label: "New".into(),
        shortcut: Some(Shortcut {
            ctrl: true,
            ..Shortcut::key(Key::Char('n'))
        }),
        enabled: true,
        checked: None,
        role: None,
        when: nsh_core::keymap::When::Always,
    };
    let quit = MenuAction {
        id: 0,
        label: String::new(),
        shortcut: MenuRole::Quit.shortcut(false),
        enabled: true,
        checked: None,
        role: Some(MenuRole::Quit),
        when: nsh_core::keymap::When::Always,
    };
    assert_eq!(
        &*menu,
        [MenuItem::Submenu {
            label: "File".into(),
            enabled: true,
            items: vec![
                MenuItem::Action(new),
                MenuItem::Separator,
                MenuItem::Action(quit)
            ],
        }]
    );
    engine.control().dispatch_event(
        ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![("id", PayloadValue::Number(1.0))]),
    );
    assert!(
        until(&rx, |batch| shows(batch, "new"))
            .iter()
            .any(|b| shows(b, "new"))
    );

    // A context menu: its item, then its promise once it closes.
    let control = engine.control();
    control.dispatch_event(
        ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![("id", PayloadValue::Number(2.0))]),
    );
    control.dispatch_event(
        ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![
            ("id", PayloadValue::Number(0.0)),
            ("closed", PayloadValue::Bool(true)),
        ]),
    );
    assert!(
        until(&rx, |batch| shows(batch, "copied closed"))
            .iter()
            .any(|b| shows(b, "copied closed"))
    );

    // On a phone, nothing is sent.
    let (_engine, rx) = start(MENU);
    let batches = until(&rx, |batch| shows(batch, "none"));
    assert!(!batches.iter().flat_map(|b| &b.items).any(|i| matches!(
        i,
        MountItem::Command {
            command: Command::Desktop(_),
            ..
        }
    )));
}

const LOCALE: &str = r#"import { mount, Text } from "nsh";
import { fontScale, locale } from "nsh";

mount(() => (
  <Text>{`${locale()} ${new Intl.NumberFormat().format(1234.5)} ${fontScale()}`}</Text>
));
"#;

#[test]
fn locale_and_font_scale_follow_the_environment() {
    let (engine, rx) = start(LOCALE);
    let first = until(&rx, |b| shows(b, "en-US 1,234.5 1"));
    assert!(first.iter().any(|b| shows(b, "en-US 1,234.5 1")));
    // What an embedding app sets in place of the system's.
    let mut environment = Environment::default();
    nsh_engine::HostEnvironment {
        locale: nsh_engine::Locale::parse("de-DE"),
        font_scale: Some(1.5),
    }
    .apply(&mut environment);
    engine.control().set_environment(environment);
    let after = until(&rx, |b| shows(b, "de-DE 1.234,5 1.5"));
    assert!(after.iter().any(|b| shows(b, "de-DE 1.234,5 1.5")));
}

const BASE_BUTTON: &str = r#"import { mount, signal, Text } from "nsh";
import { Button } from "nsh/base";

function App() {
  const count = signal(0);
  return (
    <Button selected={count() > 0} onPress={() => count.update((n) => n + 1)}>
      <Text>{`Pressed ${count()}`}</Text>
    </Button>
  );
}

mount(App);
"#;

/// `nsh/base`'s `Button` has behavior and no look: a press target with the
/// button role and the app's content, no style of its own.
#[test]
fn a_base_button_has_behavior_and_no_look() {
    let (engine, rx) = start(BASE_BUTTON);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(text_ids(&first, "Pressed 0").is_some());
    let button = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
            _ => None,
        })
        .expect("a pressable button");
    assert!(
        !first
            .items
            .iter()
            .any(|i| matches!(i, MountItem::ViewStyle { id, .. } if *id == button)),
        "no style of its own: {:?}",
        first.items
    );
    let props = |batch: &MountBatch| {
        batch.items.iter().find_map(|i| match i {
            MountItem::ViewProps { id, props } if *id == button => Some(props.clone()),
            _ => None,
        })
    };
    let first_props = props(&first).expect("its props");
    assert_eq!(
        first_props.accessibility.role,
        nsh_core::AccessibilityRole::Button
    );
    assert!(!first_props.accessibility.state.selected);
    engine
        .control()
        .dispatch_event(button, EventKind::Press, EventPayload::None);
    let after = until(&rx, |b| shows(b, "Pressed 1"));
    let selected = after.iter().rev().find_map(props).expect("new props");
    assert!(
        selected.accessibility.state.selected,
        "selected follows the app"
    );
}

const BASE_SWITCH: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Switch } from "nsh/base";

function App() {
  const on = signal(false);
  const changes = signal<boolean[]>([]);
  const parts = {
    trackClass: "w-[20px] checked:bg-[#00ff00]",
    thumbClass: "w-[10px] checked:translate-x-[6px] disabled:opacity-50",
  };
  return (
    <View>
      <Switch
        testID="wifi"
        checked={on()}
        checkedStyle={{ backgroundColor: "#0000ff" }}
        onChange={(next) => {
          changes.set([...changes(), next]);
          on.set(next);
        }}
        {...parts}
      >
        <Text>Wi-Fi</Text>
      </Switch>
      <Switch
        testID="locked"
        checked
        accessibilityLabel="Locked"
        onChange={(next) => changes.set([...changes(), next])}
        {...parts}
      />
      <Switch testID="off" checked disabled {...parts} />
      <Text>{`Changes: ${changes().join(",")}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// `nsh/base`'s `Switch`: the switch role and its value for screen readers
/// on its root alone, presses reporting the next value while the app owns
/// it, and the track and thumb styled by the switch's state.
#[test]
fn a_base_switch_reports_the_next_value_and_styles_its_parts() {
    use nsh_core::{AccessibilityRole, Checked, ViewProps};
    let (engine, rx) = start(BASE_SWITCH);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(shows(&first, "Changes: "));
    let view_props = |batch: &MountBatch, view| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::ViewProps { id, props } if *id == view => Some(props.clone()),
            _ => None,
        })
    };
    let root = |test_id: &str| {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                    Some(*id)
                }
                _ => None,
            })
            .expect(test_id)
    };
    // The view inside `parent` (a part; the label is text).
    let child = |parent: u32| {
        let views: Vec<u32> = first
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Create {
                    id,
                    kind: nsh_core::ViewKind::View,
                } => Some(*id),
                _ => None,
            })
            .collect();
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert {
                    parent: p, child, ..
                } if *p == parent && views.contains(child) => Some(*child),
                _ => None,
            })
            .expect("a part")
    };
    let (wifi, locked, off) = (root("wifi"), root("locked"), root("off"));
    let (track, thumb) = (child(wifi), child(child(wifi)));
    let style = |batches: &[MountBatch], view| {
        batches
            .iter()
            .rev()
            .flat_map(|b| b.items.iter().rev())
            .find_map(|i| match i {
                MountItem::ViewStyle { id, style } if *id == view => Some(style.clone()),
                _ => None,
            })
            .unwrap_or_default()
    };
    let state = |props: &ViewProps| props.accessibility.state;

    // The root is the switch for screen readers; its parts are no
    // accessibility elements.
    let props = view_props(&first, wifi).unwrap();
    assert_eq!(props.accessibility.role, AccessibilityRole::Switch);
    assert_eq!(state(&props).checked, Some(Checked::False));
    assert!(view_props(&first, track).is_none());
    assert!(view_props(&first, thumb).is_none());
    assert_eq!(
        view_props(&first, locked)
            .unwrap()
            .accessibility
            .label
            .as_deref(),
        Some("Locked")
    );
    let unchecked = std::slice::from_ref(&first);
    assert!(style(unchecked, thumb).transform.ops().is_empty());

    // A press reports the next value; the app sets it, so the switch, its
    // `checkedStyle` and its parts' `checked:` classes follow.
    engine
        .control()
        .dispatch_event(wifi, EventKind::Press, EventPayload::None);
    let after = until(&rx, |b| shows(b, "Changes: true"));
    let props = after
        .iter()
        .rev()
        .find_map(|b| view_props(b, wifi))
        .unwrap();
    assert_eq!(state(&props).checked, Some(Checked::True));
    assert_eq!(style(&after, wifi).background_color.0, 0x0000_ffff);
    assert_eq!(style(&after, track).background_color.0, 0x00ff_00ff);
    assert_eq!(style(&after, thumb).transform.ops()[0].value, 6.0);
    assert!(after.iter().all(|b| view_props(b, thumb).is_none()));

    // The value is the app's: a switch it keeps checked reports `false`
    // and stays checked.
    engine
        .control()
        .dispatch_event(locked, EventKind::Press, EventPayload::None);
    let after = until(&rx, |b| shows(b, "Changes: true,false"));
    assert!(after.iter().any(|b| shows(b, "Changes: true,false")));
    assert!(after.iter().all(|b| view_props(b, locked).is_none()));

    // Disabled: no presses, dimmed for screen readers, and its parts take
    // `disabled:` over `checked:`.
    let disabled = view_props(&first, off).unwrap();
    assert!(state(&disabled).disabled);
    assert_eq!(state(&disabled).checked, Some(Checked::True));
    assert!(!first.items.iter().any(|i| matches!(
        i,
        MountItem::Events { id, events } if *id == off && events.contains(EventKind::Press)
    )));
    let off_thumb = child(child(off));
    let thumb_style = style(unchecked, off_thumb);
    assert_eq!(thumb_style.opacity, 0.5);
    assert_eq!(thumb_style.transform.ops()[0].value, 6.0);
    assert!(view_props(&first, off_thumb).is_none());
}

const BASE_CHECKBOX: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Checkbox } from "nsh/base";

function App() {
  const all = signal(false);
  const some = signal(true);
  const changes = signal<boolean[]>([]);
  const parts = {
    indicatorClass:
      "w-[20px] checked:bg-[#00ff00] indeterminate:bg-[#ff0000] disabled:opacity-50",
  };
  return (
    <View>
      <Checkbox
        testID="all"
        checked={all()}
        indeterminate={some() && !all()}
        checkedStyle={{ backgroundColor: "#0000ff" }}
        indeterminateStyle={{ backgroundColor: "#ffff00" }}
        onChange={(next) => {
          changes.set([...changes(), next]);
          all.set(next);
        }}
        indicator={<Text>{all() ? "✓" : "-"}</Text>}
        {...parts}
      >
        <Text>All</Text>
      </Checkbox>
      <Checkbox
        testID="kept"
        checked
        accessibilityLabel="Kept"
        onChange={(next) => changes.set([...changes(), next])}
        {...parts}
      />
      <Checkbox testID="off" checked disabled role="menuitem" {...parts} />
      <Text>{`Changes: ${changes().join(",")}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// `nsh/base`'s `Checkbox`: the checkbox role and its value (mixed
/// included) for screen readers on its root alone, presses reporting the
/// next value while the app owns it, and the indicator styled by the
/// checkbox's state with the app's mark inside.
#[test]
fn a_base_checkbox_reports_the_next_value_and_styles_its_indicator() {
    use nsh_core::{AccessibilityRole, Checked, ViewProps};
    let (engine, rx) = start(BASE_CHECKBOX);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(shows(&first, "Changes: "));
    assert!(shows(&first, "-"), "the app's mark in the indicator");
    let view_props = |batch: &MountBatch, view| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::ViewProps { id, props } if *id == view => Some(props.clone()),
            _ => None,
        })
    };
    let root = |test_id: &str| {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                    Some(*id)
                }
                _ => None,
            })
            .expect(test_id)
    };
    // The first view inside `parent`: the indicator.
    let indicator = |parent: u32| {
        let views: Vec<u32> = first
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Create {
                    id,
                    kind: nsh_core::ViewKind::View,
                } => Some(*id),
                _ => None,
            })
            .collect();
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert {
                    parent: p, child, ..
                } if *p == parent && views.contains(child) => Some(*child),
                _ => None,
            })
            .expect("the indicator")
    };
    let (all, kept, off) = (root("all"), root("kept"), root("off"));
    let mark = indicator(all);
    let style = |batches: &[MountBatch], view| {
        batches
            .iter()
            .rev()
            .flat_map(|b| b.items.iter().rev())
            .find_map(|i| match i {
                MountItem::ViewStyle { id, style } if *id == view => Some(style.clone()),
                _ => None,
            })
            .unwrap_or_default()
    };
    let state = |props: &ViewProps| props.accessibility.state;

    // Indeterminate: mixed for screen readers on the root alone;
    // `indeterminateStyle` on the root, `indeterminate:` on the indicator.
    let props = view_props(&first, all).unwrap();
    assert_eq!(props.accessibility.role, AccessibilityRole::Checkbox);
    assert_eq!(state(&props).checked, Some(Checked::Mixed));
    assert!(view_props(&first, mark).is_none());
    let mixed = std::slice::from_ref(&first);
    assert_eq!(style(mixed, all).background_color.0, 0xffff_00ff);
    assert_eq!(style(mixed, mark).background_color.0, 0xff00_00ff);
    assert_eq!(
        view_props(&first, kept)
            .unwrap()
            .accessibility
            .label
            .as_deref(),
        Some("Kept")
    );

    // A press from indeterminate asks for checked; the app sets it, so the
    // checkbox, its `checkedStyle`, the indicator's `checked:` classes and
    // the app's mark follow.
    engine
        .control()
        .dispatch_event(all, EventKind::Press, EventPayload::None);
    let after = until(&rx, |b| shows(b, "Changes: true"));
    let props = after.iter().rev().find_map(|b| view_props(b, all)).unwrap();
    assert_eq!(state(&props).checked, Some(Checked::True));
    assert_eq!(style(&after, all).background_color.0, 0x0000_ffff);
    assert_eq!(style(&after, mark).background_color.0, 0x00ff_00ff);
    assert!(after.iter().any(|b| shows(b, "✓")));
    assert!(after.iter().all(|b| view_props(b, mark).is_none()));

    // From checked it asks for unchecked; the app's value stays the
    // value: a checkbox it keeps checked stays checked.
    engine
        .control()
        .dispatch_event(kept, EventKind::Press, EventPayload::None);
    let after = until(&rx, |b| shows(b, "Changes: true,false"));
    assert!(after.iter().all(|b| view_props(b, kept).is_none()));

    // Disabled: no presses, dimmed for screen readers, its own role, and
    // its indicator takes `disabled:` with `checked:`.
    let disabled = view_props(&first, off).unwrap();
    assert!(state(&disabled).disabled);
    assert_eq!(state(&disabled).checked, Some(Checked::True));
    assert_eq!(disabled.accessibility.role, AccessibilityRole::Menuitem);
    assert!(!first.items.iter().any(|i| matches!(
        i,
        MountItem::Events { id, events } if *id == off && events.contains(EventKind::Press)
    )));
    let off_mark = style(mixed, indicator(off));
    assert_eq!(off_mark.opacity, 0.5);
    assert_eq!(off_mark.background_color.0, 0x00ff_00ff);
}

#[test]
fn a_rust_components_tooltip_reaches_its_host() {
    let (_engine, rx) = start(
        r#"import { mount, Text } from "nsh";
import { Button, Tooltip } from "nsh/base";
mount(() => (
  <Button tooltip={<Tooltip open><Text>Save changes</Text></Tooltip>}>
    <Text>Save</Text>
  </Button>
));
"#,
    );
    // Controlled open avoids waiting for a pointer or the tooltip's delay.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut trigger = false;
    let mut tooltip = false;
    while let Ok(batch) = rx.recv_deadline(deadline) {
        trigger |= shows(&batch, "Save");
        tooltip |= shows(&batch, "Save changes");
        if trigger && tooltip {
            break;
        }
    }
    assert!(trigger, "the Rust component is mounted");
    assert!(tooltip, "the component's tooltip is mounted on its host");
}

const BASE_RADIO: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Radio, RadioGroup } from "nsh/base";

function App() {
  const plan = signal("a");
  const changes = signal<string[]>([]);
  const radio = (value: string, label: string, disabled = false) => (
    <Radio
      testID={value}
      checked={plan() === value}
      disabled={disabled}
      accessibilityLabel={label}
      class="group flex-row disabled:opacity-50"
      checkedStyle={{ backgroundColor: "#0000ff" }}
      onChange={(next) => {
        changes.set([...changes(), `${value}:${next}`]);
        plan.set(value);
      }}
    >
      <View class="w-[20px] group-checked:bg-[#00ff00]" />
      <Text>{label}</Text>
    </Radio>
  );
  return (
    <View>
      <RadioGroup testID="plans" class="flex-row">
        {radio("a", "Basic")}
        {radio("b", "Pro")}
        {radio("c", "Team", true)}
      </RadioGroup>
      <Text>{`Changes: ${changes().join(",")}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// `nsh/base`'s `Radio` in a `RadioGroup`: the radio group role on the
/// group, the radio role and its checked state on each radio alone, a
/// press on an unchecked radio asking for `true` while the app owns which
/// one is checked, a checked or disabled radio reporting nothing, and the
/// app's dot inside following the radio with `group-checked:`.
#[test]
fn a_base_radio_asks_to_be_checked_and_its_group_holds_no_value() {
    use nsh_core::{AccessibilityRole, Checked, ViewProps};
    let (engine, rx) = start(BASE_RADIO);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(shows(&first, "Changes: "));
    let view_props = |batch: &MountBatch, view| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::ViewProps { id, props } if *id == view => Some(props.clone()),
            _ => None,
        })
    };
    let root = |test_id: &str| {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                    Some(*id)
                }
                _ => None,
            })
            .expect(test_id)
    };
    // The first view inside `parent`: the app's dot.
    let dot = |parent: u32| {
        let views: Vec<u32> = first
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Create {
                    id,
                    kind: nsh_core::ViewKind::View,
                } => Some(*id),
                _ => None,
            })
            .collect();
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert {
                    parent: p, child, ..
                } if *p == parent && views.contains(child) => Some(*child),
                _ => None,
            })
            .expect("the dot")
    };
    let style = |batches: &[MountBatch], view| {
        batches
            .iter()
            .rev()
            .flat_map(|b| b.items.iter().rev())
            .find_map(|i| match i {
                MountItem::ViewStyle { id, style } if *id == view => Some(style.clone()),
                _ => None,
            })
            .unwrap_or_default()
    };
    let state = |props: &ViewProps| props.accessibility.state;
    let (plans, a, b, c) = (root("plans"), root("a"), root("b"), root("c"));
    let (dot_a, dot_b) = (dot(a), dot(b));
    let initial = std::slice::from_ref(&first);

    // The group: a radio group for screen readers, laid out by the app.
    let group = view_props(&first, plans).unwrap();
    assert_eq!(group.accessibility.role, AccessibilityRole::Radiogroup);
    assert_eq!(group.accessibility.label, None);

    // The checked radio: checked and selected for screen readers, its
    // `checkedStyle`, and the app's dot `group-checked:`.
    let props = view_props(&first, a).unwrap();
    assert_eq!(props.accessibility.role, AccessibilityRole::Radio);
    assert_eq!(props.accessibility.label.as_deref(), Some("Basic"));
    assert_eq!(state(&props).checked, Some(Checked::True));
    assert!(state(&props).selected);
    assert_eq!(style(initial, a).background_color.0, 0x0000_ffff);
    assert_eq!(style(initial, dot_a).background_color.0, 0x00ff_00ff);
    let props = view_props(&first, b).unwrap();
    assert_eq!(state(&props).checked, Some(Checked::False));
    assert!(!state(&props).selected);
    assert_eq!(style(initial, dot_b).background_color.0, 0);
    // The dot is a part of the radio, no second element.
    assert!(view_props(&first, dot_a).is_none());

    // A press on an unchecked radio asks for `true`; the app checks it and
    // unchecks the other, and the styles follow.
    engine
        .control()
        .dispatch_event(b, EventKind::Press, EventPayload::None);
    let after = until(&rx, |b| shows(b, "Changes: b:true"));
    assert!(after.iter().any(|batch| shows(batch, "Changes: b:true")));
    let now = |view| after.iter().rev().find_map(|batch| view_props(batch, view));
    assert_eq!(state(&now(b).unwrap()).checked, Some(Checked::True));
    assert_eq!(state(&now(a).unwrap()).checked, Some(Checked::False));
    assert_eq!(style(&after, b).background_color.0, 0x0000_ffff);
    assert_eq!(style(&after, dot_b).background_color.0, 0x00ff_00ff);
    assert_eq!(style(&after, dot_a).background_color.0, 0);

    // A checked radio cannot uncheck itself: a press on it reports
    // nothing, so the next change the app sees is `a`'s.
    engine
        .control()
        .dispatch_event(b, EventKind::Press, EventPayload::None);
    engine
        .control()
        .dispatch_event(a, EventKind::Press, EventPayload::None);
    let after = until(&rx, |batch| shows(batch, "Changes: b:true,a:true"));
    assert!(
        after
            .iter()
            .any(|batch| shows(batch, "Changes: b:true,a:true"))
    );

    // Disabled: no presses, dimmed for screen readers.
    let disabled = view_props(&first, c).unwrap();
    assert!(state(&disabled).disabled);
    assert_eq!(state(&disabled).checked, Some(Checked::False));
    assert!(!first.items.iter().any(|i| matches!(
        i,
        MountItem::Events { id, events } if *id == c && events.contains(EventKind::Press)
    )));
    assert_eq!(style(initial, c).opacity, 0.5);
}

const BASE_TABS: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Tab, Tabs } from "nsh/base";

function App() {
  const current = signal("a");
  const presses = signal<string[]>([]);
  const tab = (value: string, label: string, disabled = false) => (
    <Tab
      testID={value}
      selected={current() === value}
      disabled={disabled}
      accessibilityLabel={label}
      class="group flex-row disabled:opacity-50"
      selectedStyle={{ backgroundColor: "#0000ff" }}
      onPress={() => {
        presses.set([...presses(), value]);
        current.set(value);
      }}
    >
      <View class="w-[20px] group-selected:bg-[#00ff00]" />
      <Text>{label}</Text>
    </Tab>
  );
  return (
    <View>
      <Tabs testID="sections" class="flex-row">
        {tab("a", "Overview")}
        {tab("b", "Activity")}
        {tab("c", "Billing", true)}
      </Tabs>
      <Text>{`Presses: ${presses().join(",")}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// `nsh/base`'s `Tab` in `Tabs`: the tab list role on the list, the tab
/// role and its selected state on each tab alone, a press reported with
/// `onPress` (the selected tab's too) while the app owns which tab is
/// selected, a disabled tab reporting nothing, and the app's content
/// inside following the tab with `group-selected:`.
#[test]
fn a_base_tab_reports_presses_and_its_list_holds_no_value() {
    use nsh_core::{AccessibilityRole, ViewProps};
    let (engine, rx) = start(BASE_TABS);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(shows(&first, "Presses: "));
    let view_props = |batch: &MountBatch, view| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::ViewProps { id, props } if *id == view => Some(props.clone()),
            _ => None,
        })
    };
    let root = |test_id: &str| {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                    Some(*id)
                }
                _ => None,
            })
            .expect(test_id)
    };
    // The first view inside `parent`: the app's marker.
    let marker = |parent: u32| {
        let views: Vec<u32> = first
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Create {
                    id,
                    kind: nsh_core::ViewKind::View,
                } => Some(*id),
                _ => None,
            })
            .collect();
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert {
                    parent: p, child, ..
                } if *p == parent && views.contains(child) => Some(*child),
                _ => None,
            })
            .expect("the marker")
    };
    let style = |batches: &[MountBatch], view| {
        batches
            .iter()
            .rev()
            .flat_map(|b| b.items.iter().rev())
            .find_map(|i| match i {
                MountItem::ViewStyle { id, style } if *id == view => Some(style.clone()),
                _ => None,
            })
            .unwrap_or_default()
    };
    let state = |props: &ViewProps| props.accessibility.state;
    let (sections, a, b, c) = (root("sections"), root("a"), root("b"), root("c"));
    let (marker_a, marker_b) = (marker(a), marker(b));
    let initial = std::slice::from_ref(&first);

    // The list: a tab list for screen readers, laid out by the app.
    let list = view_props(&first, sections).unwrap();
    assert_eq!(list.accessibility.role, AccessibilityRole::Tablist);
    assert_eq!(list.accessibility.label, None);

    // The selected tab: selected for screen readers, its `selectedStyle`,
    // and the app's marker `group-selected:`.
    let props = view_props(&first, a).unwrap();
    assert_eq!(props.accessibility.role, AccessibilityRole::Tab);
    assert_eq!(props.accessibility.label.as_deref(), Some("Overview"));
    assert!(state(&props).selected);
    assert_eq!(state(&props).checked, None);
    assert_eq!(style(initial, a).background_color.0, 0x0000_ffff);
    assert_eq!(style(initial, marker_a).background_color.0, 0x00ff_00ff);
    let props = view_props(&first, b).unwrap();
    assert_eq!(props.accessibility.role, AccessibilityRole::Tab);
    assert!(!state(&props).selected);
    assert_eq!(style(initial, b).background_color.0, 0);
    assert_eq!(style(initial, marker_b).background_color.0, 0);
    // The marker is a part of the tab, no second element.
    assert!(view_props(&first, marker_a).is_none());

    // A press reports `onPress`; the app selects the tab and deselects the
    // other, and the styles follow.
    engine
        .control()
        .dispatch_event(b, EventKind::Press, EventPayload::None);
    let after = until(&rx, |batch| shows(batch, "Presses: b"));
    let now = |view| after.iter().rev().find_map(|batch| view_props(batch, view));
    assert!(state(&now(b).unwrap()).selected);
    assert!(!state(&now(a).unwrap()).selected);
    assert_eq!(style(&after, b).background_color.0, 0x0000_ffff);
    assert_eq!(style(&after, marker_b).background_color.0, 0x00ff_00ff);
    assert_eq!(style(&after, a).background_color.0, 0);
    assert_eq!(style(&after, marker_a).background_color.0, 0);

    // The selected tab reports its presses too (the app may scroll its
    // content to the top).
    engine
        .control()
        .dispatch_event(b, EventKind::Press, EventPayload::None);
    let after = until(&rx, |batch| shows(batch, "Presses: b,b"));
    assert!(after.iter().any(|batch| shows(batch, "Presses: b,b")));

    // Disabled: no presses, dimmed for screen readers.
    let disabled = view_props(&first, c).unwrap();
    assert!(state(&disabled).disabled);
    assert!(!state(&disabled).selected);
    assert!(!first.items.iter().any(|i| matches!(
        i,
        MountItem::Events { id, events } if *id == c && events.contains(EventKind::Press)
    )));
    assert_eq!(style(initial, c).opacity, 0.5);
}

const BASE_COLLAPSIBLE: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Collapsible } from "nsh/base";

function App() {
  const open = signal(false);
  const count = signal(0);
  return (
    <View>
      <Collapsible
        testID="region"
        open={open()}
        class="gap-[4px]"
        content={<Text>{`Details ${count()}`}</Text>}
      >
        <View
          testID="trigger"
          role="button"
          accessibilityState={{ expanded: open() }}
          onPress={() => open.set(!open())}
        >
          <Text>Summary</Text>
        </View>
      </Collapsible>
      <View testID="bump" onPress={() => count.set(count() + 1)} />
    </View>
  );
}

mount(App);
"##;

/// `nsh/base`'s `Collapsible`: its children always, its `content` after
/// them only while the app's `open` holds, made once and kept, so what is in
/// it keeps its state and follows the app while collapsed; the trigger is
/// the app's, with the expanded state it gives screen readers.
#[test]
fn a_base_collapsible_places_its_content_while_open() {
    let (engine, rx) = start(BASE_COLLAPSIBLE);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(shows(&first, "Summary"));
    assert!(
        !first
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Text { text, .. } if text.text.starts_with("Details"))),
        "collapsed: no content"
    );
    let by_test_id = |test_id: &str| {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                    Some(*id)
                }
                _ => None,
            })
            .expect(test_id)
    };
    let (region, trigger, bump) = (
        by_test_id("region"),
        by_test_id("trigger"),
        by_test_id("bump"),
    );
    let expanded = |batches: &[MountBatch]| {
        batches
            .iter()
            .rev()
            .flat_map(|b| b.items.iter().rev())
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if *id == trigger => {
                    Some(props.accessibility.state.expanded)
                }
                _ => None,
            })
            .flatten()
    };
    assert_eq!(expanded(std::slice::from_ref(&first)), Some(false));
    // The region itself is no element of its own for screen readers: the
    // trigger is.
    let region_props = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::ViewProps { id, props } if *id == region => Some(props.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        region_props.accessibility.role,
        nsh_core::AccessibilityRole::None
    );
    let press = |view| {
        engine
            .control()
            .dispatch_event(view, EventKind::Press, EventPayload::None)
    };

    // Open: the content after the children, in the region.
    press(trigger);
    let opened = until(&rx, |b| shows(b, "Details 0"));
    let text = opened
        .iter()
        .find_map(|b| text_ids(b, "Details 0"))
        .expect("the content shows");
    assert_eq!(expanded(&opened), Some(true));
    let parent_of = |batches: &[MountBatch], child: u32| {
        batches
            .iter()
            .flat_map(|b| b.items.iter())
            .find_map(|i| match i {
                MountItem::Insert {
                    parent, child: c, ..
                } if *c == child => Some(*parent),
                _ => None,
            })
    };
    // The text is in the slot's holder, the holder in the region.
    let holder = parent_of(&opened, text).expect("the holder");
    assert_eq!(parent_of(&opened, holder), Some(region));

    // Collapse: the content leaves the tree and is kept.
    press(trigger);
    let closed = until(&rx, |b| {
        b.items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { id } if *id == holder))
    });
    assert_eq!(expanded(&closed), Some(false));
    assert!(
        !closed
            .iter()
            .flat_map(|b| b.items.iter())
            .any(|i| matches!(i, MountItem::Delete { id } if *id == holder || *id == text)),
        "kept, not released"
    );

    // While collapsed, it follows the app; open again, it is back as it is.
    press(bump);
    press(trigger);
    let reopened = until(&rx, |b| {
        b.items.iter().any(
            |i| matches!(i, MountItem::Insert { parent, child, .. } if *parent == region && *child == holder),
        )
    });
    assert_eq!(expanded(&reopened), Some(true));
    let all: Vec<&MountBatch> = closed.iter().chain(reopened.iter()).collect();
    assert!(
        all.iter().any(|b| shows(b, "Details 1")),
        "the content followed the app"
    );
}

const SLOT_TRIGGERS: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { Disclosure } from "test/ui";

function App() {
  const locked = signal(false);
  const presses = signal(0);
  return (
    <View>
      <Menu
        trigger={
          <View testID="menu" accessibilityLabel="File menu">
            <Text>File</Text>
          </View>
        }
      >
        <MenuItem>
          <Text>Open</Text>
        </MenuItem>
      </Menu>
      <Disclosure
        disabled={locked()}
        trigger={
          <View
            testID="toggle"
            class="w-[40px] h-[20px] bg-[#ffffff] active:bg-[#ff0000] focus:bg-[#00ff00] disabled:opacity-50"
            onPress={() => presses.set(presses() + 1)}
          >
            <Text>Toggle</Text>
          </View>
        }
      />
      <View testID="lock" onPress={() => locked.set(!locked())} />
      <Text>{`Presses: ${presses()}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// A Rust component's props on a slot a TSX app fills go to the app's
/// element in it, live: `Menu`'s trigger says whether the menu is expanded
/// as it opens and closes (its binding was read once), and a trigger the
/// component makes a button takes its presses (the app's `onPress` too),
/// its role, focus and `disabled` itself, so the app's own `active:`,
/// `focus:` and `disabled:` classes on it follow them.
#[test]
fn a_slots_props_are_the_apps_elements_own_and_live() {
    use nsh_core::{AccessibilityRole, ViewProps, tailwind::state};
    let (engine, rx) = start(SLOT_TRIGGERS);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(shows(&first, "Presses: 0"));
    let by_test_id = |test_id: &str| {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                    Some(*id)
                }
                _ => None,
            })
            .expect(test_id)
    };
    let (menu, toggle, lock) = (by_test_id("menu"), by_test_id("toggle"), by_test_id("lock"));
    let props = |batches: &[MountBatch], view| -> Option<ViewProps> {
        batches
            .iter()
            .rev()
            .flat_map(|b| b.items.iter().rev())
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if *id == view => Some((**props).clone()),
                _ => None,
            })
    };
    let expanded = |batches: &[MountBatch], view| {
        props(batches, view).and_then(|p| p.accessibility.state.expanded)
    };
    let listens = |batches: &[MountBatch], view| {
        batches
            .iter()
            .rev()
            .flat_map(|b| b.items.iter().rev())
            .find_map(|i| match i {
                MountItem::Events { id, events } if *id == view => {
                    Some(events.contains(EventKind::Press))
                }
                _ => None,
            })
    };
    let style = |batches: &[MountBatch], view| {
        batches
            .iter()
            .rev()
            .flat_map(|b| b.items.iter().rev())
            .find_map(|i| match i {
                MountItem::ViewStyle { id, style } if *id == view => Some(style.clone()),
                _ => None,
            })
            .unwrap_or_default()
    };
    let press = |view| {
        engine
            .control()
            .dispatch_event(view, EventKind::Press, EventPayload::None)
    };
    let initial = std::slice::from_ref(&first);

    // `Menu`'s trigger: the app's element, with its label, listening to
    // presses, collapsed.
    let trigger = props(initial, menu).unwrap();
    assert_eq!(trigger.accessibility.label.as_deref(), Some("File menu"));
    assert_eq!(trigger.accessibility.state.expanded, Some(false));
    assert_eq!(listens(initial, menu), Some(true));
    // It opens and closes, and says so each time.
    press(menu);
    let opened = until(&rx, |b| {
        expanded(std::slice::from_ref(b), menu) == Some(true)
    });
    assert_eq!(expanded(&opened, menu), Some(true));
    press(menu);
    let closed = until(&rx, |b| {
        expanded(std::slice::from_ref(b), menu) == Some(false)
    });
    assert_eq!(expanded(&closed, menu), Some(false));

    // The disclosure's trigger: a focusable button, collapsed, listening
    // to presses (the component's and the app's).
    let trigger = props(initial, toggle).unwrap();
    assert_eq!(trigger.accessibility.role, AccessibilityRole::Button);
    assert_eq!(trigger.focusable, Some(true));
    assert_eq!(trigger.accessibility.state.expanded, Some(false));
    assert_eq!(listens(initial, toggle), Some(true));
    assert_eq!(style(initial, toggle).background_color.0, 0xffff_ffff);
    // A press: the component's listener and the app's both run.
    press(toggle);
    let after = until(&rx, |b| shows(b, "Presses: 1"));
    assert_eq!(expanded(&after, toggle), Some(true));
    // Pressed and focused: its own classes.
    engine.control().set_states(toggle, state::PRESSED);
    let pressed = until(&rx, |b| {
        style(std::slice::from_ref(b), toggle).background_color.0 == 0xff00_00ff
    });
    assert_eq!(style(&pressed, toggle).background_color.0, 0xff00_00ff);
    engine.control().set_states(toggle, state::FOCUSED);
    let focused = until(&rx, |b| {
        style(std::slice::from_ref(b), toggle).background_color.0 == 0x00ff_00ff
    });
    assert_eq!(style(&focused, toggle).background_color.0, 0x00ff_00ff);
    engine.control().set_states(toggle, 0);
    // Disabled by the component: its `disabled:` classes, no presses
    // mounted, disabled for screen readers.
    press(lock);
    let locked = until(&rx, |b| {
        props(std::slice::from_ref(b), toggle).is_some_and(|p| p.accessibility.state.disabled)
    });
    assert_eq!(style(&locked, toggle).opacity, 0.5);
    assert_eq!(listens(&locked, toggle), Some(false));
}

const POPUP_EVENTS: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Menu, MenuItem, Popover } from "nsh/base";

function App() {
  const heard = signal<string[]>([]);
  const hear = (what: string) => heard.set([...heard(), what]);
  return (
    <View>
      <Menu
        onOpenChange={(open, reason) => hear(`menu ${open} ${reason}`)}
        onOpen={() => hear("menu open")}
        onClose={() => hear("menu close")}
        trigger={
          <View testID="menu">
            <Text>File</Text>
          </View>
        }
      >
        <MenuItem>
          <Text>New</Text>
        </MenuItem>
      </Menu>
      <Popover
        onOpenChange={(open, reason) => hear(`popover ${open} ${reason}`)}
        onOpen={() => hear("popover open")}
        onClose={() => hear("popover close")}
        trigger={
          <View testID="popover">
            <Text>Details</Text>
          </View>
        }
      >
        <Text>Body</Text>
      </Popover>
      <Text>{`Heard: ${heard().join(", ")}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// A popup reports a change of its open state before its lifecycle
/// follows it: `onOpenChange`, then `onOpen` / `onClose` once it is all
/// there or all gone, also where that is at once (no motion).
fn popups_report_their_open_change_first(environment: Environment) {
    let (engine, rx) = start_in(POPUP_EVENTS, environment);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let by_test_id = |test_id: &str| {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                    Some(*id)
                }
                _ => None,
            })
            .expect(test_id)
    };
    let (menu, popover) = (by_test_id("menu"), by_test_id("popover"));
    let press = |view| {
        engine
            .control()
            .dispatch_event(view, EventKind::Press, EventPayload::None)
    };
    let mut heard = vec![];
    for (view, name) in [(menu, "menu"), (popover, "popover")] {
        for (open, life) in [(true, "open"), (false, "close")] {
            heard.push(format!("{name} {open} triggerPress"));
            heard.push(format!("{name} {life}"));
            let wanted = format!("Heard: {}", heard.join(", "));
            press(view);
            let batches = until(&rx, |b| shows(b, &wanted));
            assert!(
                batches.iter().any(|b| shows(b, &wanted)),
                "{wanted}: {:?}",
                batches
                    .iter()
                    .flat_map(|b| b.items.iter())
                    .filter_map(|i| match i {
                        MountItem::Text { text, .. } if text.text.starts_with("Heard") => {
                            Some(text.text.clone())
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>()
            );
        }
    }
}

/// On the desktops a menu's popup has no motion: it is open and gone in
/// the turn that changes it.
#[test]
fn popups_report_their_open_change_first_on_the_desktops() {
    popups_report_their_open_change_first(Environment {
        os: nsh_engine::Os::Windows,
        ..Environment::default()
    });
}

/// On touch screens a menu is a sheet that comes in and goes: its
/// lifecycle follows the motion, after the change.
#[test]
fn popups_report_their_open_change_first_on_touch_screens() {
    popups_report_their_open_change_first(Environment::default());
}

const BASE_PROGRESS: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Progress } from "nsh/base";

function App() {
  const value = signal(40);
  const loading = signal(false);
  return (
    <View>
      <Progress
        testID="download"
        value={value()}
        indeterminate={loading()}
        accessibilityLabel="Downloading"
        class="w-[200px]"
        trackClass="h-[4px]"
        indicatorClass={loading() ? "h-full w-[50px]" : "h-full"}
        indicatorStyle={{ backgroundColor: "#00ff00" }}
      >
        <Text>{`${value()}%`}</Text>
      </Progress>
      <View testID="more" onPress={() => value.set(value() + 80)} />
      <View testID="loading" onPress={() => loading.set(!loading())} />
    </View>
  );
}

mount(App);
"##;

/// `nsh/base`'s `Progress`: the progress bar role and its range for
/// screen readers on its root alone, the value the app owns (clamped to
/// 0 to 100) as the indicator's share of the track and as the value
/// screen readers say, and no value while indeterminate, when the
/// indicator's width is the app's.
#[test]
fn a_base_progress_shows_the_apps_value_in_its_indicator() {
    use nsh_core::{AccessibilityRole, AccessibilityValue};
    let (engine, rx) = start(BASE_PROGRESS);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(shows(&first, "40%"));
    let by_test_id = |test_id: &str| {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                    Some(*id)
                }
                _ => None,
            })
            .expect(test_id)
    };
    let (root, more, loading) = (
        by_test_id("download"),
        by_test_id("more"),
        by_test_id("loading"),
    );
    // The view inside `parent` (a part; the value is text).
    let child = |parent: u32| {
        let views: Vec<u32> = first
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Create {
                    id,
                    kind: nsh_core::ViewKind::View,
                } => Some(*id),
                _ => None,
            })
            .collect();
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert {
                    parent: p, child, ..
                } if *p == parent && views.contains(child) => Some(*child),
                _ => None,
            })
            .expect("a part")
    };
    let (track, indicator) = (child(root), child(child(root)));
    let value = |batches: &[MountBatch]| {
        batches
            .iter()
            .rev()
            .flat_map(|b| b.items.iter().rev())
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if *id == root => {
                    Some(props.accessibility.value.clone())
                }
                _ => None,
            })
            .flatten()
    };
    let range = |now| AccessibilityValue {
        min: Some(0.0),
        max: Some(100.0),
        now,
        text: None,
    };
    let width = |batches: &[MountBatch]| frame_of(batches, indicator).map(|f| f.size.width.0);

    // One element for screen readers, the progress bar with its range and
    // value; its parts are none.
    let props = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::ViewProps { id, props } if *id == root => Some(props.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(props.accessibility.role, AccessibilityRole::Progressbar);
    assert_eq!(props.accessibility.accessible, Some(true));
    assert_eq!(props.accessibility.label.as_deref(), Some("Downloading"));
    let first = std::slice::from_ref(&first);
    assert_eq!(value(first), Some(range(Some(40.0))));
    assert!(first.iter().all(|b| !b.items.iter().any(
        |i| matches!(i, MountItem::ViewProps { id, .. } if *id == track || *id == indicator)
    )));
    // The indicator is the value's share of the track, in the app's look.
    assert_eq!(width(first), Some(80.0));
    assert_eq!(
        first
            .iter()
            .flat_map(|b| b.items.iter())
            .find_map(|i| match i {
                MountItem::ViewStyle { id, style } if *id == indicator => {
                    Some(style.background_color.0)
                }
                _ => None,
            }),
        Some(0x00ff_00ff)
    );

    let press = |view| {
        engine
            .control()
            .dispatch_event(view, EventKind::Press, EventPayload::None)
    };
    // Past 100: held to the range.
    press(more);
    let after = until(&rx, |b| shows(b, "120%"));
    assert_eq!(value(&after), Some(range(Some(100.0))));
    assert_eq!(width(&after), Some(200.0));

    // Indeterminate: the range without a value, the app's width.
    press(loading);
    let after = until(&rx, |b| {
        frame_of(std::slice::from_ref(b), indicator).is_some()
    });
    assert_eq!(value(&after), Some(range(None)));
    assert_eq!(width(&after), Some(50.0));
}

const BASE_SLIDER: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Slider } from "nsh/base";

function App() {
  const price = signal<[number, number]>([20, 60]);
  const ended = signal("none");
  return (
    <View>
      <Slider
        testID="price"
        value={price()}
        onChange={(next) => price.set(next as [number, number])}
        onChangeEnd={(next) => ended.set(`end ${next}`)}
        accessibilityLabel="Maximum price"
        startAccessibilityLabel="Minimum price"
        class="w-[200px]"
        trackClass="h-[20px] justify-center"
        indicatorClass="h-[4px]"
        rangeStyle={{ backgroundColor: "#00ff00" }}
        thumbClass="w-[10px] h-[10px]"
      />
      <Text>{`Price ${price()[0]}-${price()[1]}`}</Text>
      <Text>{ended()}</Text>
    </View>
  );
}

mount(App);
"##;

/// `nsh/base`'s `Slider` with a range: each thumb is an adjustable element
/// of its own with its label and value (the start's up to the end, the
/// end's from the start), the range and the thumbs placed by the values
/// along the indicator, a press on the track moving the nearer thumb there
/// (one change, then its end), and a screen reader's increment stepping a
/// thumb.
#[test]
fn a_base_slider_moves_the_nearer_thumb_and_tells_screen_readers_each_value() {
    use nsh_core::{AccessibilityRole, AccessibilityValue, TouchEvent, TouchPhase, TouchPoint};
    let (engine, rx) = start(BASE_SLIDER);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(shows(&first, "Price 20-60"));
    let thumbs: Vec<u32> = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::ViewProps { id, props }
                if props.accessibility.role == AccessibilityRole::Adjustable =>
            {
                Some(*id)
            }
            _ => None,
        })
        .collect();
    assert_eq!(thumbs.len(), 2, "a thumb each");
    let props_of = |batches: &[MountBatch], thumb: u32| {
        batches
            .iter()
            .rev()
            .flat_map(|b| b.items.iter().rev())
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if *id == thumb => Some(props.clone()),
                _ => None,
            })
            .expect("the thumb's props")
    };
    let first = std::slice::from_ref(&first);
    let label = |thumb| {
        props_of(first, thumb)
            .accessibility
            .label
            .as_deref()
            .map(str::to_owned)
    };
    let (start_thumb, end_thumb) = match label(thumbs[0]).as_deref() {
        Some("Minimum price") => (thumbs[0], thumbs[1]),
        _ => (thumbs[1], thumbs[0]),
    };
    assert_eq!(label(start_thumb).as_deref(), Some("Minimum price"));
    assert_eq!(label(end_thumb).as_deref(), Some("Maximum price"));
    let value = |min: f32, max: f32, now: f32| AccessibilityValue {
        min: Some(min),
        max: Some(max),
        now: Some(now),
        text: Some(format!("{now}").into()),
    };
    assert_eq!(
        props_of(first, start_thumb).accessibility.value,
        Some(value(0.0, 60.0, 20.0))
    );
    assert_eq!(
        props_of(first, end_thumb).accessibility.value,
        Some(value(20.0, 100.0, 60.0))
    );
    // The thumbs at 20% and 60% of the indicator, the range between them.
    assert_eq!(
        frame_of(first, start_thumb).map(|f| f.origin.x.0),
        Some(40.0)
    );
    assert_eq!(
        frame_of(first, end_thumb).map(|f| f.origin.x.0),
        Some(120.0)
    );
    let range = first[0]
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::ViewStyle { id, style } if style.background_color.0 == 0x00ff_00ff => {
                Some(*id)
            }
            _ => None,
        })
        .expect("the range");
    let range_frame = frame_of(first, range).expect("the range's frame");
    assert_eq!(
        (range_frame.origin.x.0, range_frame.size.width.0),
        (40.0, 80.0)
    );

    // The track: around the indicator, which holds the thumbs.
    let parent = |child: u32| {
        first[0]
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert {
                    parent, child: c, ..
                } if *c == child => Some(*parent),
                _ => None,
            })
            .expect("a parent")
    };
    let track = parent(parent(end_thumb));
    // A press at 75% of the track: nearer the end's thumb (the middle of
    // the two is at 40%), which jumps there.
    let touch = |phase| {
        EventPayload::Touch(Box::new(TouchEvent {
            phase,
            timestamp: 0.0,
            activated: None,
            points: vec![TouchPoint {
                id: 1,
                target: track,
                path: if phase == TouchPhase::Start {
                    vec![track]
                } else {
                    Vec::new()
                },
                page: nsh_core::geometry::point(px(150.0), px(10.0)),
                location: nsh_core::geometry::point(px(150.0), px(10.0)),
                changed: true,
            }],
        }))
    };
    engine
        .control()
        .dispatch_event(ROOT_ID, EventKind::Touch, touch(TouchPhase::Start));
    engine
        .control()
        .dispatch_event(ROOT_ID, EventKind::Touch, touch(TouchPhase::End));
    let after = until(&rx, |b| shows(b, "end 20,75"));
    assert!(after.iter().any(|b| shows(b, "Price 20-75")));
    assert_eq!(
        props_of(&after, end_thumb).accessibility.value,
        Some(value(20.0, 100.0, 75.0))
    );
    assert_eq!(
        props_of(&after, start_thumb).accessibility.value,
        Some(value(0.0, 75.0, 20.0))
    );

    // A screen reader's increment on the start's thumb: one step.
    engine.control().dispatch_event(
        start_thumb,
        EventKind::AccessibilityAction,
        EventPayload::Map(vec![("actionName", PayloadValue::Str("increment".into()))]),
    );
    let after = until(&rx, |b| shows(b, "end 21,75"));
    assert!(after.iter().any(|b| shows(b, "Price 21-75")));
}

const TAB_BAR: &str = r##"import { mount, signal } from "nsh";
import { TabBar } from "nsh/mobile";

const selected = signal(0);

function App() {
  return (
    <TabBar
      items={[
        { title: "Records", icon: "list.bullet" },
        { title: "Stats", icon: "chart.bar" },
      ]}
      selectedIndex={selected()}
      onChange={(index: number) => selected.set(index)}
    />
  );
}

mount(App);
"##;

fn is_tab_bar(item: &MountItem) -> bool {
    matches!(item, MountItem::Component { name, .. }
        if &**name == nsh_core::platform::TAB_BAR_COMPONENT)
}

/// `nsh/mobile`'s `TabBar` is the system's component on iOS and Android,
/// given the tabs as the app wrote them.
#[test]
fn the_tab_bar_is_the_systems_component_on_ios_and_android() {
    use nsh_core::platform::Os;

    for os in [Os::Ios, Os::Android] {
        let (_engine, rx) = start_in(
            TAB_BAR,
            Environment {
                os,
                ..Environment::default()
            },
        );
        let batches = until(&rx, |batch| batch.items.iter().any(is_tab_bar));
        let props = batches.iter().find_map(|batch| {
            batch.items.iter().find_map(|i| match i {
                MountItem::ComponentProps { props, .. } => Some(props.clone()),
                _ => None,
            })
        });
        let props = props.expect("its props reach it");
        let value = |key: &str| {
            props
                .iter()
                .find(|(name, _)| &**name == key)
                .and_then(|(_, value)| value.clone())
        };
        assert_eq!(
            value("items"),
            Some(serde_json::json!([
                { "title": "Records", "icon": "list.bullet" },
                { "title": "Stats", "icon": "chart.bar" },
            ])),
            "{os:?}"
        );
        assert_eq!(value("selectedIndex"), Some(serde_json::json!(0)), "{os:?}");
    }
}

/// Where the system has no tab bar it renders nothing: no component at all;
/// `isAvailable` tells which platforms `nsh/mobile` serves.
#[test]
fn the_tab_bar_renders_nothing_on_the_desktops_and_the_web() {
    use nsh_core::platform::Os;

    let app = TAB_BAR
        .replace("mount, signal", "mount, signal, Text")
        .replace("import { TabBar }", "import { TabBar, isAvailable }")
        .replace(
            "mount(App);",
            "mount(() => <><App /><Text>{`Ready: ${isAvailable}`}</Text></>);",
        );
    for (os, available) in [(Os::Ios, true), (Os::Android, true)] {
        let (_engine, rx) = start_in(
            &app,
            Environment {
                os,
                ..Environment::default()
            },
        );
        let ready = format!("Ready: {available}");
        let batches = until(&rx, |batch| shows(batch, &ready));
        assert!(batches.iter().any(|batch| shows(batch, &ready)), "{os:?}");
    }
    for os in [Os::MacOs, Os::Windows, Os::Linux, Os::Web] {
        let (_engine, rx) = start_in(
            &app,
            Environment {
                os,
                ..Environment::default()
            },
        );
        let batches = until(&rx, |batch| shows(batch, "Ready: false"));
        assert!(
            batches.iter().any(|batch| shows(batch, "Ready: false")),
            "{os:?}"
        );
        let platform = batches
            .iter()
            .any(|batch| batch.items.iter().any(is_tab_bar));
        assert!(!platform, "no system bar on {os:?}, no component");
    }
}

/// The user's choice reaches `onChange` as the index, and reactive updates
/// reach the same bar; `selectedIndex` removed is its default, 0.
#[test]
fn the_tab_bar_reports_the_users_choice_and_follows_its_props() {
    let app = r#"import { mount, signal, Text, View } from "nsh";
import { TabBar } from "nsh/mobile";
const selected = signal<number | undefined>(0);
const items = signal([{ title: "Records" }, { title: "Stats" }]);
mount(() => <View>
  <TabBar items={items()} selectedIndex={selected()}
    onChange={(index) => {
      selected.set(index);
      items.set([{ title: "Records" }, { title: "Statistics" }]);
    }} />
  <Text>{`Selected: ${selected()}`}</Text>
  <Text onPress={() => selected.set(undefined)}>Reset</Text>
</View>);
"#;
    let (engine, rx) = start(app);
    let initial = until(&rx, |batch| shows(batch, "Selected: 0"));
    let bar = initial
        .iter()
        .flat_map(|batch| &batch.items)
        .find_map(|item| match item {
            MountItem::Component { id, .. } if is_tab_bar(item) => Some(*id),
            _ => None,
        })
        .expect("the system bar");
    engine.control().dispatch_event(
        bar,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: "change".into(),
            data: serde_json::json!(1),
        },
    );
    let updates = until(&rx, |batch| shows(batch, "Selected: 1"));
    assert!(updates.iter().any(|batch| shows(batch, "Selected: 1")));
    let props: Vec<_> = updates
        .iter()
        .flat_map(|batch| &batch.items)
        .filter_map(|item| match item {
            MountItem::ComponentProps { id, props } if *id == bar => Some(props),
            _ => None,
        })
        .flatten()
        .collect();
    assert!(
        props
            .iter()
            .any(|(name, value)| &**name == "selectedIndex"
                && *value == Some(serde_json::json!(1)))
    );
    assert!(props.iter().any(|(name, value)| &**name == "items"
        && *value == Some(serde_json::json!([{ "title": "Records" }, { "title": "Statistics" }]))));
    let reset = initial
        .iter()
        .find_map(|batch| text_ids(batch, "Reset"))
        .expect("reset text");
    engine
        .control()
        .dispatch_event(reset, EventKind::Press, EventPayload::None);
    let reset = until(&rx, |batch| shows(batch, "Selected: undefined"));
    assert!(reset.iter().any(|batch| batch.items.iter().any(|item| {
        matches!(item, MountItem::ComponentProps { id, props } if *id == bar
            && props.iter().any(|(name, value)| &**name == "selectedIndex"
                && *value == Some(serde_json::json!(0))))
    })));
}

const BASE_PLOT: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Area, Grid, Line, Plot } from "nsh/base/plot";

type Row = { t: number; price: number; avg?: number; name: string };

function App() {
  const rows = signal<Row[]>([
    { t: 0, price: 10, avg: 15, name: "a" },
    { t: 1, price: 20, avg: 15, name: "b" },
    { t: 2, price: 30, name: "c" },
  ]);
  const hovered = signal<number | null>(null);
  return (
    <View>
      <Plot
        testID="plot"
        data={rows()}
        y="price"
        yScale={{ type: "linear", domain: [0, 40] }}
        accessibilityLabel="Price"
        class="w-[200px] h-[100px] stroke-[#ff0000]"
        style={{ color: "#0000ff" }}
        onHoverChange={(index) => hovered.set(index)}
      >
        <Grid y={[0, 20, 40]} class="stroke-[#00ff00]" style={{ strokeDasharray: "2 2" }} />
        <Area class="fill-[#0000ff]/50" curve="linear" />
        <Line curve="linear" class="stroke-2" />
        <Line y="avg" curve="stepAfter" class="stroke-current" />
      </Plot>
      <Text>{`hover ${hovered()}`}</Text>
      <View testID="more" onPress={() => rows.set([...rows(), { t: 3, price: 40, name: "d" }])} />
    </View>
  );
}

mount(App);
"##;

/// `nsh/base/plot`: a `Plot` of rows with its marks, each a canvas drawn
/// natively from the rows' fields by the plot's scales, painting with the
/// paint properties it inherits (`stroke-*` on the plot, `fill-*` and
/// `strokeDasharray` on a mark, `currentColor` where none is set); one
/// element for screen readers; the row nearest the pointer reported when
/// it changes; new rows drawn again in one batch.
#[test]
fn a_base_plot_draws_its_marks_from_the_rows() {
    use nsh_core::{
        AccessibilityRole, Color, HoverEvent,
        canvas::{CanvasOp, Num, Paint, PathOp},
    };
    let (engine, rx) = start(BASE_PLOT);
    // The marks draw once the plot has its size.
    let drawings = |batches: &[MountBatch]| {
        batches
            .iter()
            .flat_map(|b| b.items.iter())
            .filter_map(|i| match i {
                MountItem::Canvas { id, drawing } => Some((*id, drawing.clone())),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let points = |ops: &[CanvasOp]| {
        ops.iter()
            .filter_map(|op| match op {
                CanvasOp::Path(PathOp::MoveTo(Num::Const(x), Num::Const(y)))
                | CanvasOp::Path(PathOp::LineTo(Num::Const(x), Num::Const(y))) => Some((*x, *y)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let mut batches = Vec::new();
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(500)) {
        let done = drawings(std::slice::from_ref(&batch))
            .iter()
            .any(|(_, d)| points(&d.ops).len() > 3);
        batches.push(batch);
        if done {
            break;
        }
    }
    assert!(shows(&batches[0], "hover null"));
    // The latest drawing of each canvas, in the order JS made the marks,
    // in the plot's coordinates (each canvas reaches 8 points past it).
    assert_eq!(plot_bleeds(&batches), [8.0; 4]);
    let latest = plot_drawings(&batches);
    let [(_, grid), (_, area), (line, price), (_, avg)] = &latest[..] else {
        panic!("four marks: {latest:?}")
    };
    let (red, blue, green) = (Color(0xff00_00ff), Color(0x0000_ffff), Color(0x00ff_00ff));
    // The grid: its own stroke and dashes, a line across at each value
    // (on the middle of a pixel row), 40 at the top.
    assert_eq!(grid.ops[0], CanvasOp::StrokeStyle(Paint::Color(green)));
    assert_eq!(grid.ops[2], CanvasOp::LineDash([px(2.0), px(2.0)].into()));
    assert_eq!(
        points(&grid.ops),
        [
            (0.0, 100.5),
            (200.0, 100.5),
            (0.0, 50.5),
            (200.0, 50.5),
            (0.0, 0.5),
            (200.0, 0.5)
        ]
    );
    // The area: its fill, the price line and down to the bottom edge.
    assert_eq!(
        area.ops[0],
        CanvasOp::FillStyle(Paint::Color(Color(0x0000_ff80)))
    );
    assert_eq!(
        &points(&area.ops)[..5],
        [
            (0.0, 75.0),
            (100.0, 50.0),
            (200.0, 25.0),
            (200.0, 100.0),
            (0.0, 100.0)
        ]
    );
    // The lines: the plot's stroke inherited, its own width; the second
    // the plot's text color (`stroke-current`), steps through the rows
    // with an `avg`.
    assert_eq!(price.ops[0], CanvasOp::StrokeStyle(Paint::Color(red)));
    assert_eq!(price.ops[1], CanvasOp::LineWidth(Num::Const(2.0)));
    assert_eq!(
        points(&price.ops),
        [(0.0, 75.0), (100.0, 50.0), (200.0, 25.0)]
    );
    assert_eq!(avg.ops[0], CanvasOp::StrokeStyle(Paint::Color(blue)));
    assert_eq!(
        points(&avg.ops),
        [(0.0, 62.5), (100.0, 62.5), (100.0, 62.5)]
    );
    // The area's top edge: the plot's stroke, inherited as CSS does.
    assert!(area.ops.contains(&CanvasOp::StrokeStyle(Paint::Color(red))));

    // One element for screen readers: the image, with the app's label.
    let plot = batches
        .iter()
        .flat_map(|b| b.items.iter())
        .find_map(|i| match i {
            MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some("plot") => {
                Some((*id, props.clone()))
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(plot.1.accessibility.role, AccessibilityRole::Image);
    assert_eq!(plot.1.accessibility.accessible, Some(true));
    assert_eq!(plot.1.accessibility.label.as_deref(), Some("Price"));

    // The pointer: the nearest row, once per change, none once it leaves.
    let hover = |x: f32| {
        engine.control().dispatch_event(
            plot.0,
            EventKind::HoverMove,
            EventPayload::Hover(HoverEvent {
                position: nsh_core::geometry::point(px(x), px(10.0)),
                ..Default::default()
            }),
        )
    };
    hover(90.0);
    until(&rx, |b| shows(b, "hover 1"));
    hover(160.0);
    until(&rx, |b| shows(b, "hover 2"));
    engine
        .control()
        .dispatch_event(plot.0, EventKind::HoverOut, EventPayload::None);
    until(&rx, |b| shows(b, "hover null"));

    // New rows: the marks drawn again, in one batch, nothing for the grid
    // whose lines stay.
    let more = batches
        .iter()
        .flat_map(|b| b.items.iter())
        .find_map(|i| match i {
            MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some("more") => {
                Some(*id)
            }
            _ => None,
        })
        .unwrap();
    engine
        .control()
        .dispatch_event(more, EventKind::Press, EventPayload::None);
    let after = until(&rx, |b| !drawings(std::slice::from_ref(b)).is_empty());
    let redrawn = drawings(&after[after.len() - 1..]);
    assert_eq!(redrawn.len(), 3, "the area and the lines: {redrawn:?}");
    let (_, price) = redrawn.iter().find(|(id, _)| id == line).unwrap();
    assert_eq!(
        points(&price.ops),
        [
            (0.0, 75.0),
            (66.666664, 50.0),
            (133.33333, 25.0),
            (200.0, 0.0)
        ]
    );
}
/// The latest drawing of each plot mark's canvas in `batches`, in the
/// order the marks were made, in the plot's coordinates: without the
/// translation by the canvas's bleed past the plot ([`plot_bleeds`]).
fn plot_drawings(batches: &[MountBatch]) -> Vec<(u32, std::sync::Arc<nsh_core::canvas::Drawing>)> {
    use nsh_core::canvas::CanvasOp;
    plot_canvases(batches)
        .into_iter()
        .map(|(id, d)| {
            let mut d = (*d).clone();
            if matches!(d.ops.first(), Some(CanvasOp::Translate(..))) {
                d.ops.remove(0);
            }
            (id, std::sync::Arc::new(d))
        })
        .collect()
}

/// How far each plot mark's canvas reaches past the plot (its drawing's
/// first translation), in the order the marks were made.
fn plot_bleeds(batches: &[MountBatch]) -> Vec<f32> {
    use nsh_core::canvas::{CanvasOp, Num};
    plot_canvases(batches)
        .iter()
        .filter_map(|(_, d)| match d.ops.first() {
            Some(CanvasOp::Translate(Num::Const(x), Num::Const(y))) if x == y => Some(*x),
            _ => None,
        })
        .collect()
}

fn plot_canvases(batches: &[MountBatch]) -> Vec<(u32, std::sync::Arc<nsh_core::canvas::Drawing>)> {
    let mut latest: Vec<(u32, std::sync::Arc<nsh_core::canvas::Drawing>)> = Vec::new();
    for item in batches.iter().flat_map(|b| b.items.iter()) {
        if let MountItem::Canvas { id, drawing } = item {
            match latest.iter_mut().find(|(i, _)| i == id) {
                Some(entry) => entry.1 = drawing.clone(),
                None => latest.push((*id, drawing.clone())),
            }
        }
    }
    latest.sort_by_key(|(id, _)| *id);
    latest
}

/// The points a drawing's path goes through (its moves, lines and the
/// ends of its curves).
fn path_points(ops: &[nsh_core::canvas::CanvasOp]) -> Vec<(f32, f32)> {
    use nsh_core::canvas::{CanvasOp, Num, PathOp};
    ops.iter()
        .filter_map(|op| match op {
            CanvasOp::Path(PathOp::MoveTo(Num::Const(x), Num::Const(y)))
            | CanvasOp::Path(PathOp::LineTo(Num::Const(x), Num::Const(y))) => Some((*x, *y)),
            CanvasOp::Path(PathOp::CubicTo(n)) => match (n[4], n[5]) {
                (Num::Const(x), Num::Const(y)) => Some((x, y)),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// The view whose `testID` is `test_id`.
fn test_view(batches: &[MountBatch], test_id: &str) -> u32 {
    batches
        .iter()
        .flat_map(|b| b.items.iter())
        .find_map(|i| match i {
            MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                Some(*id)
            }
            _ => None,
        })
        .expect(test_id)
}

/// Batches until one holds a drawing that `done` accepts.
fn until_drawn(
    rx: &Receiver<MountBatch>,
    done: impl Fn(&nsh_core::canvas::Drawing) -> bool,
) -> Vec<MountBatch> {
    until(rx, |b| {
        b.items
            .iter()
            .any(|i| matches!(i, MountItem::Canvas { drawing, .. } if done(drawing)))
    })
}

const BASE_PLOT_SHAPES: &str = r##"import { mount, signal, View } from "nsh";
import { Area, Grid, Line, Plot } from "nsh/base/plot";

type Row = { t: number; v: number | null };

function App() {
  const width = signal(200);
  const rows: Row[] = [
    { t: 0, v: -10 },
    { t: 1, v: null },
    { t: 2, v: 10 },
    { t: 3, v: 30 },
  ];
  return (
    <View>
      {/* The default curve, a gap and negatives; a function of each row. */}
      <Plot testID="curved" data={rows} y="v" style={{ width: width(), height: 100 }}>
        <Line />
        <Line y={(d: Row) => d.v ?? 0} />
      </Plot>
      {/* Rows of a mark's own, on a linear x scale. */}
      <Plot data={rows} x="t" y="v" xScale={{ type: "linear", domain: [0, 4] }} yScale={{ type: "linear", domain: [-10, 30] }} style={{ width: 200, height: 100 }}>
        <Line data={[{ at: 1, w: 30 }, { at: 3, w: -10 }]} x="at" y="w" curve="linear" />
      </Plot>
      {/* No rows, one row, all equal values. */}
      <Plot data={[]} y="v" style={{ width: 200, height: 100 }}><Line /></Plot>
      <Plot data={[{ v: 5 }]} y="v" style={{ width: 200, height: 100 }}><Line /></Plot>
      <Plot data={[{ v: 5 }, { v: 5 }]} y="v" style={{ width: 200, height: 100 }}><Area /></Plot>
      {/* currentColor follows the appearance. */}
      <Plot data={[{ v: 1 }, { v: 2 }]} y="v" class="text-black dark:text-white" style={{ width: 200, height: 100 }}>
        <Grid y={[1, 2]} />
        {/* A theme's chart token, a series' color. */}
        <Grid y={[1]} class="stroke-chart-1" />
      </Plot>
      <View testID="wider" onPress={() => width.set(400)} style={{ height: 20 }} />
    </View>
  );
}

mount(App);
"##;

/// `nsh/base/plot`'s marks over the edges of their data: the default
/// curve (`natural`, a smooth one), rows without a value skipped as
/// `gpui-base` skips them, negatives, the app's function of a row (called
/// in the next turn), rows of a mark's own, no rows, one row, a domain of
/// one value, a resize, and `currentColor` following the appearance.
#[test]
fn base_plot_marks_draw_the_edges_of_their_data() {
    use nsh_core::canvas::{CanvasOp, Paint, PathOp};
    let environment = Environment {
        color_scheme: nsh_core::platform::ColorScheme::Dark,
        ..Environment::default()
    };
    let (engine, rx) = start_in(BASE_PLOT_SHAPES, environment);
    // The function's values come a turn after the rows.
    let batches = until_drawn(&rx, |d| {
        path_points(&d.ops)
            == [
                (0.0, 100.0),
                (66.666664, 75.0),
                (133.33333, 50.0),
                (200.0, 0.0),
            ]
    });
    // Every mark's canvas reaches past the plot by the strokes' room (8
    // points), so a line through the domain's highest or lowest value
    // draws whole; these curves swing no further than their points.
    assert_eq!(plot_bleeds(&batches), [8.0; 8]);
    let marks = plot_drawings(&batches);
    let [
        (_, curved),
        _,
        (_, own),
        (_, empty),
        (_, one),
        (_, equal),
        (_, grid),
        (_, chart),
    ] = &marks[..]
    else {
        panic!("eight marks: {marks:?}")
    };
    // The default curve: cubic segments through the rows with a value
    // (-10, 10, 30 over the extent -10 to 30; the gap skipped).
    assert!(
        curved
            .ops
            .iter()
            .any(|op| matches!(op, CanvasOp::Path(PathOp::CubicTo(_))))
    );
    assert_eq!(
        path_points(&curved.ops),
        [(0.0, 100.0), (133.33333, 50.0), (200.0, 0.0)]
    );
    // A mark's own rows on the plot's linear x scale.
    assert_eq!(path_points(&own.ops), [(50.0, 0.0), (150.0, 100.0)]);
    // No rows: no path. One row: a move to the middle, as `gpui-base`'s.
    assert!(path_points(&empty.ops).is_empty());
    assert_eq!(path_points(&one.ops), [(100.0, 50.0)]);
    // All equal: the middle of the plot.
    assert_eq!(path_points(&equal.ops)[..2], [(0.0, 50.0), (200.0, 50.0)]);
    // Dark: the grid's `currentColor` is the plot's dark text color.
    assert_eq!(
        grid.ops[0],
        CanvasOp::StrokeStyle(Paint::Color(nsh_core::Color(0xffff_ffff)))
    ); // `stroke-chart-1`: the theme's first chart color (dark), opaque.
    let CanvasOp::StrokeStyle(Paint::Color(c)) = chart.ops[0] else {
        panic!("{:?}", chart.ops[0])
    };
    assert!(c.0 & 0xff == 0xff && c != nsh_core::Color(0xffff_ffff));

    // Wider: the marks drawn again for the new width.
    let wider = test_view(&batches, "wider");
    engine
        .control()
        .dispatch_event(wider, EventKind::Press, EventPayload::None);
    let after = until_drawn(&rx, |d| path_points(&d.ops).last() == Some(&(400.0, 0.0)));
    assert!(!plot_drawings(&after).is_empty());
}

const BASE_PLOT_MOTION: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Line, Plot } from "nsh/base/plot";

function App() {
  const hovered = signal<number | null>(null);
  return (
    <View>
      <Plot
        testID="plot"
        data={[{ v: 1 }, { v: 2 }, { v: 3 }]}
        y="v"
        appearGeneration={1}
        motion={{ appear: { duration: 300 }, enter: { duration: 120 }, exit: { duration: 80 }, pointer: { stiffness: 300, damping: 30 } }}
        accessibilityValue={{ text: hovered() == null ? undefined : `row ${hovered()}` }}
        crossLineClass="w-px bg-[#999999]"
        dotClass="size-2 rounded-full bg-[#3366ff]"
        tooltipContent={<Text>tip</Text>}
        onHoverChange={(index) => hovered.set(index)}
        style={{ width: 200, height: 100 }}
      >
        <Line dot dotClass="size-1" />
      </Plot>
      <Text>{`hover ${hovered()}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// `Plot`'s motion (`gpui-base`'s `PlotMotion`), natively: the marks draw
/// in over `motion.appear` behind a clip the platform's animator moves;
/// the hover's parts (cross line, a dot per mark, the tooltip) take the
/// first row the pointer comes over at once and fade in over `enter`,
/// glide to the next on the pointer spring, and fade out over `exit`; the
/// app's value for screen readers follows; no mark is drawn again for the
/// pointer. With reduced motion, everything is complete at once.
#[test]
fn base_plot_moves_natively_with_its_motion() {
    use nsh_core::{
        animation::{AnimationOp, Driver},
        canvas::CanvasOp,
    };
    let (engine, rx) = start(BASE_PLOT_MOTION);
    let batches = until_drawn(&rx, |d| {
        d.ops.iter().any(|op| matches!(op, CanvasOp::Clip(..)))
    });
    let timings = |batches: &[MountBatch]| -> Vec<(f32, f32)> {
        batches
            .iter()
            .flat_map(|b| b.items.iter())
            .filter_map(|i| match i {
                MountItem::Animation(AnimationOp::Start {
                    driver:
                        Driver::Timing {
                            to, duration_ms, ..
                        },
                    ..
                }) => Some((*to, *duration_ms)),
                _ => None,
            })
            .collect()
    };
    let springs = |batches: &[MountBatch]| {
        batches
            .iter()
            .flat_map(|b| b.items.iter())
            .filter(|i| {
                matches!(
                    i,
                    MountItem::Animation(AnimationOp::Start {
                        driver: Driver::Spring { .. },
                        ..
                    })
                )
            })
            .count()
    };
    // The appear: 0 to 1 over 300 ms, the line clipped to it (a slot the
    // animator moves) and its dots in.
    // The appear starts in the turn after the first drawing (an async
    // task of the plot's), so wait for its timing too.
    let mut batches = batches;
    if !timings(&batches).contains(&(1.0, 300.0)) {
        batches.extend(until(&rx, |b| {
            timings(std::slice::from_ref(b)).contains(&(1.0, 300.0))
        }));
    }
    assert!(timings(&batches).contains(&(1.0, 300.0)));
    let line = plot_drawings(&batches);
    assert!(!line[0].1.slots.is_empty());
    assert!(shows(&batches[0], "hover null"));

    let plot = test_view(&batches, "plot");
    let hover = |x: f32| {
        engine.control().dispatch_event(
            plot,
            EventKind::HoverMove,
            EventPayload::Hover(nsh_core::HoverEvent {
                position: nsh_core::geometry::point(px(x), px(10.0)),
                ..Default::default()
            }),
        )
    };
    // Entering: the parts placed at once, then faded in over 120 ms; the
    // app's value for screen readers follows; no mark drawn again.
    hover(90.0);
    let entered = until(&rx, |b| shows(b, "hover 1"));
    assert!(timings(&entered).contains(&(1.0, 120.0)));
    assert_eq!(springs(&entered), 0);
    assert!(plot_drawings(&entered).is_empty());
    assert!(entered.iter().flat_map(|b| b.items.iter()).any(|i| matches!(
        i,
        MountItem::ViewProps { id, props } if *id == plot
            && props.accessibility.value.as_ref().and_then(|v| v.text.as_deref()) == Some("row 1")
    )));
    // Over the plot: the next row on the pointer spring.
    hover(190.0);
    let glided = until(&rx, |b| shows(b, "hover 2"));
    assert!(springs(&glided) > 0);
    assert!(plot_drawings(&glided).is_empty());
    // Leaving: faded out over 80 ms.
    engine
        .control()
        .dispatch_event(plot, EventKind::HoverOut, EventPayload::None);
    let left = until(&rx, |b| shows(b, "hover null"));
    assert!(timings(&left).contains(&(0.0, 80.0)));

    // Reduced motion: no appear, no clip.
    let environment = Environment {
        reduce_motion: true,
        ..Environment::default()
    };
    let (_engine, rx) = start_in(BASE_PLOT_MOTION, environment);
    let mut batches = until(&rx, |b| shows(b, "hover null"));
    batches.extend(until(&rx, |_| false));
    assert!(!timings(&batches).contains(&(1.0, 300.0)));
    assert!(
        plot_drawings(&batches)
            .iter()
            .all(|(_, d)| !d.ops.iter().any(|op| matches!(op, CanvasOp::Clip(..))))
    );
}

const BASE_PLOT_PARTS: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Area, Line, Plot } from "nsh/base/plot";

function App() {
  const hovered = signal<number | null>(null);
  const placement = signal<"top" | "pointer">("top");
  return (
    <View>
      <Plot
        testID="plot"
        data={[{ v: 10, w: 5 }, { v: 20, w: 15 }, { v: 30, w: 35 }]}
        y="v"
        yScale={{ type: "linear", domain: [0, 40] }}
        dotClass="size-2"
        dotStyle={{ backgroundColor: "#ffffff" }}
        tooltipContent={<View testID="tip" style={{ width: 60, height: 20 }} />}
        tooltipPlacement={placement()}
        tooltipOffset={8}
        onHoverChange={(index) => hovered.set(index)}
        style={{ width: 200, height: 100 }}
      >
        <Area curve="linear" backgroundClass="bg-linear-to-b from-[#ff0000] to-transparent" hoverDotClass="hidden" />
        <Line curve="linear" hoverDotStyle={{ backgroundColor: "#ff0000" }} />
        <Line y="w" curve="linear" />
      </Plot>
      <Text>{`hover ${hovered()} ${placement()}`}</Text>
      <View testID="pointer" onPress={() => placement.set("pointer")} style={{ height: 20 }} />
    </View>
  );
}

mount(App);
"##;

/// The parts `gpui-base`'s plot gives each mark and its tooltip: a mark's
/// own hover dot (`hoverDotStyle`, the plot's `dotStyle` for the marks
/// that set none), an area's background (a CSS gradient over the box
/// around its shape, shown inside the shape only, its `fill` then none),
/// and the tooltip's placement (`tooltipPlacement`, `tooltipOffset`): the
/// layout puts it on a side of a point the animator moves and keeps
/// inside the plot.
#[test]
fn base_plot_marks_have_parts_of_their_own_and_the_tooltip_stays_inside() {
    use nsh_core::{
        Color, HoverEvent,
        animation::Animator,
        canvas::{CanvasOp, GradientShape, Paint},
        geometry::point,
    };
    let (engine, rx) = start(BASE_PLOT_PARTS);
    let mut all = until_drawn(&rx, |d| {
        d.ops
            .iter()
            .any(|op| matches!(op, CanvasOp::FillStyle(Paint::Gradient(_))))
    });
    all.extend(until(&rx, |_| false));

    // The area's background: the gradient from its highest point (25) to
    // its baseline (100), filling its shape; the canvas's view draws no
    // background, and the area's `fill` is none.
    let drawings = plot_drawings(&all);
    let (background, gradient) = drawings
        .iter()
        .find_map(|(id, d)| {
            d.ops.iter().find_map(|op| match op {
                CanvasOp::FillStyle(Paint::Gradient(g)) => Some((*id, g.clone())),
                _ => None,
            })
        })
        .expect("a gradient");
    assert_eq!(
        gradient.shape,
        GradientShape::Linear {
            start: point(px(100.0), px(25.0)),
            end: point(px(100.0), px(100.0)),
        }
    );
    assert_eq!(gradient.stops[0].1, Color(0xff00_00ff));
    let style = all
        .iter()
        .flat_map(|b| b.items.iter())
        .filter_map(|i| match i {
            MountItem::ViewStyle { id, style } if *id == background => Some(style.clone()),
            _ => None,
        })
        .next_back()
        .unwrap();
    assert!(style.background_color.is_transparent());
    assert!(
        style
            .effects
            .as_deref()
            .is_none_or(|e| e.background_images.is_empty())
    );
    assert!(drawings.iter().any(|(id, d)| *id != background
        && d.ops.first() == Some(&CanvasOp::FillStyle(Paint::Color(Color::TRANSPARENT)))));

    // The hover's dots: the first line's its own, the other line's the
    // plot's (the area's is hidden).
    let backgrounds = |all: &[MountBatch], color: Color| {
        let mut ids: Vec<u32> = all
            .iter()
            .flat_map(|b| b.items.iter())
            .filter_map(|i| match i {
                MountItem::ViewStyle { id, style } if style.background_color == color => Some(*id),
                _ => None,
            })
            .collect();
        ids.sort();
        ids.dedup();
        ids.len()
    };
    assert_eq!(backgrounds(&all, Color(0xff00_00ff)), 1);
    assert!(backgrounds(&all, Color(0xffff_ffff)) >= 1);

    let plot = test_view(&all, "plot");
    let hover = |x: f32, y: f32| {
        engine.control().dispatch_event(
            plot,
            EventKind::HoverMove,
            EventPayload::Hover(HoverEvent {
                position: point(px(x), px(y)),
                ..Default::default()
            }),
        )
    };
    // The tooltip: the view around the app's content, and the point it is
    // placed by around that; where the layout puts the one and the
    // animator the other.
    let tip = test_view(&all, "tip");
    let parent = |all: &[MountBatch], child: u32| {
        all.iter()
            .flat_map(|b| b.items.iter())
            .find_map(|i| match i {
                MountItem::Insert {
                    parent, child: c, ..
                } if *c == child => Some(*parent),
                _ => None,
            })
            .unwrap()
    };
    // The tooltip's content sits in its slot's view, inside the box its
    // margins place, inside the point the animator moves.
    let (holder, point_view) = {
        let holder = parent(&all, parent(&all, tip));
        (holder, parent(&all, holder))
    };
    let placed = |all: &[MountBatch]| {
        let frame = all
            .iter()
            .flat_map(|b| b.items.iter())
            .filter_map(|i| match i {
                MountItem::Frame { id, frame } if *id == holder => Some(*frame),
                _ => None,
            })
            .next_back()
            .unwrap();
        let mut animator = Animator::default();
        for item in all.iter().flat_map(|b| b.items.iter()) {
            animator.apply(item);
        }
        let mut moved = (f32::NAN, f32::NAN);
        animator.write(
            |id| (id == point_view).then_some(id),
            |_, values, _| {
                moved = (
                    values.transform[0].unwrap_or(f32::NAN),
                    values.transform[1].unwrap_or(f32::NAN),
                )
            },
        );
        (
            (frame.origin.x.0, frame.origin.y.0),
            (frame.size.width.0, frame.size.height.0),
            moved,
        )
    };
    let near = |(x, y): (f32, f32), (wx, wy): (f32, f32)| {
        assert!(
            (x - wx).abs() < 0.01 && (y - wy).abs() < 0.01,
            "({x}, {y}) is not ({wx}, {wy})"
        );
    };

    // `"top"`: centered on the cross line at the last row (200), kept
    // inside the right edge (140 + 60), its offset below the top.
    hover(190.0, 10.0);
    all.extend(until(&rx, |b| shows(b, "hover 2 top")));
    all.extend(until(&rx, |_| false));
    let (at, size, moved) = placed(&all);
    near(at, (0.0, 8.0));
    near(size, (60.0, 20.0));
    near(moved, (140.0, 0.0));

    // `"pointer"`: in the lower right, left of the cross line and above
    // the pointer, its offset from both.
    let pointer = test_view(&all, "pointer");
    engine
        .control()
        .dispatch_event(pointer, EventKind::Press, EventPayload::None);
    all.extend(until(&rx, |b| shows(b, "hover 2 pointer")));
    hover(190.0, 80.0);
    all.extend(until(&rx, |_| false));
    let (at, _, moved) = placed(&all);
    near(at, (-68.0, -28.0));
    near(moved, (200.0, 80.0));
    // In the upper left: right of the cross line, below the pointer.
    hover(10.0, 10.0);
    all.extend(until(&rx, |b| shows(b, "hover 0 pointer")));
    all.extend(until(&rx, |_| false));
    let (at, _, moved) = placed(&all);
    near(at, (8.0, 8.0));
    near(moved, (0.0, 10.0));
}

const BASE_PLOT_REFRESH: &str = r##"import { mount, signal, View, Text } from "nsh";
import { Line, Plot } from "nsh/base/plot";
function App() {
  const width = signal(200);
  const rows = signal([{ v: 10 }, { v: 20 }, { v: 30 }]);
  const maximum = signal(40);
  const hovered = signal<number | null>(null);
  const events = signal(0);
  const step = signal(0);
  return <View>
    <Plot testID="plot" data={rows()} y="v"
      yScale={{ type: "linear", domain: [0, maximum()] }}
      crossLineStyle={{ width: 1, backgroundColor: "#0000ff" }}
      dotStyle={{ width: 8, height: 8, backgroundColor: "#ff0000" }}
      tooltipContent={<View testID="tip" style={{ width: 60, height: 20 }} />}
      onHoverChange={(index) => { hovered.set(index); events.update(n => n + 1); }}
      style={{ width: width(), height: 100 }}>
      <Line curve="linear" />
    </Plot>
    <Text>{`state=${step()} events=${events()} row=${hovered()}`}</Text>
    <View testID="resize" onPress={() => { width.set(400); step.set(1); }} />
    <View testID="data" onPress={() => { rows.set([{ v: 10 }, { v: 30 }, { v: 30 }]); step.set(2); }} />
    <View testID="scale" onPress={() => { maximum.set(60); step.set(3); }} />
    <View testID="shrink" onPress={() => { rows.set([{ v: 10 }]); step.set(4); }} />
  </View>;
}
mount(App);
"##;

#[test]
fn base_plot_refreshes_hover_geometry_without_new_pointer_events() {
    use nsh_core::{Color, HoverEvent, TransformKind, animation::Animator, geometry::point};

    let (engine, rx) = start(BASE_PLOT_REFRESH);
    let mut all = until_drawn(&rx, |_| true);
    all.extend(until(&rx, |_| false));
    let plot = test_view(&all, "plot");
    let parent = |batches: &[MountBatch], child: u32| {
        batches
            .iter()
            .flat_map(|batch| &batch.items)
            .find_map(|item| match item {
                MountItem::Insert {
                    parent, child: id, ..
                } if *id == child => Some(*parent),
                _ => None,
            })
            .expect("mounted parent")
    };
    let colored = |batches: &[MountBatch], color: Color| {
        batches
            .iter()
            .flat_map(|batch| &batch.items)
            .find_map(|item| match item {
                MountItem::ViewStyle { id, style } if style.background_color == color => Some(*id),
                _ => None,
            })
            .expect("styled hover part")
    };
    let cross = parent(&all, colored(&all, Color(0x0000_ffff)));
    // Band centering is static slot 0; the animated row coordinate follows it.
    let cross_transform = all
        .iter()
        .flat_map(|batch| &batch.items)
        .filter_map(|item| match item {
            MountItem::ViewStyle { id, style } if *id == cross => Some(style.transform),
            _ => None,
        })
        .next_back()
        .expect("cross style");
    assert_eq!(
        cross_transform
            .ops()
            .iter()
            .map(|op| (op.kind, op.value))
            .collect::<Vec<_>>(),
        vec![
            (TransformKind::TranslateX, 0.0),
            (TransformKind::TranslateX, 0.0)
        ]
    );
    let dot = parent(&all, colored(&all, Color(0xff00_00ff)));
    // The dot's fixed half-size centering precedes its animated coordinates.
    let dot_transform = all
        .iter()
        .flat_map(|batch| &batch.items)
        .filter_map(|item| match item {
            MountItem::ViewStyle { id, style } if *id == dot => Some(style.transform),
            _ => None,
        })
        .next_back()
        .expect("dot style");
    assert_eq!(
        dot_transform
            .ops()
            .iter()
            .map(|op| (op.kind, op.value))
            .collect::<Vec<_>>(),
        vec![
            (TransformKind::TranslateX, -4.0),
            (TransformKind::TranslateY, -4.0),
            (TransformKind::TranslateX, 0.0),
            (TransformKind::TranslateY, 0.0),
        ]
    );
    let tip = test_view(&all, "tip");
    let tip_anchor = parent(&all, parent(&all, parent(&all, tip)));
    let animated = |batches: &[MountBatch], view: u32| {
        let mut animator = Animator::default();
        for item in batches.iter().flat_map(|batch| &batch.items) {
            animator.apply(item);
        }
        let mut out = None;
        animator.write(
            |id| (id == view).then_some(id),
            |_, values, _| out = Some(values),
        );
        out.expect("the hover part has animation bindings")
    };
    let near = |actual: Option<f32>, expected: f32| {
        let actual = actual.expect("bound coordinate");
        assert!((actual - expected).abs() < 0.01, "{actual} != {expected}");
    };
    let status = |batches: &[MountBatch]| {
        batches
            .iter()
            .flat_map(|batch| &batch.items)
            .filter_map(|item| match item {
                MountItem::Text { text, .. } if text.text.starts_with("state=") => {
                    Some(text.text.clone())
                }
                _ => None,
            })
            .next_back()
            .expect("status text")
    };
    engine.control().dispatch_event(
        plot,
        EventKind::HoverMove,
        EventPayload::Hover(HoverEvent {
            position: point(px(100.0), px(50.0)),
            ..Default::default()
        }),
    );
    all.extend(until(&rx, |b| shows(b, "state=0 events=1 row=1")));
    all.extend(until(&rx, |_| false));
    assert_eq!(status(&all), "state=0 events=1 row=1");
    near(animated(&all, cross).transform[1], 100.0);
    near(animated(&all, dot).transform[2], 100.0);
    near(animated(&all, dot).transform[3], 50.0);
    near(animated(&all, tip_anchor).transform[0], 70.0);

    // No more pointer events: the selected row stays the same while its
    // layout, data and scale change. Notifications remain row changes only.
    for (action, expected_status, x, y, tip_x) in [
        ("resize", "state=1 events=1 row=1", 200.0, 50.0, 170.0),
        ("data", "state=2 events=1 row=1", 200.0, 25.0, 170.0),
        ("scale", "state=3 events=1 row=1", 200.0, 50.0, 170.0),
    ] {
        engine.control().dispatch_event(
            test_view(&all, action),
            EventKind::Press,
            EventPayload::None,
        );
        all.extend(until(&rx, |b| shows(b, expected_status)));
        all.extend(until(&rx, |_| false));
        assert_eq!(status(&all), expected_status);
        near(animated(&all, cross).transform[1], x);
        near(animated(&all, dot).transform[2], x);
        near(animated(&all, dot).transform[3], y);
        near(animated(&all, tip_anchor).transform[0], tip_x);
        near(animated(&all, cross).opacity, 1.0);
    }
    engine.control().dispatch_event(
        test_view(&all, "shrink"),
        EventKind::Press,
        EventPayload::None,
    );
    all.extend(until(&rx, |b| shows(b, "state=4 events=2 row=null")));
    all.extend(until(&rx, |_| false));
    assert_eq!(status(&all), "state=4 events=2 row=null");
    for id in [cross, dot, tip_anchor] {
        near(animated(&all, id).opacity, 0.0);
    }
}

const BASE_PLOT_RADIAL_POSITION: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Line, Pie, Plot } from "nsh/base/plot";
function App() {
  const radial = signal(true);
  const rows = signal([{ x: NaN, v: 1 }, { x: NaN, v: 1 }]);
  const hovered = signal<number | null>(null);
  const events = signal(0);
  return <View>
    <Plot testID="plot" data={rows()} x="x" y="v"
      xScale={{ type: "linear", domain: [0, 1] }}
      crossLineStyle={{ width: 1, backgroundColor: "#0000ff" }}
      tooltipPlacement="pointer"
      tooltipContent={<View testID="tip" style={{ width: 20, height: 10 }} />}
      onHoverChange={(index) => { hovered.set(index); events.update(n => n + 1); }}
      style={{ width: 200, height: 100 }}>
      <If when={radial()} else={<Line />}><Pie /></If>
    </Plot>
    <Text>{`mode=${radial()} events=${events()} row=${hovered()}`}</Text>
    <View testID="line" onPress={() => {
      rows.set([{ x: 0, v: 1 }, { x: 1, v: 1 }]); radial.set(false);
    }} />
    <View testID="pie" onPress={() => radial.set(true)} />
  </View>;
}
mount(App);
"##;

#[test]
fn base_plot_radial_position_does_not_use_the_cartesian_scale() {
    use nsh_core::{Color, HoverEvent, TransformKind, animation::Animator, geometry::point};

    let (engine, rx) = start(BASE_PLOT_RADIAL_POSITION);
    let mut all = until_drawn(&rx, |_| true);
    all.extend(until(&rx, |_| false));
    let plot = test_view(&all, "plot");
    let parent = |batches: &[MountBatch], child: u32| {
        batches
            .iter()
            .flat_map(|batch| &batch.items)
            .find_map(|item| match item {
                MountItem::Insert {
                    parent, child: id, ..
                } if *id == child => Some(*parent),
                _ => None,
            })
            .expect("mounted parent")
    };
    let cross_part = all
        .iter()
        .flat_map(|batch| &batch.items)
        .find_map(|item| match item {
            MountItem::ViewStyle { id, style } if style.background_color == Color(0x0000_ffff) => {
                Some(*id)
            }
            _ => None,
        })
        .expect("cross line");
    let cross = parent(&all, cross_part);
    // Band centering is static slot 0; the animated row coordinate follows it.
    let cross_transform = all
        .iter()
        .flat_map(|batch| &batch.items)
        .filter_map(|item| match item {
            MountItem::ViewStyle { id, style } if *id == cross => Some(style.transform),
            _ => None,
        })
        .next_back()
        .expect("cross style");
    assert_eq!(
        cross_transform
            .ops()
            .iter()
            .map(|op| (op.kind, op.value))
            .collect::<Vec<_>>(),
        vec![
            (TransformKind::TranslateX, 0.0),
            (TransformKind::TranslateX, 0.0)
        ]
    );
    let tip = test_view(&all, "tip");
    let tip_anchor = parent(&all, parent(&all, parent(&all, tip)));
    let assert_position = |batches: &[MountBatch], x: f32| {
        let mut animator = Animator::default();
        for item in batches.iter().flat_map(|batch| &batch.items) {
            animator.apply(item);
        }
        for (view, slot) in [(cross, 1), (tip_anchor, 0)] {
            let mut actual = None;
            animator.write(
                |id| (id == view).then_some(id),
                |_, values, _| actual = Some(values),
            );
            let actual = actual.expect("hover animation bindings");
            let at = actual.transform[slot].expect("bound x coordinate");
            assert!((at - x).abs() < 0.01, "{at} != {x}");
            assert_eq!(actual.opacity, Some(1.0));
        }
    };
    let status = |batches: &[MountBatch]| {
        batches
            .iter()
            .flat_map(|batch| &batch.items)
            .filter_map(|item| match item {
                MountItem::Text { text, .. } if text.text.starts_with("mode=") => {
                    Some(text.text.clone())
                }
                _ => None,
            })
            .next_back()
            .expect("status text")
    };
    let hover = |x: f32, y: f32| {
        engine.control().dispatch_event(
            plot,
            EventKind::HoverMove,
            EventPayload::Hover(HoverEvent {
                position: point(px(x), px(y)),
                ..Default::default()
            }),
        );
    };
    // The left half is row 1, even though neither row has a finite x.
    hover(70.0, 50.0);
    all.extend(until(&rx, |b| shows(b, "mode=true events=1 row=1")));
    all.extend(until(&rx, |_| false));
    assert_position(&all, 70.0);
    // Within that slice: move the anchors, without another row event or draw.
    hover(65.0, 60.0);
    let moved = until(&rx, |_| false);
    assert!(plot_drawings(&moved).is_empty());
    all.extend(moved);
    assert_eq!(status(&all), "mode=true events=1 row=1");
    assert_position(&all, 65.0);

    // The same selected row changes between Cartesian and radial placement.
    engine.control().dispatch_event(
        test_view(&all, "line"),
        EventKind::Press,
        EventPayload::None,
    );
    all.extend(until(&rx, |b| shows(b, "mode=false events=1 row=1")));
    all.extend(until(&rx, |_| false));
    hover(190.0, 50.0);
    all.extend(until(&rx, |_| false));
    assert_eq!(status(&all), "mode=false events=1 row=1");
    assert_position(&all, 200.0);
    engine
        .control()
        .dispatch_event(test_view(&all, "pie"), EventKind::Press, EventPayload::None);
    all.extend(until(&rx, |b| shows(b, "mode=true events=1 row=1")));
    all.extend(until(&rx, |_| false));
    hover(70.0, 50.0);
    all.extend(until(&rx, |_| false));
    assert_eq!(status(&all), "mode=true events=1 row=1");
    assert_position(&all, 70.0);
}

const BASE_PLOT_PIE: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Arc, Pie, Plot } from "nsh/base/plot";

type Row = { name: string; share: number };
const FILLS: Record<string, string> = { a: "fill-[#ff0000]", b: "fill-[#00ff00]", c: "fill-[#0000ff]" };

function App() {
  const hovered = signal<number | null>(null);
  const rows: Row[] = [
    { name: "a", share: 1 },
    { name: "b", share: 1 },
    { name: "none", share: 0 },
    { name: "c", share: 2 },
  ];
  return (
    <View>
      <Plot
        testID="plot"
        data={rows}
        accessibilityLabel="Shares"
        onHoverChange={(index) => hovered.set(index)}
        style={{ width: 200, height: 100 }}
      >
        <Arc innerRadius="50%" class="fill-[#999999]" />
        <Pie
          value="share"
          innerRadius="50%"
          padAngle={0.1}
          hoverLift={6}
          hoverDim={0.4}
          sliceClass={(d: Row) => FILLS[d.name]}
          sliceStyle={{ stroke: "#ffffff", strokeWidth: 2 }}
        />
        <Arc startAngle={-Math.PI / 2} endAngle={Math.PI / 2} innerRadius={10} outerRadius={20} />
      </Plot>
      <Text>{`hover ${hovered()}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// An arc of a drawing: its center, radius (`None`: an animated one),
/// start and end (`NaN`: animated) and whether it turns counterclockwise.
type DrawnArc = ((f32, f32), Option<f32>, (f32, f32), bool);

/// The arcs of a drawing, in order.
fn drawn_arcs(ops: &[nsh_core::canvas::CanvasOp]) -> Vec<DrawnArc> {
    use nsh_core::canvas::{CanvasOp, Num, PathOp};
    let n = |n: &Num| match n {
        Num::Const(n) => Some(*n),
        _ => None,
    };
    ops.iter()
        .filter_map(|op| match op {
            CanvasOp::Path(PathOp::Arc {
                x,
                y,
                radius,
                start,
                end,
                ccw,
            }) => Some((
                (n(x)?, n(y)?),
                n(radius),
                (n(start).unwrap_or(f32::NAN), n(end).unwrap_or(f32::NAN)),
                *ccw,
            )),
            _ => None,
        })
        .collect()
}

/// Whether the arcs `got` are `want`, their angles to 1e-4.
fn same_arcs(got: &[DrawnArc], want: &[DrawnArc]) -> bool {
    let near = |a: f32, b: f32| (a - b).abs() < 1e-4;
    got.len() == want.len()
        && got.iter().zip(want).all(|(g, w)| {
            g.0 == w.0 && g.1 == w.1 && near(g.2.0, w.2.0) && near(g.2.1, w.2.1) && g.3 == w.3
        })
}

/// `nsh/base/plot`'s `Pie` and `Arc` (`gpui-base`'s `Pie` and `Arc`): a
/// canvas per slice, each its share of the turn from 12 o'clock, a row
/// worth nothing without one, the pad as wide at the hole as at the rim,
/// each slice painted with its own classes (a function of its row) and
/// the pie's style; an arc between two angles. The pointer over the pie
/// finds the slice under it (none in the hole or outside), the slice
/// grows by `hoverLift` and the others fade by `hoverDim` on the
/// animator, and no slice is drawn again for the pointer.
#[test]
fn base_plot_pie_draws_a_slice_per_row_and_follows_the_pointer() {
    use std::f32::consts::{FRAC_PI_2, PI};

    use nsh_core::{
        Color, HoverEvent,
        animation::{AnimationValue, Animator},
        canvas::{CanvasOp, FillRule, Paint},
        geometry::point,
    };
    let (engine, rx) = start(BASE_PLOT_PIE);
    // The slices' classes come a turn after the rows.
    let mut all = until_drawn(&rx, |d| {
        d.ops
            .contains(&CanvasOp::FillStyle(Paint::Color(Color(0x0000_ffff))))
    });
    all.extend(until(&rx, |_| false));
    let drawings = plot_drawings(&all);
    // The ring and the gauge (made with the plot), and the slices (made
    // once the rows' values are read), in the order of their rows.
    let rim = |d: &nsh_core::canvas::Drawing| drawn_arcs(&d.ops).first().and_then(|a| a.1);
    let ring = drawings.iter().find(|(_, d)| rim(d) == Some(50.0));
    let gauge = drawings.iter().find(|(_, d)| rim(d) == Some(20.0));
    let slices: Vec<_> = drawings.iter().filter(|(_, d)| rim(d).is_none()).collect();
    let (Some((_, ring)), Some((_, gauge)), [(s0, a), (s1, b), (s3, c)]) =
        (ring, gauge, &slices[..])
    else {
        panic!("a ring, three slices and a gauge: {drawings:?}")
    };
    // The slices reach past the plot by the strokes' room and their lift.
    let mut bleeds = plot_bleeds(&all);
    bleeds.sort_by(f32::total_cmp);
    assert_eq!(bleeds, [8.0, 8.0, 14.0, 14.0, 14.0]);
    // A ring at the plot's center, the largest circle it holds (50) down
    // to the hole (50%: 25); its own fill.
    assert!(same_arcs(
        &drawn_arcs(&ring.ops),
        &[
            (
                (100.0, 50.0),
                Some(50.0),
                (-FRAC_PI_2, 3.0 * FRAC_PI_2),
                false
            ),
            (
                (100.0, 50.0),
                Some(25.0),
                (3.0 * FRAC_PI_2, -FRAC_PI_2),
                true
            ),
        ]
    ));
    assert_eq!(
        ring.ops[0],
        CanvasOp::FillStyle(Paint::Color(Color(0x9999_99ff)))
    );
    // The first slice: a quarter from 12 o'clock (1 of 1 + 1 + 2), its rim
    // animated (the lift), the pad 0.1 wide at the rim (0.05 each side)
    // and the gap as wide at the hole: its edges half the gap's width
    // (`50 * sin(0.05)`) from the radials there too.
    let inner = (50.0 * 0.05f32.sin() / 25.0).asin();
    assert!(
        same_arcs(
            &drawn_arcs(&a.ops),
            &[
                ((100.0, 50.0), None, (-FRAC_PI_2 + 0.05, -0.05), false),
                (
                    (100.0, 50.0),
                    Some(25.0),
                    (-inner, -FRAC_PI_2 + inner),
                    true
                ),
            ]
        ),
        "{:?}",
        drawn_arcs(&a.ops)
    );
    assert!((drawn_arcs(&b.ops)[0].2.0 - 0.05).abs() < 1e-4);
    // The last row's slice: the half after the empty row, which has none.
    let last = drawn_arcs(&c.ops)[0].2;
    assert!((last.0 - (FRAC_PI_2 + 0.05)).abs() < 1e-4, "{last:?}");
    assert!((last.1 - (3.0 * FRAC_PI_2 - 0.05)).abs() < 1e-4, "{last:?}");
    // Each slice's fill its row's, its stroke the pie's.
    let fill = |d: &nsh_core::canvas::Drawing| {
        d.ops.iter().find_map(|op| match op {
            CanvasOp::FillStyle(Paint::Color(c)) => Some(*c),
            _ => None,
        })
    };
    assert_eq!(fill(a), Some(Color(0xff00_00ff)));
    assert_eq!(fill(b), Some(Color(0x00ff_00ff)));
    assert_eq!(fill(c), Some(Color(0x0000_ffff)));
    assert!(
        a.ops
            .contains(&CanvasOp::StrokeStyle(Paint::Color(Color(0xffff_ffff))))
    );
    assert!(a.ops.contains(&CanvasOp::Fill(None, FillRule::NonZero)));
    // The gauge: the upper half, from 9 o'clock, between 10 and 20.
    assert!(same_arcs(
        &drawn_arcs(&gauge.ops),
        &[
            ((100.0, 50.0), Some(20.0), (-PI, 0.0), false),
            ((100.0, 50.0), Some(10.0), (0.0, -PI), true),
        ]
    ));

    let plot = test_view(&all, "plot");
    let hover = |x: f32, y: f32| {
        engine.control().dispatch_event(
            plot,
            EventKind::HoverMove,
            EventPayload::Hover(HoverEvent {
                position: point(px(x), px(y)),
                ..Default::default()
            }),
        )
    };
    // What the animator shows of a slice: its opacity and its rim.
    let shown = |all: &[MountBatch], slice: u32| {
        let mut animator = Animator::default();
        for item in all.iter().flat_map(|b| b.items.iter()) {
            animator.apply(item);
        }
        let mut out = (f32::NAN, f32::NAN);
        animator.write(
            |id| (id == slice).then_some(id),
            |_, values, args| {
                out.0 = values.opacity.unwrap_or(f32::NAN);
                if let Some((_, AnimationValue::Number(r))) = args.first() {
                    out.1 = *r;
                }
            },
        );
        out
    };
    // To the animator's float precision.
    let is = |(o, r): (f32, f32), (wo, wr): (f32, f32)| {
        assert!(
            (o - wo).abs() < 1e-5 && (r - wr).abs() < 1e-4,
            "({o}, {r}) is not ({wo}, {wr})"
        )
    };
    is(shown(&all, *s0), (1.0, 50.0));
    // Upper right: the first row's slice; it grows, the others fade.
    hover(130.0, 30.0);
    let over = until(&rx, |b| shows(b, "hover 0"));
    assert!(plot_drawings(&over).is_empty(), "no slice drawn again");
    all.extend(over);
    all.extend(until(&rx, |_| false));
    is(shown(&all, *s0), (1.0, 56.0));
    is(shown(&all, *s1), (0.6, 50.0));
    // Lower left: the last row's.
    hover(70.0, 70.0);
    all.extend(until(&rx, |b| shows(b, "hover 3")));
    all.extend(until(&rx, |_| false));
    is(shown(&all, *s0), (0.6, 50.0));
    is(shown(&all, *s3), (1.0, 56.0));
    // In the hole: none; back on a slice; outside the ring: none.
    hover(100.0, 50.0);
    all.extend(until(&rx, |b| shows(b, "hover null")));
    hover(130.0, 30.0);
    all.extend(until(&rx, |b| shows(b, "hover 0")));
    hover(195.0, 5.0);
    all.extend(until(&rx, |b| shows(b, "hover null")));
    all.extend(until(&rx, |_| false));
    // Gone: every slice whole again.
    is(shown(&all, *s0), (1.0, 50.0));
    is(shown(&all, *s3), (1.0, 50.0));
}

const BASE_PLOT_PIE_MOTION: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Pie, Plot } from "nsh/base/plot";

function App() {
  const hovered = signal<number | null>(null);
  return (
    <View>
      <Plot
        testID="plot"
        data={[{ v: 1 }, { v: 3 }]}
        y="v"
        appearGeneration={1}
        motion={{ appear: { duration: 300 }, enter: { duration: 120 }, pointer: { stiffness: 300, damping: 30 } }}
        onHoverChange={(index) => hovered.set(index)}
        style={{ width: 100, height: 100 }}
      >
        <Pie hoverLift={4} />
      </Plot>
      <Text>{`hover ${hovered()}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// A pie's motion (`gpui-component`'s pie): the ring sweeps in from its
/// first slice over the plot's appear, its angles animated values the
/// platform moves; the slice under the pointer lifts on the pointer
/// spring. With reduced motion the ring is whole at once.
#[test]
fn base_plot_pie_sweeps_in_and_lifts_on_the_pointer_spring() {
    use nsh_core::{
        HoverEvent,
        animation::{AnimationOp, Driver},
        geometry::point,
    };
    let (engine, rx) = start(BASE_PLOT_PIE_MOTION);
    // Sweeping: the slices' angles are animated values.
    let mut all = until_drawn(&rx, |d| {
        drawn_arcs(&d.ops).first().is_some_and(|a| a.2.0.is_nan())
    });
    let appear = |b: &MountBatch| {
        b.items.iter().any(|i| {
            matches!(
                i,
                MountItem::Animation(AnimationOp::Start {
                    driver: Driver::Timing { duration_ms, .. },
                    ..
                }) if *duration_ms == 300.0
            )
        })
    };
    if !all.iter().any(appear) {
        all.extend(until(&rx, appear));
    }
    let plot = test_view(&all, "plot");
    // The second row's slice, past 3 o'clock: it lifts on the spring.
    engine.control().dispatch_event(
        plot,
        EventKind::HoverMove,
        EventPayload::Hover(HoverEvent {
            position: point(px(30.0), px(60.0)),
            ..Default::default()
        }),
    );
    let mut over = until(&rx, |b| shows(b, "hover 1"));
    over.extend(until(&rx, |_| false));
    assert!(over.iter().flat_map(|b| b.items.iter()).any(|i| matches!(
        i,
        MountItem::Animation(AnimationOp::Start {
            driver: Driver::Spring { .. },
            ..
        })
    )));

    // Reduced motion: whole at once, no sweep.
    let environment = Environment {
        reduce_motion: true,
        ..Environment::default()
    };
    let (_engine, rx) = start_in(BASE_PLOT_PIE_MOTION, environment);
    let mut all = until(&rx, |b| shows(b, "hover null"));
    all.extend(until(&rx, |_| false));
    let drawings = plot_drawings(&all);
    assert_eq!(drawings.len(), 2);
    assert!(drawings.iter().all(|(_, d)| {
        let arcs = drawn_arcs(&d.ops);
        !arcs.is_empty() && arcs.iter().all(|a| !a.2.0.is_nan())
    }));
}

const BASE_PLOT_PIE_UPDATE: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Arc, Pie, Plot } from "nsh/base/plot";

function App() {
  const donut = signal(true);
  setTimeout(() => donut.set(false), 50);
  return (
    <View>
      <Plot
        testID="plot"
        data={[{ v: 1 }, { v: 3 }]}
        y="v"
        motion={{ update: { duration: 250 } }}
        style={{ width: 100, height: 100 }}
      >
        <Arc innerRadius={donut() ? "50%" : 0} />
        <Pie innerRadius={donut() ? "50%" : 0} padAngle={0.1} />
      </Plot>
      <Text>{donut() ? "donut" : "pie"}</Text>
    </View>
  );
}

mount(App);
"##;

/// A donut turning into a pie (`motion.update`): the hole closes over the
/// update's timing, its radius an animated value the platform moves, while
/// the slices' angles stay put. With reduced motion the pie shows at once.
#[test]
fn base_plot_pie_radii_move_with_the_update_motion() {
    use nsh_core::animation::{AnimationOp, Driver};
    let updates = |b: &MountBatch| {
        b.items.iter().any(|i| {
            matches!(
                i,
                MountItem::Animation(AnimationOp::Start {
                    driver: Driver::Timing { duration_ms, .. },
                    ..
                }) if *duration_ms == 250.0
            )
        })
    };
    // The inner edges of the drawings after the switch: each animated.
    let inner_edges = |all: &[MountBatch]| -> Vec<DrawnArc> {
        plot_drawings(all)
            .iter()
            .map(|(_, d)| *drawn_arcs(&d.ops).last().expect("an inner edge"))
            .collect()
    };

    let (_engine, rx) = start(BASE_PLOT_PIE_UPDATE);
    let mut all = until(&rx, |b| shows(b, "pie"));
    all.extend(until(&rx, |_| false));
    assert!(all.iter().any(updates), "the hole closes over the update");
    let switched = all.iter().position(|b| shows(b, "pie")).unwrap();
    let edges = inner_edges(&all[switched..]);
    // The ring and both slices.
    assert_eq!(edges.len(), 3, "{edges:?}");
    assert!(edges.iter().all(|e| e.1.is_none() && e.3), "{edges:?}");
    // The slices' outer edges keep their angles.
    let rims: Vec<_> = plot_drawings(&all[switched..])
        .iter()
        .map(|(_, d)| drawn_arcs(&d.ops)[0])
        .collect();
    assert!(
        rims.iter().all(|a| !a.2.0.is_nan() && a.1.is_some()),
        "{rims:?}"
    );

    // Reduced motion: the pie at once, its slices meeting short of the
    // center.
    let environment = Environment {
        reduce_motion: true,
        ..Environment::default()
    };
    let (_engine, rx) = start_in(BASE_PLOT_PIE_UPDATE, environment);
    let mut all = until(&rx, |b| shows(b, "pie"));
    all.extend(until(&rx, |_| false));
    assert!(!all.iter().any(updates));
    let switched = all.iter().position(|b| shows(b, "pie")).unwrap();
    let edges = inner_edges(&all[switched..]);
    assert!(edges.iter().all(|e| e.1.is_some()), "{edges:?}");
}

const BASE_PLOT_BARS: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Bar, Plot } from "nsh/base/plot";

type Row = { m: string; a: number; b: number; c: number | null };

function App() {
  const hovered = signal<number | null>(null);
  const rows: Row[] = [
    { m: "Jan", a: 10, b: 20, c: 5 },
    { m: "Feb", a: 30, b: 10, c: null },
    { m: "Mar", a: -10, b: 0, c: 15 },
  ];
  return (
    <View>
      <Plot
        testID="bars"
        data={rows}
        xScale={{ type: "band", paddingInner: 0.25, paddingOuter: 0.125 }}
        yScale={{ type: "linear", domain: [-20, 60] }}
        crossLineClass="w-full bg-[#eeeeee]"
        onHoverChange={(index) => hovered.set(index)}
        style={{ width: 300, height: 80 }}
      >
        <Bar value="a" class="fill-[#ff0000]" cornerRadii={{ topLeft: 2, topRight: 2 }} inactiveOpacity={0.4} label="a" />
        <Bar value="b" stack="s" class="fill-[#00ff00]" />
        <Bar value="c" stack="s" label={(d: Row) => `${d.c}%`} />
      </Plot>
      {/* Bars across: bands down the y axis, values along x. */}
      <Plot data={rows} yScale={{ type: "band" }} style={{ width: 100, height: 60 }}>
        <Bar value="b" />
      </Plot>
      <Text>{`hover ${hovered()}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// The rectangles a drawing fills (its `rect` and `roundRect` subpaths
/// with constant numbers).
fn bar_rects(ops: &[nsh_core::canvas::CanvasOp]) -> Vec<[f32; 4]> {
    use nsh_core::canvas::{CanvasOp, Num, PathOp};
    ops.iter()
        .filter_map(|op| match op {
            CanvasOp::Path(PathOp::Rect(r) | PathOp::RoundRect(r, _)) => match r {
                [Num::Const(x), Num::Const(y), Num::Const(w), Num::Const(h)] => {
                    Some([*x, *y, *w, *h])
                }
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// `nsh/base/plot`'s `Bar` (`gpui-base`'s `Bar` on a `ScaleBand`, its
/// `Stack`): a bar per row in the row's band, bars outside a stack side by
/// side, a stack's bars piled from its base (a missing value adding
/// nothing), negatives growing down, the app's corners and paint; bars
/// across on a band y scale; a label at each bar's end, from a field or
/// the app's function; the hover finds the band under the pointer, the
/// cross line as wide as the band, and draws no bar again.
#[test]
fn base_plot_bars_stand_in_bands_and_stack() {
    use nsh_core::{
        Color, HoverEvent,
        canvas::{CanvasOp, Num, Paint, PathOp},
    };
    let (engine, rx) = start(BASE_PLOT_BARS);
    let mut all = until_drawn(&rx, |d| {
        bar_rects(&d.ops).contains(&[0.0, 20.0, 50.0, 20.0])
    });
    // The labels' function answers a turn later.
    all.extend(until(&rx, |_| false));
    assert_eq!(plot_bleeds(&all), [8.0; 4]);
    let marks = plot_drawings(&all);
    let [(_, a), (_, b), (_, c), (_, across)] = &marks[..] else {
        panic!("four bars: {marks:?}")
    };
    // Three bands of 75, 100 apart (`paddingInner` 0.25 of a step, half
    // that at each end), two places of 37.5 in each: `a`, and the stack
    // `s`. The y scale: 60 - value.
    assert_eq!(
        a.ops[0],
        CanvasOp::FillStyle(Paint::Color(Color(0xff00_00ff)))
    );
    assert_eq!(
        bar_rects(&a.ops),
        [
            [12.5, 50.0, 37.5, 10.0],
            [112.5, 30.0, 37.5, 30.0],
            [212.5, 60.0, 37.5, 10.0]
        ]
    );
    // Its corners, top left and top right; it fades with the hover.
    let (two, none) = (Num::Const(2.0), Num::Const(0.0));
    assert!(a.ops.contains(&CanvasOp::Path(PathOp::RoundRect(
        [
            Num::Const(12.5),
            Num::Const(50.0),
            Num::Const(37.5),
            Num::Const(10.0)
        ],
        [two, two, none, none]
    ))));
    assert!(
        a.ops
            .iter()
            .any(|op| matches!(op, CanvasOp::GlobalAlpha(Num::Slot(_))))
    );
    // The stack: `b` from 0, `c` from where `b` ends; no bar where a value
    // is 0 or missing. Square corners: plain rectangles.
    assert_eq!(
        bar_rects(&b.ops),
        [[50.0, 40.0, 37.5, 20.0], [150.0, 50.0, 37.5, 10.0]]
    );
    assert!(b.ops.iter().all(|op| !matches!(
        op,
        CanvasOp::GlobalAlpha(_) | CanvasOp::Path(PathOp::RoundRect(..))
    )));
    assert_eq!(
        bar_rects(&c.ops),
        [[50.0, 35.0, 37.5, 5.0], [250.0, 45.0, 37.5, 15.0]]
    );
    // Across: bands of 20 down the plot, values along x (0 to 20 over 100).
    assert_eq!(
        bar_rects(&across.ops),
        [[0.0, 0.0, 100.0, 20.0], [0.0, 20.0, 50.0, 20.0]]
    );

    // The labels: at each bar's end, centered on the bar; above an upright
    // bar, below one growing down.
    let parent_of = |all: &[MountBatch], child: u32| {
        all.iter()
            .flat_map(|b| b.items.iter())
            .find_map(|i| match i {
                MountItem::Insert {
                    parent, child: c, ..
                } if *c == child => Some(*parent),
                _ => None,
            })
            .unwrap()
    };
    let frame_of = |all: &[MountBatch], id: u32| {
        all.iter()
            .flat_map(|b| b.items.iter())
            .filter_map(|i| match i {
                MountItem::Frame { id: f, frame } if *f == id => Some(*frame),
                _ => None,
            })
            .next_back()
            .unwrap()
    };
    let label_at = |text: &str| {
        let id = all.iter().find_map(|b| text_ids(b, text)).expect(text);
        let f = frame_of(&all, parent_of(&all, id));
        (f.origin.x.0, f.origin.y.0)
    };
    // Layout rounds frames to whole points.
    let near = |text: &str, (x, y): (f32, f32)| {
        let (lx, ly) = label_at(text);
        assert!(
            (lx - x).abs() <= 0.5 && (ly - y).abs() <= 0.5,
            "{text} at ({lx}, {ly}), not ({x}, {y})"
        );
    };
    near("10", (31.25, 50.0));
    near("30", (131.25, 30.0));
    near("-10", (231.25, 70.0));
    near("5%", (68.75, 35.0));
    near("15%", (268.75, 45.0));
    assert!(!all.iter().any(|b| shows(b, "null%")));

    // The hover: the band under the pointer; the cross line as wide as it.
    let plot = test_view(&all, "bars");
    engine.control().dispatch_event(
        plot,
        EventKind::HoverMove,
        EventPayload::Hover(HoverEvent {
            position: nsh_core::geometry::point(px(160.0), px(10.0)),
            ..Default::default()
        }),
    );
    let hovered = until(&rx, |b| shows(b, "hover 1"));
    assert!(plot_drawings(&hovered).is_empty());
    all.extend(hovered);
    all.extend(until(&rx, |_| false));
    let line = all
        .iter()
        .flat_map(|b| b.items.iter())
        .find_map(|i| match i {
            MountItem::ViewStyle { id, style } if style.background_color == Color(0xeeee_eeff) => {
                Some(*id)
            }
            _ => None,
        })
        .expect("the cross line");
    assert_eq!(frame_of(&all, parent_of(&all, line)).size.width.0, 75.0);
}

const BASE_PLOT_BAR_MOTION: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Bar, Plot } from "nsh/base/plot";

function App() {
  const hovered = signal<number | null>(null);
  return (
    <View>
      <Plot
        testID="plot"
        data={[{ v: 1 }, { v: 2 }, { v: 3 }]}
        y="v"
        xScale={{ type: "band" }}
        appearGeneration={1}
        motion={{ appear: { duration: 300, easing: "easeOut" }, enter: { duration: 120 }, pointer: { stiffness: 300, damping: 30 } }}
        onHoverChange={(index) => hovered.set(index)}
        style={{ width: 300, height: 100 }}
      >
        <Bar stagger={0.5} inactiveOpacity={0.3} label="v" />
      </Plot>
      <Text>{`hover ${hovered()}`}</Text>
    </View>
  );
}

mount(App);
"##;

/// `Bar`'s motion, natively: with the plot's appear its bars grow out of
/// their base, one after another (`stagger`, `gpui-base`'s
/// `PlotAppear::staggered`), their ends values the platform's animator
/// moves over a linear time each bar eases; the bars of other rows fade
/// with the hover, and the pointer draws no bar again. With reduced
/// motion they are whole at once.
#[test]
fn base_plot_bars_grow_and_fade_natively() {
    use nsh_core::{
        animation::{AnimationOp, Driver, Easing},
        canvas::{CanvasOp, Num, PathOp},
    };
    let grows = |d: &nsh_core::canvas::Drawing| {
        d.ops.iter().any(|op| {
            matches!(
                op,
                CanvasOp::Path(PathOp::Rect([
                    Num::Const(_),
                    Num::Slot(_),
                    Num::Const(_),
                    Num::Slot(_)
                ]))
            )
        })
    };
    let (engine, rx) = start(BASE_PLOT_BAR_MOTION);
    let mut batches = until_drawn(&rx, grows);
    batches.extend(until(&rx, |_| false));
    // The appear's time: linear over 300 ms, each bar easing its slice.
    assert!(
        batches
            .iter()
            .flat_map(|b| b.items.iter())
            .any(|i| matches!(
                i,
                MountItem::Animation(AnimationOp::Start {
                    driver: Driver::Timing {
                        to,
                        duration_ms,
                        easing: Easing::Linear,
                        ..
                    },
                    ..
                }) if *to == 1.0 && *duration_ms == 300.0
            ))
    );
    assert!(batches.iter().any(|b| shows(b, "3")));

    let plot = test_view(&batches, "plot");
    engine.control().dispatch_event(
        plot,
        EventKind::HoverMove,
        EventPayload::Hover(nsh_core::HoverEvent {
            position: nsh_core::geometry::point(px(150.0), px(10.0)),
            ..Default::default()
        }),
    );
    let entered = until(&rx, |b| shows(b, "hover 1"));
    assert!(plot_drawings(&entered).is_empty());

    // Reduced motion: whole at once.
    let environment = Environment {
        reduce_motion: true,
        ..Environment::default()
    };
    let (_engine, rx) = start_in(BASE_PLOT_BAR_MOTION, environment);
    let mut batches = until(&rx, |b| shows(b, "hover null"));
    batches.extend(until(&rx, |_| false));
    let drawings = plot_drawings(&batches);
    assert!(drawings.iter().all(|(_, d)| !grows(d)));
    assert_eq!(bar_rects(&drawings[0].1.ops).len(), 3);
}

const BASE_PLOT_BAND_REFRESH: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Bar, Plot } from "nsh/base/plot";
function App() {
  const height = signal(120);
  const bands = signal(3);
  const across = signal(true);
  const rows = signal([{ v: 10 }, { v: 20 }, { v: 30 }]);
  const stage = signal(0);
  const hovered = signal<number | null>(null);
  const events = signal(0);
  return <View>
    <Plot testID="plot" data={rows()} y="v"
      xScale={across() ? { type: "linear", domain: [0, 40] } : { type: "band", bandCount: bands() }}
      yScale={across() ? { type: "band", bandCount: bands() } : { type: "linear", domain: [0, 40] }}
      crossLineClass="w-full h-full bg-[#0000ff]"
      tooltipContent={<View testID="tip" style={{ width: 40, height: 16 }} />}
      onHoverChange={index => { hovered.set(index); events.update(n => n + 1); }}
      style={{ width: 200, height: height() }}>
      <Bar value="v" inactiveOpacity={0.4} />
    </Plot>
    <Text>{`band=${stage()} events=${events()} row=${hovered()}`}</Text>
    <View testID="height" onPress={() => { height.set(240); stage.set(1); }} />
    <View testID="bands" onPress={() => { bands.set(4); stage.set(2); }} />
    <View testID="axis" onPress={() => { across.set(false); stage.set(3); }} />
    <View testID="shrink" onPress={() => { rows.set([{ v: 10 }]); stage.set(4); }} />
  </View>;
}
mount(App);
"##;

#[test]
fn base_plot_y_bands_refresh_stationary_hover_and_follow_an_axis_switch() {
    use nsh_core::{Color, HoverEvent, TransformKind, animation::Animator, geometry::point};

    let (engine, rx) = start(BASE_PLOT_BAND_REFRESH);
    let mut all = until_drawn(&rx, |_| true);
    all.extend(until(&rx, |_| false));
    let plot = test_view(&all, "plot");
    let parent = |batches: &[MountBatch], child: u32| {
        batches
            .iter()
            .flat_map(|b| &b.items)
            .filter_map(|item| match item {
                MountItem::Insert {
                    parent, child: id, ..
                } if *id == child => Some(*parent),
                _ => None,
            })
            .next_back()
            .expect("mounted parent")
    };
    let cross = |batches: &[MountBatch]| {
        // Axis changes replace the cross-line branch; inspect the latest part.
        let part = batches
            .iter()
            .flat_map(|b| &b.items)
            .filter_map(|item| match item {
                MountItem::ViewStyle { id, style }
                    if style.background_color == Color(0x0000_ffff) =>
                {
                    Some(*id)
                }
                _ => None,
            })
            .next_back()
            .expect("cross-line part");
        parent(batches, part)
    };
    let tip = test_view(&all, "tip");
    let tip_anchor = parent(&all, parent(&all, parent(&all, tip)));
    let animated = |batches: &[MountBatch], id: u32| {
        let mut animator = Animator::default();
        for item in batches.iter().flat_map(|b| &b.items) {
            animator.apply(item);
        }
        let mut values = None;
        animator.write(
            |view| (view == id).then_some(view),
            |_, v, _| values = Some(v),
        );
        values.expect("hover animation bindings")
    };
    let near = |value: Option<f32>, expected: f32| {
        let value = value.expect("bound coordinate");
        assert!((value - expected).abs() < 0.01, "{value} != {expected}");
    };
    let check = |batches: &[MountBatch], axis: TransformKind, span: f32, at: f32, tip_x: f32| {
        let cross = cross(batches);
        let style = batches
            .iter()
            .flat_map(|b| &b.items)
            .filter_map(|item| match item {
                MountItem::ViewStyle { id, style } if *id == cross => Some(style.transform),
                _ => None,
            })
            .next_back()
            .expect("cross style");
        let ops = style.ops();
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].kind, axis);
        assert_eq!(ops[1].kind, axis);
        assert!((ops[0].value + span / 2.0).abs() < 0.01);
        assert_eq!(ops[1].value, 0.0);
        near(animated(batches, cross).transform[1], at);
        near(animated(batches, cross).opacity, 1.0);
        near(animated(batches, tip_anchor).transform[0], tip_x);
    };
    let status = |batches: &[MountBatch]| {
        batches
            .iter()
            .flat_map(|b| &b.items)
            .filter_map(|item| match item {
                MountItem::Text { text, .. } if text.text.starts_with("band=") => {
                    Some(text.text.clone())
                }
                _ => None,
            })
            .next_back()
            .expect("band status")
    };
    engine.control().dispatch_event(
        plot,
        EventKind::HoverMove,
        EventPayload::Hover(HoverEvent {
            position: point(px(80.0), px(60.0)),
            ..Default::default()
        }),
    );
    let entered = until(&rx, |b| shows(b, "band=0 events=1 row=1"));
    assert!(
        plot_drawings(&entered).is_empty(),
        "the pointer redraws no bar"
    );
    all.extend(entered);
    all.extend(until(&rx, |_| false));
    check(&all, TransformKind::TranslateY, 40.0, 60.0, 60.0);

    // No more pointer events. Keep the selected row while its Y band moves,
    // then move that same row onto the X band axis without notifying again.
    for (action, expected, axis, span, at, tip_x) in [
        (
            "height",
            "band=1 events=1 row=1",
            TransformKind::TranslateY,
            80.0,
            120.0,
            60.0,
        ),
        (
            "bands",
            "band=2 events=1 row=1",
            TransformKind::TranslateY,
            60.0,
            90.0,
            60.0,
        ),
        (
            "axis",
            "band=3 events=1 row=1",
            TransformKind::TranslateX,
            50.0,
            75.0,
            55.0,
        ),
    ] {
        engine.control().dispatch_event(
            test_view(&all, action),
            EventKind::Press,
            EventPayload::None,
        );
        all.extend(until(&rx, |b| shows(b, expected)));
        all.extend(until(&rx, |_| false));
        assert_eq!(status(&all), expected);
        check(&all, axis, span, at, tip_x);
    }
    engine.control().dispatch_event(
        test_view(&all, "shrink"),
        EventKind::Press,
        EventPayload::None,
    );
    all.extend(until(&rx, |b| shows(b, "band=4 events=2 row=null")));
    all.extend(until(&rx, |_| false));
    assert_eq!(status(&all), "band=4 events=2 row=null");
    near(animated(&all, cross(&all)).opacity, 0.0);
    near(animated(&all, tip_anchor).opacity, 0.0);
}
