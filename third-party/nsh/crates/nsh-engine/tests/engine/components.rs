//! Rust components through the generated JS glue (the tests' own set,
//! `test/ui`): props, events, children, named slots, children placed one by
//! one, and a list of the app's rows; the runtime's modules (`Alert`), the
//! status bar of pages and dialogs and the environment (`SafeAreaView`,
//! `KeyboardAvoidingView`).

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
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: ui_sets.iter().map(Into::into).collect(),
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode_with(
        &bundle.code,
        false,
        &ui_sets.iter().map(Into::into).collect::<Vec<_>>(),
    )
    .unwrap();
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

const SAFE_AREA: &str = r#"import { mount, Text } from "nsh";
import { KeyboardAvoidingView, SafeAreaView, safeArea } from "nsh/base";

mount(() => (
  <KeyboardAvoidingView style={{ flex: 1 }}>
    <SafeAreaView style={{ flex: 1, padding: 4 }} edges={["top", "bottom"]}>
      <Text>inside</Text>
      <Text>{`top ${safeArea().top}`}</Text>
    </SafeAreaView>
  </KeyboardAvoidingView>
));
"#;

#[test]
fn safe_area_and_keyboard_avoiding_views() {
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
        "the safe area view above the keyboard"
    );
}

const RUNTIME_MODULES: &str = r#"import { mount, signal, Text } from "nsh";
import { reduceMotion, setAccessibilityFocus } from "nsh/accessibility";
import { platform } from "nsh/device";
import { Toast } from "nsh/android";
import { Image } from "nsh";

const shown = signal("waiting");
let note: unknown;
setTimeout(async () => {
  Toast.show("hello", "long");
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
    let mut toast = None;
    let mut focused = None;
    let mut requests = Vec::new();
    let control = engine.control();
    until(&rx, |batch| {
        for item in &batch.items {
            match item {
                MountItem::Command {
                    id: ROOT_ID,
                    command: Command::Toast { text, long },
                } => toast = Some((text.clone(), *long)),
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
    assert_eq!(toast, Some(("hello".to_owned(), true)));
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
import { Clipboard } from "nsh/clipboard";

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
import { Clipboard } from "nsh/clipboard";

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
import { Picker } from "nsh/picker";

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

const INPUT_TRAITS: &str = r##"import { mount, Input, Text } from "nsh";

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
    <Text selectable style={{ selectionColor: "#ff0000" }}>Pick me</Text>
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
import { BackHandler } from "nsh/android";

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
import { colorScheme, setColorScheme } from "nsh/device";

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
import { fontScale, locale } from "nsh/device";

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
