//! `nsh/storage`: an app's entries kept in a file across launches, its
//! quota, and the same entries read and written from Rust.

use std::{path::PathBuf, time::Duration};

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, MountBatch, MountItem, Size,
    storage::Storage,
    ui::{Root, prelude::*},
};
use nsh_engine::{App, Bundle, Engine, EngineConfig, Environment, FileStorage};

use crate::ChannelSink;

/// A directory of its own under the test's temporary directory.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nsh-storage-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `app` with `capabilities`, its storage in `data`.
fn start(
    name: &str,
    app: &str,
    capabilities: Option<&str>,
    data: &PathBuf,
) -> (Engine, Receiver<MountBatch>) {
    launch(name, app, capabilities, None, None, Some(data))
}

/// `app` with `capabilities` and the id `app_id`, the platform giving
/// `data_dir` and `storage`.
fn launch(
    name: &str,
    app: &str,
    capabilities: Option<&str>,
    app_id: Option<&str>,
    data_dir: Option<&std::path::Path>,
    storage: Option<&PathBuf>,
) -> (Engine, Receiver<MountBatch>) {
    let dir = scratch(name);
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode_with(&bundle.code, false, &[]).unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: nsh_engine::App::Js(
            unsafe { Bundle::bytecode(bytecode) }
                .with_capabilities_json(capabilities)
                .unwrap()
                .with_app_id(app_id),
        ),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: data_dir.map(Into::into),
        cache: nsh_engine::CacheOptions::off(),
        storage: storage.map(|data| FileStorage::open(data) as _),
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

/// The text shown once it starts with `prefix` (or the last one, after
/// nothing came for 2 s).
fn shown(rx: &Receiver<MountBatch>, prefix: &str) -> String {
    let mut last = String::new();
    while let Ok(batch) = rx.recv_timeout(Duration::from_secs(2)) {
        for item in &batch.items {
            if let MountItem::Text { text, .. } = item {
                last = text.text.clone();
                if last.starts_with(prefix) {
                    return last;
                }
            }
        }
    }
    last
}

const COUNTER: &str = r#"import { mount, signal, Text } from "nsh";
import { Storage } from "nsh/storage";

const shown = signal("waiting");
setTimeout(async () => {
  try {
    const launches = Number((await Storage.getItem("launches")) ?? "0") + 1;
    Storage.setItem("launches", String(launches));
    Storage.setItem("scratch", "x");
    Storage.removeItem("scratch");
    const keys = await Storage.keys();
    let full = "fits";
    await Storage.setItem("big", "x".repeat(6 * 1024 * 1024)).catch(() => (full = "full"));
    shown.set(`done ${launches} ${keys.join(",")} ${full} ${await Storage.getItem("missing")}`);
  } catch (e) {
    shown.set(`done error ${e}`);
  }
}, 0);

mount(() => <Text>{shown()}</Text>);
"#;

#[test]
fn entries_last_across_launches() {
    let data = scratch("data");
    for launch in 1..=2 {
        // Capabilities do not cover storage: the app's own data.
        let (engine, rx) = start("counter", COUNTER, Some("{}"), &data);
        assert_eq!(
            shown(&rx, "done"),
            format!("done {launch} launches full null")
        );
        // Stopping the engine drops the storage, which writes what is left.
        drop(engine);
    }
    let file = std::fs::read_to_string(data.join("storage.json")).unwrap();
    assert_eq!(file, r#"{"launches":"2"}"#);
}

#[derive(Clone, PartialEq, Props)]
struct ReaderProps {}

/// The Rust entry of an app whose TSX entry is [`COUNTER`]: reads what the
/// JS wrote and writes for it.
#[component]
fn Reader(_props: ReaderProps) -> impl IntoElement {
    let seen = Storage::get_item("launches").unwrap_or_default();
    Storage::set_item("launches", "2").unwrap();
    Storage::set_item("from_rust", "hi").unwrap();
    let keys = Storage::get_all_keys().join(",");
    text(move || format!("rust saw {seen} {keys}"))
}

#[test]
fn rust_shares_the_entries_of_js() {
    let data = scratch("shared");
    let (engine, rx) = start("shared", COUNTER, None, &data);
    assert_eq!(shown(&rx, "done"), "done 1 launches full null");
    drop(engine);
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::new::<Reader>(|| ReaderProps {})),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: Some(FileStorage::open(&data)),
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    assert_eq!(shown(&rx, "rust"), "rust saw 1 from_rust,launches");
    drop(engine);
    // And the JS sees what Rust wrote.
    let (_engine, rx) = start("shared-again", COUNTER, None, &data);
    assert_eq!(shown(&rx, "done"), "done 3 from_rust,launches full null");
}

const EDGES: &str = r#"import { mount, signal, Text } from "nsh";
import { Storage } from "nsh/storage";

const shown = signal("waiting");
const outcomes: string[] = [];
async function attempt(name: string, f: () => Promise<unknown>) {
  try {
    await f();
    outcomes.push(`${name}:ok`);
  } catch {
    outcomes.push(`${name}:refused`);
  }
}
setTimeout(async () => {
  await attempt("number", () => Storage.setItem("n", 1 as unknown as string));
  await attempt("nokey", () => (Storage.getItem as () => Promise<unknown>)());
  Storage.setItem("a", "1");
  Storage.setItem("b", "2");
  // Every call is a promise, also those that return nothing.
  const removing = Storage.removeItem("missing");
  const clearing = Storage.clear();
  outcomes.push(removing instanceof Promise && clearing instanceof Promise ? "promises" : "plain");
  await clearing;
  const cleared = (await Storage.keys()).length;
  await Storage.setItem("ключ", "值😀");
  shown.set(`done ${outcomes.join(" ")} ${cleared} ${await Storage.getItem("ключ")}`);
}, 0);

mount(() => <Text>{shown()}</Text>);
"#;

#[test]
fn js_arguments_are_checked_and_clear_empties() {
    let data = scratch("edges");
    let (engine, rx) = start("edges", EDGES, None, &data);
    assert_eq!(
        shown(&rx, "done"),
        "done number:refused nokey:refused promises 0 值😀"
    );
    drop(engine);
    let file = std::fs::read_to_string(data.join("storage.json")).unwrap();
    assert_eq!(file, r#"{"ключ":"值😀"}"#);
}

#[derive(Clone, PartialEq, Props)]
struct EditorProps {}

/// Every function Rust has for the app's storage.
#[component]
fn Editor(_props: EditorProps) -> impl IntoElement {
    Storage::set_item("a", "1").unwrap();
    Storage::set_item("b", "2").unwrap();
    Storage::remove_item("a");
    Storage::remove_item("missing");
    let after_remove = Storage::get_all_keys().join(",");
    let full = Storage::set_item("big", "x".repeat(nsh_core::storage::QUOTA)).is_err();
    Storage::clear();
    let after_clear = Storage::get_all_keys().len();
    let missing = Storage::get_item("b").is_none();
    text(move || format!("rust {after_remove} {full} {after_clear} {missing}"))
}

#[test]
fn rust_edits_the_storage() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::new::<Editor>(|| EditorProps {})),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        // In memory: the platform gave none.
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
    let _engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    assert_eq!(shown(&rx, "rust"), "rust b true 0 true");
}

#[test]
fn each_app_keeps_its_data_under_its_id() {
    let root = scratch("data-root");
    for (name, id) in [
        ("orders", Some("com.example.orders")),
        ("notes", Some("com.example.notes")),
    ] {
        let (engine, rx) = launch(name, COUNTER, None, id, Some(&root), None);
        assert_eq!(shown(&rx, "done"), "done 1 launches full null");
        drop(engine);
    }
    // A second launch of one app finds its own data, not the other's.
    let (engine, rx) = launch(
        "orders-again",
        COUNTER,
        None,
        Some("com.example.orders"),
        Some(&root),
        None,
    );
    assert_eq!(shown(&rx, "done"), "done 2 launches full null");
    drop(engine);
    // Without an id, or with one that is no directory name: `default`.
    for id in [None, Some("../escape")] {
        let (engine, rx) = launch("anonymous", COUNTER, None, id, Some(&root), None);
        shown(&rx, "done");
        drop(engine);
    }
    let kept = |dir: &str| std::fs::read_to_string(root.join(dir).join("storage.json")).unwrap();
    assert_eq!(kept("com.example.orders"), r#"{"launches":"2"}"#);
    assert_eq!(kept("com.example.notes"), r#"{"launches":"1"}"#);
    assert_eq!(kept("default"), r#"{"launches":"2"}"#);
    assert!(!root.join("../escape").exists());
}

#[derive(Clone, PartialEq, Props)]
struct WriterProps {}

#[component]
fn Writer(_props: WriterProps) -> impl IntoElement {
    Storage::set_item("from", "rust").unwrap();
    text(|| "rust wrote".to_owned())
}

#[test]
fn a_rust_root_keeps_its_data_under_its_id() {
    let root = scratch("rust-root");
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: App::Rust(Root::new::<Writer>(|| WriterProps {}).app_id("com.example.rusty")),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: Some(root.clone()),
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    assert_eq!(shown(&rx, "rust"), "rust wrote");
    drop(engine);
    let file = root.join("com.example.rusty/storage.json");
    assert_eq!(std::fs::read_to_string(file).unwrap(), r#"{"from":"rust"}"#);
}

#[test]
fn a_built_bundle_carries_its_apps_id() {
    let dir = scratch("built");
    std::fs::write(dir.join("bundle.js"), "").unwrap();
    assert_eq!(Bundle::read(&dir.join("bundle.js")).unwrap().app_id, None);
    std::fs::write(dir.join("app.json"), r#"{ "id": "com.example.built" }"#).unwrap();
    let bundle = Bundle::read(&dir.join("bundle.js")).unwrap();
    assert_eq!(bundle.app_id.as_deref(), Some("com.example.built"));
    assert_eq!(App::Js(bundle).app_id(), Some("com.example.built"));
}
