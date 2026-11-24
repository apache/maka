//! A Rust app's `host_call`, `host_post` and `on_host_event` (TS: `nsh`'s
//! `host`): the embedding app's `HostChannel` answers them where it has
//! handlers or sent events, the platform's host (the web page's) where it
//! has one, and calls fail with `Unavailable` elsewhere. The same
//! capability and errors as TSX's.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventPayload, JsonValue, MountBatch, MountItem, ROOT_ID,
    element::Root, prelude::*,
};
use nsh_engine::{App, Engine, EngineConfig, Environment, HostChannel};
use serde_json::json;

use crate::{
    ChannelSink,
    components::{shows, until},
};

/// What a call settled with: its value, or the error's code.
fn settled(result: Result<JsonValue, HostError>) -> String {
    match result {
        Ok(value) => value.to_string(),
        Err(error) => error.code().unwrap_or("TypeError").to_owned(),
    }
}

/// Calls `user.profile`, a function its handler fails, one nobody handles,
/// one the app is not granted and one of no valid name; posts `analytics`;
/// shows what the calls settled with and the `greet` events it heard.
#[component]
fn HostApp() -> impl IntoElement {
    let shown = signal(String::from("waiting"));
    let heard = signal(Vec::<String>::new());
    on_host_event("greet", move |payload: &JsonValue| {
        heard.update(|h| h.push(payload.to_string()))
    });
    spawn(async move {
        let mut results = Vec::new();
        for name in [
            "user.profile",
            "user.fail",
            "user.missing",
            "admin.wipe",
            "user/../x",
        ] {
            results.push(settled(host_call(name, json!({ "id": 7 })).await));
        }
        host_post("analytics", json!({ "event": "open" }));
        host_post("admin.log", json!({ "event": "refused" }));
        shown.set(results.join(" | "));
    });
    view().child(text(move || {
        format!("{} ; heard {}", shown.get(), heard.get().join(","))
    }))
}

fn root() -> Root {
    Root::of::<HostApp>().capabilities_json(r#"{ "host": ["user.*", "analytics"] }"#)
}

fn start(
    root: Root,
    environment: Environment,
    host: &HostChannel,
) -> (Engine, Receiver<MountBatch>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        environment,
        host: host.clone(),
        ..EngineConfig::new(App::Rust(root))
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// Waits until a text the app shows contains `wanted`.
fn wait_for(rx: &Receiver<MountBatch>, wanted: &str) -> Vec<MountBatch> {
    let has = |batch: &MountBatch| {
        texts(std::slice::from_ref(batch))
            .iter()
            .any(|t| t.contains(wanted))
    };
    let batches = until(rx, has);
    assert!(
        batches.last().is_some_and(has),
        "never showed {wanted:?}: {:?}",
        texts(&batches)
    );
    batches
}

fn texts(batches: &[MountBatch]) -> Vec<String> {
    batches
        .iter()
        .flat_map(|b| &b.items)
        .filter_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.to_string()),
            _ => None,
        })
        .collect()
}

const RESULTS: &str = r#"{"id":7,"name":"Ada"} | ERR_NSH_HOST_ERROR | ERR_NSH_HOST_ERROR | ERR_ACCESS_DENIED | TypeError"#;

#[test]
fn a_rust_app_calls_posts_and_hears_the_embedding_app() {
    let host = HostChannel::new();
    let posts = Arc::new(Mutex::new(Vec::new()));
    host.handle("user.profile", |call| {
        let id = call.data()["id"].clone();
        call.resolve(json!({ "id": id, "name": "Ada" }));
    });
    host.handle("user.fail", |call| call.reject("boom"));
    let seen = posts.clone();
    host.handle("analytics", move |call| {
        assert!(call.is_post());
        seen.lock().unwrap().push(call.data().clone());
    });
    // Granted to nobody: the app's post of it never reaches the handler.
    let refused = posts.clone();
    host.handle("admin.log", move |call| {
        refused.lock().unwrap().push(call.data().clone())
    });
    // An event sent before the app starts reaches its first listeners.
    host.send("greet", json!("early")).unwrap();
    let (_engine, rx) = start(root(), Environment::default(), &host);
    wait_for(&rx, &format!("{RESULTS} ; heard \"early\""));
    assert_eq!(*posts.lock().unwrap(), vec![json!({ "event": "open" })]);

    host.send("greet", json!({ "who": "Ada" })).unwrap();
    wait_for(&rx, r#"heard "early",{"who":"Ada"}"#);
}

#[test]
fn a_rust_app_calls_the_platform_host_without_a_channel() {
    let environment = Environment {
        host: true,
        ..Environment::default()
    };
    let (engine, rx) = start(root(), environment, &HostChannel::new());
    let control = engine.control();
    let mut commands = Vec::new();
    let done = format!("{RESULTS} ; heard ");
    until(&rx, |batch| {
        for item in &batch.items {
            let MountItem::Command {
                id: ROOT_ID,
                command,
            } = item
            else {
                continue;
            };
            if let Command::HostCall { id, name, args } = command {
                let reply = match name.as_str() {
                    "user.profile" => {
                        json!({ "type": "reply", "id": id, "ok": true, "value": { "id": args["id"], "name": "Ada" } })
                    }
                    _ => {
                        json!({ "type": "reply", "id": id, "ok": false, "error": "no such function" })
                    }
                };
                control.dispatch_event(ROOT_ID, EventKind::Host, EventPayload::Json(reply));
            }
            commands.push(command.clone());
        }
        shows(batch, &done)
    });
    let names: Vec<_> = commands
        .iter()
        .filter_map(|c| match c {
            Command::HostCall { name, .. } => Some(format!("call {name}")),
            Command::HostPost { name, args } => Some(format!("post {name} {args}")),
            _ => None,
        })
        .collect();
    // Refused calls and posts never reach the platform.
    assert_eq!(
        names,
        [
            "call user.profile",
            "call user.fail",
            "call user.missing",
            r#"post analytics {"event":"open"}"#,
        ]
    );
    // The page's events reach the listeners.
    control.dispatch_event(
        ROOT_ID,
        EventKind::Host,
        EventPayload::Json(json!({ "type": "event", "event": "greet", "payload": [1, 2] })),
    );
    wait_for(&rx, "heard [1,2]");
}

#[test]
fn without_a_host_calls_are_unavailable_and_posts_go_nowhere() {
    let (_engine, rx) = start(root(), Environment::default(), &HostChannel::new());
    let batches = wait_for(
        &rx,
        "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM | ERR_FEATURE_UNAVAILABLE_ON_PLATFORM | ERR_FEATURE_UNAVAILABLE_ON_PLATFORM | ERR_ACCESS_DENIED | TypeError",
    );
    let posted = batches.iter().flat_map(|b| &b.items).any(|i| {
        matches!(
            i,
            MountItem::Command {
                command: Command::HostPost { .. } | Command::HostCall { .. },
                ..
            }
        )
    });
    assert!(!posted);
}

/// Waits `timeout_ms` (the default without one) for `slow`'s answer.
#[derive(Clone, PartialEq, Props)]
struct SlowProps {
    #[prop(default)]
    timeout_ms: Option<u32>,
}

#[component]
fn Slow(props: SlowProps) -> impl IntoElement {
    let shown = signal(String::from("waiting"));
    let options = match props.timeout_ms {
        Some(ms) => HostCallOptions::default().timeout(Duration::from_millis(ms.into())),
        None => HostCallOptions::default(),
    };
    spawn(async move {
        let result = host_call_with("slow", JsonValue::Null, options).await;
        shown.set(match result {
            Err(HostError::TimedOut { name, timeout }) => {
                format!("{name} timed out after {} ms", timeout.as_millis())
            }
            other => settled(other),
        });
    });
    view().child(text(move || shown.get()))
}

#[test]
fn a_call_the_host_does_not_answer_in_time_times_out() {
    let host = HostChannel::new();
    let held = Arc::new(Mutex::new(Vec::new()));
    let keep = held.clone();
    host.handle("slow", move |call| keep.lock().unwrap().push(call));
    let root = Root::new::<Slow>(|| SlowProps {
        timeout_ms: Some(100),
    })
    .capabilities_json(r#"{ "host": true }"#);
    let (_engine, rx) = start(root, Environment::default(), &host);
    wait_for(&rx, "slow timed out after 100 ms");
    // Its late answer goes nowhere.
    for call in held.lock().unwrap().drain(..) {
        call.resolve(json!("late"));
    }
    let after = until(&rx, |_| false);
    assert!(!texts(&after).iter().any(|t| t.contains("late")));
}

/// Counts `tick` events in a branch `stop` removes: its listener goes
/// with it.
#[component]
fn Ticker() -> impl IntoElement {
    let ticks = signal(0);
    let listening = signal(true);
    on_host_event("stop", move |_: &JsonValue| listening.set(false));
    view()
        .child(when(listening, move || {
            on_host_event("tick", move |_: &JsonValue| ticks.update(|t| *t += 1));
            view()
        }))
        .child(text(move || {
            format!("ticks {} listening {}", ticks.get(), listening.get())
        }))
}

#[test]
fn a_listener_stops_with_its_owner() {
    let host = HostChannel::new();
    let (_engine, rx) = start(Root::of::<Ticker>(), Environment::default(), &host);
    wait_for(&rx, "ticks 0 listening true");
    host.send("tick", JsonValue::Null).unwrap();
    wait_for(&rx, "ticks 1 listening true");
    host.send("stop", JsonValue::Null).unwrap();
    wait_for(&rx, "ticks 1 listening false");
    host.send("tick", JsonValue::Null).unwrap();
    let after = until(&rx, |_| false);
    assert!(!texts(&after).iter().any(|t| t.contains("ticks 2")));
}

/// Listens to `greet` only once `ready` came, as an app that loads first;
/// `ready`'s listener is there from the start.
#[component]
fn LateListener() -> impl IntoElement {
    let ready = signal(false);
    let heard = signal(Vec::<String>::new());
    on_host_event("ready", move |_: &JsonValue| ready.set(true));
    view()
        .child(when(ready, move || {
            on_host_event("greet", move |payload: &JsonValue| {
                heard.update(|h| h.push(payload.to_string()))
            });
            view()
        }))
        .child(text(move || {
            format!("ready {} heard {}", ready.get(), heard.get().join(","))
        }))
}

#[test]
fn a_listener_added_late_hears_the_events_kept_for_it() {
    let host = HostChannel::new();
    // One before the app starts and one after: no listener of `greet` is
    // there for either, so both wait for the first.
    host.send("greet", json!("early")).unwrap();
    let (_engine, rx) = start(Root::of::<LateListener>(), Environment::default(), &host);
    wait_for(&rx, "ready false heard ");
    host.send("greet", json!("started")).unwrap();
    host.send("ready", JsonValue::Null).unwrap();
    wait_for(&rx, r#"ready true heard "early","started""#);
    // Heard, they are not kept: later events follow them.
    host.send("greet", json!("live")).unwrap();
    wait_for(&rx, r#"heard "early","started","live""#);
}

#[test]
fn a_call_answered_later_from_another_thread_settles() {
    let host = HostChannel::new();
    host.handle("slow", |call| {
        let reply = call.into_reply().unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            reply.resolve(json!("later"));
        });
    });
    let root = Root::of::<Slow>().capabilities_json(r#"{ "host": true }"#);
    let (_engine, rx) = start(root, Environment::default(), &host);
    wait_for(&rx, r#""later""#);
}
