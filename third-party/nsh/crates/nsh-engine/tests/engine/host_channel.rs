//! `nsh/host` with the embedding app's `HostChannel`: launch parameters,
//! events (kept until the app listens, and while no app runs), calls the
//! host answers at once, later from another thread, with an error, not at
//! all or that it does not handle, posts, and stopping to listen.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, MountBatch, MountItem, Size, geometry::px};
use nsh_engine::{Bundle, Engine, EngineConfig, HostChannel, JsonValue};
use serde_json::json;

use crate::ChannelSink;

fn bundle(app: &str) -> Bundle {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = crate::temporary_root().join(format!(
        "nsh-host-channel-{}-{}",
        std::process::id(),
        APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
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
    // SAFETY: compiled just now by this runtime.
    unsafe { Bundle::bytecode(bytecode) }.with_policy(nsh_engine::Policy {
        declared: Some(
            nsh_core::access::Capabilities::from_json(&json!({ "host": true })).unwrap(),
        ),
        ..Default::default()
    })
}

fn start(bundle: Bundle, host: &HostChannel) -> (Engine, Receiver<MountBatch>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        viewport: Size::new(px(400.0), px(600.0)),
        host: host.clone(),
        ..EngineConfig::new(bundle)
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// Waits for a shown text containing every one of `parts` and returns it;
/// panics with the last text after a few seconds.
fn wait_for(rx: &Receiver<MountBatch>, parts: &[&str]) -> String {
    let mut last = String::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let Ok(batch) = rx.recv_timeout(Duration::from_millis(100)) else {
            continue;
        };
        for item in batch.items {
            if let MountItem::Text { text, .. } = item {
                last = text.text.to_string();
            }
        }
        if parts.iter().all(|p| last.contains(p)) {
            return last;
        }
    }
    panic!("no text with {parts:?}; last: {last}");
}

/// The texts shown within `time`.
fn texts_within(rx: &Receiver<MountBatch>, time: Duration) -> Vec<String> {
    let mut texts = Vec::new();
    let deadline = std::time::Instant::now() + time;
    while let Ok(batch) = rx.recv_deadline(deadline) {
        for item in batch.items {
            if let MountItem::Text { text, .. } = item {
                texts.push(text.text.to_string());
            }
        }
    }
    texts
}

const APP: &str = r#"import { mount, signal, Text } from "nsh";
import { host } from "nsh";

const log = signal<string[]>([]);
const say = (s: string) => log.set([...log(), s]);

say(`params ${host.params.conversation} ${typeof host.params}`);

// Listened to after the event came: kept until then.
setTimeout(() => {
  host.on("early", (d: any) => say(`early ${d.a}`));
}, 10);
const off = host.on("ping", (d) => say(`ping ${d}`));
host.on("stop", () => off());

host.call("echo", { n: 1 }).then((v: any) => say(`echo ${v.got.n}`));
host.call("fail").catch((e) => say(`fail ${e instanceof Error} ${e.message}`));
host.call("missing").catch((e) => say(`missing ${e.message}`));
host.call("dropped").catch((e) => say(`dropped ${e.message}`));
host.call("later", 21).then((v) => say(`later ${v}`));
host.post("analytics", { screen: "home", f: () => 1 });
try {
  host.on("", () => {});
} catch (e) {
  say(`bad ${(e as Error).name}`);
}
host.call(42 as any).catch((e) => say(`not a name ${e.name}`));

mount(() => <Text>{log().join(" | ")}</Text>);
"#;

#[test]
fn the_app_and_its_host_talk() {
    let host = HostChannel::new();
    let mut params = serde_json::Map::new();
    params.insert("conversation".into(), json!("c-42"));
    host.set_params(params);
    // Before the app runs: kept for it.
    host.send("early", json!({ "a": 1 })).unwrap();
    host.handle("echo", |call| {
        let data = call.data().clone();
        call.resolve(json!({ "got": data }));
    });
    host.handle("fail", |call| call.reject("nope"));
    host.handle("dropped", drop);
    host.handle("later", |call| {
        // Answered from another thread, later.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            let n = call.data().as_i64().unwrap_or(0);
            call.resolve(json!(n * 2));
        });
    });
    let (posts_tx, posts) = crossbeam_channel::unbounded();
    host.handle("analytics", move |call| {
        assert!(call.is_post());
        let _ = posts_tx.send(call.data().clone());
    });

    let (engine, rx) = start(bundle(APP), &host);
    let text = wait_for(
        &rx,
        &[
            "params c-42 object",
            "early 1",
            "echo 1",
            "fail true nope",
            "missing host.call(\"missing\"): the embedding app handles no \"missing\"",
            "dropped host.call(\"dropped\"): the embedding app did not answer",
            "later 42",
            "bad TypeError",
            "not a name TypeError",
        ],
    );
    assert!(!text.contains("ping"), "{text}");
    // Functions are left out, as `JSON.stringify` leaves them.
    assert_eq!(
        posts.recv_timeout(Duration::from_secs(1)).unwrap(),
        json!({ "screen": "home" })
    );

    host.send("ping", json!(1)).unwrap();
    wait_for(&rx, &["ping 1"]);
    // No listener any more: kept, not delivered.
    host.send("stop", JsonValue::Null).unwrap();
    host.send("ping", json!(2)).unwrap();
    let texts = texts_within(&rx, Duration::from_millis(300));
    assert!(texts.iter().all(|t| !t.contains("ping 2")), "{texts:?}");
    drop(engine);
}

const LISTENER: &str = r#"import { mount, signal, Text } from "nsh";
import { host } from "nsh";

const seen = signal<string[]>([]);
host.on("open", (d: any) => seen.set([...seen(), d.id]));
mount(() => <Text>{`opened ${seen().join(",")}`}</Text>);
"#;

#[test]
fn events_wait_for_the_next_app() {
    let host = HostChannel::new();
    let (engine, rx) = start(bundle(LISTENER), &host);
    host.send("open", json!({ "id": "a" })).unwrap();
    wait_for(&rx, &["opened a"]);
    drop(engine);
    // No app runs: the next one gets them, in order.
    host.send("open", json!({ "id": "b" })).unwrap();
    host.send("open", json!({ "id": "c" })).unwrap();
    let (engine, rx) = start(bundle(LISTENER), &host);
    wait_for(&rx, &["opened b,c"]);
    drop(engine);
    assert!(host.send("", JsonValue::Null).is_err());
}

const PARAMS: &str = r#"import { mount, Text } from "nsh";
import { host } from "nsh";

mount(() => <Text>{`keys ${Object.keys(host.params).length}`}</Text>);
"#;

#[test]
fn an_app_without_parameters_reads_an_empty_object() {
    let (engine, rx) = start(bundle(PARAMS), &HostChannel::new());
    wait_for(&rx, &["keys 0"]);
    drop(engine);
}
