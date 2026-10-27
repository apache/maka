//! End-to-end hot module replacement: bundle a small app for development,
//! edit its modules and apply the updates in place.

use std::{path::Path, time::Duration};

use crossbeam_channel::{Receiver, Sender};
use nsh_core::{
    ApproxTextEngine, EventKind, EventPayload, MountBatch, MountItem, NodeId, Size, geometry::px,
};
use nsh_engine::{Bundle, Engine, EngineConfig, HotUpdate, MountSink};

struct ChannelSink(Sender<MountBatch>, Sender<()>, Sender<String>);

impl MountSink for ChannelSink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.0.send(batch);
    }

    fn hot_update_failed(&self) {
        let _ = self.1.send(());
    }

    fn report_error(&self, message: &str) {
        let _ = self.2.send(message.to_owned());
    }
}

const APP: &str = r#"
import { Image, mount, signal, Text, View } from "nsh";
import { Counter } from "./Counter";
import dot from "./dot.png";

function App() {
  const n = signal(0);
  return <View><Image src={dot} /><Text onPress={() => n.set(n() + 1)}>app {n()}</Text><Counter /></View>;
}

mount(App);
"#;

const COUNTER: &str = r#"
import { signal, Text } from "nsh";
import { greeting } from "./words";

export function Counter() {
  const c = signal(0);
  return <Text onPress={() => c.set(c() + 1)}>{greeting} {c()}</Text>;
}
"#;

const WORDS: &str = r#"export const greeting = "counter";"#;

/// The text views on screen: the latest text of each, and the tree.
#[derive(Default)]
struct Screen {
    texts: std::collections::BTreeMap<NodeId, String>,
    parents: std::collections::HashMap<NodeId, NodeId>,
}

impl Screen {
    fn apply(&mut self, batch: &MountBatch) {
        for item in &batch.items {
            match item {
                MountItem::Text { id, text, .. } => {
                    self.texts.insert(*id, text.text.clone());
                }
                MountItem::Insert { parent, child, .. }
                | MountItem::ProjectRoot {
                    parent, id: child, ..
                } => {
                    self.parents.insert(*child, *parent);
                }
                MountItem::Remove { id } | MountItem::Delete { id } => {
                    self.parents.remove(id);
                }
                _ => {}
            }
        }
    }

    /// Texts attached to the root.
    fn shown(&self) -> Vec<(NodeId, &str)> {
        let attached = |mut id: NodeId| loop {
            if id == nsh_core::ROOT_ID {
                return true;
            }
            match self.parents.get(&id) {
                Some(&p) => id = p,
                None => return false,
            }
        };
        self.texts
            .iter()
            .filter(|(id, _)| attached(**id))
            .map(|(id, t)| (*id, t.as_str()))
            .collect()
    }

    fn find(&self, prefix: &str) -> Option<NodeId> {
        self.shown()
            .into_iter()
            .find(|(_, t)| t.starts_with(prefix))
            .map(|(id, _)| id)
    }

    fn texts(&self) -> Vec<String> {
        let mut t: Vec<String> = self
            .shown()
            .into_iter()
            .map(|(_, t)| t.to_owned())
            .collect();
        t.sort();
        t
    }
}

fn drain(rx: &Receiver<MountBatch>, screen: &mut Screen) {
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
        screen.apply(&batch);
    }
}

fn update(dir: &Path, previous: &mut nsh_bundler::HotBundle, n: u32) -> Option<HotUpdate> {
    let next =
        nsh_bundler::bundle_hot(&dir.join("App.tsx"), &[nsh_base::registry().into()]).unwrap();
    let patch = next.patch(previous);
    *previous = next;
    match patch {
        nsh_bundler::HotPatch::Update { code, source_map } => Some(HotUpdate {
            name: format!("hot-{n}.js"),
            code,
            source_map: source_map.map(Into::into),
        }),
        other => panic!("expected an update, got {other:?}"),
    }
}

#[test]
fn edits_replace_modules_and_keep_unrelated_state() {
    let dir = std::env::temp_dir().join(format!("nsh-hot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("App.tsx"), APP).unwrap();
    std::fs::write(dir.join("Counter.tsx"), COUNTER).unwrap();
    std::fs::write(dir.join("words.ts"), WORDS).unwrap();
    // A 1x1 PNG: asset modules are part of development bundles too.
    std::fs::write(
        dir.join("dot.png"),
        [
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0d, 0x49,
            0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0,
            0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ],
    )
    .unwrap();

    let mut bundle =
        nsh_bundler::bundle_hot(&dir.join("App.tsx"), &[nsh_base::registry().into()]).unwrap();
    let (code, map) = bundle.script();
    let (tx, rx) = crossbeam_channel::unbounded();
    let (failed_tx, failed) = crossbeam_channel::unbounded();
    let (errors_tx, errors) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(Bundle::source(code).with_source_map(map.unwrap())),
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
    let engine = Engine::start(
        config,
        || ApproxTextEngine,
        ChannelSink(tx, failed_tx, errors_tx),
    )
    .unwrap();
    let control = engine.control();
    let mut screen = Screen::default();
    drain(&rx, &mut screen);
    assert_eq!(screen.texts(), ["app 0", "counter 0"]);

    // Some state in both components.
    let press = |id| control.dispatch_event(id, EventKind::Press, EventPayload::None);
    press(screen.find("app").unwrap());
    press(screen.find("app").unwrap());
    press(screen.find("counter").unwrap());
    drain(&rx, &mut screen);
    assert_eq!(screen.texts(), ["app 2", "counter 1"]);

    // A component edit: only that component renders again.
    std::fs::write(
        dir.join("Counter.tsx"),
        COUNTER.replace("{greeting} {c()}", "{greeting}: {c()}"),
    )
    .unwrap();
    control.hot_update(update(&dir, &mut bundle, 1).unwrap());
    drain(&rx, &mut screen);
    assert_eq!(screen.texts(), ["app 2", "counter: 0"]);

    // A plain module edit reaches the components that import it.
    press(screen.find("counter").unwrap());
    std::fs::write(dir.join("words.ts"), WORDS.replace("counter", "taps")).unwrap();
    control.hot_update(update(&dir, &mut bundle, 2).unwrap());
    drain(&rx, &mut screen);
    assert_eq!(screen.texts(), ["app 2", "taps: 0"]);

    // An edit of the root component renders it again, and what it renders:
    // their own state starts afresh.
    std::fs::write(dir.join("App.tsx"), APP.replace("app {n()}", "app! {n()}")).unwrap();
    control.hot_update(update(&dir, &mut bundle, 3).unwrap());
    drain(&rx, &mut screen);
    assert_eq!(screen.texts(), ["app! 0", "taps: 0"]);

    // A component that throws reports the error and renders nothing; the
    // fix renders it again.
    let counter = COUNTER.replace("{greeting} {c()}", "{greeting}: {c()}");
    let broken = counter.replace(
        "const c = signal(0);",
        "const c = signal(0);\n  if (c() === 0) throw new Error(\"broken counter\");",
    );
    std::fs::write(dir.join("Counter.tsx"), &broken).unwrap();
    control.hot_update(update(&dir, &mut bundle, 4).unwrap());
    drain(&rx, &mut screen);
    assert_eq!(screen.texts(), ["app! 0"]);
    let error = errors.try_recv().expect("the error is reported");
    assert!(error.contains("broken counter"), "{error}");
    std::fs::write(dir.join("Counter.tsx"), &counter).unwrap();
    control.hot_update(update(&dir, &mut bundle, 5).unwrap());
    drain(&rx, &mut screen);
    assert_eq!(screen.texts(), ["app! 0", "taps: 0"]);
    assert!(failed.try_recv().is_err(), "no update needed a reload");

    // A native module the running bundle does not import: a reload.
    std::fs::write(
        dir.join("Counter.tsx"),
        format!(
            "import {{ isAvailable }} from \"nsh/desktop\";\nconsole.log(isAvailable);\n{counter}"
        ),
    )
    .unwrap();
    let next =
        nsh_bundler::bundle_hot(&dir.join("App.tsx"), &[nsh_base::registry().into()]).unwrap();
    assert!(matches!(next.patch(&bundle), nsh_bundler::HotPatch::Reload));
    let _ = std::fs::remove_dir_all(&dir);
}

const NAV_APP: &str = r#"
import { mount, signal, Text, View } from "nsh";
import { NavPage, NavStack, createNavStack } from "nsh/base";

type Route = { name: string };
const nav = createNavStack<Route>([{ name: "home" }]);
const taps = signal(0);

function Label(props: { route: string }) {
  return <Text>label {props.route}</Text>;
}

function Local() {
  const c = signal(0);
  return <Text onPress={() => c.set(c() + 1)}>local {c()}</Text>;
}

function App() {
  return (
    <View style={{ flex: 1 }}>
    <Local />
    <NavStack state={nav} style={{ flex: 1 }}>
      {(route) => (
        <NavPage title={route.name}>
          <View>
            <Text onPress={() => nav.push({ name: `page${nav.routes().length}` })}>push {route.name}</Text>
            <Text onPress={() => taps.set(taps() + 1)}>taps {taps()}</Text>
            <Label route={route.name} />
          </View>
        </NavPage>
      )}
    </NavStack>
    </View>
  );
}

MOUNT
"#;

/// Edits of the entry keep the mounted tree, the top-level signals and the
/// navigator's screens, with `mount(App)` and with an inline function.
#[test]
fn entry_edits_keep_navigation_and_state() {
    for (n, mount) in ["mount(App);", "mount(() => <App />);"]
        .into_iter()
        .enumerate()
    {
        let app = NAV_APP.replace("MOUNT", mount);
        let dir = std::env::temp_dir().join(format!("nsh-hot-nav-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("App.tsx"), &app).unwrap();
        let sets = [nsh_base::registry()];
        let described: Vec<_> = sets.iter().map(Into::into).collect();
        let mut bundle = nsh_bundler::bundle_hot(&dir.join("App.tsx"), &described).unwrap();
        let (code, map) = bundle.script();
        let (tx, rx) = crossbeam_channel::unbounded();
        let (failed_tx, failed) = crossbeam_channel::unbounded();
        let (errors_tx, errors) = crossbeam_channel::unbounded();
        let config = EngineConfig {
            app: nsh_engine::App::Js(Bundle::source(code).with_source_map(map.unwrap())),
            viewport: Size::new(px(390.0), px(844.0)),
            trace: false,
            network: None,
            websocket: None,
            filesystem: None,
            assets: None,
            environment: Default::default(),
            header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
            limits: nsh_engine::Limits::default(),
            ui_sets: sets.to_vec(),
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
        let engine = Engine::start(
            config,
            || ApproxTextEngine,
            ChannelSink(tx, failed_tx, errors_tx),
        )
        .unwrap();
        let control = engine.control();
        let mut screen = Screen::default();
        drain(&rx, &mut screen);
        assert_eq!(
            screen.texts(),
            ["label home", "local 0", "push home", "taps 0"],
            "{mount}"
        );

        // A pushed screen and a top-level signal's state.
        let press = |id| control.dispatch_event(id, EventKind::Press, EventPayload::None);
        press(screen.find("push home").unwrap());
        drain(&rx, &mut screen);
        press(screen.find("taps").unwrap());
        press(screen.find("local").unwrap());
        drain(&rx, &mut screen);
        let state = [
            "label home",
            "label page1",
            "local 1",
            "push home",
            "push page1",
            "taps 1",
            "taps 1",
        ];
        assert_eq!(screen.texts(), state, "{mount}");

        // An edit of another component of the entry: only it renders again
        // (the state of the others stays).
        let edited = app.replace("label {props.route}", "label: {props.route}");
        std::fs::write(dir.join("App.tsx"), &edited).unwrap();
        control.hot_update(update(&dir, &mut bundle, 1).unwrap());
        drain(&rx, &mut screen);
        let labelled = state.map(|t| t.replace("label ", "label: "));
        assert_eq!(screen.texts(), labelled, "{mount}");

        // An edit of the root component renders the tree again (its
        // components' own state starts afresh), from the kept navigator and
        // signal: the pushed screen stays.
        let edited = edited.replace(
            "<NavStack state={nav} style={{ flex: 1 }}>",
            "<NavStack state={nav} style={{ flex: 1, gap: 1 }}>",
        );
        std::fs::write(dir.join("App.tsx"), &edited).unwrap();
        control.hot_update(update(&dir, &mut bundle, 2).unwrap());
        drain(&rx, &mut screen);
        let fresh = labelled.map(|t| t.replace("local 1", "local 0"));
        assert_eq!(screen.texts(), fresh, "{mount}");

        // A changed initializer starts afresh.
        let edited = edited.replace("signal(0)", "signal(10)");
        std::fs::write(dir.join("App.tsx"), &edited).unwrap();
        control.hot_update(update(&dir, &mut bundle, 3).unwrap());
        drain(&rx, &mut screen);
        assert!(
            screen.texts().contains(&"taps 10".to_owned()),
            "{:?}",
            screen.texts()
        );
        assert!(
            screen.texts().contains(&"push page1".to_owned()),
            "{:?}",
            screen.texts()
        );

        assert!(failed.try_recv().is_err(), "no update needed a reload");
        assert!(errors.try_recv().is_err(), "no errors");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
