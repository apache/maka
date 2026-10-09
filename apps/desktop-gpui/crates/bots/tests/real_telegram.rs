/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! A Telegram message answered end to end: a real Runtime Host from the Maka
//! checkout on a fresh State Root under `target/tmp`, with a model
//! connection to the scripted demo model (`scripts/demo-model.py`), the real
//! bot sidecar under the supervisor, and a fake Telegram Bot API
//! (`sidecars/bots/test/fake-telegram.mjs`). A private chat sends one
//! message; the test waits for the reply on the fake API and finds the Host
//! Session the bot answered in, labelled `bot` and `telegram`.
//!
//! ```sh
//! MAKA_REPO=~/code/maka-pin cargo test -p bots --test real_telegram -- --ignored --nocapture
//! ```
//!
//! Ignored by default, and a no-op without `MAKA_REPO`: it needs a built
//! checkout (`docs/dev-host.md`), a Node found as the app finds it, and
//! `python3`. The bridge has no setting for the Telegram API base URL, so the
//! sidecar sends its requests to the fake through
//! `MAKA_BOTS_TELEGRAM_API_ORIGIN` (`sidecars/bots/telegram-api.mjs`).
//! The Host, the setup script and the sidecar run with provider keys removed
//! and `HOME` set to an empty directory in the scratch folder, so neither the
//! user's skills nor their Maka data reach them. Everything started here is
//! stopped by its pid, and the scratch folder, which holds the Host's control
//! directory and owner lock under that `HOME`, is deleted.
#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use bots::{
    BotChatSettings, BotEvent, BotHost, BotProvider, HostLinkState, LaunchOptions, RestartPolicy,
    SupervisedBots, prepare_launch,
};
use futures_lite::future::block_on;
use host_client::{
    ConnectOptions, Connected, Connection, MAKA_REPO_ENV, NodeRuntime, random_client_instance_id,
};
use host_protocol::{
    ClientHello, PermissionMode, SessionCatalogItem, SessionCatalogQuery, SessionCatalogQueryInput,
    SessionCatalogQueryResult, WorkspaceTarget,
};
use serde_json::{Value, json};

const READY_TIMEOUT: Duration = Duration::from_secs(90);
const REPLY_TIMEOUT: Duration = Duration::from_secs(90);
/// The demo model's answer to a prompt it has no scenario for.
const DEMO_ANSWER: &str = "This demo model only knows a few scripted tasks.";
const CHAT_ID: i64 = 7001;
const TOKEN: &str = "4242:live-test-token";

/// A child process stopped by its pid when dropped.
struct Started {
    name: &'static str,
    child: Child,
    /// Held open: the fake API exits when its stdin closes.
    _stdin: Option<ChildStdin>,
}

impl Started {
    fn stop(&mut self) {
        let pid = self.child.id();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = Command::new("kill").arg(pid.to_string()).status();
            let deadline = Instant::now() + Duration::from_secs(15);
            while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(50));
            }
            if self.child.try_wait().ok().flatten().is_none() {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
        eprintln!("{} (pid {pid}) stopped: {:?}", self.name, self.child.try_wait());
    }
}

impl Drop for Started {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The first stdout line of `child`, within `timeout`, and a thread that
/// drains the rest.
fn first_line(child: &mut Child, timeout: Duration, what: &str) -> String {
    let stdout = child.stdout.take().expect("stdout");
    let (lines, first) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if lines.send(line).is_err() {
                // Keep draining so the child never blocks on a full pipe.
                continue;
            }
        }
    });
    first.recv_timeout(timeout).unwrap_or_else(|_| panic!("{what} printed nothing"))
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root")
}

/// `scripts/demo-model.py` on a free loopback port.
fn start_demo_model(scratch: &Path) -> (Started, u16) {
    let loader = "import importlib.util, sys\n\
        spec = importlib.util.spec_from_file_location('demo_model', sys.argv[1])\n\
        model = importlib.util.module_from_spec(spec)\n\
        spec.loader.exec_module(model)\n\
        server = model.ThreadingHTTPServer(('127.0.0.1', 0), model.Handler)\n\
        print(server.server_address[1], flush=True)\n\
        server.serve_forever()\n";
    let mut child = Command::new("python3")
        .arg("-c")
        .arg(loader)
        .arg(repo_root().join("scripts/demo-model.py"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(scratch.join("demo-model.stderr")).expect("stderr"))
        .spawn()
        .expect("python3");
    let port = first_line(&mut child, Duration::from_secs(20), "the demo model")
        .trim()
        .parse()
        .expect("port");
    (Started { name: "demo model", child, _stdin: None }, port)
}

/// `runtime-host serve` on the scratch State Root; returns its local endpoint.
fn start_host(repo: &Path, node: &Path, scratch: &Path, home: &Path) -> (Started, String) {
    let mut child = Command::new(node)
        .arg(repo.join("packages/cli/dist/dev-cli.js"))
        .args(["runtime-host", "serve", "--root"])
        .arg(scratch.join("state-root"))
        .arg("--json")
        .current_dir(repo)
        .env("HOME", home)
        .env_remove("DEEPSEEK_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(scratch.join("host.stderr")).expect("stderr"))
        .spawn()
        .expect("runtime-host serve");
    let line = first_line(&mut child, READY_TIMEOUT, "the Host");
    let event: Value = serde_json::from_str(&line).expect("ready event");
    assert_eq!(event["event"], "runtime_host_ready", "{line}");
    assert_eq!(
        event["protocol"]["compatibilityEpoch"],
        host_protocol::RUNTIME_HOST_COMPATIBILITY_EPOCH
    );
    let endpoint = event["listeners"]
        .as_array()
        .expect("listeners")
        .iter()
        .find(|listener| listener["kind"] == "local_ipc")
        .and_then(|listener| listener["endpoint"].as_str())
        .expect("local endpoint")
        .to_owned();
    (Started { name: "Runtime Host", child, _stdin: None }, endpoint)
}

/// Gives the Host a default model on the demo model and a project, as
/// `scripts/demo-root.sh` does; returns the project id.
fn configure_host(
    repo: &Path,
    node: &Path,
    scratch: &Path,
    home: &Path,
    model_port: u16,
) -> String {
    let setup = scratch.join("setup.mjs");
    let loader = repo_root().join("sidecars/bots/maka.mjs");
    std::fs::write(
        &setup,
        format!(
            r#"import {{ loadMaka }} from {loader};
const [checkout, rootPath, workspace, baseUrl] = process.argv.slice(2);
const {{ client, protocol }} = await loadMaka(checkout);
const r = await client.connectExistingRuntimeHost({{ rootPath, protocol: {{ min: protocol.RUNTIME_HOST_PROTOCOL_VERSION, max: protocol.RUNTIME_HOST_PROTOCOL_VERSION }}, compositionId: protocol.INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID }});
if (r.kind !== 'connected') throw new Error(JSON.stringify(r));
const c = r.connection;
const target = {{ kind: 'create', providerType: 'custom', defaultApiProtocol: 'openai-chat', slug: 'demo', name: 'Scripted demo' }};
await c.request('connection.onboarding.verify', {{ target, apiKey: 'demo', baseUrl }});
await c.request('connection.onboarding.save', {{ target, apiKey: 'demo', baseUrl, enabledModelIds: ['scripted-demo'] }});
const cat = await client.readRuntimeHostConnectionCatalog(c);
const demo = cat.connections.find((x) => x.slug === 'demo');
await c.request('connection.catalog.set-default-target', {{ expectedCatalogRevision: cat.revision, target: {{ connectionId: demo.connectionId, modelId: 'scripted-demo' }} }});
const registered = await c.request('project.catalog.mutate', {{ kind: 'register', path: workspace, prefer: true }});
console.log(JSON.stringify(registered));
await c.close();
process.exit(0);
"#,
            loader = serde_json::to_string(&format!("file://{}", loader.display())).expect("url"),
        ),
    )
    .expect("setup script");
    let workspace = scratch.join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let output = Command::new(node)
        .arg(&setup)
        .arg(repo)
        .arg(scratch.join("state-root"))
        .arg(&workspace)
        .arg(format!("http://127.0.0.1:{model_port}/v1"))
        .env("HOME", home)
        .env_remove("DEEPSEEK_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .output()
        .expect("setup");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "setup failed: {stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let registered: Value =
        serde_json::from_str(stdout.trim()).expect("project.catalog.mutate result");
    eprintln!("registered the workspace: {registered}");
    find_string(&registered, "projectId")
        .or_else(|| find_string(&registered, "id"))
        .expect("a project id")
}

fn find_string(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(fields) => fields
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| fields.values().find_map(|value| find_string(value, key))),
        Value::Array(items) => items.iter().find_map(|value| find_string(value, key)),
        _ => None,
    }
}

/// The fake Bot API; returns its origin.
fn start_fake_telegram(node: &Path, scratch: &Path) -> (Started, String) {
    let mut child = Command::new(node)
        .arg(repo_root().join("sidecars/bots/test/fake-telegram.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(scratch.join("fake-telegram.stderr")).expect("stderr"))
        .spawn()
        .expect("fake Telegram");
    let stdin = child.stdin.take();
    let line = first_line(&mut child, Duration::from_secs(20), "the fake Telegram API");
    let origin: Value = serde_json::from_str(&line).expect("origin line");
    let origin = origin["origin"].as_str().expect("origin").to_owned();
    (Started { name: "fake Telegram API", child, _stdin: stdin }, origin)
}

/// One HTTP/1.1 request to the fake; returns the JSON body.
fn fake_request(origin: &str, method: &str, path: &str, body: Option<&Value>) -> Value {
    let address = origin.strip_prefix("http://").expect("http origin");
    let mut stream = TcpStream::connect(address).expect("connect to the fake");
    let body = body.map(Value::to_string).unwrap_or_default();
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .expect("request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("response");
    let (_, body) = response.split_once("\r\n\r\n").expect("headers and body");
    serde_json::from_str(body).expect("JSON body")
}

#[test]
#[ignore = "serves a real Runtime Host and the bot sidecar from $MAKA_REPO; run with --ignored"]
fn a_telegram_message_is_answered_in_a_bot_session() {
    let Some(repo) = std::env::var_os(MAKA_REPO_ENV).map(PathBuf::from) else {
        eprintln!("skipped: {MAKA_REPO_ENV} is not set");
        return;
    };
    let scratch = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("real-telegram-{}", uuid::Uuid::new_v4().simple()));
    let home = scratch.join("home");
    std::fs::create_dir_all(&home).expect("scratch home");
    let node = block_on(NodeRuntime::discover()).expect("a Node to run the Host");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        exercise(&repo, node.path(), &scratch, &home)
    }));
    std::fs::remove_dir_all(&scratch).ok();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

fn exercise(repo: &Path, node: &Path, scratch: &Path, home: &Path) {
    let (_model, model_port) = start_demo_model(scratch);
    let (_host, endpoint) = start_host(repo, node, scratch, home);
    let project_id = configure_host(repo, node, scratch, home, model_port);
    let (_fake, origin) = start_fake_telegram(node, scratch);
    eprintln!("demo model on {model_port}, Host at {endpoint}, fake Telegram at {origin}");

    let options = LaunchOptions::default()
        .with_checkout(repo)
        .with_node(node)
        .with_lock_directory(scratch.join("locks"))
        .with_cache_directory(scratch.join("cache"))
        .with_env("HOME", home)
        .with_env("MAKA_BOTS_TELEGRAM_API_ORIGIN", &origin);
    let host = BotHost::Local { state_root: scratch.join("state-root") };
    let launch = block_on(prepare_launch(&host, &options)).expect("launch");
    let SupervisedBots { handle, run, events, .. } = launch.supervise(RestartPolicy::default());
    let supervisor = thread::spawn(move || block_on(run));
    let (collected, collected_rx) = mpsc::channel();
    thread::spawn(move || {
        while let Ok(event) = block_on(events.recv()) {
            if let BotEvent::Log { message, .. } = &event {
                eprintln!("sidecar: {message}");
            }
            if collected.send(event).is_err() {
                break;
            }
        }
    });

    block_on(handle.set_workspace(Some(WorkspaceTarget::Project { project_id })))
        .expect("workspace");
    let mut settings = BotChatSettings::default();
    let telegram = settings.channel_mut(BotProvider::Telegram);
    telegram.enabled = true;
    telegram.token = TOKEN.into();
    block_on(handle.apply_settings(settings)).expect("apply");

    // The bridge polls, and the sidecar reached the Host.
    let (mut polling, mut connected) = (false, false);
    let deadline = Instant::now() + READY_TIMEOUT;
    while !(polling && connected) {
        let event = collected_rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("the channel polls and the sidecar connects");
        match event {
            BotEvent::Status(status) if status.provider() == BotProvider::Telegram => {
                polling |= status.status.running;
            }
            BotEvent::Host(HostLinkState::Connected { .. }) => connected = true,
            BotEvent::Exited { reason, .. } | BotEvent::Suspended { reason } => {
                panic!("the sidecar stopped: {reason}")
            }
            _ => {}
        }
    }

    let message = json!({
        "message_id": 1,
        "from": { "id": CHAT_ID, "is_bot": false, "first_name": "Live", "username": "live_test" },
        "chat": { "id": CHAT_ID, "type": "private" },
        "date": 1_727_500_000,
        "text": "hello from telegram"
    });
    fake_request(&origin, "POST", "/_test/updates", Some(&json!({ "message": message })));

    // The answer arrives as the final sendMessage, threaded under the question.
    let deadline = Instant::now() + REPLY_TIMEOUT;
    let calls = loop {
        let calls = fake_request(&origin, "GET", "/_test/calls", None);
        let answered = calls.as_array().expect("calls").iter().any(|call| {
            call["method"] == "sendMessage" && call["body"]["chat_id"].as_str() == Some("7001")
        });
        if answered {
            break calls;
        }
        assert!(Instant::now() < deadline, "no reply reached the fake API: {calls:#}");
        thread::sleep(Duration::from_millis(200));
    };
    let calls = calls.as_array().expect("calls");
    let reply = calls.iter().find(|call| call["method"] == "sendMessage").expect("sendMessage");
    assert_eq!(reply["body"]["text"], DEMO_ANSWER, "{reply:#}");
    assert_eq!(reply["body"]["reply_to_message_id"], 1);
    let methods: Vec<_> = calls.iter().filter_map(|call| call["method"].as_str()).collect();
    eprintln!("Bot API calls: {methods:?}");
    assert!(methods.contains(&"sendChatAction"), "the typing indicator ran");

    // The Host has the bot Session, in explore, with the chat in it.
    let hello = ClientHello::new(random_client_instance_id());
    let Connected { connection, pump, .. } =
        block_on(Connection::connect(&endpoint, hello, ConnectOptions::default()))
            .expect("connect");
    let pump = thread::spawn(move || block_on(pump));
    let page = block_on(async {
        connection.wait_until_ready(READY_TIMEOUT).await?;
        connection
            .request_with_timeout::<SessionCatalogQuery>(
                &SessionCatalogQueryInput::ListStart,
                Duration::from_secs(20),
            )
            .await
    })
    .expect("session.catalog.query");
    connection.shutdown();
    let _ = pump.join();
    let SessionCatalogQueryResult::Page { sessions, .. } = page else {
        panic!("a catalog page, got {page:?}");
    };
    let bot_sessions: Vec<_> = sessions
        .iter()
        .filter_map(|item| match item {
            SessionCatalogItem::Session(session) => Some(session),
            _ => None,
        })
        // The Host adds `mode:bot` for the session's start mode.
        .filter(|session| session.labels.starts_with(&["bot".to_owned(), "telegram".to_owned()]))
        .collect();
    assert_eq!(bot_sessions.len(), 1, "one bot Session: {sessions:#?}");
    let session = bot_sessions[0];
    assert_eq!(session.name, "Telegram 任务");
    assert!(session.labels.iter().any(|label| label == "mode:bot"), "{:?}", session.labels);
    assert_eq!(session.permission_mode, PermissionMode::Explore);
    eprintln!(
        "bot Session {} answered: {:?}",
        session.id,
        session.last_message_preview.as_deref().unwrap_or_default()
    );

    block_on(handle.shutdown());
    supervisor.join().expect("supervisor");
}
