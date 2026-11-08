//! `Notifications` of `nsh` from JS: the platform's answers reach the
//! promises and `press` listeners, and a capability refused rejects.

use std::time::Duration;

use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventPayload, MountItem, PayloadValue, ROOT_ID, Size,
    geometry::px,
    notifications::{Notification, NotificationCommand as N, NotificationEvent as Field},
};
use nsh_engine::{Bundle, Capabilities, Engine, EngineConfig};

use crate::ChannelSink;

const APP: &str = r#"
import { mount, Notifications, signal, Text } from "nsh";
function App() {
  const said = signal("");
  const say = (s) => said.set(`${said()} ${s}`);
  Notifications.on("press", ({ id }) => say(`pressed:${id}`));
  (async () => {
    await Notifications.setBadge(4);
    await Notifications.close("old");
    for (const count of [-1, 1.5]) await Notifications.setBadge(count).catch((e) => say(e.name));
    await Notifications.show({ id: "", title: "T" }).catch((e) => say(e.name));
    say(await Notifications.requestPermission());
    say(`shown:${await Notifications.show({ id: "a", title: "T", body: "B" })}`);
    say(`silent:${await Notifications.show({ id: "b", title: "T", silent: true })}`);
  })();
  return <Text>{said()}</Text>;
}
mount(App);
"#;

const DENIED: &str = r#"
import { mount, Notifications, signal, Text } from "nsh";
function App() {
  const said = signal("");
  const say = (e) => said.set(`${said()} ${e.code}/${e.permission}`);
  try {
    Notifications.on("press", () => {});
  } catch (e) {
    say(e);
  }
  (async () => {
    await Notifications.setBadge(1).catch(say);
    await Notifications.permission().catch(say);
  })();
  return <Text>{said()}</Text>;
}
mount(App);
"#;

fn bundle(app: &str, name: &str) -> Bundle {
    let dir =
        crate::temporary_root().join(format!("nsh-notifications-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    let ui_sets = [nsh_base::registry()];
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
    // SAFETY: compiled just now by this runtime.
    unsafe { Bundle::bytecode(bytecode) }
}

/// Plays a platform that shows notifications until a text contains `end`,
/// granting what is asked and pressing `a` once it shows.
fn play(config: EngineConfig, end: &str) -> (String, Vec<N>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let control = engine.control();
    let mut text = String::new();
    let mut commands = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        let Ok(batch) = rx.recv_timeout(Duration::from_millis(100)) else {
            continue;
        };
        for item in batch.items {
            match item {
                MountItem::Text { text: t, .. } => text = t.text.to_string(),
                MountItem::Command {
                    id: ROOT_ID,
                    command: Command::Notification(command),
                } => {
                    let answer = match &command {
                        N::Permission { id, .. } => vec![
                            (Field::ID, PayloadValue::Number(f64::from(*id))),
                            (Field::PERMISSION, PayloadValue::Str("granted".into())),
                        ],
                        N::Show { id, .. } => vec![
                            (Field::ID, PayloadValue::Number(f64::from(*id))),
                            (Field::SHOWN, PayloadValue::Bool(true)),
                        ],
                        _ => vec![],
                    };
                    let shown = matches!(command, N::Show { .. });
                    commands.push(command);
                    if !answer.is_empty() {
                        control.dispatch_event(
                            ROOT_ID,
                            EventKind::Notification,
                            EventPayload::Map(answer),
                        );
                    }
                    if shown {
                        control.dispatch_event(
                            ROOT_ID,
                            EventKind::Notification,
                            EventPayload::Map(vec![(
                                Field::PRESSED,
                                PayloadValue::Str("a".into()),
                            )]),
                        );
                    }
                }
                _ => {}
            }
        }
        if text.contains(end) {
            return (text, commands);
        }
    }
    panic!("no text with {end}; last: {text}");
}

fn config(bundle: Bundle) -> EngineConfig {
    EngineConfig {
        viewport: Size::new(px(400.0), px(600.0)),
        ui_sets: vec![nsh_base::registry()],
        ..EngineConfig::new(bundle)
    }
}

#[test]
fn the_platform_answers_the_app() {
    let mut config = config(bundle(APP, "app"));
    config.environment.notifications = true;
    let (text, commands) = play(config, "silent:true");
    assert!(
        text.contains("RangeError RangeError RangeError granted"),
        "{text}"
    );
    assert!(text.contains("shown:true"), "{text}");
    assert!(text.contains("pressed:a"), "{text}");
    assert!(commands.contains(&N::SetBadge(4)));
    assert!(commands.contains(&N::Close("old".into())));
    assert!(commands.contains(&N::Listen));
    assert!(commands.contains(&N::Permission { id: 0, ask: true }));
    assert!(commands.contains(&N::Show {
        id: 1,
        notification: Notification::new("a", "T", "B"),
    }));
    assert!(commands.contains(&N::Show {
        id: 2,
        notification: Notification::new("b", "T", "").silent(true),
    }));
}

#[test]
fn the_capability_refuses() {
    let mut app = bundle(DENIED, "denied");
    app.policy.declared = Some(Capabilities::from_json(&serde_json::json!({})).unwrap());
    let mut config = config(app);
    config.environment.notifications = true;
    let (_, commands) = play(
        config,
        "ERR_ACCESS_DENIED/notifications ERR_ACCESS_DENIED/notifications ERR_ACCESS_DENIED/notifications",
    );
    assert_eq!(commands, vec![]);
}
