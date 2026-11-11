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

#![cfg(all(target_os = "macos", feature = "desktop-tests"))]

// The real Desktop workbench on NSH's native surface, admitted to an owned Root.
// This is not an OS-window/Desktop Shell E2E test or a terminal-keyboard surface.
#[path = "support/host.rs"]
mod host;

use host::{Host, Result, Sandbox};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Request, Response,
    body::{Bytes, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use maka_app_client::{Client, Journal};
use maka_capabilities::call::{Attachments, ReadResource, ResourceEncoding};
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::{
    contract::ResourceType,
    operation::{OperationOutcome, OperationReply, OperationResult, Receipt},
};
use maka_workbench::bindings::Bindings;
use nsh_platform_macos::TerminalSurface;
use nsh_terminal::{
    Bounds, DevicePixels, MouseButton, MouseDownEvent, MouseUpEvent, NativeSurface, PlatformInput,
    point, px, size,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    ops::Range,
    panic::AssertUnwindSafe,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const STEP: Duration = Duration::from_secs(30);
const MODEL_MENU: [&str; 3] = [
    "Back to model settings",
    "Manage connections and models",
    "Manage external agents",
];

struct InputDiagnostics {
    armed: AtomicBool,
    observed: AtomicUsize,
    js_observed: AtomicUsize,
    engine_observed: AtomicUsize,
}

static INPUT_DIAGNOSTICS: InputDiagnostics = InputDiagnostics {
    armed: AtomicBool::new(false),
    observed: AtomicUsize::new(0),
    js_observed: AtomicUsize::new(0),
    engine_observed: AtomicUsize::new(0),
};

impl log::Log for InputDiagnostics {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        match metadata.target() {
            "js" => metadata.level() <= log::Level::Warn,
            "nsh::perf" | "nsh::interaction" | "nsh::input" => self.armed.load(Ordering::Relaxed),
            _ => false,
        }
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        if record.target() == "js" {
            if self.js_observed.fetch_add(1, Ordering::Relaxed) < 16 {
                eprintln!("desktop js [{}] {}", record.level(), record.args());
            }
        } else if record.target() == "nsh::perf" {
            if self.engine_observed.load(Ordering::Relaxed) >= 16 {
                return;
            }
            let message = record.args().to_string();
            if message.starts_with("event ")
                && self.engine_observed.fetch_add(1, Ordering::Relaxed) < 16
            {
                eprintln!("desktop engine event [{}] {message}", record.target());
            }
        } else if self.observed.fetch_add(1, Ordering::Relaxed) < 32 {
            eprintln!(
                "desktop native input [{}] {}",
                record.target(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

struct FixtureKey;
impl ReadResource for FixtureKey {
    fn encoding(&self) -> ResourceEncoding {
        ResourceEncoding::Utf8
    }
    fn resource_type(&self) -> ResourceType {
        ResourceType {
            name: "maka.text.utf8".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        b"desktop-fixture".len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>> {
        b"desktop-fixture"
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid fixture key range".into())
    }
}

struct ModelFixture {
    base: String,
    nonce_requests: Arc<AtomicUsize>,
    stop: CancellationToken,
    task: Option<JoinHandle<Result<()>>>,
}
impl ModelFixture {
    fn spawn(listener: TcpListener, nonce: String) -> Result<Self> {
        let base = format!(
            "http://{}/v1",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let stop = CancellationToken::new();
        let nonce_requests = Arc::new(AtomicUsize::new(0));
        let (cancel, requests) = (stop.clone(), nonce_requests.clone());
        let nonce = Arc::new(nonce);
        let task = tokio::spawn(async move {
            let mut calls = JoinSet::new();
            let mut failures = Vec::new();
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    joined = calls.join_next(), if !calls.is_empty() => {
                        match joined.expect("nonempty HTTP connections") {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => { failures.push(error); break; }
                            Err(error) => { failures.push(format!("HTTP connection task: {error}")); break; }
                        }
                    }
                    accepted = listener.accept() => {
                        let (socket, _) = match accepted {
                            Ok(accepted) => accepted,
                            Err(error) => { failures.push(format!("model accept: {error}")); break; }
                        };
                        let (nonce, requests, cancel) = (nonce.clone(), requests.clone(), cancel.clone());
                        calls.spawn(async move {
                            let service = service_fn(move |request| {
                                model_response(request, nonce.clone(), requests.clone())
                            });
                            let mut builder = hyper::server::conn::http1::Builder::new();
                            builder.keep_alive(false);
                            tokio::select! {
                                _ = cancel.cancelled() => Ok(()),
                                result = builder.serve_connection(TokioIo::new(socket), service) =>
                                    result.map_err(|error| format!("model HTTP: {error}")),
                            }
                        });
                    }
                }
            }
            drop(listener);
            cancel.cancel();
            while let Some(joined) = calls.join_next().await {
                match joined {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => failures.push(error),
                    Err(error) => failures.push(format!("join model connection: {error}")),
                }
            }
            if failures.is_empty() {
                Ok(())
            } else {
                Err(failures.join("; "))
            }
        });
        Ok(Self {
            base,
            nonce_requests,
            stop,
            task: Some(task),
        })
    }

    async fn close(&mut self) -> Result<()> {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            task.await
                .map_err(|error| format!("join model listener: {error}"))??;
        }
        Ok(())
    }
}

async fn model_response(
    request: Request<Incoming>,
    nonce: Arc<String>,
    requests: Arc<AtomicUsize>,
) -> Result<Response<Full<Bytes>>> {
    let path = request.uri().path();
    let listing = request.method() == hyper::Method::GET && path == "/v1/models";
    if !listing && !(request.method() == hyper::Method::POST && path == "/v1/chat/completions") {
        return Err("unexpected model request method or path".into());
    }
    let (body, content_type) = if listing {
        (
            json!({"object":"list","data":[{"id":"gpt-4.1","object":"model"}]}).to_string(),
            "application/json",
        )
    } else {
        let bytes = Limited::new(request.into_body(), 8 * 1024 * 1024)
            .collect()
            .await
            .map_err(|error| format!("read model request: {error}"))?
            .to_bytes();
        let body: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if body["model"] != "gpt-4.1" {
            return Err("unexpected model identity".into());
        }
        let messages = body["messages"]
            .as_array()
            .ok_or("model request omitted messages")?;
        if messages.iter().any(|message| {
            message["role"] == "user" && message["content"].to_string().contains(nonce.as_str())
        }) {
            requests.fetch_add(1, Ordering::Relaxed);
        }
        let first = json!({"id":"desktop","object":"chat.completion.chunk","choices":[{
            "index":0,"delta":{"role":"assistant","content":format!("desktop-reply-{nonce}")},"finish_reason":null}]});
        let last = json!({"id":"desktop","object":"chat.completion.chunk","choices":[{
            "index":0,"delta":{},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}});
        (
            format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n"),
            "text/event-stream",
        )
    };
    Response::builder()
        .header("content-type", content_type)
        .header("connection", "close")
        .body(Full::new(Bytes::from(body)))
        .map_err(|error| error.to_string())
}

fn model_row_label(choice: &Value) -> Result<String> {
    Ok(format!(
        "Use {} · {}",
        choice["label"]
            .as_str()
            .ok_or("model choice omitted label")?,
        choice["sourceName"]
            .as_str()
            .ok_or("model choice omitted source name")?
    ))
}

fn model_identity(choice: &Value) -> Value {
    let selection = &choice["selection"];
    json!({"label":choice["label"],"sourceName":choice["sourceName"],
        "kind":selection["kind"],"connectionId":selection["connectionId"],
        "modelId":selection["modelId"],"thinkingLevel":selection["thinkingLevel"]})
}

async fn phase<T>(name: &str, future: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(STEP, future)
        .await
        .map_err(|_| format!("deadline waiting for {name}"))?
        .map_err(|error| format!("{name}: {error}"))
}

fn returned(reply: &OperationReply) -> Result<Value> {
    match &reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            ..
        } => Ok(value.clone()),
        other => Err(format!(
            "expected actual recorded Returned success, got {other:?}"
        )),
    }
}

async fn mutate(
    client: &Client,
    endpoint: &str,
    method: &str,
    input: Value,
    resources: Attachments,
) -> Result<Value> {
    let mutation = client
        .mutation(
            Uuid::new_v4(),
            endpoint,
            method,
            input,
            resources,
            None,
            json!({"kind":"desktop-new-session-setup"}),
        )
        .await?;
    mutation.prepare().await?;
    returned(&mutation.confirm().await?)
}

async fn sessions(client: &Client) -> Result<BTreeMap<String, Value>> {
    let page = client
        .query(
            "agent",
            "list",
            json!({"filter":"all","position":{"kind":"start"}}),
        )
        .await?;
    if !page
        .get("after")
        .ok_or("list omitted required after cursor")?
        .is_null()
    {
        return Err(format!(
            "fresh owned Root unexpectedly requires pagination: {page}"
        ));
    }
    let rows = page["sessions"].as_array().ok_or("list omitted Sessions")?;
    let mut result = BTreeMap::new();
    for row in rows {
        let id = row["id"].as_str().ok_or("Session omitted id")?.to_owned();
        if result.insert(id, row.clone()).is_some() {
            return Err("Session list repeated an identity".into());
        }
    }
    Ok(result)
}

fn wait_native(
    platform: &TerminalSurface,
    errors: &RefCell<Option<String>>,
    name: &str,
    mut ready: impl FnMut() -> Result<bool>,
) -> Result<()> {
    let deadline = Instant::now() + STEP;
    loop {
        platform.pump_with_draw(true);
        if let Some(error) = platform.take_error() {
            return Err(format!("{name}: native platform: {error}"));
        }
        if let Some(error) = errors.borrow().as_ref() {
            return Err(format!("{name}: workbench: {error}"));
        }
        if ready()? {
            return Ok(());
        }
        if platform.is_quit_requested() {
            return Err(format!("{name}: window unexpectedly closed"));
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("deadline waiting for {name}"));
        }
        if !platform.has_pending() {
            let until = platform.next_deadline().unwrap_or(deadline).min(deadline);
            // The platform's wake callback unparks this owner thread. Only a
            // real dispatcher deadline or this phase deadline bounds the wait.
            std::thread::park_timeout(until.saturating_duration_since(now));
        }
    }
}

fn settle(name: &str, errors: &mut Vec<String>, operation: impl FnOnce() -> Result<()>) {
    match std::panic::catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => errors.push(format!("{name}: {error}")),
        Err(panic) => {
            let cause = panic
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| panic.downcast_ref::<&str>().copied())
                .unwrap_or("non-text panic");
            errors.push(format!("{name} panicked: {cause}"));
        }
    }
}

pub(crate) fn new_conversation_creates_and_selects_a_session_in_the_same_workspace() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("desktop test runtime");
    let sandbox = runtime
        .block_on(Sandbox::new())
        .expect("owned empty Unix Root and HOME");
    let mut process = None;
    let mut control = None;
    let mut observer = None;
    let mut bindings = None;
    let mut desktop_client = None;
    let mut platform = None;
    let mut model = None;
    let nonce = format!("desktop-message-{}", Uuid::new_v4().simple());
    let errors = Rc::new(RefCell::new(None::<String>));
    let frames = Rc::new(Cell::new(0usize));

    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| -> Result<()> {
        log::set_logger(&INPUT_DIAGNOSTICS).map_err(|error| error.to_string())?;
        log::set_max_level(log::LevelFilter::Debug);
        eprintln!(
            "desktop input diagnostics static_max={:?}",
            log::STATIC_MAX_LEVEL
        );
        let (seed_id, seed_title, directory, model_choice) = runtime.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|error| error.to_string())?;
            model = Some(ModelFixture::spawn(listener, nonce.clone())?);
            // Store the exact child before any startup await, including connect.
            process = Some(Host::spawn(&sandbox)?);
            let (admin, address) = phase("real default Host startup", process.as_mut().unwrap().ready()).await?;
            let epoch = admin.epoch();
            control = Some(admin);
            observer = Some(Client::new(
                phase("independent public API connection", HostClient::connect(&address, Some(epoch))).await?,
                phase("real observer Journal outside Root", Journal::open(&sandbox.journal)).await?,
                "receipts".into(),
            )?);
            let api = observer.as_ref().unwrap();
            // Choose the owned Root's real language preference, rather than
            // changing process globals or assuming the runner's OS language.
            let preferences = phase("read owned Root preferences", api.query("settings", "assistantPreferences", json!({}))).await?;
            let language = phase("set owned Root's English UI preference", mutate(api, "settings", "updateAssistantPreferences",
                json!({"expectedRevision":preferences["revision"],"mutation":{"kind":"language","preference":"en"}}), Attachments::new())).await?;
            if language["kind"] != "committed" { return Err(format!("language setup rejected: {language}")); }
            let checked = phase("verify actual UI language", api.query("settings", "assistantPreferences", json!({}))).await?;
            assert_eq!(checked["resolvedLanguage"], "en");
            let catalog = phase("read loopback connection catalog", api.query("settings", "connections", json!({"kind":"start"}))).await?;
            assert_eq!(catalog["kind"], "ready");
            assert!(catalog["defaultTarget"].is_null());
            let configured = phase("create owned loopback connection", mutate(api, "settings", "create", json!({
                "expectedCatalogRevision":catalog["revision"],"connection":{
                    "slug":"desktop","name":"Desktop loopback",
                    "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"},
                    "configuration":{"baseUrl":model.as_ref().unwrap().base},
                    "enabled":true,"enabledModelIds":["gpt-4.1"],
                    "modelOverrides":{"gpt-4.1":{"codeMode":false,"apiProtocol":"openai-chat-completions"}}
                }}), Attachments::new())).await?;
            assert_eq!(configured["kind"], "committed");
            let connection = configured["connection"]["connectionId"].as_str().ok_or("missing connection id")?;
            let detail = phase("read loopback credential target", api.query("settings", "connection", json!({"connectionId":connection,"includeEditingFacts":true}))).await?;
            assert_eq!(detail["kind"], "ready");
            let secret: Arc<dyn ReadResource> = Arc::new(FixtureKey);
            let credential = phase("store dummy loopback credential", mutate(api, "settings", "saveCredential",
                json!({"expected":detail["target"],"expectedCredential":null}),
                Attachments::from([("secret".into(), secret)]))).await?;
            assert_eq!(credential["kind"], "saved");
            let choices = phase("read actual UI model choice", api.query("agent", "models", json!({"kind":"start","query":""}))).await?;
            assert_eq!(choices["kind"], "ready");
            assert!(choices["next"].is_null());
            let model_choice = choices["choices"].as_array().ok_or("missing model choices")?.iter()
                .find(|choice| choice["selection"]["connectionId"] == connection && choice["selection"]["modelId"] == "gpt-4.1")
                .ok_or("configured loopback model is not a UI choice")?.clone();
            eprintln!("desktop setup model page kind={} revision={} count={:?} next={} choice={} expected_label={:?} fixture_enabled={} fixture_enabled_model_ids={}",
                choices["kind"], choices["revision"], choices["choices"].as_array().map(Vec::len), choices["next"],
                model_identity(&model_choice), model_row_label(&model_choice)?, detail["enabled"], detail["editing"]["enabledModelIds"]);
            let title = format!("desktop-seed-{}", Uuid::new_v4().simple());
            let created = phase("create real idle seed Session", mutate(api, "agent", "create", json!({
                "backend":null,"automaticTitle":false,"tools":[],"title":title,"labels":[],
                "workspace":{"kind":"directory","path":sandbox.workspace},
            }), Attachments::new())).await?;
            if created["kind"] != "created" { return Err(format!("seed creation rejected: {created}")); }
            let id = created["session"]["id"].as_str().ok_or("creation omitted Session id")?.to_owned();
            let (client, directory) = phase("real Desktop workbench admission and Journal", maka_workbench::host::admit(
                phase("real Desktop Host connection", HostClient::connect(&address, Some(epoch))).await?,
                &sandbox.root, "desktop",
            )).await?;
            let bot_read = phase("reserve Bot read marker in shell control custody", client.control(
                Uuid::new_v4(), "markBotRead", json!({"sessionId":id,"through":2}),
            )).await?;
            let original = client.operation_for_control(bot_read.id()).await?;
            assert_eq!(original.session_id.as_deref(), Some(id.as_str()));
            assert_eq!(original.method, "markBotRead");
            // This checks reservation custody, not an outbox domain mutation.
            bot_read.close().await?;
            desktop_client = Some(client.clone());
            bindings = Some(Bindings::new(client, runtime.handle().clone()));
            Ok::<_, String>((id, title, directory, model_choice))
        })?;

        let owner = bindings.as_ref().unwrap();
        let mut config = maka_workbench::configuration(
            owner.registry(Some(seed_id.clone())),
            runtime.handle().clone(),
        );
        config.trace = true;
        config.context = config.context.with(owner.reload());
        config.data_dir = Some(directory.clone());
        config.assets = Some(owner.assets());
        config.chunk_loader = Some(owner.chunk_loader());
        let submitted = frames.clone();
        let main_thread = std::thread::current();
        platform = Some(
            TerminalSurface::new(
                config,
                size(DevicePixels(1200), DevicePixels(800)),
                1.0,
                Box::new(move |frame| {
                    let rendered = std::thread::spawn(move || frame.submit()?.complete())
                        .join()
                        .expect("native snapshot transfer panicked")
                        .expect("native snapshot capture failed");
                    assert!(
                        !rendered.pixels().is_empty(),
                        "native surface returned no pixels"
                    );
                    submitted.set(submitted.get() + 1);
                }),
                Arc::new(move || main_thread.unpark()),
            )
            .map_err(|error| error.to_string())?,
        );
        let native = platform.as_ref().unwrap();
        native.set_active(true).map_err(|error| error.to_string())?;
        let bounds = |label: &str| -> Result<Vec<Bounds<nsh_terminal::Pixels>>> {
            Ok(native.pressable_bounds(label))
        };
        let paint = |_name: &str| -> Result<()> {
            native.pump_with_draw(true);
            match native.take_error() {
                Some(error) => Err(error),
                None => Ok(()),
            }
        };
        wait_native(
            native,
            &errors,
            "rendered Desktop workbench with selected seed",
            || {
                Ok(frames.get() > 0
                    && bounds("New conversation")?.len() == 1
                    && bounds("Choose model and effort")?.len() == 1
                    && bounds(&format!("Open conversation {seed_title}"))?.len() == 1)
            },
        )?;
        // Bounds observe the current NSH tree; native dispatches against its
        // rendered frame. A prior startup frame is not this target's paint.
        paint("actual native frame after seed controls mounted")?;
        for label in MODEL_MENU {
            assert!(
                bounds(label)?.is_empty(),
                "seed unexpectedly opened model selection: {label}"
            );
        }
        let before = runtime.block_on(phase(
            "independent pre-click Session list",
            sessions(observer.as_ref().unwrap()),
        ))?;
        let seed = before
            .get(&seed_id)
            .ok_or("seed disappeared before click")?
            .clone();
        assert_eq!(seed["title"], seed_title);
        assert!(seed["backend"].is_null());
        let seed_session = runtime.block_on(phase("observe original seed", async {
            Ok(observer
                .as_ref()
                .unwrap()
                .query("agent", "observe", json!({"sessionId":seed_id}))
                .await?["session"]
                .clone())
        }))?;
        let desktop = desktop_client.as_ref().unwrap();
        assert!(
            runtime
                .block_on(phase(
                    "initial actual Desktop recent folders",
                    desktop.recent_workspaces()
                ))?
                .is_empty()
        );

        let diagnose = |stage: &str| {
            let window_state = (
                native.viewport_size(),
                native.scale_factor(),
                native.is_active(),
                native.text_input_target(),
            );
            let mut labels = MODEL_MENU
                .iter()
                .map(|label| (*label).to_owned())
                .collect::<Vec<_>>();
            labels.extend(
                [
                    "New conversation",
                    "Choose model and effort",
                    "Close model selection",
                    "Choose model",
                    "Retry model catalog",
                    "Retry model policy",
                    "Focus message composer",
                    "Edit current model settings",
                    "Dismiss action feedback",
                    "Chat",
                    "Trajectory",
                    "Open settings",
                    "Choose composer workspace",
                    "Add a model connection",
                ]
                .into_iter()
                .map(str::to_owned),
            );
            labels.extend([
                format!("Open conversation {seed_title}"),
                "Open conversation New conversation".into(),
                format!("Actions for {seed_title}"),
                "Actions for New conversation".into(),
            ]);
            let controls = labels
                .into_iter()
                .map(|label| {
                    let observed = bounds(&label);
                    (label, observed)
                })
                .collect::<BTreeMap<_, _>>();
            // Independent observations, bounded separately: a pending-control
            // read must not erase a successful public domain observation.
            let (domain, pending) = runtime.block_on(async {
                tokio::join!(
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        sessions(observer.as_ref().unwrap())
                    ),
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        desktop_client.as_ref().unwrap().pending_controls()
                    ),
                )
            });
            let added = match &domain {
                Ok(Ok(rows)) => Some(
                    rows.keys()
                        .filter(|id| !before.contains_key(*id))
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            };
            eprintln!(
                "desktop diagnostic [{stage}] frames={} native_input_records={} js_warning_error_records={} engine_event_records={} window={window_state:?} controls={controls:?} before_ids={:?} added_ids={added:?} public_sessions={domain:?} original_pending_controls={pending:?}",
                frames.get(),
                INPUT_DIAGNOSTICS.observed.load(Ordering::Relaxed),
                INPUT_DIAGNOSTICS
                    .js_observed
                    .load(Ordering::Relaxed)
                    .min(16),
                INPUT_DIAGNOSTICS
                    .engine_observed
                    .load(Ordering::Relaxed)
                    .min(16),
                before.keys().collect::<Vec<_>>()
            );
        };
        INPUT_DIAGNOSTICS.armed.store(true, Ordering::Relaxed);
        diagnose("before original click");

        let click = |label: &str| -> Result<()> {
            paint("actual native frame before semantic pointer input")?;
            let targets = bounds(label)?;
            assert_eq!(targets.len(), 1, "{label} must have one live native target");
            let target = targets[0];
            assert!(target.size.width > px(0.0) && target.size.height > px(0.0));
            let position = point(
                target.origin.x + target.size.width / 2.0,
                target.origin.y + target.size.height / 2.0,
            );
            eprintln!("desktop click label={label:?} bounds={target:?}");
            let mut down = MouseDownEvent::default();
            down.position = position;
            down.button = MouseButton::Left;
            down.click_count = 1;
            native.dispatch_input(PlatformInput::MouseDown(down))?;
            let mut up = MouseUpEvent::default();
            up.position = position;
            up.button = MouseButton::Left;
            up.click_count = 1;
            native.dispatch_input(PlatformInput::MouseUp(up))?;
            Ok(())
        };
        let models_pane = |name: &str| -> Result<()> {
            let result = wait_native(native, &errors, name, || {
                for label in MODEL_MENU {
                    if bounds(label)?.len() != 1 {
                        return Ok(false);
                    }
                }
                Ok(true)
            });
            if result.is_err() {
                diagnose(name);
            }
            result?;
            paint("actual native frame with models pane")
        };

        click("New conversation")?;
        paint("actual native frame after original New click")?;
        diagnose("after original New click");
        wait_native(
            native,
            &errors,
            "new draft remembers the original workspace",
            || {
                let recent = runtime.block_on(phase(
                    "read actual Desktop recent folders",
                    desktop.recent_workspaces(),
                ))?;
                if recent.is_empty() {
                    return Ok(false);
                }
                assert_eq!(recent.len(), 1);
                assert_eq!(
                    recent[0].path,
                    seed["workspace"]["path"]
                        .as_str()
                        .ok_or("seed omitted workspace path")?
                );
                Ok(bounds("Choose model and effort")?.len() == 1)
            },
        )?;
        assert_eq!(
            runtime.block_on(phase(
                "New must not materialize a Session",
                sessions(observer.as_ref().unwrap())
            ))?,
            before
        );
        let unchanged = runtime.block_on(phase(
            "seed after New",
            observer
                .as_ref()
                .unwrap()
                .query("agent", "observe", json!({"sessionId":seed_id})),
        ))?;
        assert_eq!(unchanged["session"], seed_session);

        click("Choose model and effort")?;
        models_pane("pending draft's real models pane")?;
        let setup_label = model_row_label(&model_choice)?;
        let mut choose = setup_label.clone();
        let mut presentations = None;
        let row_started = Instant::now();
        let row = wait_native(native, &errors, "actual loopback model row", || {
            if presentations.is_none() {
                let page = runtime.block_on(async {
                    tokio::time::timeout(
                        STEP.saturating_sub(row_started.elapsed()),
                        observer.as_ref().unwrap().query(
                            "agent",
                            "models",
                            json!({"kind":"start","query":""}),
                        ),
                    )
                    .await
                    .map_err(|_| "deadline reading current model presentation")?
                })?;
                assert_eq!(page["kind"], "ready");
                let matches = page["choices"]
                    .as_array()
                    .ok_or("current model catalog omitted choices")?
                    .iter()
                    .filter(|choice| choice["selection"] == model_choice["selection"])
                    .collect::<Vec<_>>();
                assert_eq!(
                    matches.len(),
                    1,
                    "authorized model selection must remain unique"
                );
                let current = matches[0];
                assert_eq!(current["sourceName"], model_choice["sourceName"]);
                let current_label = model_row_label(current)?;
                choose = current_label.clone();
                eprintln!(
                    "desktop current model presentation revision={} choice={} exact_label={current_label:?}",
                    page["revision"],
                    model_identity(current)
                );
                // The UI may retain its opening snapshot while metadata adopts a display name.
                let mut labels = vec![current_label];
                if labels[0] != setup_label {
                    labels.push(setup_label.clone());
                }
                presentations = Some(labels);
            }
            let mut visible = None;
            for label in presentations.as_ref().unwrap() {
                let targets = bounds(label)?;
                assert!(
                    targets.len() <= 1,
                    "model presentation has duplicate native rows"
                );
                if targets.len() == 1 {
                    assert!(
                        visible.is_none(),
                        "one selection has multiple live model presentations"
                    );
                    visible = Some(label.clone());
                }
            }
            if let Some(label) = visible {
                choose = label;
                Ok(true)
            } else {
                Ok(false)
            }
        });
        if let Err(error) = row {
            diagnose("actual loopback model row failure");
            eprintln!(
                "desktop model row expected_label={choose:?} choice={} bounds={:?}",
                model_identity(&model_choice),
                bounds(&choose)
            );
            // Failure-only reads: each gets one explicit three-second observation budget.
            let (models, connections) = runtime.block_on(async {
                tokio::join!(
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        observer.as_ref().unwrap().query(
                            "agent",
                            "models",
                            json!({"kind":"start","query":""})
                        )
                    ),
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        observer.as_ref().unwrap().query(
                            "settings",
                            "connections",
                            json!({"kind":"start"})
                        )
                    ),
                )
            });
            match models {
                Ok(Ok(page)) => {
                    let rows = page["choices"].as_array();
                    eprintln!(
                        "desktop fresh models kind={} revision={} count={:?} next={}",
                        page["kind"],
                        page["revision"],
                        rows.map(Vec::len),
                        page["next"]
                    );
                    for choice in rows.into_iter().flatten().take(8) {
                        let label = model_row_label(choice);
                        let visible = label.as_ref().map(|label| bounds(label));
                        eprintln!(
                            "desktop fresh model choice={} exact_label={label:?} bounds={visible:?}",
                            model_identity(choice)
                        );
                    }
                }
                Ok(Err(_)) => eprintln!(
                    "desktop fresh models status=query_error; detail omitted from metadata-only diagnostic"
                ),
                Err(_) => eprintln!("desktop fresh models status=three_second_timeout"),
            }
            match connections {
                Ok(Ok(page)) => {
                    let rows = page["connections"].as_array();
                    let fixture = rows.into_iter().flatten()
                        .find(|row| row["basis"]["connectionId"] == model_choice["selection"]["connectionId"])
                        .map(|row| json!({"connectionId":row["basis"]["connectionId"],"revision":row["basis"]["revision"],
                            "enabled":row["enabled"],"enabledModelCount":row["enabledModelCount"]}));
                    eprintln!(
                        "desktop fresh connections kind={} revision={} count={:?} next={} fixture_summary={fixture:?}",
                        page["kind"],
                        page["revision"],
                        rows.map(Vec::len),
                        page["next"]
                    );
                }
                Ok(Err(_)) => eprintln!(
                    "desktop fresh connections status=query_error; detail omitted from metadata-only diagnostic"
                ),
                Err(_) => eprintln!("desktop fresh connections status=three_second_timeout"),
            }
            return Err(error);
        }
        paint("actual native frame with loopback model row")?;
        click(&choose)?;
        wait_native(
            native,
            &errors,
            "model choice closes the pending picker",
            || {
                for label in MODEL_MENU {
                    if !bounds(label)?.is_empty() {
                        return Ok(false);
                    }
                }
                Ok(bounds("Focus message composer")?.len() == 1)
            },
        )?;
        paint("actual native frame after choosing pending model")?;
        click("Focus message composer")?;
        wait_native(native, &errors, "real native composer input target", || {
            Ok(native.text_input_target().is_some())
        })?;
        // This is the current native native editor, not a JS callback or a stored draft edit.
        assert!(native.paste(nsh_core::PasteEvent::new(&nonce)));
        wait_native(
            native,
            &errors,
            "actual enabled Send message after native paste",
            || Ok(bounds("Send message")?.len() == 1),
        )?;
        paint("actual native frame with enabled Send message")?;
        click("Send message")?;

        let mut original_message = None;
        let mut completed_session = None;
        let mut first_completion_snapshot = None;
        let mut last_completion_snapshot = None;
        let completion = wait_native(
            native,
            &errors,
            "UI first send materializes one Session and completes its original Run",
            || {
                let mut snapshot = json!({
                    "stage":"sessions", "addedCount":null, "sessionId":null,
                    "messageId":null, "runId":null, "history":null, "work":null,
                });
                let completed = runtime.block_on(phase("observe actual UI submission", async {
                let api = observer.as_ref().unwrap();
                let after = sessions(api).await?;
                snapshot["seedRowEqualsOriginal"] = json!(after.get(&seed_id) == Some(&seed));
                assert_eq!(after.get(&seed_id), Some(&seed), "UI submission mutated seed");
                assert!(before.keys().all(|id| after.contains_key(id)));
                let added = after.iter().filter(|(id, _)| !before.contains_key(*id)).collect::<Vec<_>>();
                snapshot["addedCount"] = json!(added.len());
                assert!(added.len() <= 1, "UI submission created duplicate Sessions");
                let Some((id, created)) = added.first().copied() else { return Ok(None); };
                snapshot["sessionId"] = json!(id);
                snapshot["workspaceEqualsSeed"] = json!(created["workspace"] == seed["workspace"]);
                assert_eq!(created["workspace"], seed["workspace"]);
                snapshot["stage"] = json!("history");
                let history = api.query("agent", "history", json!({"sessionId":id,"position":{"kind":"start"},"view":"conversation"})).await?;
                snapshot["history"] = json!({
                    "kind":history["kind"], "through":history["through"],
                    "afterIsNull":history.get("after").map(Value::is_null),
                });
                assert_eq!(history["kind"], "ready");
                assert!(history.get("after").ok_or("history omitted after")?.is_null());
                let chunks = history["chunks"].as_array().ok_or("history omitted chunks")?;
                let users = chunks.iter().filter(|row| row["role"] == "user" && row["field"] == "body").collect::<Vec<_>>();
                snapshot["history"]["chunkCount"] = json!(chunks.len());
                snapshot["history"]["userBodyCount"] = json!(users.len());
                snapshot["history"]["assistantBodyCount"] = json!(chunks.iter()
                    .filter(|row| row["role"] == "assistant" && row["field"] == "body").count());
                snapshot["history"]["assistantFinalOutputCount"] = json!(chunks.iter()
                    .filter(|row| row["role"] == "assistant" && row["finalOutput"] == true).count());
                snapshot["history"]["assistantRows"] = json!(chunks.iter()
                    .filter(|row| row["role"] == "assistant").take(4)
                    .map(|row| json!({
                        "role":row["role"], "field":row["field"], "runId":row["runId"],
                        "modelPart":row.get("modelPart").map(|part| json!({
                            "stepId":part["stepId"], "attemptId":part["attemptId"], "ordinal":part["ordinal"],
                        })),
                        "offset":row["offset"], "totalBytes":row["totalBytes"],
                        "finalOutput":row["finalOutput"] == true,
                        "textEqualsExpected":row["text"] == format!("desktop-reply-{nonce}"),
                    })).collect::<Vec<_>>());
                if users.is_empty() { return Ok(None); }
                assert_eq!(users.len(), 1, "UI must submit the original nonce once");
                let user = users[0];
                assert_eq!(user["text"], nonce);
                assert_eq!(user["offset"], 0);
                let message = user["messageId"].as_str().ok_or("user message omitted id")?.to_owned();
                let run = user["runId"].as_str().ok_or("user message omitted Run")?.to_owned();
                snapshot["messageId"] = json!(message);
                snapshot["runId"] = json!(run);
                let identity = (message.clone(), run.clone());
                match &original_message {
                    Some(original) => assert_eq!(original, &identity, "UI submission changed its original identity"),
                    None => original_message = Some(identity),
                }
                snapshot["stage"] = json!("work");
                let work = api.query("agent", "work", json!({"sessionId":id,"target":{"kind":"message","messageId":message}})).await?;
                snapshot["work"] = json!({
                    "kind":work["kind"], "runId":work["execution"]["runId"],
                    "highWater":work["execution"]["highWater"],
                    "stateKind":work["execution"]["state"]["kind"],
                    "waitKinds":work["execution"]["state"]["waits"].as_array().map(|waits|
                        waits.iter().take(8).map(|wait| &wait["kind"]).collect::<Vec<_>>()),
                    "pendingInteractions":work["pendingInteractions"],
                });
                if work["kind"] == "pending" { return Ok(None); }
                assert_eq!(work["kind"], "delivered");
                assert_eq!(work["execution"]["runId"], run);
                match work["execution"]["state"]["kind"].as_str() {
                    Some("admitted" | "running" | "waiting") => return Ok(None),
                    Some("completed") => {}
                    state => return Err(format!("UI original Run did not complete successfully: {state:?}")),
                }
                let replies = chunks.iter().filter(|row| row["role"] == "assistant" && row["finalOutput"] == true).collect::<Vec<_>>();
                if replies.is_empty() { return Ok(None); }
                assert_eq!(replies.len(), 1);
                assert_eq!(replies[0]["text"], format!("desktop-reply-{nonce}"));
                assert_eq!(replies[0]["runId"], run);
                snapshot["stage"] = json!("observe new Session");
                let observed = api.query("agent", "observe", json!({"sessionId":id})).await?;
                snapshot["backendEqualsOriginalSelection"] = json!(observed["session"]["backend"] == model_choice["selection"]);
                assert_eq!(observed["session"]["backend"], model_choice["selection"]);
                snapshot["stage"] = json!("observe seed Session");
                let original = api.query("agent", "observe", json!({"sessionId":seed_id})).await?;
                snapshot["seedSessionEqualsOriginal"] = json!(original["session"] == seed_session);
                assert_eq!(original["session"], seed_session);
                snapshot["stage"] = json!("complete");
                Ok(Some(id.clone()))
            }));
                if let Some((message, run)) = &original_message {
                    snapshot["originalMessageId"] = json!(message);
                    snapshot["originalRunId"] = json!(run);
                }
                snapshot["fixture"] = json!({
                    "nonceRequests":model.as_ref().unwrap().nonce_requests.load(Ordering::Relaxed),
                    "includesAux":true,
                });
                first_completion_snapshot.get_or_insert_with(|| snapshot.clone());
                last_completion_snapshot = Some(snapshot);
                if let Some(id) = completed? {
                    completed_session = Some(id);
                    Ok(true)
                } else {
                    Ok(false)
                }
            },
        );
        if completion.is_err() {
            diagnose("first-send completion failure");
            eprintln!(
                "desktop first-send completion snapshots={}",
                json!({
                    "first":first_completion_snapshot, "last":last_completion_snapshot,
                })
            );
        }
        completion?;
        assert_ne!(completed_session.as_deref(), Some(seed_id.as_str()));
        assert!(
            model
                .as_ref()
                .unwrap()
                .nonce_requests
                .load(Ordering::Relaxed)
                >= 1,
            "actual UI nonce must reach the owned model endpoint"
        );
        wait_native(
            native,
            &errors,
            "new nonempty Session is the selected Desktop conversation",
            || {
                Ok(bounds("Chat")?.len() == 1
                    && bounds("Trajectory")?.len() == 1
                    && bounds("Choose model and effort")?.len() == 1)
            },
        )?;
        paint("actual native frame of selected completed Session")?;
        // The empty seed and pending draft cannot expose these nonempty conversation tabs.
        click("Choose model and effort")?;
        wait_native(
            native,
            &errors,
            "selected new Session's model settings root",
            || {
                for label in [
                    "Choose model",
                    "Edit current model settings",
                    "Manage external agents",
                    "Manage connections and models",
                ] {
                    if bounds(label)?.len() != 1 {
                        return Ok(false);
                    }
                }
                Ok(true)
            },
        )?;
        assert!(
            bounds("Close model selection")?.is_empty(),
            "Desktop root has no terminal close header"
        );
        assert!(
            bounds("Back to model settings")?.is_empty(),
            "Desktop root has no models-pane back header"
        );
        paint("actual native frame of selected Session's model settings")?;
        click("Choose model")?;
        models_pane("persisted new Session's real models pane")?;
        let after = runtime.block_on(phase(
            "final independent Session list",
            sessions(observer.as_ref().unwrap()),
        ))?;
        assert_eq!(after.len(), before.len() + 1);
        assert!(before.keys().all(|id| after.contains_key(id)));
        assert_eq!(after.get(&seed_id), Some(&seed));
        assert_eq!(
            after
                .keys()
                .find(|id| !before.contains_key(*id))
                .map(String::as_str),
            completed_session.as_deref()
        );
        Ok(())
    }));

    // UI and Host handles outlive every setup/render panic. Stop the original
    // view, settle the original Bindings, then request Host quit or reap it.
    let mut cleanup = Vec::new();
    settle("stop original view", &mut cleanup, || {
        if let Some(native) = &platform {
            native.stop();
        }
        Ok(())
    });
    settle("stop original platform", &mut cleanup, || {
        if let Some(native) = &platform {
            native.shutdown();
        }
        drop(platform.take());
        Ok(())
    });
    if let Some(owner) = &bindings {
        settle("original Bindings", &mut cleanup, || {
            runtime.block_on(phase("close original workbench Bindings", owner.close()))
        });
    }
    if let Some(api) = &observer {
        settle("independent API", &mut cleanup, || {
            runtime.block_on(phase("close independent API client", api.close()))
        });
    }
    if matches!(&outcome, Ok(Ok(())))
        && cleanup.is_empty()
        && let (Some(child), Some(client)) = (&mut process, &mut control)
    {
        settle("Host quit", &mut cleanup, || {
            runtime.block_on(phase(
                "Host quit ACK, stdout EOF and wait",
                child.quit(client),
            ))
        });
    }
    if let Some(child) = &mut process {
        settle("original Child", &mut cleanup, || {
            runtime.block_on(phase(
                "exact original Child failure kill/wait",
                child.cleanup(),
            ))
        });
    }
    if let Some(model) = &mut model {
        settle(
            "owned model listener and every connection",
            &mut cleanup,
            || runtime.block_on(model.close()),
        );
    }
    if !cleanup.is_empty() {
        eprintln!("desktop cleanup failures: {}", cleanup.join("; "));
    }
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}
