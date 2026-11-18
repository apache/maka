//! `Application.launchAtLogin()` and `setLaunchAtLogin` of `nsh/desktop`
//! from JS, with a platform's login item: whether it is on reaches the app,
//! the calls run in the order the app makes them, and a failure of the
//! system rejects a change with its code.

use std::{
    collections::VecDeque,
    io,
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_core::{
    ApproxTextEngine, MountItem, Size,
    desktop::{LoginItemBackend, LoginItemStatus},
    geometry::px,
};
use nsh_engine::{Bundle, Engine, EngineConfig};

use crate::ChannelSink;

const APP: &str = r#"
import { mount, signal, Text } from "nsh";
import { Application } from "nsh/desktop";
function App() {
  const said = signal("");
  const say = (s) => said.set(`${said()} ${s}`);
  const ok = () => say("ok");
  const code = (e) => say(e.code ?? e.name);
  (async () => {
    // Made together, they run in the order the app made them.
    const calls = [
      Application.setLaunchAtLogin(true).then(ok),
      Application.launchAtLogin().then(say),
      Application.setLaunchAtLogin(false).then(ok),
    ];
    for (const call of calls) await call;
    // The system's failures: a change rejects with its code, a read is off.
    await Application.setLaunchAtLogin(true).then(ok, code);
    await Application.setLaunchAtLogin(true).then(ok, code);
    await Application.launchAtLogin().then(say, code);
    await Application.setLaunchAtLogin(false).then(ok, code);
    // Anything but a boolean rejects before the system is asked.
    await Application.setLaunchAtLogin().then(ok, code);
    say("done");
  })();
  return <Text>{said()}</Text>;
}
mount(App);
"#;

/// A platform's login item that answers from a script and records the
/// calls: a change (`Some`) or a read.
struct Scripted {
    answers: Mutex<VecDeque<io::Result<LoginItemStatus>>>,
    calls: Mutex<Vec<Option<bool>>>,
}

impl Scripted {
    fn new(answers: impl IntoIterator<Item = io::Result<LoginItemStatus>>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into_iter().collect()),
            calls: Mutex::default(),
        })
    }

    fn answer(&self, call: Option<bool>) -> io::Result<LoginItemStatus> {
        self.calls.lock().unwrap().push(call);
        self.answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(io::Error::other("no answer left")))
    }
}

impl LoginItemBackend for Scripted {
    fn status(&self) -> io::Result<LoginItemStatus> {
        self.answer(None)
    }

    fn set(&self, enabled: bool) -> io::Result<LoginItemStatus> {
        self.answer(Some(enabled))
    }
}

fn bundle(app: &str, name: &str) -> Bundle {
    let dir = crate::temporary_root().join(format!("nsh-login-item-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    let ui_sets = [nsh_base::registry()];
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: ui_sets.iter().map(Into::into).collect(),
        ..Default::default()
    })
    .unwrap();
    // The bundle is in memory now.
    let _ = std::fs::remove_dir_all(&dir);
    let bytecode = nsh_js::compile_bytecode_with(
        &bundle.code,
        false,
        &ui_sets.iter().map(Into::into).collect::<Vec<_>>(),
    )
    .unwrap();
    // SAFETY: compiled just now by this runtime.
    unsafe { Bundle::bytecode(bytecode) }
}

/// Runs `bundle` with the platform's login item `backend` until its text
/// contains `end`, and gives the text.
fn shown(bundle: Bundle, backend: Arc<Scripted>, end: &str) -> String {
    let config = EngineConfig {
        viewport: Size::new(px(400.0), px(600.0)),
        ui_sets: vec![nsh_base::registry()],
        login_item: Some(backend),
        ..EngineConfig::new(bundle)
    };
    let (tx, rx) = crossbeam_channel::unbounded();
    let _engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let mut text = String::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        let Ok(batch) = rx.recv_timeout(Duration::from_millis(100)) else {
            continue;
        };
        for item in batch.items {
            if let MountItem::Text { text: t, .. } = item {
                text = t.text.to_string();
            }
        }
        if text.contains(end) {
            return text;
        }
    }
    panic!("no text with {end}; last: {text}");
}

#[test]
fn an_app_reads_and_changes_launch_at_login() {
    let backend = Scripted::new([
        Ok(LoginItemStatus::Enabled),
        // Waiting for the user's approval reads as off.
        Ok(LoginItemStatus::RequiresApproval),
        Ok(LoginItemStatus::Disabled),
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "not permitted",
        )),
        Err(io::Error::new(io::ErrorKind::InvalidFilename, "too long")),
        Err(io::Error::new(io::ErrorKind::InvalidInput, "no such id")),
        Err(io::Error::other("failed")),
    ]);
    // No `"capabilities"` declared: it needs none.
    let text = shown(bundle(APP, "app"), backend.clone(), "done");
    assert_eq!(
        text.trim(),
        "ok false ok EACCES ENAMETOOLONG false EIO TypeError done"
    );
    assert_eq!(
        *backend.calls.lock().unwrap(),
        [
            Some(true),
            None,
            Some(false),
            Some(true),
            Some(true),
            None,
            Some(false)
        ]
    );
}
