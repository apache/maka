//! Split bundles: an app whose second screen is `import()`ed loads its
//! chunks on demand, from the bundle or from the platform.

use std::time::Duration;

use crossbeam_channel::{Receiver, Sender};
use nsh_core::{
    ApproxTextEngine, EventKind, EventPayload, MountBatch, MountItem, NodeId, Size, geometry::px,
};
use nsh_engine::{Bundle, Chunk, Engine, EngineConfig, MountSink};

const APP: &str = r#"
import { mount, signal, Text, View } from "nsh";
import { label } from "./shared";

function App() {
  const screen = signal<any>(null);
  const error = signal("");
  const open = () =>
    import("./Screen").then((m) => screen.set(() => m.Screen), (e) => error.set(e.message));
  // Also opened from the screen: what both use goes into a chunk of its own.
  const settings = () => import("./Settings").then((m) => screen.set(() => m.default));
  return (
    <View>
      <Text onPress={open}>{label("home")}</Text>
      <Text onPress={settings}>settings</Text>
      {screen() && screen()()}
      <Text>{error()}</Text>
    </View>
  );
}

mount(App);
"#;

const SCREEN: &str = r#"
import { signal, Text, View } from "nsh";
import { label } from "./shared";
import { detail } from "./detail";

export function Screen() {
  const settings = signal<any>(null);
  const open = () => import("./Settings").then((m) => settings.set(() => m.default));
  return (
    <View>
      <Text onPress={open}>{label(detail)}</Text>
      {settings() && settings()()}
    </View>
  );
}
"#;

const SETTINGS: &str = r#"
import { Text } from "nsh";
import { detail } from "./detail";

export default function Settings() {
  return <Text>settings of the {detail}</Text>;
}
"#;

/// The app, bundled split.
fn bundle(name: &str) -> nsh_bundler::Bundle {
    let dir = std::env::temp_dir().join(format!("nsh-split-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for (file, code) in [
        ("App.tsx", APP),
        ("Screen.tsx", SCREEN),
        ("Settings.tsx", SETTINGS),
        (
            "shared.ts",
            "export const label = (s: string) => `[${s}]`;\n",
        ),
        ("detail.ts", "export const detail = \"second screen\";\n"),
    ] {
        std::fs::write(dir.join(file), code).unwrap();
    }
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: dir.join("App.tsx"),
        minify: true,
        split: true,
        ui_sets: Vec::new(),
    })
    .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    bundle
}

fn config(bundle: Bundle) -> EngineConfig {
    EngineConfig {
        app: nsh_engine::App::Js(bundle),
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
    }
}

/// Hands batches and chunk requests to the test; `loads`: whether it
/// loads chunks.
struct Sink {
    batches: Sender<MountBatch>,
    chunks: Sender<String>,
    loads: bool,
}

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.batches.send(batch);
    }

    fn load_chunk(&self, id: &str) -> bool {
        let _ = self.chunks.send(id.to_owned());
        self.loads
    }
}

/// The texts on screen by node.
#[derive(Default)]
struct Screen(std::collections::BTreeMap<NodeId, String>);

impl Screen {
    fn drain(&mut self, rx: &Receiver<MountBatch>) {
        while let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
            for item in &batch.items {
                match item {
                    MountItem::Text { id, text, .. } => {
                        self.0.insert(*id, text.text.clone());
                    }
                    MountItem::Delete { id } => {
                        self.0.remove(id);
                    }
                    _ => {}
                }
            }
        }
    }

    fn find(&self, text: &str) -> NodeId {
        *self
            .0
            .iter()
            .find(|(_, t)| t.as_str() == text)
            .unwrap_or_else(|| panic!("no text {text:?} in {:?}", self.texts()))
            .0
    }

    fn texts(&self) -> Vec<&str> {
        self.0
            .values()
            .map(String::as_str)
            .filter(|t| !t.is_empty())
            .collect()
    }
}

fn start(bundle: Bundle, loads: bool) -> (Engine, Receiver<MountBatch>, Receiver<String>) {
    let (batches, rx) = crossbeam_channel::unbounded();
    let (chunks, requests) = crossbeam_channel::unbounded();
    let sink = Sink {
        batches,
        chunks,
        loads,
    };
    let engine = Engine::start(config(bundle), || ApproxTextEngine, sink).unwrap();
    (engine, rx, requests)
}

fn chunk(bundle: &nsh_bundler::Bundle, id: &str) -> Chunk {
    let c = bundle.chunks.iter().find(|c| c.id == id).unwrap();
    Chunk::source(&c.id, c.code.clone())
}

#[test]
fn imported_screens_load_their_chunks_from_the_platform() {
    let split = bundle("platform");
    let ids: Vec<&str> = split.chunks.iter().map(|c| c.id.as_str()).collect();
    // The screens, and what only they share.
    assert_eq!(ids.len(), 3, "{ids:?}");
    assert!(
        ids.contains(&"Screen.js") && ids.contains(&"Settings.js"),
        "{ids:?}"
    );
    let (engine, rx, requests) = start(Bundle::source(split.code.clone()), true);
    let control = engine.control();
    let mut screen = Screen::default();
    screen.drain(&rx);
    assert_eq!(screen.texts(), ["[home]", "settings"]);

    control.dispatch_event(screen.find("[home]"), EventKind::Press, EventPayload::None);
    // The screen's chunk and the one it shares with the settings, at once.
    let mut asked: Vec<String> = (0..2)
        .map(|_| requests.recv_timeout(Duration::from_secs(5)).unwrap())
        .collect();
    asked.sort();
    let shared = ids
        .iter()
        .find(|i| !["Screen.js", "Settings.js"].contains(i))
        .unwrap();
    assert_eq!(asked, ["Screen.js".to_owned(), shared.to_string()]);
    // Nothing shows until both are there.
    control.chunk_loaded(chunk(&split, "Screen.js"));
    screen.drain(&rx);
    assert_eq!(screen.texts(), ["[home]", "settings"]);
    control.chunk_loaded(chunk(&split, shared));
    screen.drain(&rx);
    assert_eq!(screen.texts(), ["[home]", "settings", "[second screen]"]);

    // A chunk imported from a chunk: only what is not loaded yet.
    control.dispatch_event(
        screen.find("[second screen]"),
        EventKind::Press,
        EventPayload::None,
    );
    let asked = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(asked, "Settings.js");
    assert!(requests.recv_timeout(Duration::from_millis(100)).is_err());
    control.chunk_loaded(chunk(&split, "Settings.js"));
    screen.drain(&rx);
    assert!(
        screen.texts().contains(&"settings of the second screen"),
        "{:?}",
        screen.texts()
    );
}

#[test]
fn chunks_that_come_with_the_bundle_load_without_asking() {
    let split = bundle("given");
    // Bytecode, as a native package would ship it.
    let sources: Vec<(&str, &str)> = split
        .chunks
        .iter()
        .map(|c| (c.id.as_str(), c.code.as_str()))
        .collect();
    let chunks = nsh_js::compile_chunk_bytecode(&split.code, &sources, true, &[]).unwrap();
    let entry = nsh_js::compile_bytecode(&split.code, true).unwrap();
    // SAFETY: compiled just now by this runtime.
    let bundle = unsafe { Bundle::bytecode(entry) }.with_chunks(
        sources
            .iter()
            .zip(chunks)
            // SAFETY: as above.
            .map(|((id, _), bytes)| unsafe { Chunk::bytecode(*id, bytes) }),
    );
    let (engine, rx, requests) = start(bundle, false);
    let mut screen = Screen::default();
    screen.drain(&rx);
    let control = engine.control();
    control.dispatch_event(screen.find("[home]"), EventKind::Press, EventPayload::None);
    screen.drain(&rx);
    assert_eq!(screen.texts(), ["[home]", "settings", "[second screen]"]);
    assert!(requests.try_recv().is_err(), "nothing was asked for");
}

#[test]
fn an_import_fails_when_the_host_cannot_load_its_chunk() {
    let split = bundle("missing");
    let (engine, rx, _requests) = start(Bundle::source(split.code.clone()), false);
    let mut screen = Screen::default();
    screen.drain(&rx);
    let control = engine.control();
    control.dispatch_event(screen.find("[home]"), EventKind::Press, EventPayload::None);
    screen.drain(&rx);
    let texts = screen.texts();
    assert_eq!(texts.len(), 3, "{texts:?}");
    assert!(texts[2].starts_with("could not load chunk"), "{texts:?}");
}
