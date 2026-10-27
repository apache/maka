//! `nsh/host`: calls into the app embedding NSH and its events, answered
//! by a stand-in for the platform (as `components.rs`' clipboard is).

use crossbeam_channel::Receiver;
use nsh_core::{Command, EventKind, EventPayload, MountBatch, MountItem, ROOT_ID};
use nsh_engine::{Engine, Environment};
use serde_json::json;

use crate::components::{shows, start_with, until};

/// What the tests' apps declare: every host function granted.
const ALL: Option<&str> = Some(r#"{ "host": true }"#);

/// A platform that embeds a host.
fn with_host() -> Environment {
    Environment {
        host: true,
        ..Environment::default()
    }
}

/// Calls each of `names` with `{ a: 1 }` and shows `available()` and what
/// each call settled with.
fn calls(names: &[&str]) -> String {
    let names = serde_json::to_string(names).unwrap();
    format!(
        r#"import {{ mount, signal, Text }} from "nsh";
import {{ host }} from "nsh";

const shown = signal("waiting");
const settled = async (p) => {{
  try {{ return JSON.stringify(await p); }} catch (e) {{ return `rejected ${{e.message}}`; }}
}};
setTimeout(async () => {{
  const results = [];
  for (const name of {names}) results.push(await settled(host.call(name, {{ a: 1 }})));
  shown.set(`${{host.available()}} ${{results.join(" | ")}}`);
}}, 0);

mount(() => <Text>{{shown()}}</Text>);
"#
    )
}

/// A host on the platform: answers each call with its arguments, `fail`
/// with an error. Returns the calls that reached it.
fn serve_host(
    engine: &Engine,
    rx: &Receiver<MountBatch>,
    mut done: impl FnMut(&str) -> bool,
) -> Vec<Command> {
    let control = engine.control();
    let mut commands = Vec::new();
    until(rx, |batch| {
        for item in &batch.items {
            let MountItem::Command {
                id: ROOT_ID,
                command: command @ Command::HostCall { id, name, args },
            } = item
            else {
                continue;
            };
            let reply = if name == "fail" {
                json!({ "type": "reply", "id": id, "ok": false, "error": "boom" })
            } else {
                json!({ "type": "reply", "id": id, "ok": true, "value": args })
            };
            control.dispatch_event(ROOT_ID, EventKind::Host, EventPayload::Json(reply));
            commands.push(command.clone());
        }
        texts(batch).any(|t| done(&t))
    });
    commands
}

fn texts(batch: &MountBatch) -> impl Iterator<Item = String> + '_ {
    batch.items.iter().filter_map(|i| match i {
        MountItem::Text { text, .. } => Some(text.text.to_string()),
        _ => None,
    })
}

/// The names of the calls that reached the platform.
fn names(commands: &[Command]) -> Vec<&str> {
    commands
        .iter()
        .filter_map(|c| match c {
            Command::HostCall { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn host_call_round_trips_through_the_platform() {
    let echo = Some(r#"{ "host": ["echo"] }"#);
    let (engine, rx) = start_with(&calls(&["echo"]), with_host(), echo, None);
    let commands = serve_host(&engine, &rx, |t| t == r#"true {"a":1}"#);
    assert_eq!(
        commands,
        [Command::HostCall {
            id: 1,
            name: "echo".into(),
            args: json!({ "a": 1 }),
        }]
    );
    // Without a host, nothing reaches the platform and calls reject.
    let (engine, rx) = start_with(&calls(&["echo"]), Environment::default(), echo, None);
    let commands = serve_host(&engine, &rx, |t| {
        t == "false rejected nsh/host: this platform has no host"
    });
    assert!(commands.is_empty(), "{commands:?}");
}

#[test]
fn a_failing_host_call_rejects_with_its_message() {
    let (engine, rx) = start_with(&calls(&["fail"]), with_host(), ALL, None);
    let mut shown = String::new();
    serve_host(&engine, &rx, |t| {
        let done = t.starts_with("true ");
        if done {
            shown = t.to_owned();
        }
        done
    });
    assert_eq!(shown, "true rejected boom");
}

#[test]
fn host_calls_need_their_capability() {
    // Declared without `host`, and not declared at all: denied alike (the
    // other capabilities keep their grant-all default for apps without a
    // declaration; the host's functions never do).
    for capabilities in [Some("{}"), None] {
        host_call_is_denied(capabilities);
    }
}

fn host_call_is_denied(capabilities: Option<&str>) {
    crate::logs::capture();
    let (engine, rx) = start_with(&calls(&["echo"]), with_host(), capabilities, None);
    let mut shown = String::new();
    let commands = serve_host(&engine, &rx, |t| {
        let done = t.starts_with("true ");
        if done {
            shown = t.to_owned();
        }
        done
    });
    assert!(commands.is_empty(), "{commands:?}");
    assert!(
        shown.starts_with("true rejected ") && shown.contains("capabilities.host"),
        "{shown}"
    );
    // The refusal is logged, saying which key to add.
    let logged = crate::logs::lines_containing("nsh/host: `echo` is not granted");
    assert!(
        logged.iter().any(|w| w.contains("capabilities.host")),
        "{logged:?}"
    );
}

#[test]
fn host_allowlist_matches_prefixes() {
    let (engine, rx) = start_with(
        &calls(&["bridge.call", "other"]),
        with_host(),
        Some(r#"{ "host": ["bridge.*"] }"#),
        None,
    );
    let mut shown = String::new();
    let commands = serve_host(&engine, &rx, |t| {
        let done = t.starts_with("true ");
        if done {
            shown = t.to_owned();
        }
        done
    });
    assert_eq!(names(&commands), ["bridge.call"]);
    assert!(shown.starts_with(r#"true {"a":1} | rejected "#), "{shown}");
}

const EVENTS: &str = r#"import { mount, signal, Text } from "nsh";
import { host } from "nsh";

const shown = signal("waiting");
let once = 0;
let all = 0;
const first = host.on("tick", () => {
  once++;
  first.remove();
});
host.on("tick", (payload) => {
  all++;
  shown.set(`${once} ${all} ${JSON.stringify(payload)}`);
});
host.on("other", () => shown.set("wrong event"));
setTimeout(() => shown.set("ready"), 0);

mount(() => <Text>{shown()}</Text>);
"#;

#[test]
fn host_events_reach_listeners_until_removed() {
    let (engine, rx) = start_with(EVENTS, with_host(), Some("{}"), None);
    until(&rx, |b| shows(b, "ready"));
    for n in [1, 2] {
        engine.control().dispatch_event(
            ROOT_ID,
            EventKind::Host,
            EventPayload::Json(json!({ "type": "event", "event": "tick", "payload": { "n": n } })),
        );
    }
    let batches = until(&rx, |b| shows(b, r#"1 2 {"n":2}"#));
    assert!(
        batches.iter().any(|b| shows(b, r#"1 2 {"n":2}"#)),
        "{:?}",
        batches.iter().flat_map(texts).collect::<Vec<_>>()
    );
}

/// Calls `slow` with `options` (JS) once the app runs, and shows how it
/// settled.
fn timed(options: &str) -> String {
    format!(
        r#"import {{ mount, signal, Text }} from "nsh";
import {{ host }} from "nsh";

const shown = signal("waiting");
setTimeout(() => {{
  host.call("slow", null, {options}).then(
    (value) => shown.set(`ok ${{JSON.stringify(value)}}`),
    (e) => shown.set(`rejected ${{e.message}}`),
  );
}}, 0);

mount(() => <Text>{{shown()}}</Text>);
"#
    )
}

/// The ids of the host calls in `batches`.
fn call_ids(batches: &[MountBatch]) -> Vec<u64> {
    batches
        .iter()
        .flat_map(|b| &b.items)
        .filter_map(|item| match item {
            MountItem::Command {
                command: Command::HostCall { id, .. },
                ..
            } => Some(*id),
            _ => None,
        })
        .collect()
}

fn reply(engine: &Engine, id: u64, value: serde_json::Value) {
    reply_with_id(engine, json!(id), value);
}

fn reply_with_id(engine: &Engine, id: serde_json::Value, value: serde_json::Value) {
    engine.control().dispatch_event(
        ROOT_ID,
        EventKind::Host,
        EventPayload::Json(json!({ "type": "reply", "id": id, "ok": true, "value": value })),
    );
}

#[test]
fn a_host_call_times_out_and_its_late_reply_is_ignored() {
    let (engine, rx) = start_with(&timed("{ timeout: 200 }"), with_host(), ALL, None);
    let batches = until(&rx, |b| {
        shows(b, "rejected nsh/host: slow timed out after 200 ms")
    });
    assert!(
        batches
            .iter()
            .any(|b| shows(b, "rejected nsh/host: slow timed out after 200 ms")),
        "{:?}",
        batches.iter().flat_map(texts).collect::<Vec<_>>()
    );
    let ids = call_ids(&batches);
    assert_eq!(ids.len(), 1, "{ids:?}");
    // The host answers late: nothing changes, nothing fails.
    reply(&engine, ids[0], json!(1));
    let after = until(&rx, |_| false);
    assert!(
        !after.iter().flat_map(texts).any(|t| t.starts_with("ok")),
        "{:?}",
        after.iter().flat_map(texts).collect::<Vec<_>>()
    );
}

#[test]
fn a_reply_before_the_timeout_wins() {
    let (engine, rx) = start_with(&timed("{ timeout: 300 }"), with_host(), ALL, None);
    let mut answered = false;
    let batches = until(&rx, |b| {
        if !answered && let Some(&id) = call_ids(std::slice::from_ref(b)).first() {
            reply(&engine, id, json!(7));
            answered = true;
        }
        shows(b, "ok 7")
    });
    assert!(batches.iter().any(|b| shows(b, "ok 7")));
    // Past the timeout, the settled call stays settled.
    std::thread::sleep(std::time::Duration::from_millis(400));
    let after = until(&rx, |_| false);
    assert!(
        !after
            .iter()
            .flat_map(texts)
            .any(|t| t.starts_with("rejected")),
        "{:?}",
        after.iter().flat_map(texts).collect::<Vec<_>>()
    );
}

#[test]
fn a_timeout_of_zero_waits_for_the_host() {
    let (engine, rx) = start_with(&timed("{ timeout: 0 }"), with_host(), ALL, None);
    let mut ids = Vec::new();
    // No answer for a while: the call keeps waiting.
    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_millis(600) {
        let batches = until(&rx, |_| false);
        ids.extend(call_ids(&batches));
        assert!(
            !batches
                .iter()
                .flat_map(texts)
                .any(|t| t.starts_with("rejected")),
            "{:?}",
            batches.iter().flat_map(texts).collect::<Vec<_>>()
        );
    }
    assert_eq!(ids.len(), 1, "{ids:?}");
    reply(&engine, ids[0], json!("late"));
    let batches = until(&rx, |b| shows(b, r#"ok "late""#));
    assert!(batches.iter().any(|b| shows(b, r#"ok "late""#)));
}

#[test]
fn host_function_names_outside_their_charset_are_refused() {
    // Granted everything, yet none of these reach the host: a host that
    // puts the name in a path or a URL never sees `/` or `..`.
    let long = "a".repeat(129);
    let bad = [
        "user.x/../../admin",
        "",
        "a..b",
        "user x",
        "ok\u{0}",
        long.as_str(),
    ];
    let (engine, rx) = start_with(&calls(&bad), with_host(), ALL, None);
    let mut shown = String::new();
    let commands = serve_host(&engine, &rx, |t| {
        let done = t.starts_with("true ");
        if done {
            shown = t.to_owned();
        }
        done
    });
    assert!(commands.is_empty(), "{commands:?}");
    let results: Vec<&str> = shown.trim_start_matches("true ").split(" | ").collect();
    assert_eq!(results.len(), bad.len(), "{shown}");
    assert!(
        results
            .iter()
            .all(|r| r.starts_with("rejected nsh/host: invalid function name")),
        "{shown}"
    );
    // The longest name and every character of the set pass.
    let max = "a".repeat(128);
    let good = ["user.info", "a-b_c:d.E9", max.as_str()];
    let (engine, rx) = start_with(&calls(&good), with_host(), ALL, None);
    let commands = serve_host(&engine, &rx, |t| t.starts_with("true "));
    assert_eq!(names(&commands), good);
}

#[test]
fn timeouts_past_the_clocks_reach_wait_without_limit() {
    // Too long for a `Duration` (1e30 ms) or for the clock's `Instant`
    // (1.5e22 ms): the call waits for the host as with 0, and the engine
    // goes on.
    for timeout in ["1e30", "1.5e22"] {
        let options = format!("{{ timeout: {timeout} }}");
        let (engine, rx) = start_with(&timed(&options), with_host(), ALL, None);
        let mut answered = false;
        let batches = until(&rx, |b| {
            if !answered && let Some(&id) = call_ids(std::slice::from_ref(b)).first() {
                reply(&engine, id, json!(timeout));
                answered = true;
            }
            shows(b, &format!(r#"ok "{timeout}""#))
        });
        assert!(
            batches
                .iter()
                .any(|b| shows(b, &format!(r#"ok "{timeout}""#))),
            "{timeout}: {:?}",
            batches.iter().flat_map(texts).collect::<Vec<_>>()
        );
    }
}

#[test]
fn negative_and_non_finite_timeouts_reject() {
    for (timeout, shown) in [("-1", "-1"), ("NaN", "NaN"), ("Infinity", "inf")] {
        let options = format!("{{ timeout: {timeout} }}");
        let (_engine, rx) = start_with(&timed(&options), with_host(), ALL, None);
        let wanted = format!("rejected nsh/host: invalid timeout {shown}");
        let batches = until(&rx, |b| shows(b, &wanted));
        assert!(
            batches.iter().any(|b| shows(b, &wanted)),
            "{timeout}: {:?}",
            batches.iter().flat_map(texts).collect::<Vec<_>>()
        );
        assert!(call_ids(&batches).is_empty());
    }
}

#[test]
fn a_reply_whose_id_is_not_a_whole_number_answers_no_call() {
    let (engine, rx) = start_with(&timed("{ timeout: 0 }"), with_host(), ALL, None);
    let mut answered = false;
    let batches = until(&rx, |b| {
        if !answered && let Some(&id) = call_ids(std::slice::from_ref(b)).first() {
            assert_eq!(id, 1);
            // 1.5 is not call 1; 1.0 is (JSON numbers may come as floats).
            reply_with_id(&engine, json!(1.5), json!("half"));
            reply_with_id(&engine, json!(1.0), json!("whole"));
            answered = true;
        }
        shows(b, r#"ok "whole""#) || shows(b, r#"ok "half""#)
    });
    assert!(
        batches.iter().any(|b| shows(b, r#"ok "whole""#)),
        "{:?}",
        batches.iter().flat_map(texts).collect::<Vec<_>>()
    );
}

const THROWING_LISTENER: &str = r#"import { mount, signal, Text } from "nsh";
import { host } from "nsh";

const shown = signal("waiting");
host.on("tick", () => {
  throw new Error("first listener");
});
host.on("tick", (payload) => shown.set(`second ${JSON.stringify(payload)}`));
setTimeout(() => shown.set("ready"), 0);

mount(() => <Text>{shown()}</Text>);
"#;

#[test]
fn a_throwing_host_listener_leaves_the_others_called() {
    crate::logs::capture();
    let (engine, rx) = start_with(THROWING_LISTENER, with_host(), Some("{}"), None);
    until(&rx, |b| shows(b, "ready"));
    engine.control().dispatch_event(
        ROOT_ID,
        EventKind::Host,
        EventPayload::Json(json!({ "type": "event", "event": "tick", "payload": 1 })),
    );
    let batches = until(&rx, |b| shows(b, "second 1"));
    assert!(
        batches.iter().any(|b| shows(b, "second 1")),
        "{:?}",
        batches.iter().flat_map(texts).collect::<Vec<_>>()
    );
    // The first listener's error is still reported.
    assert!(!crate::logs::wait_for("first listener").is_empty());
}
