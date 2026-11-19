//! Apps end to end:
//! one TSX file importing only `nsh`, bundled as an ES module, run on the
//! native modules through bytecode, tapped after the idle GC.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, EventKind, EventPayload, MountBatch, MountItem, Points, Size, geometry::px,
};
use nsh_engine::{Bundle, Engine, EngineConfig};

use crate::ChannelSink;

const APP: &str = r#"import { computed, mount, signal, Text, View } from "nsh";

function Counter(props: { label: string }) {
  const count = signal(0);
  const double = computed(() => count() * 2);
  return (
    <View testID="counter" onPress={() => count.update((c) => c + 1)}>
      <Text>{props.label}: {count()} / {double()}</Text>
      <If when={count() > 1} else={<Text>few</Text>}>
        <Text>many</Text>
      </If>
    </View>
  );
}

function App() {
  const items = signal([{ id: "a" }, { id: "b" }]);
  return (
    <View>
      <Counter label="Taps" />
      <View testID="rotate" onPress={() => items.update((i) => [...i.slice(1), i[0]])}>
        <Each of={items()} key={(i) => i.id}>{(item, index) => <Text>{index()}{item().id}</Text>}</Each>
      </View>
    </View>
  );
}

mount(App);
"#;

fn start() -> (Engine, Receiver<MountBatch>) {
    let dir = std::env::temp_dir().join(format!("nsh-compiled-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("App.tsx"), APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: dir.join("App.tsx"),
        minify: true,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    assert!(!bundle.code.contains("solid"), "only the app's code");
    let bytecode =
        nsh_js::compile_bytecode_with(&bundle.code, true, &[nsh_base::registry().into()]).unwrap();
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
        speech: None,
        chunk_loader: None,
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

fn texts(batch: &MountBatch) -> Vec<String> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn a_single_file_app_on_the_native_modules() {
    let (engine, rx) = start();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let mut shown = texts(&first);
    shown.sort();
    assert_eq!(shown, ["0a", "1b", "Taps: 0 / 0", "few"]);
    let mut pressable: Vec<_> = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
            _ => None,
        })
        .collect();
    // Static children are made before dynamic ones: the rotating view
    // comes before the counter component's.
    pressable.sort();
    let [rotate, counter] = pressable[..] else {
        panic!("{pressable:?}")
    };

    // The idle collector runs: the app stays reachable through its views.
    while rx.recv_timeout(Duration::from_millis(1300)).is_ok() {}

    let control = engine.control();
    let tap = |id| {
        control.dispatch_event(id, EventKind::Press, EventPayload::None);
        rx.recv_timeout(Duration::from_secs(5)).expect("an update")
    };
    assert_eq!(texts(&tap(counter)), ["Taps: 1 / 2"]);
    let second = tap(counter);
    assert!(
        texts(&second).contains(&"many".to_owned()),
        "{:?}",
        texts(&second)
    );
    // Rows keep their views and show their new index.
    let rotated = tap(rotate);
    assert!(
        !rotated
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Create { .. })),
        "{:?}",
        rotated.items
    );
    let mut t = texts(&rotated);
    t.sort();
    assert_eq!(t, ["0b", "1a"]);
}

const NAVIGATION: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Dialog, NavPage, NavStack, createNavStack } from "nsh/base";
import { safeAreaInsets } from "nsh";

type Route = { name: string };
const nav = createNavStack<Route>([{ name: "home" }]);
const open = signal(false);

function Insets() {
  const insets = safeAreaInsets();
  return <Text>{`inset ${insets().top}`}</Text>;
}

mount(() => (
  <View style={{ flex: 1 }}>
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage title={route.name} headerRight={<Text onPress={() => open.set(true)}>open</Text>}>
          <View>
            <Text onPress={() => nav.push({ name: `page${nav.routes().length}` })}>push {route.name}</Text>
            <Insets />
          </View>
        </NavPage>
      )}
    </NavStack>
    <Dialog open={open()} onOpenChange={({ open: o }) => open.set(o)}>
      <Text>in modal</Text>
    </Dialog>
  </View>
));
"#;

fn start_app(app: &str) -> (Engine, Receiver<MountBatch>) {
    start_app_with(app, (px(44.0), px(96.0)))
}

/// [`start_app`] on a platform whose screen headers are `header_heights`
/// ([`nsh_core::NO_NATIVE_HEADER`]: none, as on the desktops and the web).
fn start_app_with(app: &str, header_heights: (Points, Points)) -> (Engine, Receiver<MountBatch>) {
    start_app_culling(app, header_heights, false)
}

/// [`start_app_with`], with scroll views making only the views near their
/// viewport (`content_culling`), as the platforms' apps do.
fn start_app_culling(
    app: &str,
    header_heights: (Points, Points),
    content_culling: bool,
) -> (Engine, Receiver<MountBatch>) {
    let dir = std::env::temp_dir().join(format!(
        "nsh-compiled-nav-{}-{}-{}",
        std::process::id(),
        app.len(),
        header_heights.0.0
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("App.tsx"), app).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: dir.join("App.tsx"),
        minify: false,
        split: false,
        ui_sets: vec![
            nsh_base::registry().into(),
            crate::test_ui::registry().into(),
        ],
        ..Default::default()
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode_with(
        &bundle.code,
        false,
        &[
            nsh_base::registry().into(),
            crate::test_ui::registry().into(),
        ],
    )
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        content_culling,
        network: None,
        websocket: None,
        refuse_connections: None,
        filesystem: None,
        assets: None,
        environment: Default::default(),
        header_heights,
        limits: nsh_engine::Limits::default(),
        ui_sets: vec![nsh_base::registry(), crate::test_ui::registry()],
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
        speech: None,
        chunk_loader: None,
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

/// The next batch `wanted` accepts (releases of popped screens' views may
/// come in batches of their own first).
fn next(rx: &Receiver<MountBatch>, wanted: impl Fn(&MountBatch) -> bool) -> MountBatch {
    loop {
        let batch = rx.recv_timeout(Duration::from_secs(5)).expect("a batch");
        if wanted(&batch) {
            return batch;
        }
    }
}

fn text_id(batch: &MountBatch, wanted: &str) -> Option<u32> {
    batch.items.iter().find_map(|i| match i {
        MountItem::Text { id, text, .. } if text.text == wanted => Some(*id),
        _ => None,
    })
}

fn titles(batch: &MountBatch) -> Vec<(u32, String)> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::ScreenConfig { id, config } => {
                Some((*id, config.title.as_deref()?.to_owned()))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn navigation_stacks_screens_and_modals() {
    let (engine, rx) = start_app(NAVIGATION);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let home = titles(&first);
    assert_eq!(home.last().map(|t| t.1.as_str()), Some("home"), "{home:?}");
    let home_screen = home[0].0;
    assert!(text_id(&first, "inset 0").is_some(), "{:?}", texts(&first));
    // The screen reports its insets: what it renders sees them.
    let insets = |top: f64| {
        EventPayload::Map(vec![
            ("top", nsh_core::PayloadValue::Number(top)),
            ("right", nsh_core::PayloadValue::Number(0.0)),
            ("bottom", nsh_core::PayloadValue::Number(34.0)),
            ("left", nsh_core::PayloadValue::Number(0.0)),
        ])
    };
    control.dispatch_event(home_screen, EventKind::Insets, insets(100.0));
    let batch = rx.recv_timeout(Duration::from_secs(5)).expect("insets");
    assert!(
        texts(&batch).contains(&"inset 100".to_owned()),
        "{:?}",
        texts(&batch)
    );
    // Push: a second screen.
    let push = text_id(&first, "push home").unwrap();
    control.dispatch_event(push, EventKind::Press, EventPayload::None);
    let batch = rx.recv_timeout(Duration::from_secs(5)).expect("pushed");
    let page = titles(&batch);
    assert_eq!(page.last().map(|t| t.1.as_str()), Some("page1"), "{page:?}");
    let page_screen = page[0].0;
    // The user pops it natively: its route goes, so the next push is page1
    // again.
    control.dispatch_event(page_screen, EventKind::Dismiss, EventPayload::None);
    while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
    control.dispatch_event(push, EventKind::Press, EventPayload::None);
    let batch = next(&rx, |b| !titles(b).is_empty());
    assert_eq!(titles(&batch).last().map(|t| t.1.as_str()), Some("page1"));
    // The header's button opens the modal.
    let open = text_id(&first, "open").expect("a header item");
    control.dispatch_event(open, EventKind::Press, EventPayload::None);
    let batch = next(&rx, |b| {
        b.items.iter().any(|i| {
            matches!(
                i,
                MountItem::Create {
                    kind: nsh_core::ViewKind::Modal,
                    ..
                }
            )
        })
    });
    assert!(text_id(&batch, "in modal").is_some());
}

const SCROLL_DIALOG: &str = r#"import { mount, signal, Scroll, Text, View } from "nsh";
import { Dialog } from "nsh/base";

const open = signal(false);

mount(() => (
  <Scroll style={{ flex: 1 }}>
    <View style={{ height: 3000 }}>
      <View testID="open" onPress={() => open.set(true)}>
        <Text>Open</Text>
      </View>
      <Dialog open={open()} presentation="pageSheet">
        <Text>in sheet</Text>
      </Dialog>
    </View>
    <View style={{ height: 3000 }}>
      <Dialog open={open()}>
        <Text>far down</Text>
      </Dialog>
    </View>
  </Scroll>
));
"#;

/// A dialog in a scroll view's content opens as the platforms' apps run
/// it (`content_culling`): its modal shows over everything, beside the
/// content in view and in content far down that was not made yet.
#[test]
fn dialogs_in_a_scroll_view_open_with_content_culling() {
    let (engine, rx) = start_app_culling(SCROLL_DIALOG, (px(44.0), px(96.0)), true);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let button = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
            _ => None,
        })
        .expect("the button");
    engine
        .control()
        .dispatch_event(button, EventKind::Press, EventPayload::None);
    let modals = |b: &MountBatch| {
        b.items
            .iter()
            .filter(|i| {
                matches!(
                    i,
                    MountItem::Create {
                        kind: nsh_core::ViewKind::Modal,
                        ..
                    }
                )
            })
            .count()
    };
    let batch = next(&rx, |b| modals(b) > 0);
    assert_eq!(modals(&batch), 2);
    assert!(text_id(&batch, "in sheet").is_some());
    assert!(text_id(&batch, "far down").is_some());
}

const SLIDING_CARDS: &str = r#"import { createAnimatedValue, mount, Scroll, Text, View } from "nsh";

// A page of sections that fade and slide 14pt up into place as they appear.
function Card(props: { index: number }) {
  const t = createAnimatedValue(0);
  t.timing(1, { duration: 300, delay: Math.min(8, props.index) * 40 });
  const y = t.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });
  return (
    <View style={{ height: 200, opacity: t, transform: [{ translateY: y }] }}>
      <Text>{`card ${props.index}`}</Text>
    </View>
  );
}

mount(() => (
  <Scroll style={{ flex: 1 }}>
    {Array.from({ length: 30 }, (_, i) => (
      <Card index={i} />
    ))}
  </Scroll>
));
"#;

/// Sections that slide in by a few points are culled as still ones: the
/// page makes those near the screen, not all of them in its first frames,
/// and the others as it scrolls to them.
#[test]
fn sliding_sections_are_made_as_they_come_near() {
    let (engine, rx) = start_app_culling(SLIDING_CARDS, (px(44.0), px(96.0)), true);
    let mut texts = Vec::new();
    let mut scroll = None;
    // Every batch the start sends, its paced views included.
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(500)) {
        for item in &batch.items {
            match item {
                MountItem::Text { text, .. } => texts.push(text.text.to_string()),
                MountItem::Create {
                    id,
                    kind: nsh_core::ViewKind::Scroll,
                } => scroll = Some(*id),
                _ => {}
            }
        }
    }
    let has = |texts: &[String], t: &str| texts.iter().any(|x| x == t);
    // 844pt of screen and one around it: cards 0 to 8 (8 starts at 1600,
    // 14pt of slide short of 1688), not 9 (1800) and on.
    assert!(has(&texts, "card 0") && has(&texts, "card 8"), "{texts:?}");
    assert!(
        !has(&texts, "card 9") && !has(&texts, "card 29"),
        "{texts:?}"
    );
    // Scrolled to the end, the last cards come.
    engine.control().scroll(
        scroll.expect("the scroll view"),
        nsh_core::geometry::point(Points(0.0), Points(6000.0 - 844.0)),
        0,
    );
    let mut texts = Vec::new();
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(500)) {
        for item in &batch.items {
            if let MountItem::Text { text, .. } = item {
                texts.push(text.text.to_string());
            }
        }
    }
    assert!(has(&texts, "card 29"), "{texts:?}");
}

const MODAL_DISMISS: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";

const open = signal(true);
const status = signal("waiting");

mount(() => (
  <View style={{ flex: 1 }}>
    <Text>{status()}</Text>
    <Dialog open={open()} onCancel={() => open.set(false)} closeOnEscape={false} onClose={() => status.set("dismissed")}>
      <Text>in modal</Text>
    </Dialog>
  </View>
));
"#;

/// An app removes its modal when asked to close it; the platform reports
/// the dismissal once the modal has gone, and the app still hears it.
#[test]
fn removed_modal_hears_its_dismissal() {
    let (engine, rx) = start_app(MODAL_DISMISS);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let modal = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Create {
                id,
                kind: nsh_core::ViewKind::Modal,
                ..
            } => Some(*id),
            _ => None,
        })
        .expect("a modal");
    control.dispatch_event(modal, EventKind::RequestClose, EventPayload::None);
    next(&rx, |b| {
        b.items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { id } if *id == modal))
    });
    control.dispatch_event(modal, EventKind::Dismiss, EventPayload::None);
    let batch = next(&rx, |b| text_id(b, "dismissed").is_some());
    assert!(text_id(&batch, "dismissed").is_some());
}

const REPLACED_WITH_OPEN_DIALOG: &str = r#"import { mount, signal, Text, View } from "nsh";
import { createNavStack, Dialog, NavPage, NavStack } from "nsh/base";

const nav = createNavStack<{ name: string }>([{ name: "list" }]);
const sheet = signal(true);

// Garbage with cycles, so QuickJS collects them.
function churn() {
  for (let i = 0; i < 200000; i++) {
    const a: { b?: unknown } = {};
    a.b = { a };
  }
}

setTimeout(() => {
  nav.setRoutes([{ name: "list" }, { name: "item" }]);
  churn();
  setTimeout(() => churn(), 0);
}, 0);

mount(() => (
  <NavStack state={nav} style={{ flex: 1 }}>
    {(route) =>
      route.name === "list" ? (
        <NavPage title="List">
          <View style={{ flex: 1 }}>
            <Dialog open={sheet()} presentation="pageSheet" onOpenChange={({ open }) => sheet.set(open)}>
              <Text>in the sheet</Text>
            </Dialog>
          </View>
        </NavPage>
      ) : (
        <NavPage title="Item">
          <Text>item</Text>
        </NavPage>
      )
    }
  </NavStack>
));
"#;

/// Routes replaced under a page with an open dialog, then cycles
/// collected: the dialog's dismissal handler is freed once, not again
/// when the engine stops (#1643).
#[test]
fn replacing_a_page_with_an_open_dialog_survives_collection() {
    let (engine, rx) = start_app(REPLACED_WITH_OPEN_DIALOG);
    next(&rx, |b| text_id(b, "item").is_some());
    while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
    drop(engine);
}

const BUILT_ONCE: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Dialog, NavPage, NavStack, createNavStack } from "nsh/base";

const nav = createNavStack<{ name: string }>([{ name: "home" }]);
const built: Record<string, number> = {};
const summary = signal("");
setTimeout(() => summary.set(Object.keys(built).sort().map((k) => `${k} ${built[k]}`).join(", ")), 0);

function Part(props: { name: string }) {
  built[props.name] = (built[props.name] ?? 0) + 1;
  return <Text>{props.name}</Text>;
}

mount(() => (
  <View style={{ flex: 1 }}>
    <NavStack state={nav} style={{ flex: 1 }}>
      {() => (
        <NavPage title="home" headerRight={<Part name="header" />}>
          <Part name="screen" />
        </NavPage>
      )}
    </NavStack>
    <Dialog open={true}>
      <Part name="modal" />
    </Dialog>
    <Text>{summary()}</Text>
  </View>
));
"#;

/// A screen's content, its header's items and a modal's content are built
/// once each: the props a component spreads on its view leave `children`
/// (a getter that builds them) unread.
#[test]
fn screens_and_modals_build_their_content_once() {
    let (_engine, rx) = start_app(BUILT_ONCE);
    let batch = next(&rx, |b| texts(b).iter().any(|t| t.starts_with("header ")));
    let shown = texts(&batch);
    assert!(
        shown.contains(&"header 1, modal 1, screen 1".to_owned()),
        "{shown:?}"
    );
}

const CHILDREN_SIBLINGS: &str = r#"
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function Wrap(props: { children?: any }) {
  return <View>{props.children}</View>;
}

const saved = signal(false);
mount(() => (
  <View>
    <View class="pb-[env(keyboard-inset-height)]">
      <Input testID="a" />
      <If when={saved()}><Text>saved a</Text></If>
    </View>
    <Wrap>
      <Input testID="b" />
      {saved() ? <Text>saved b</Text> : null}
    </Wrap>
    <Wrap>
      <Input testID="c" />
      <Each of={saved() ? ["saved c"] : []}>{(t: string) => <Text>{t}</Text>}</Each>
    </Wrap>
    <Text onPress={() => saved.set(true)}>save</Text>
  </View>
));
"#;

/// A change in one child of a component's children (`<If>`, a ternary,
/// `<Each>`) updates that child alone: its siblings, made by the same
/// `children` getter, stay (an input keeps its text and focus).
#[test]
fn a_changing_child_leaves_its_siblings() {
    let (engine, rx) = start_app(CHILDREN_SIBLINGS);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let save = text_id(&first, "save").expect("the save text");
    engine
        .control()
        .dispatch_event(save, EventKind::Press, EventPayload::None);
    let batch = next(&rx, |b| texts(b).iter().any(|t| t.starts_with("saved")));
    let shown = texts(&batch);
    for text in ["saved a", "saved b", "saved c"] {
        assert!(shown.contains(&text.to_owned()), "{shown:?}");
    }
    let remade: Vec<&MountItem> = batch
        .items
        .iter()
        .filter(|i| {
            matches!(
                i,
                MountItem::Create {
                    kind: nsh_core::ViewKind::Input,
                    ..
                } | MountItem::Remove { .. }
                    | MountItem::Delete { .. }
            )
        })
        .collect();
    assert!(remade.is_empty(), "{remade:#?}");
}

const CHILDREN_BESIDE_A_BRANCH: &str = r#"
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

const open = signal(true);
function Card(props: { children?: any }) {
  return (
    <View>
      {open() ? <Text>open</Text> : <Text>closed</Text>}
      {props.children}
    </View>
  );
}

const saved = signal(false);
mount(() => (
  <View>
    <Card>
      {open() ? <Input testID="a" /> : null}
      {saved() ? <Text>saved</Text> : null}
    </Card>
    <Text onPress={() => saved.set(true)}>save</Text>
  </View>
));
"#;

/// The same when the component shows its children beside a branch of its
/// own (`{cond ? a : b}{props.children}`): each of the children's
/// functions keeps a memo of its own, so `saved` changing runs only the
/// child that reads it, and the input beside it is not made again.
#[test]
fn children_beside_a_branch_leave_their_siblings() {
    let (engine, rx) = start_app(CHILDREN_BESIDE_A_BRANCH);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let save = text_id(&first, "save").expect("the save text");
    engine
        .control()
        .dispatch_event(save, EventKind::Press, EventPayload::None);
    let batch = next(&rx, |b| texts(b).iter().any(|t| t == "saved"));
    let remade: Vec<&MountItem> = batch
        .items
        .iter()
        .filter(|i| {
            matches!(
                i,
                MountItem::Create {
                    kind: nsh_core::ViewKind::Input,
                    ..
                } | MountItem::Remove { .. }
                    | MountItem::Delete { .. }
            )
        })
        .collect();
    assert!(remade.is_empty(), "{remade:#?}");
}

const IF_ELSE_EXPRESSION: &str = r#"
import { mount, signal, Text, View } from "nsh";

const shown = signal(false);
const label = signal("first label");
mount(() => (
  <View>
    <Text>
      <If when={shown()} else={label()}>shown</If>
    </Text>
    <Text onPress={() => label.set("second label")}>change</Text>
  </View>
));
"#;

/// `<If>`'s `else` that is an expression, not an element, follows what it
/// reads, as the same expression among the children does.
#[test]
fn an_if_else_expression_follows_its_reads() {
    let (engine, rx) = start_app(IF_ELSE_EXPRESSION);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(
        texts(&first).contains(&"first label".to_owned()),
        "{:?}",
        texts(&first)
    );
    let change = text_id(&first, "change").expect("the change text");
    engine
        .control()
        .dispatch_event(change, EventKind::Press, EventPayload::None);
    next(&rx, |b| texts(b).iter().any(|t| t == "second label"));
}

const BRANCH_EXPRESSION: &str = r#"
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

const wide = signal(true);
const saved = signal(false);
mount(() => (
  <View>
    <If when={wide()}>
      {(() => <Input testID="a" />)()}
    </If>
    {saved() ? <Text>saved</Text> : null}
    <Text onPress={() => saved.set(true)}>save</Text>
  </View>
));
"#;

/// An `<If>` whose branch is an expression (a function the branch returns)
/// keeps its nodes when a sibling changes: the expression runs in its
/// item's memo, not again in the effect of the whole array (issue #171: a
/// page's cards made again, and their enter animation replayed, when a
/// dialog beside them opened).
#[test]
fn a_branch_expression_stays_when_a_sibling_changes() {
    let (engine, rx) = start_app(BRANCH_EXPRESSION);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let save = text_id(&first, "save").expect("the save text");
    engine
        .control()
        .dispatch_event(save, EventKind::Press, EventPayload::None);
    let batch = next(&rx, |b| texts(b).iter().any(|t| t == "saved"));
    let remade: Vec<&MountItem> = batch
        .items
        .iter()
        .filter(|i| {
            matches!(
                i,
                MountItem::Create {
                    kind: nsh_core::ViewKind::Input,
                    ..
                } | MountItem::Remove { .. }
                    | MountItem::Delete { .. }
            )
        })
        .collect();
    assert!(remade.is_empty(), "{remade:#?}");
}

const NESTED_CHILDREN: &str = r#"
import { mount, signal, Text, View } from "nsh";

function Wrap(props: { children?: any }) {
  return <View>{props.children}</View>;
}

const list = signal(true);
const extra = signal(false);
mount(() => (
  <View>
    <Wrap>
      {list()
        ? [<Text>first</Text>, <If when={extra()}><Text>extra</Text></If>]
        : <Text>other</Text>}
    </Wrap>
    <Text onPress={() => extra.set(!extra())}>extra?</Text>
    <Text onPress={() => list.set(!list())}>list?</Text>
  </View>
));
"#;

/// An insert whose value changes (the getter reads `list`) makes its items'
/// effect again, for the new value: the one of the old value no longer
/// shows anything.
#[test]
fn a_new_value_replaces_the_effect_of_its_items() {
    let (engine, rx) = start_app(NESTED_CHILDREN);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let (extra, list) = (
        text_id(&first, "extra?").expect("extra?"),
        text_id(&first, "list?").expect("list?"),
    );
    let press = |id| control.dispatch_event(id, EventKind::Press, EventPayload::None);
    press(extra);
    let batch = next(&rx, |b| texts(b).contains(&"extra".to_owned()));
    assert!(!texts(&batch).contains(&"first".to_owned()), "first stays");
    press(list);
    let batch = next(&rx, |b| texts(b).contains(&"other".to_owned()));
    let removed = batch
        .items
        .iter()
        .filter(|i| matches!(i, MountItem::Remove { .. }))
        .count();
    assert_eq!(removed, 2, "{:#?}", batch.items);
    // The old value's `<If>` shows nothing any more, in any batch until the
    // new value is shown again.
    press(extra);
    press(list);
    loop {
        let batch = rx.recv_timeout(Duration::from_secs(5)).expect("a batch");
        let shown = texts(&batch);
        assert!(!shown.contains(&"extra".to_owned()), "{shown:?}");
        if shown.contains(&"first".to_owned()) {
            break;
        }
    }
}

const IF_VALUE: &str = r#"
import { mount, signal, Text, View } from "nsh";

const user = signal<{ name: string } | null>(null);
mount(() => (
  <View>
    <If when={user()} else={<Text>signed out</Text>}>
      {(u) => <Text>{`hello ${u().name}`}</Text>}
    </If>
    <Text onPress={() => user.set({ name: user()?.name === "Ada" ? "Grace" : "Ada" })}>next</Text>
    <Text onPress={() => user.set(null)}>out</Text>
  </View>
));
"#;

/// An `<If>`'s function child gets an accessor of `when`: the branch is
/// made when it turns truthy, follows its value in place while it stays
/// so, and goes when it turns falsy.
#[test]
fn an_if_hands_its_function_child_the_value() {
    let (engine, rx) = start_app(IF_VALUE);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    assert!(texts(&first).contains(&"signed out".to_owned()));
    let (next_id, out) = (
        text_id(&first, "next").expect("next"),
        text_id(&first, "out").expect("out"),
    );
    let press = |id| control.dispatch_event(id, EventKind::Press, EventPayload::None);
    press(next_id);
    let batch = next(&rx, |b| texts(b).contains(&"hello Ada".to_owned()));
    let hello = text_id(&batch, "hello Ada").expect("the branch's text");
    press(next_id);
    let batch = next(&rx, |b| texts(b).contains(&"hello Grace".to_owned()));
    // The same text, updated: the branch stayed.
    assert_eq!(text_id(&batch, "hello Grace"), Some(hello));
    assert!(
        !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Create { .. })),
        "{:#?}",
        batch.items
    );
    press(out);
    next(&rx, |b| texts(b).contains(&"signed out".to_owned()));
}

const REFS: &str = r#"
import { mount, signal, Text, View, type InputRef, type ViewRef } from "nsh";
import { Input } from "nsh/base";
import { Stepper, type StepperRef } from "test/ui";

function Field(props: { ref?: (node: InputRef) => void }) {
  return <Input ref={props.ref} />;
}

let assigned: ViewRef | undefined;
const held = signal<InputRef | undefined>(undefined);
const fields: { input?: InputRef; [key: string]: InputRef | undefined } = {};
const key = () => "computed";
let called: ViewRef | undefined;
let forwarded: InputRef | undefined;
const stepper = signal<StepperRef | undefined>(undefined);
const report = signal("");

mount(() => (
  <View>
    <View ref={assigned} />
    <Input ref={held} />
    <Input ref={fields.input} />
    <Input ref={fields[key()]} />
    <View ref={(n) => (called = n)} />
    <Field ref={forwarded!} />
    <Stepper ref={stepper} />
    <Text onPress={() => report.set([assigned, held(), fields.input, fields.computed, called, forwarded, stepper()]
      .map((r) => (r ? "set" : "unset")).join(" "))}>check</Text>
    <Text>{report()}</Text>
  </View>
));
"#;

/// Every kind of ref target gets the element (or the component's ref): a
/// `let` variable and fields are assigned, a signal set, a function
/// called, also through a TS component and on a Rust component.
#[test]
fn refs_reach_variables_signals_fields_and_functions() {
    let (engine, rx) = start_app(REFS);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let check = text_id(&first, "check").expect("the check text");
    engine
        .control()
        .dispatch_event(check, EventKind::Press, EventPayload::None);
    let batch = next(&rx, |b| texts(b).iter().any(|t| t.contains("set")));
    assert!(
        texts(&batch).contains(&"set set set set set set set".to_owned()),
        "{:?}",
        texts(&batch)
    );
}

const CONTENT_SIZE: &str = r#"
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

const size = signal("none");
mount(() => (
  <View>
    <Input
      placeholder="A much longer placeholder"
      style={{ width: 300, height: 40 }}
      onContentSizeChange={({ size: e }) => size.set(`${e.width}x${e.height}`)}
    />
    <Text>{`size ${size()}`}</Text>
  </View>
));
"#;

/// A fixed-size input reports the size of its text as the user types (its
/// own frame never changes), and an empty one the size of an empty line,
/// not its placeholder's.
#[test]
fn inputs_report_their_text_size_as_it_changes() {
    let (engine, rx) = start_app(CONTENT_SIZE);
    let mut input = None;
    let mut size = String::new();
    // The batches until the size shown is not `last`.
    let mut wait = |last: &str| {
        loop {
            let batch = rx.recv_timeout(Duration::from_secs(5)).expect("a batch");
            for item in &batch.items {
                match item {
                    MountItem::Create {
                        id,
                        kind: nsh_core::ViewKind::Input,
                    } => input = Some(*id),
                    MountItem::Text { text, .. } if text.text.starts_with("size ") => {
                        size = text.text.clone();
                    }
                    _ => {}
                }
            }
            if size != last && size != "size none" && !size.is_empty() {
                return (input.expect("an input"), size.clone());
            }
        }
    };
    let (input, empty) = wait("");
    // An empty line (ApproxTextEngine gives its zero-width space a width).
    assert_eq!(empty, "size 8x17");
    let control = engine.control();
    let mut last = empty;
    for (count, (text, want)) in [
        ("ab", "size 16x17"),
        ("abc", "size 24x17"),
        ("", "size 8x17"),
    ]
    .into_iter()
    .enumerate()
    {
        control.dispatch_event(
            input,
            EventKind::ChangeText,
            EventPayload::Text {
                text: text.into(),
                count: count as u32 + 1,
            },
        );
        last = wait(&last).1;
        assert_eq!(last, want, "after {text:?}");
    }
}

const SAME_ROUTE_TWICE: &str = r#"import { mount, Text, View } from "nsh";
import { NavPage, NavStack, createNavStack } from "nsh/base";

const nav = createNavStack(["home"]);

mount(() => (
  <View style={{ flex: 1 }}>
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route, index) => (
        <NavPage title={`${route} ${index()}`}>
          <Text onPress={() => nav.push("detail")}>{`push from ${index()}`}</Text>
          <Text>{`depth ${nav.routes().length}`}</Text>
        </NavPage>
      )}
    </NavStack>
  </View>
));
"#;

/// A route pushed twice is two screens: the user popping the top one
/// natively removes that one only.
#[test]
fn a_route_pushed_twice_is_two_screens() {
    let (engine, rx) = start_app(SAME_ROUTE_TWICE);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let push = text_id(&first, "push from 0").unwrap();
    control.dispatch_event(push, EventKind::Press, EventPayload::None);
    let batch = next(&rx, |b| !titles(b).is_empty());
    assert_eq!(
        titles(&batch).last().map(|t| t.1.as_str()),
        Some("detail 1")
    );
    while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
    control.dispatch_event(push, EventKind::Press, EventPayload::None);
    let batch = next(&rx, |b| !titles(b).is_empty());
    let top = titles(&batch);
    assert_eq!(
        top.last().map(|t| t.1.as_str()),
        Some("detail 2"),
        "{top:?}"
    );
    let top_screen = top[0].0;
    while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
    // The user pops the top "detail": the other one stays.
    control.dispatch_event(top_screen, EventKind::Dismiss, EventPayload::None);
    let batch = next(&rx, |b| texts(b).iter().any(|t| t.starts_with("depth ")));
    assert!(
        texts(&batch).contains(&"depth 2".to_owned()),
        "{:?}",
        texts(&batch)
    );
}

const DIALOG_EVENTS: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";

const log = signal<string[]>([]);
const add = (s: string) => log.update((l) => [...l, s]);
const open = signal(true);
const swipe = signal(true);

mount(() => (
  <View style={{ flex: 1 }}>
    <Text>{`log ${log().join(",")}`}</Text>
    <Text onPress={() => { swipe.set(false); open.set(true); }}>again</Text>
    <Dialog
      open={open()}
      presentation="pageSheet"
      animation="fade"
      closeOnSwipe={swipe()}
      closeOnBackdropPress={false}
      backdropClass="bg-black/50"
      onOpen={() => add("open")}
      onCancel={() => add("cancel")}
      onOpenChange={({ open: o, reason }) => { add(`change ${o} ${reason}`); open.set(o); }}
    >
      <Text>in dialog</Text>
    </Dialog>
  </View>
));
"#;

fn modal_of(batch: &MountBatch) -> Option<u32> {
    batch.items.iter().find_map(|i| match i {
        MountItem::Create {
            id,
            kind: nsh_core::ViewKind::Modal,
            ..
        } => Some(*id),
        _ => None,
    })
}

fn log_of(batch: &MountBatch) -> Option<String> {
    texts(batch).into_iter().find(|t| t.starts_with("log "))
}

/// A dialog reports the user's attempts (`onCancel`) and, when its
/// `closeOn*` flag let it close natively, `onOpenChange(false, reason)`.
#[test]
fn dialogs_report_cancels_and_closes_with_their_reason() {
    let (engine, rx) = start_app(DIALOG_EVENTS);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let modal = modal_of(&first).expect("a dialog");
    let config = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::ModalConfig { id, config } if *id == modal => Some(config.clone()),
            _ => None,
        })
        .expect("its config");
    assert!(config.close_on_escape && config.close_on_swipe);
    assert!(!config.close_on_backdrop_press);
    assert_eq!(config.presentation, nsh_core::ModalPresentation::PageSheet);
    assert_eq!(config.animation, nsh_core::ModalAnimation::Fade);
    // The backdrop part: a view of the dialog with the app's classes.
    let backdrop = backdrop_of(&first, modal).expect("a backdrop");
    control.dispatch_event(modal, EventKind::Show, EventPayload::None);
    next(&rx, |b| log_of(b).as_deref() == Some("log open"));
    let reason =
        |r: &str| EventPayload::Map(vec![("reason", nsh_core::PayloadValue::Str(r.to_owned()))]);
    // A backdrop press: its flag is false, it only asks.
    control.dispatch_event(backdrop, EventKind::Press, EventPayload::None);
    next(&rx, |b| log_of(b).as_deref() == Some("log open,cancel"));
    // A swipe closes it.
    control.dispatch_event(modal, EventKind::RequestClose, reason("swipe"));
    next(&rx, |b| {
        log_of(b).as_deref() == Some("log open,cancel,cancel,change false swipe")
    });
    // Open again without swiping: no reason is Escape's.
    let again = text_id(&first, "again").unwrap();
    control.dispatch_event(again, EventKind::Press, EventPayload::None);
    let batch = next(&rx, |b| modal_of(b).is_some());
    let modal = modal_of(&batch).unwrap();
    control.dispatch_event(modal, EventKind::RequestClose, reason("swipe"));
    next(&rx, |b| {
        log_of(b).as_deref() == Some("log open,cancel,cancel,change false swipe,cancel")
    });
    control.dispatch_event(modal, EventKind::RequestClose, EventPayload::None);
    next(&rx, |b| {
        log_of(b).is_some_and(|l| l.ends_with(",cancel,cancel,change false cancel"))
    });
}

const SHEET_DETENTS: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";

const log = signal<string[]>([]);

mount(() => (
  <View style={{ flex: 1 }}>
    <Text>{`log ${log().join(",")}`}</Text>
    <Dialog
      presentation="pageSheet"
      detents={["medium", { height: 200 }, { fraction: 0.4 }, "bogus", { fraction: 3 }, { height: -1 }, { height: NaN }] as any}
      detent="medium"
      defaultDetent="large"
      grabber
      largestUndimmedDetent={{ fraction: 0.4 }}
      onDetentChange={({ detent }) => log.update((l) => [...l, JSON.stringify(detent)])}
    >
      <Text>in sheet</Text>
    </Dialog>
  </View>
));
"#;

/// A dialog's sheet options reach the platform from TSX as the core's
/// `SheetDetent`s, detents that are not one left out; the platform's
/// `DetentChange` payload reaches the app as the same JS value.
#[test]
fn sheet_detents_reach_the_platform_and_the_users_moves_the_app() {
    use nsh_core::{SheetDetent, geometry::Percentage};
    let (engine, rx) = start_app(SHEET_DETENTS);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let modal = modal_of(&first).expect("a dialog");
    let config = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::ModalConfig { id, config } if *id == modal => Some(config.clone()),
            _ => None,
        })
        .expect("its config");
    assert_eq!(
        config.detents,
        vec![
            SheetDetent::Medium,
            SheetDetent::Height(Points(200.0)),
            SheetDetent::Fraction(Percentage(0.4)),
        ]
    );
    assert_eq!(config.detent, Some(SheetDetent::Medium));
    assert_eq!(config.default_detent, Some(SheetDetent::Large));
    assert!(config.grabber);
    assert_eq!(
        config.largest_undimmed_detent,
        Some(SheetDetent::Fraction(Percentage(0.4)))
    );
    control.dispatch_event(
        modal,
        EventKind::DetentChange,
        SheetDetent::Height(Points(200.0)).change_payload(),
    );
    next(&rx, |b| {
        log_of(b).as_deref() == Some(r#"log {"height":200}"#)
    });
    control.dispatch_event(
        modal,
        EventKind::DetentChange,
        SheetDetent::Large.change_payload(),
    );
    next(&rx, |b| {
        log_of(b).as_deref() == Some(r#"log {"height":200},"large""#)
    });
}

/// The children `Insert`ed into `parent`, in order.
fn children_of(batch: &MountBatch, parent: u32) -> Vec<u32> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Insert {
                parent: p, child, ..
            } if *p == parent => Some(*child),
            _ => None,
        })
        .collect()
}

/// The view of dialog `modal` with a translucent black background: its
/// backdrop (`bg-black/50`).
fn backdrop_of(batch: &MountBatch, modal: u32) -> Option<u32> {
    let black = nsh_core::Color::parse("#00000080").unwrap();
    children_of(batch, modal).into_iter().find(|&c| {
        batch.items.iter().any(|i| {
            matches!(i, MountItem::ViewStyle { id, style } if *id == c && style.background_color == black)
        })
    })
}

const DIALOG_PARTS: &str = r##"import { mount, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";

const open = signal(true);
const backdrop = signal(false);
const log = signal<string[]>([]);
const add = (s: string) => log.update((l) => [...l, s]);

mount(() => (
  <View style={{ flex: 1 }}>
    <Text>{`log ${log().join(",")}`}</Text>
    <Text onPress={() => backdrop.set(true)}>backdrop</Text>
    <Text onPress={() => { open.set(false); open.set(true); }}>reopen</Text>
    <Text onPress={() => { open.set(false); }}>close</Text>
    <Dialog
      open={open()}
      class="bg-white p-4"
      backdropStyle={backdrop() ? { backgroundColor: "#00000080" } : undefined}
      onCancel={() => add("cancel")}
      onOpenChange={({ open: o, reason }) => add(`change ${o} ${reason}`)}
      onClose={() => add("close")}
    >
      <Text>in dialog</Text>
    </Dialog>
  </View>
));
"##;

/// A dialog renders the app's popup, and a backdrop only while the app
/// styles one; a press on it closes the dialog even when the app keeps
/// `open` true, until `open` goes from false to true.
#[test]
fn dialogs_render_their_parts_and_close_from_the_backdrop() {
    let (engine, rx) = start_app(DIALOG_PARTS);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let modal = modal_of(&first).expect("a dialog");
    // Only the popup, styled with the dialog's classes; the dialog itself
    // has no style.
    let parts = children_of(&first, modal);
    assert_eq!(parts.len(), 1, "{:?}", first.items);
    let white = nsh_core::Color::parse("#ffffff").unwrap();
    assert!(first.items.iter().any(|i| matches!(
        i,
        MountItem::ViewStyle { id, style } if *id == parts[0] && style.background_color == white
    )));
    assert!(
        !first
            .items
            .iter()
            .any(|i| matches!(i, MountItem::ViewStyle { id, .. } if *id == modal))
    );
    // A backdrop once the app styles one, behind the popup.
    let press = |batch: &MountBatch, label: &str| {
        control.dispatch_event(
            text_id(batch, label).unwrap(),
            EventKind::Press,
            EventPayload::None,
        )
    };
    press(&first, "backdrop");
    let batch = next(&rx, |b| backdrop_of(b, modal).is_some());
    let backdrop = backdrop_of(&batch, modal).unwrap();
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Insert { parent, child, before: Some(b) } if *parent == modal && *child == backdrop && *b == parts[0]
    )));
    // Pressing it closes the dialog although `open` stays true.
    control.dispatch_event(backdrop, EventKind::Press, EventPayload::None);
    let batch = next(&rx, |b| {
        b.items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { id } if *id == modal))
    });
    assert_eq!(
        log_of(&batch).as_deref(),
        Some("log cancel,change false backdropPress")
    );
    // The platform reports it gone.
    control.dispatch_event(modal, EventKind::Dismiss, EventPayload::None);
    next(&rx, |b| log_of(b).is_some_and(|l| l.ends_with(",close")));
    // `open` from false to true shows it again.
    press(&first, "close");
    while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
    press(&first, "reopen");
    let batch = next(&rx, |b| modal_of(b).is_some());
    assert!(text_id(&batch, "in dialog").is_some());
}

const PAGE_EVENTS: &str = r##"import { mount, signal, Text, View } from "nsh";
import { NavPage, NavStack, createNavStack } from "nsh/base";

const nav = createNavStack(["home", "edit"]);
const log = signal<string[]>([]);

mount(() => (
  <View style={{ flex: 1 }}>
    <Text>{`log ${log().join(",")}`}</Text>
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage
          title={route}
          popOnBack={route !== "edit"}
          popOnSwipe={false}
          animation="fade"
          headerStyle={{ backgroundColor: "#ff0000", color: "#00ff00" }}
          headerClass="bg-white tint-blue-500"
          header={<Text>bar</Text>}
          onBackPress={() => log.update((l) => [...l, `back ${route}`])}
          onDismiss={() => log.update((l) => [...l, `pop ${route}`])}
        >
          <Text>{`depth ${nav.routes().length}`}</Text>
        </NavPage>
      )}
    </NavStack>
  </View>
));
"##;

/// A page whose `popOnBack` is false stays: its back presses call
/// `onBackPress`; a native pop calls `onDismiss` after its route went.
#[test]
fn pages_keep_or_pop_by_their_flags() {
    let (engine, rx) = start_app(PAGE_EVENTS);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let configs: Vec<(u32, nsh_core::ScreenConfig)> = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::ScreenConfig { id, config } => Some((*id, (**config).clone())),
            _ => None,
        })
        .collect();
    let config = |title: &str| {
        configs
            .iter()
            .rev()
            .find(|(_, c)| c.title.as_deref() == Some(title))
            .cloned()
            .unwrap_or_else(|| panic!("{title}: {configs:?}"))
    };
    let (edit, edit_config) = config("edit");
    let (home, home_config) = config("home");
    assert!(edit_config.prevent_back && !home_config.prevent_back);
    assert!(!edit_config.gesture_enabled);
    assert_eq!(edit_config.animation, nsh_core::ScreenAnimation::Fade);
    // `headerStyle` wins over `headerClass`, key by key.
    assert_eq!(
        edit_config.background_color,
        nsh_core::Color::parse("#ff0000")
    );
    assert_eq!(edit_config.title_color, nsh_core::Color::parse("#00ff00"));
    assert!(edit_config.tint_color.is_some());
    assert!(edit_config.header_view.is_some());
    // Every page listening to `onBackPress` reports back presses, and
    // only those listen.
    let listens = |id: u32| {
        first.items.iter().any(|i| {
            matches!(i, MountItem::Events { id: v, events } if *v == id && events.contains(EventKind::BackRequest))
        })
    };
    assert!(listens(edit) && listens(home));
    control.dispatch_event(edit, EventKind::BackRequest, EventPayload::None);
    next(&rx, |b| log_of(b).as_deref() == Some("log back edit"));
    // A page that pops on back hears its back presses too.
    control.dispatch_event(home, EventKind::BackRequest, EventPayload::None);
    next(&rx, |b| {
        log_of(b).as_deref() == Some("log back edit,back home")
    });
    control.dispatch_event(edit, EventKind::Dismiss, EventPayload::None);
    let batch = next(&rx, |b| log_of(b).is_some_and(|l| l.ends_with("pop edit")));
    assert!(
        texts(&batch).contains(&"depth 1".to_owned()),
        "{:?}",
        texts(&batch)
    );
}

const PAGE_HEADER_ITEMS: &str = r##"import { mount, signal, Text, View } from "nsh";
import { NavPage, NavStack, createNavStack } from "nsh/base";

const nav = createNavStack(["home"]);
const log = signal<string[]>([]);
const filter = signal("all");
const suspended = signal(false);

mount(() => (
  <View style={{ flex: 1 }}>
    <Text>{`log ${log().join(",")}`}</Text>
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage
          title={route}
          headerRight={<Text>fallback</Text>}
          ios={{
            headerRightItems: [
              {
                key: "edit",
                systemItem: "edit",
                onPress: () => log.update((l) => [...l, "press edit"]),
              },
              {
                key: "more",
                symbol: "ellipsis.circle",
                menu: [
                  {
                    label: suspended() ? "Reinstate" : "Suspend",
                    onSelect: () => {
                      suspended.set(!suspended());
                      log.update((l) => [...l, suspended() ? "menu suspend" : "menu reinstate"]);
                    },
                  },
                  {
                    label: "Open",
                    checked: filter() === "open",
                    onSelect: () => {
                      filter.set("open");
                      log.update((l) => [...l, "menu open"]);
                    },
                  },
                ],
              },
              { key: "add", systemItem: "add", onPress: () => log.update((l) => [...l, "press add"]) },
            ],
          }}
        >
          <Text>{`filter ${filter()}`}</Text>
          <Text>{`suspended ${suspended()}`}</Text>
        </NavPage>
      )}
    </NavStack>
  </View>
));
"##;

/// Trailing `ios.headerRightItems` reach the platform in the screen's
/// config; presses and menu selections report the root's `Menu` event
/// with the items' ids. Re-binding (same keys) assigns new ids; stale
/// ones no longer run.
#[test]
fn pages_report_trailing_header_item_presses_and_menu_selections() {
    let (engine, rx) = start_app(PAGE_HEADER_ITEMS);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let config = first
        .items
        .iter()
        .rev()
        .find_map(|i| match i {
            MountItem::ScreenConfig { config, .. } => Some((**config).clone()),
            _ => None,
        })
        .expect("a page");
    assert_eq!(config.right_items.len(), 3);
    assert_eq!(
        config.right_items[0].content,
        nsh_core::HeaderItemContent::SystemItem(nsh_core::HeaderSystemItem::Edit)
    );
    assert!(config.right_items[0].press_id != 0);
    assert_eq!(
        config.right_items[1].content,
        nsh_core::HeaderItemContent::Symbol("ellipsis.circle".into())
    );
    let menu = config.right_items[1].menu.as_ref().expect("more menu");
    assert_eq!(menu.len(), 2);
    let suspend_id = match &menu[0] {
        nsh_core::desktop::MenuItem::Action(action) => {
            assert_eq!(action.label, "Suspend");
            assert!(action.id != 0);
            action.id
        }
        other => panic!("expected an action, got {other:?}"),
    };
    let edit_id = config.right_items[0].press_id;
    control.dispatch_event(
        nsh_core::ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![("id", nsh_core::PayloadValue::Number(edit_id as f64))]),
    );
    next(&rx, |b| log_of(b).as_deref() == Some("log press edit"));
    control.dispatch_event(
        nsh_core::ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![(
            "id",
            nsh_core::PayloadValue::Number(suspend_id as f64),
        )]),
    );
    let batch = next(&rx, |b| {
        log_of(b).as_deref() == Some("log press edit,menu suspend")
    });
    assert!(
        texts(&batch).contains(&"suspended true".to_owned()),
        "{:?}",
        texts(&batch)
    );
    let updated = batch
        .items
        .iter()
        .rev()
        .find_map(|i| match i {
            MountItem::ScreenConfig { config, .. } => Some((**config).clone()),
            _ => None,
        })
        .expect("updated page");
    assert!(
        nsh_core::element::header::same_right_buttons(&config.right_items, &updated.right_items),
        "same keys keep the UIBarButtonItems"
    );
    let new_edit_id = updated.right_items[0].press_id;
    let reinstate_id = match &updated.right_items[1].menu.as_ref().unwrap()[0] {
        nsh_core::desktop::MenuItem::Action(action) => {
            assert_eq!(action.label, "Reinstate");
            action.id
        }
        other => panic!("expected an action, got {other:?}"),
    };
    assert_ne!(new_edit_id, edit_id);
    assert_ne!(reinstate_id, suspend_id);
    // Stale ids from the previous binding do nothing.
    control.dispatch_event(
        nsh_core::ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![("id", nsh_core::PayloadValue::Number(edit_id as f64))]),
    );
    assert!(rx.try_recv().is_err(), "stale edit id must not run");
    // The current binding's press id still runs (what a kept UIKit target
    // must report after update_right_item refreshes press_id).
    control.dispatch_event(
        nsh_core::ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![(
            "id",
            nsh_core::PayloadValue::Number(new_edit_id as f64),
        )]),
    );
    next(&rx, |b| {
        log_of(b).as_deref() == Some("log press edit,menu suspend,press edit")
    });
    control.dispatch_event(
        nsh_core::ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![(
            "id",
            nsh_core::PayloadValue::Number(reinstate_id as f64),
        )]),
    );
    let batch = next(&rx, |b| {
        log_of(b).as_deref() == Some("log press edit,menu suspend,press edit,menu reinstate")
    });
    assert!(
        texts(&batch).contains(&"suspended false".to_owned()),
        "{:?}",
        texts(&batch)
    );
}

const SELECTION_MENU: &str = r##"import { mount, signal, Text, View } from "nsh";

const log = signal<string[]>([]);
const label = signal("Highlight");

mount(() => (
  <View style={{ flex: 1 }}>
    <Text>{`log ${log().join(",")}`}</Text>
    <View
      selectable
      selectionMenu={[
        { label: label(), onSelect: () => { log.update((l) => [...l, label()]); label.set("Unhighlight"); } },
        { type: "separator" },
        { label: "Define", disabled: true },
      ]}
    >
      <Text>Some words</Text>
    </View>
  </View>
));
"##;

/// The items of a selectable view's `selectionMenu` reach its view props;
/// a chosen item's `onSelect` runs when the platform reports its id as the
/// root's `Menu` event, and items set again get new ids (stale ones do
/// nothing).
#[test]
fn selection_menu_items_run_when_chosen() {
    use nsh_core::desktop::MenuItem;

    let (engine, rx) = start_app(SELECTION_MENU);
    let control = engine.control();
    let menu_of = |batch: &MountBatch| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::ViewProps { props, .. } if props.selectable_view => {
                Some(props.selection_menu.clone())
            }
            _ => None,
        })
    };
    let first = next(&rx, |b| menu_of(b).is_some());
    let menu = menu_of(&first).unwrap();
    let [
        MenuItem::Action(highlight),
        MenuItem::Separator,
        MenuItem::Action(define),
    ] = &menu[..]
    else {
        panic!("two items and a separator: {menu:?}");
    };
    assert_eq!(highlight.label, "Highlight");
    assert!(highlight.id != 0);
    assert_eq!(define.label, "Define");
    assert!(!define.enabled);
    let choose = |id: u32| {
        control.dispatch_event(
            nsh_core::ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![("id", nsh_core::PayloadValue::Number(id as f64))]),
        );
    };
    choose(highlight.id);
    let batch = next(&rx, |b| menu_of(b).is_some());
    let updated = menu_of(&batch).unwrap();
    let MenuItem::Action(unhighlight) = &updated[0] else {
        panic!("an action: {updated:?}");
    };
    assert_eq!(unhighlight.label, "Unhighlight");
    assert_ne!(unhighlight.id, highlight.id);
    let mut seen = log_of(&batch);
    while seen.as_deref() != Some("log Highlight") {
        seen = log_of(&next(&rx, |b| log_of(b).is_some()));
    }
    // The old id does nothing.
    choose(highlight.id);
    assert!(
        rx.recv_timeout(std::time::Duration::from_millis(300))
            .is_err()
    );
    choose(unhighlight.id);
    next(&rx, |b| {
        log_of(b).as_deref() == Some("log Highlight,Unhighlight")
    });
}

const PAGE_HEADER: &str = r#"import { mount, Text, View } from "nsh";
import { NavPage, NavStack, createNavStack } from "nsh/base";

const nav = createNavStack(["home"]);

mount(() => (
  <View style={{ flex: 1 }}>
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage title={route} headerRight={<Text>right</Text>} header={<View testID="bar" style={{ height: 60 }}><Text>bar</Text></View>}>
          <View testID="content" style={{ height: 10 }} />
        </NavPage>
      )}
    </NavStack>
  </View>
));
"#;

fn frame_of(batch: &MountBatch, id: u32) -> Option<nsh_core::Bounds<Points>> {
    batch.items.iter().rev().find_map(|i| match i {
        MountItem::Frame { id: v, frame } if *v == id => Some(*frame),
        _ => None,
    })
}

fn screen_config_of(batch: &MountBatch) -> Option<(u32, nsh_core::ScreenConfig)> {
    batch.items.iter().rev().find_map(|i| match i {
        MountItem::ScreenConfig { id, config } => Some((*id, (**config).clone())),
        _ => None,
    })
}

/// Without a native header (desktops, the web), a page's `header` sits at
/// its top, as wide as the page and as tall as it lays out, and the content
/// starts below it; with one, the content starts below the native bar.
#[test]
fn pages_place_their_header_without_a_native_one() {
    let (_engine, rx) = start_app_with(PAGE_HEADER, nsh_core::NO_NATIVE_HEADER);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let (screen, config) = screen_config_of(&first).expect("a page");
    let header = config.header_view.expect("its header");
    let frame = frame_of(&first, header).expect("the header's frame");
    assert_eq!(
        (
            frame.origin.x,
            frame.origin.y,
            frame.size.width,
            frame.size.height
        ),
        (px(0.0), px(0.0), px(390.0), px(60.0))
    );
    assert_eq!(config.header_height, px(60.0));
    let content = children_of(&first, screen)
        .into_iter()
        .filter(|&c| Some(c) != config.header_view && Some(c) != config.right)
        .find(|&c| frame_of(&first, c).is_some_and(|f| f.size.height == px(10.0)))
        .expect("the content");
    assert_eq!(frame_of(&first, content).unwrap().origin.y, px(60.0));

    let (_engine, rx) = start_app(PAGE_HEADER);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let (_, config) = screen_config_of(&first).expect("a page");
    assert_eq!(config.header_height, px(44.0));
}

const INPUT_AND_LIST: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { List } from "nsh";

const items = signal<number[]>([]);
const log = signal("log");

mount(() => (
  <View style={{ flex: 1 }}>
    <Text>{log()}</Text>
    <Input
      testID="field"
      onChange={({ value: text }) => log.set(`change ${text}`)}
      onSubmit={(e) => log.set(`submit ${e.text}`)}
    />
    <Text onPress={() => items.set([1, 2])}>fill</Text>
    <List
      each={items()}
      style={{ flex: 1 }}
      contentStyle={{ padding: 8 }}
      header={() => <Text>head</Text>}
      empty={() => <Text>nothing</Text>}
      separator={() => <Text>sep</Text>}
    >
      {(item) => <Text>{`row ${item()}`}</Text>}
    </List>
  </View>
));
"#;

/// An input reports edits with `onChange` and the return key with
/// `onSubmit`; a list renders its `header`, `empty` and `separator`.
#[test]
fn inputs_and_list_slots() {
    let (engine, rx) = start_app(INPUT_AND_LIST);
    let control = engine.control();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let mut seen = texts(&first);
    while let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
        seen.extend(texts(&b));
    }
    assert!(seen.contains(&"head".to_owned()), "{seen:?}");
    assert!(seen.contains(&"nothing".to_owned()), "{seen:?}");
    let input = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Input { id, .. } => Some(*id),
            _ => None,
        })
        .expect("an input");
    control.dispatch_event(
        input,
        EventKind::ChangeText,
        EventPayload::Text {
            text: "hi".into(),
            count: 1,
        },
    );
    next(&rx, |b| text_id(b, "change hi").is_some());
    control.dispatch_event(
        input,
        EventKind::SubmitEditing,
        EventPayload::Text {
            text: "hi".into(),
            count: 1,
        },
    );
    next(&rx, |b| text_id(b, "submit hi").is_some());
    let fill = text_id(&first, "fill").unwrap();
    control.dispatch_event(fill, EventKind::Press, EventPayload::None);
    let mut seen = Vec::new();
    while let Ok(b) = rx.recv_timeout(Duration::from_millis(300)) {
        seen.extend(texts(&b));
    }
    for wanted in ["row 1", "row 2", "sep"] {
        assert!(seen.contains(&wanted.to_owned()), "{wanted}: {seen:?}");
    }
}

const SET_ROUTES: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Dialog, NavPage, NavStack, createNavStack } from "nsh/base";

const home = { name: "home" };
const nav = createNavStack([home]);
const made = signal(0);
setTimeout(() => nav.setRoutes([home, { name: "a" }, { name: "b" }]), 0);

mount(() => (
  <View style={{ flex: 1 }}>
    <NavStack state={nav} testID="stack" style={{ flex: 1 }}>
      {(route) => {
        if (route === home) made.update((n) => n + 1);
        return (
          <NavPage title={route.name} testID={`page-${route.name}`}>
            <Text>{`home made ${made()}`}</Text>
          </NavPage>
        );
      }}
    </NavStack>
    <Dialog testID="dialog" backdropClass="bg-black/50" backdropTestID="backdrop">
      <Text>in dialog</Text>
    </Dialog>
  </View>
));
"#;

/// `setRoutes` keeps the page of a route that stays; pages, stacks,
/// dialogs and their backdrops take test ids; a backdrop is no Tab stop.
#[test]
fn set_routes_keeps_pages_that_stay_and_parts_take_test_ids() {
    let (_engine, rx) = start_app(SET_ROUTES);
    let mut batches = Vec::new();
    while let Ok(b) = rx.recv_timeout(Duration::from_millis(500)) {
        batches.push(b);
    }
    let all: Vec<String> = batches.iter().flat_map(texts).collect();
    assert!(all.contains(&"home made 1".to_owned()), "{all:?}");
    assert!(
        !all.contains(&"home made 2".to_owned()),
        "home was made again: {all:?}"
    );
    let ids: Vec<String> = batches
        .iter()
        .flat_map(|b| b.items.iter())
        .filter_map(|i| match i {
            MountItem::ViewProps { props, .. } => props.test_id.as_deref().map(str::to_owned),
            _ => None,
        })
        .collect();
    for wanted in [
        "stack",
        "page-home",
        "page-a",
        "page-b",
        "dialog",
        "backdrop",
    ] {
        assert!(ids.iter().any(|i| i == wanted), "{wanted} in {ids:?}");
    }
    // The backdrop's presses are the pointer's: it is no stop of Tab,
    // which would hold the dialog's focus where Return closes it.
    let backdrop = batches
        .iter()
        .flat_map(|b| b.items.iter())
        .find_map(|i| match i {
            MountItem::ViewProps { props, .. } if props.test_id.as_deref() == Some("backdrop") => {
                Some(props.focusable)
            }
            _ => None,
        });
    assert_eq!(backdrop, Some(Some(false)), "the backdrop is no Tab stop");
}

const SET_ROUTES_KINDS: &str = r#"import { mount, signal, Text, View } from "nsh";
import { NavPage, NavStack, createNavStack } from "nsh/base";

const page = { name: "page" };
const name = (route: unknown) => (typeof route === "object" ? (route as { name: string }).name : String(route));
const nav = createNavStack<unknown>(["a", "a", 1, page, NaN]);
const made = signal<string[]>([]);
setTimeout(() => nav.setRoutes(["a", 1, page, "a", "b", 1, NaN]), 0);

mount(() => (
  <View style={{ flex: 1 }}>
    <Text>{`made ${made().join(" ")}`}</Text>
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => {
        made.update((all) => [...all, name(route)]);
        return <NavPage title={name(route)}><Text>{name(route)}</Text></NavPage>;
      }}
    </NavStack>
  </View>
));
"#;

/// `setRoutes` keeps, for each route that stays, the first page of that
/// route not kept yet, routes compared as `===` does: strings by content,
/// objects by identity, numbers by value (`NaN` never), however many.
#[test]
fn set_routes_keeps_the_pages_of_routes_of_every_kind() {
    let (_engine, rx) = start_app(SET_ROUTES_KINDS);
    let mut all = Vec::new();
    while let Ok(b) = rx.recv_timeout(Duration::from_millis(500)) {
        all.extend(texts(&b));
    }
    // The five pages, then only those of "b", the second 1 and NaN: the
    // first "a", 1, `page` and the second "a" keep theirs.
    let last = all.iter().rev().find(|t| t.starts_with("made"));
    assert_eq!(
        last.map(String::as_str),
        Some("made a a 1 page NaN b 1 NaN"),
        "{all:?}"
    );
}

const SPARSE_ARRAYS: &str = r#"
import { Animated, mount, nativeComponent, PanResponder, Path2D, split, Text, View } from "nsh";
import { createNavStack } from "nsh/base";

const huge = () => new Array(2 ** 32 - 1);
function Children() {
  return <View>{huge()}</View>;
}
function Rows() {
  return <View><Each of={huge()}>{() => <Text>row</Text>}</Each></View>;
}
function attempt(render: () => unknown) {
  try {
    render();
    return "rendered";
  } catch (e) {
    const error = e as Error;
    return `${error.name}${error.message.includes("cannot be read") ? "" : `(${error.message})`}`;
  }
}
function AtTheBound() {
  return <View>{new Array(2 ** 20)}</View>;
}
function JustOver() {
  return <View>{new Array(2 ** 20 + 1)}</View>;
}
// Each array is short; nested in itself they hold 1000 ** 64 items. Reading
// it depth first ends at the nesting bound, and checking whether it holds
// functions (first) ends at the item budget.
function Cycle() {
  const a: unknown[] = new Array(1000).fill(0);
  a.fill(a);
  return <View>{a}</View>;
}
// A proxy whose length grows after it was checked.
function Growing() {
  let reads = 0;
  const array = new Proxy([1, 2, 3], {
    get: (target, key, receiver) =>
      key === "length" ? (++reads > 1 ? 2 ** 32 - 1 : 3) : Reflect.get(target, key, receiver),
  });
  return <View><Each of={array}>{() => <Text>row</Text>}</Each></View>;
}
const Native = nativeComponent("Probe", { props: huge() as never[] });
const pan = PanResponder.create({});
// Within the bound, but read pairwise or nested: on `main` each of these
// ran for far longer than the frame is waited for (from 1.6 s for 2 ** 13
// routes, quadratic; 4.4 s for 2 ** 20 keys of 2 ** 10 props, a product;
// 8 s and 3.7 GB for a canvas argument eight wide).
const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
function Nested() {
  const a: unknown[] = new Array(1000).fill(0);
  return a.fill(a);
}
// A stack at the bound refuses another screen and can still be popped.
function Full() {
  const stack = createNavStack(new Array(2 ** 20).fill("a"));
  const pushed = attempt(() => stack.push("b"));
  stack.pop();
  return `${pushed},${stack.routes().length}`;
}
const results = [
  `children:${attempt(Children)}`,
  `at:${attempt(AtTheBound)}`,
  `each:${attempt(Rows)}`,
  `over:${attempt(JustOver)}`,
  `cycle:${attempt(Cycle)}`,
  `growing:${attempt(Growing)}`,
  `stagger:${attempt(() => Animated.stagger(10, huge()))}`,
  `sequence:${attempt(() => Animated.sequence(huge()))}`,
  `split:${attempt(() => split({}, huge() as string[]))}`,
  `stack:${attempt(() => createNavStack(huge()))}`,
  `setRoutes:${attempt(() => createNavStack([]).setRoutes(huge()))}`,
  `native:${attempt(() => <Native />)}`,
  `grant:${attempt(() => pan.panHandlers.onResponderGrant({ touches: huge() } as never))}`,
  `move:${attempt(() => pan.panHandlers.onResponderMove({ touches: huge() } as never))}`,
  `canvas:${attempt(() => new Path2D().moveTo(Nested() as never, 0))}`,
  `routes:${attempt(() => createNavStack(names("a", 2 ** 15)).setRoutes(names("b", 2 ** 15)))}`,
  `keys:${attempt(() => split(Object.fromEntries(names("p", 2 ** 15).map((k) => [k, 0])), names("k", 2 ** 17)))}`,
  `full:${Full()}`,
];
mount(() => <Text>{results.join(" ")}</Text>);
"#;

/// A sparse array is as long as it says, and the renderer reads arrays
/// natively, where the time budget cannot interrupt: one that says it has
/// billions of items is refused with a `RangeError` instead of holding the
/// engine thread for billions of reads.
#[test]
fn arrays_too_long_to_render_are_refused() {
    let (_engine, rx) = start_app(SPARSE_ARRAYS);
    let first = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("first frame");
    assert_eq!(
        texts(&first),
        [
            "children:RangeError at:rendered each:RangeError over:RangeError \
             cycle:TypeError(nsh: children nested too deeply) growing:rendered \
             stagger:RangeError sequence:RangeError split:RangeError \
             stack:RangeError setRoutes:RangeError native:RangeError \
             grant:RangeError move:RangeError canvas:rendered routes:rendered \
             keys:rendered full:RangeError(nsh: a navigation stack holds at most \
             1048576 screens),1048575"
        ],
        "{:?}",
        texts(&first)
    );
}

const DECODED_VALUES: &str = r#"
import { Animated, createAnimatedValue, mount, nativeComponent, Scroll, Text, View } from "nsh";
import { List } from "nsh";

function attempt(render: () => unknown) {
  try {
    render();
    return "rendered";
  } catch (e) {
    const error = e as Error;
    return `${error.name}${error.message.includes("cannot be read") ? "" : `(${error.message})`}`;
  }
}
// As long as an array can be: its length is a float past 2 ** 31, which
// rquickjs's `Array::len` asserted is an integer, aborting the process.
const huge = () => new Array(2 ** 32 - 1);
const self: unknown[] = [];
self.push(self);
const theme: Record<string, unknown> = {};
theme.theme = theme;
const keys: Record<string, number> = {};
for (let i = 0; i < 2 ** 16; i++) keys[`k${i}`] = i;
const outputs = huge();
outputs[0] = "red";
const Probe = nativeComponent("Probe", { props: ["data"] } as never) as never as (props: { data: unknown }) => never;
const value = createAnimatedValue(0);
let shared: any = Animated.timing(value, { toValue: 1, duration: 10 });
for (let i = 0; i < 63; i++) shared = Animated.sequence(new Array(1000).fill(shared));
// Within the bound alone, over it four times: a composite's keyframes are
// counted with the rest of what it runs.
const frames = Animated.keyframes(value, { keyframes: new Array(2 ** 19).fill(0), duration: 10 });
const sharedFrames = Animated.sequence(new Array(4).fill(frames));
const results = [
  `styleSelf:${attempt(() => <View style={self as never} />)}`,
  `styleSparse:${attempt(() => <View style={huge() as never} />)}`,
  `styleKeys:${attempt(() => <View style={keys as never} />)}`,
  `fontVariant:${attempt(() => <Text style={{ fontVariant: huge() as never }}>x</Text>)}`,
  `boxShadow:${attempt(() => <View style={{ boxShadow: huge() as never }} />)}`,
  `transform:${attempt(() => <View style={{ transform: huge() as never }} />)}`,
  `translate:${attempt(() => <View style={{ translate: huge() as never }} />)}`,
  `outputRange:${attempt(() => value.interpolate({ inputRange: [0, 1], outputRange: outputs }))}`,
  `inputRange:${attempt(() => value.interpolate({ inputRange: huge(), outputRange: [0, 1] }))}`,
  `native:${attempt(() => <Probe data={huge()} />)}`,
  `scrollbar:${attempt(() => <Scroll scrollbar={theme as never}><Text>x</Text></Scroll>)}`,
  `sticky:${attempt(() => <List each={[1]} stickyHeaderIndices={huge() as never}>{() => <Text>x</Text>}</List>)}`,
  `captureKeys:${attempt(() => <View focusable captureKeys={huge() as never} />)}`,
];
// A start returns a promise: what it cannot decode rejects it.
const settled = (start: () => Promise<unknown>) =>
  start().then(
    () => "resolved",
    (e: Error) => `${e.name}${e.message.includes("cannot be read") ? "" : `(${e.message})`}`,
  );
Promise.all([
  settled(() => Animated.timing(value, { toValue: 1, easing: huge() as never }).start()),
  settled(() => Animated.decay(value, { velocity: 1, clamp: huge() as never }).start()),
  settled(() => shared.start()),
  settled(() => sharedFrames.start()),
]).then(([easing, clamp, sharedRuns, sharedKeyframes]) => {
  results.push(`easing:${easing}`, `clamp:${clamp}`, `shared:${sharedRuns}`, `keyframes:${sharedKeyframes}`);
  mount(() => <Text>{results.join(" ")}</Text>);
});
"#;

/// What the decoders read of the values apps pass natively, where neither
/// the time budget nor the interpreter's stack limit applies: an array as
/// long as an array can be (which aborted the process), one holding itself
/// (which overflowed the engine thread's stack) and composites sharing
/// their children (10^189 runs) are refused; a style of 2^16 keys and a
/// theme holding itself are read.
#[test]
fn values_too_long_or_nested_in_themselves_are_refused_when_decoded() {
    let (_engine, rx) = start_app(DECODED_VALUES);
    // The results are mounted once the starts settled: a start that did not
    // reject would run its animation, and frames of it come first.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut shown = Vec::new();
    while let Ok(batch) = rx.recv_deadline(deadline) {
        shown = texts(&batch);
        if shown.iter().any(|t| t.starts_with("styleSelf:")) {
            break;
        }
    }
    assert_eq!(
        shown,
        [
            "styleSelf:TypeError(nsh: styles nested too deeply) styleSparse:RangeError \
             styleKeys:rendered fontVariant:RangeError boxShadow:RangeError \
             transform:RangeError translate:RangeError outputRange:RangeError \
             inputRange:RangeError native:RangeError(a native component value is nested \
             deeper than 64 or has more than 1048576 entries) scrollbar:rendered \
             sticky:RangeError captureKeys:RangeError easing:RangeError clamp:TypeError(decay: `clamp` must be \
             [min, max]) shared:RangeError keyframes:RangeError"
        ],
        "{:?}",
        shown
    );
}
