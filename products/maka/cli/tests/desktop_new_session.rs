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

#![cfg(all(unix, feature = "desktop-tests"))]

// The real Desktop workbench on an offscreen GPUI/Wgpu platform. This is not
// an OS-window/Desktop Shell E2E test or a terminal-keyboard surface.
#[path = "support/host.rs"]
mod host;

use gpui::{
    AppContext, Application, Bounds, Focusable, MouseButton, MouseDownEvent, MouseUpEvent,
    PlatformInput, WindowBounds, WindowHandle, WindowOptions, point, px, size,
};
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
use nsh_gpui_terminal::TerminalPlatform;
use nsh_platform_gpui::{AppOptions, AppView};
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
    platform: &TerminalPlatform,
    errors: &RefCell<Option<String>>,
    name: &str,
    mut ready: impl FnMut() -> Result<bool>,
) -> Result<()> {
    let deadline = Instant::now() + STEP;
    loop {
        platform.pump();
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

#[test]
fn new_conversation_creates_and_selects_a_session_in_the_same_workspace() {
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
    let mut application = None;
    let mut model = None;
    let nonce = format!("desktop-message-{}", Uuid::new_v4().simple());
    let window: Rc<RefCell<Option<WindowHandle<AppView>>>> = Rc::new(RefCell::new(None));
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
            let detail = phase("read loopback credential target", api.query("settings", "connection", json!({"connectionId":connection}))).await?;
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
            TerminalPlatform::new(
                Box::new(
                    gpui_wgpu::WgpuHeadlessRenderer::new().map_err(|error| error.to_string())?,
                ),
                Box::new(move |frame| {
                    let rendered = std::thread::spawn(move || frame.submit()?.complete())
                        .join()
                        .expect("original GPU readback panicked")
                        .expect("original GPU readback failed");
                    assert!(
                        !rendered.pixels().is_empty(),
                        "GPU returned no actual pixels"
                    );
                    submitted.set(submitted.get() + 1);
                }),
                Arc::new(move || main_thread.unpark()),
            )
            .map_err(|error| error.to_string())?,
        );
        let native = platform.as_ref().unwrap();
        let opened = window.clone();
        let failed = errors.clone();
        application = Some(
            Application::with_platform(native.clone()).run_embedded(move |cx| {
                *opened.borrow_mut() = Some(
                    cx.open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                point(px(0.0), px(0.0)),
                                size(px(1200.0), px(800.0)),
                            ))),
                            inactive_frame_interval: None,
                            ..Default::default()
                        },
                        move |window, cx| {
                            cx.new(|cx| {
                                let view = AppView::new(
                                    AppOptions {
                                        terminal_keyboard: false,
                                        data_dir: Some(directory),
                                        cache: nsh_engine::CacheOptions::off(),
                                        ..Default::default()
                                    },
                                    window,
                                    cx,
                                );
                                view.on_error(move |message| {
                                    failed
                                        .borrow_mut()
                                        .get_or_insert_with(|| message.to_owned());
                                });
                                // AppView's public Desktop environment owns idiom, viewport
                                // and OS; its actual native window supplies input and layout.
                                view.load_with_config(config);
                                window.focus(&view.focus_handle(cx), cx);
                                view
                            })
                        },
                    )
                    .expect("open actual offscreen GPUI window"),
                );
            }),
        );
        native.set_active(true).map_err(|error| error.to_string())?;
        let embedded = application.as_ref().unwrap();
        let bounds = |label: &str| -> Result<Vec<Bounds<gpui::Pixels>>> {
            embedded.update(|cx| {
                window
                    .borrow()
                    .as_ref()
                    .ok_or("original window missing")?
                    .update(cx, |view, _, _| view.pressable_bounds(label))
                    .map_err(|error| error.to_string())
            })
        };
        let paint = |name: &str| -> Result<()> {
            let previous = frames.get();
            embedded
                .update(|cx| {
                    window
                        .borrow()
                        .as_ref()
                        .unwrap()
                        .update(cx, |_, window, _| window.refresh())
                })
                .map_err(|error| error.to_string())?;
            wait_native(native, &errors, name, || Ok(frames.get() > previous))
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
        // Bounds observe the current NSH tree; GPUI dispatches against its
        // rendered frame. A prior startup frame is not this target's paint.
        paint("actual GPU frame after seed controls mounted")?;
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
            let window_state = embedded.update(|cx| {
                window
                    .borrow()
                    .as_ref()
                    .unwrap()
                    .update(cx, |view, window, cx| {
                        format!(
                            "viewport={:?} scale={} active={} view_focused={} mouse={:?} focus_subtree_hovered={} input_group_admitted={}",
                            window.viewport_size(),
                            window.scale_factor(),
                            window.is_window_active(),
                            view.focus_handle(cx).is_focused(window),
                            window.mouse_position(),
                            view.focus_handle(cx).contains_hovered(window),
                            window.input_group_is_admitted(window.active_input_group()),
                        )
                    })
                    .map_err(|error| error.to_string())
            });
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
            paint("actual GPU frame before semantic pointer input")?;
            let targets = bounds(label)?;
            assert_eq!(targets.len(), 1, "{label} must have one live native target");
            let target = targets[0];
            assert!(target.size.width > px(0.0) && target.size.height > px(0.0));
            let position = point(
                target.origin.x + target.size.width / 2.0,
                target.origin.y + target.size.height / 2.0,
            );
            eprintln!("desktop click label={label:?} bounds={target:?}");
            native
                .dispatch_input(PlatformInput::MouseDown(MouseDownEvent {
                    position,
                    button: MouseButton::Left,
                    click_count: 1,
                    ..Default::default()
                }))
                .map_err(|error| error.to_string())?;
            native
                .dispatch_input(PlatformInput::MouseUp(MouseUpEvent {
                    position,
                    button: MouseButton::Left,
                    click_count: 1,
                    ..Default::default()
                }))
                .map_err(|error| error.to_string())?;
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
            paint("actual GPU frame with models pane")
        };

        click("New conversation")?;
        paint("actual GPU frame after original New click")?;
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
        let choose = format!(
            "Use {} · {}",
            model_choice["label"]
                .as_str()
                .ok_or("model choice omitted label")?,
            model_choice["sourceName"]
                .as_str()
                .ok_or("model choice omitted source name")?
        );
        wait_native(native, &errors, "actual loopback model row", || {
            Ok(bounds(&choose)?.len() == 1)
        })?;
        paint("actual GPU frame with loopback model row")?;
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
        paint("actual GPU frame after choosing pending model")?;
        click("Focus message composer")?;
        wait_native(native, &errors, "real native composer input target", || {
            Ok(native.text_input_target().is_some())
        })?;
        // This is the current GPUI native editor, not a JS callback or a stored draft edit.
        native.paste(&nonce).map_err(|error| error.to_string())?;
        wait_native(
            native,
            &errors,
            "actual enabled Send message after native paste",
            || Ok(bounds("Send message")?.len() == 1),
        )?;
        paint("actual GPU frame with enabled Send message")?;
        click("Send message")?;

        let mut original_message = None;
        let mut completed_session = None;
        let completion = wait_native(
            native,
            &errors,
            "UI first send materializes one Session and completes its original Run",
            || {
                let completed = runtime.block_on(phase("observe actual UI submission", async {
                let api = observer.as_ref().unwrap();
                let after = sessions(api).await?;
                assert_eq!(after.get(&seed_id), Some(&seed), "UI submission mutated seed");
                assert!(before.keys().all(|id| after.contains_key(id)));
                let added = after.iter().filter(|(id, _)| !before.contains_key(*id)).collect::<Vec<_>>();
                assert!(added.len() <= 1, "UI submission created duplicate Sessions");
                let Some((id, created)) = added.first().copied() else { return Ok(None); };
                assert_eq!(created["workspace"], seed["workspace"]);
                let history = api.query("agent", "history", json!({"sessionId":id,"position":{"kind":"start"},"view":"conversation"})).await?;
                assert_eq!(history["kind"], "ready");
                assert!(history.get("after").ok_or("history omitted after")?.is_null());
                let chunks = history["chunks"].as_array().ok_or("history omitted chunks")?;
                let users = chunks.iter().filter(|row| row["role"] == "user" && row["field"] == "body").collect::<Vec<_>>();
                if users.is_empty() { return Ok(None); }
                assert_eq!(users.len(), 1, "UI must submit the original nonce once");
                let user = users[0];
                assert_eq!(user["text"], nonce);
                assert_eq!(user["offset"], 0);
                let message = user["messageId"].as_str().ok_or("user message omitted id")?.to_owned();
                let run = user["runId"].as_str().ok_or("user message omitted Run")?.to_owned();
                let identity = (message.clone(), run.clone());
                match &original_message {
                    Some(original) => assert_eq!(original, &identity, "UI submission changed its original identity"),
                    None => original_message = Some(identity),
                }
                let work = api.query("agent", "work", json!({"sessionId":id,"target":{"kind":"message","messageId":message}})).await?;
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
                let observed = api.query("agent", "observe", json!({"sessionId":id})).await?;
                assert_eq!(observed["session"]["backend"], model_choice["selection"]);
                let original = api.query("agent", "observe", json!({"sessionId":seed_id})).await?;
                assert_eq!(original["session"], seed_session);
                Ok(Some(id.clone()))
            }))?;
                if let Some(id) = completed {
                    completed_session = Some(id);
                    Ok(true)
                } else {
                    Ok(false)
                }
            },
        );
        if completion.is_err() {
            diagnose("first-send completion failure");
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
        paint("actual GPU frame of selected completed Session")?;
        // The empty seed and pending draft cannot expose these nonempty conversation tabs.
        click("Choose model and effort")?;
        wait_native(
            native,
            &errors,
            "selected new Session's model settings root",
            || Ok(bounds("Close model selection")?.len() == 1 && bounds("Choose model")?.len() == 1),
        )?;
        paint("actual GPU frame of selected Session's model settings")?;
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
                .filter(|id| !before.contains_key(*id))
                .next()
                .map(String::as_str),
            completed_session.as_deref()
        );
        Ok(())
    }));

    // UI and Host handles outlive every setup/render panic. Stop the original
    // view, settle the original Bindings, then request Host quit or reap it.
    let mut cleanup = Vec::new();
    settle("stop original view", &mut cleanup, || {
        if let Some(app) = &application {
            app.update(|cx| {
                if let Some(window) = window.borrow().as_ref() {
                    window
                        .update(cx, |view, _, _| view.stop())
                        .map_err(|error| error.to_string())
                } else {
                    Ok(())
                }
            })
        } else {
            Ok(())
        }
    });
    settle("drop original GPUI application", &mut cleanup, || {
        drop(application.take());
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
    if matches!(&outcome, Ok(Ok(()))) && cleanup.is_empty() {
        if let (Some(child), Some(client)) = (&mut process, &mut control) {
            settle("Host quit", &mut cleanup, || {
                runtime.block_on(phase(
                    "Host quit ACK, stdout EOF and wait",
                    child.quit(client),
                ))
            });
        }
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
