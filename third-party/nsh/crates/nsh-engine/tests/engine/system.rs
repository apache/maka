//! Native worker completions must wake the engine, including during initial evaluation.
use std::time::{Duration, Instant};

use nsh_core::{ApproxTextEngine, MountItem, Size, platform::Os};
use nsh_engine::{Bundle, Engine, EngineConfig, Environment};

use crate::ChannelSink;

#[test]
fn filesystem_completion_during_initial_evaluation_is_delivered_without_timers() {
    filesystem_startup(false);
}

#[test]
fn app_directory_override_reaches_process_and_filesystem_grants() {
    filesystem_startup(true);
}

fn filesystem_startup(override_directory: bool) {
    let dir = std::env::temp_dir().join(format!(
        "nsh-system-startup-{}-{override_directory}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let data_dir = if override_directory {
        dir.join("custom")
    } else {
        dir.join("data/com.example.system")
    };
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::write(data_dir.join("input.txt"), "native file ready").unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(
        &entry,
        r#"import { mount, signal, Text } from "nsh";
import fs from "fs/promises";
import process from "process";
if (!process.dataDir || typeof process.env !== "object" || process !== globalThis.process) {
  throw new Error(`Engine metadata missing: dataDir=${process.dataDir}, env=${typeof process.env}`);
}
const status = signal("waiting");
const request = Promise.all([
  fs.readFile("${dataDir}/input.txt", "utf8"),
  fs.readFile(process.dataDir + "/input.txt", "utf8"),
]).then(([anchor, processPath]) => {
  if (anchor !== processPath) throw new Error("data directory mismatch");
  return anchor;
});
// Finish the native operation before the engine finishes evaluating this module.
const until = Date.now() + 100;
while (Date.now() < until) {}
request.then(value => status.set(value), error => status.set(String(error)));
mount(() => <Text>{status()}</Text>);
"#,
    )
    .unwrap();
    let bundled = nsh_bundler::bundle_hot(&entry, &[]).unwrap();
    let (code, _) = bundled.script();
    let bundle = Bundle::source(code)
        .with_app_id(Some("com.example.system"))
        .with_capabilities_json(Some(r#"{"fs":{"read":["${dataDir}"]}}"#))
        .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(bundle),
        viewport: Size::new(nsh_core::geometry::px(400.0), nsh_core::geometry::px(300.0)),
        trace: false,
        content_culling: false,
        network: None,
        websocket: None,
        refuse_connections: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment {
            os: if cfg!(target_os = "macos") {
                Os::MacOs
            } else {
                Os::Linux
            },
            ..Default::default()
        },
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        support_dir: Some(dir.join("data")),
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
        audio: None,
        windows: None,
        login_item: None,
        data_dir: override_directory.then_some(data_dir),
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut shown = Vec::new();
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        let Ok(batch) = rx.recv_timeout(remaining) else {
            break;
        };
        shown.extend(batch.items.iter().filter_map(|item| match item {
            MountItem::Text { text, .. } => Some(text.text.clone()),
            _ => None,
        }));
        if shown.iter().any(|text| text == "native file ready") {
            break;
        }
    }
    drop(engine);
    let _ = std::fs::remove_dir_all(dir);
    assert!(
        shown.iter().any(|text| text == "native file ready"),
        "native completion never reached the UI: {shown:?}"
    );
}

#[test]
fn trusted_path_anchors_reach_the_vm_without_application_metadata() {
    let temporary = crate::temporary_root();
    let root = temporary.join(format!("nsh-engine-trusted-paths-{}", std::process::id()));
    let plugin = root.join("plugin");
    let home = root.join("home");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(plugin.join("source.txt"), "plugin").unwrap();
    std::fs::write(home.join("home.txt"), "home").unwrap();
    let entry = plugin.join("App.tsx");
    std::fs::write(
        &entry,
        r#"import {mount, signal, Text} from 'nsh';
import fs from 'fs/promises';
const status = signal('waiting');
Promise.all([
  fs.readFile('source.txt', 'utf8'),
  fs.readFile('${pluginDir}/source.txt', 'utf8'),
  fs.readFile('${homeDir}/home.txt', 'utf8'),
]).then(values => status.set(values.join('|')), error => status.set(String(error)));
mount(() => <Text>{status()}</Text>);"#,
    )
    .unwrap();
    let bundled = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
        ..Default::default()
    })
    .unwrap();
    let mut paths = nsh_core::access::TrustedPaths::default();
    paths.plugin_dir = Some(plugin);
    paths.home_dir = Some(home);
    let bundle = Bundle::source(bundled.code)
        .with_app_id(Some("com.example.anchors"))
        .with_system_paths(paths)
        .with_capabilities_json(Some(r#"{"fs":{"read":["${pluginDir}","${homeDir}"]}}"#))
        .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(bundle),
        viewport: Size::new(nsh_core::geometry::px(400.0), nsh_core::geometry::px(300.0)),
        trace: false,
        content_culling: false,
        network: None,
        websocket: None,
        refuse_connections: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
        environment: Environment {
            os: Os::Linux,
            ..Default::default()
        },
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        support_dir: Some(root.join("data")),
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
        audio: None,
        windows: None,
        login_item: None,
        data_dir: None,
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut shown = Vec::new();
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        let Ok(batch) = rx.recv_timeout(remaining) else {
            break;
        };
        shown.extend(batch.items.iter().filter_map(|item| match item {
            MountItem::Text { text, .. } => Some(text.text.clone()),
            _ => None,
        }));
        if shown.iter().any(|text| text == "plugin|plugin|home") {
            break;
        }
    }
    drop(engine);
    std::fs::remove_dir_all(root).unwrap();
    assert!(
        shown.iter().any(|text| text == "plugin|plugin|home"),
        "anchors never reached the VM: {shown:?}"
    );
}

#[test]
fn process_exit_requests_the_platform_to_close_the_app() {
    let bundle = Bundle::source("import process from 'process'; process.exit(7);".to_owned())
        .with_capabilities_json(Some(r#"{"process":{"exit":true}}"#))
        .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(
        EngineConfig::new(bundle),
        || ApproxTextEngine,
        ChannelSink(tx),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut closed = false;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        let Ok(batch) = rx.recv_timeout(remaining) else {
            break;
        };
        if batch.items.iter().any(|item| matches!(item, MountItem::Command { id, command: nsh_core::Command::ExitApp } if *id == nsh_core::ROOT_ID)) {
            closed = true;
            break;
        }
    }
    drop(engine);
    assert!(
        closed,
        "process.exit did not reach the platform command path"
    );
}
