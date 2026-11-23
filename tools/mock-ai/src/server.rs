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

mod admin;
mod http;
mod ws;

use crate::codec::format_http_error_body;
use crate::control::{ControlPlaneConfig, CustomRouteFn, StoredResponses};
use crate::handler::{
    AsyncFnHandler, ChainHandler, FilterHandler, FnHandler, InteractiveHandler, ScriptedHandler,
    SessionTracker, TurnContext, TurnHandle, TurnHandler,
};
use crate::metrics::{
    MetricsSnapshot, RecordedControlRequest, RecordedRequest, RecorderMode, RequestRecorder,
    ServerMetrics,
};
use crate::pacing::{
    DynamicProfileManager, LatencyProfile, ProfileSnapshot, RuntimeProfile, ScenarioSchedule,
};
use crate::plan::{CloseSignal, HttpErrorSpec, TurnEvent, TurnPlan, Usage};
use crate::protocol::{AuthPolicy, NormalizedRequest, Protocol};
#[cfg(feature = "proxy")]
use crate::proxy::{CassetteReplayer, ProxyRecordConfig, ProxyRecorder, ReplayConfig};
use crate::ratelimit::{RateLimitConfig, RateLimiter};
#[cfg(feature = "rules")]
use crate::rules::{ConfigError, RuleEngine, RuleSpec};
#[cfg(feature = "tls")]
use crate::tls::TlsServerConfig;
use crate::watchdog::{ProtocolWatchdog, WatchdogConfig, WatchdogSnapshot};
use bytes::Bytes;
use futures_util::FutureExt;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::any::Any;
use std::collections::BTreeMap;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::io;
use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_util::sync::CancellationToken;

pub(super) type BoxBody = UnsyncBoxBody<Bytes, io::Error>;

/// Low-level connection and memory tuning for high-concurrency stress tests.
#[derive(Debug, Clone)]
pub struct ServerTuning {
    /// Maximum HTTP request body size accepted (default: 64 MiB).
    pub max_request_bytes: usize,
    /// Per-WebSocket read/write buffer size in bytes (default: 16 KiB).
    pub ws_read_buffer_size: usize,
    /// Max WebSocket message size (default: 128 MiB).
    pub ws_max_message_size: usize,
    /// Max WebSocket frame size (default: 32 MiB).
    pub ws_max_frame_size: usize,
    /// Enable HTTP/1.1 keep-alive (default: true).
    pub http_keep_alive: bool,
    /// Maximum tracked sessions in `SessionTracker` (default: 65,536).
    pub max_tracked_sessions: usize,
    /// Enforce strict `previous_response_id` continuity checks on Responses HTTP/WS (default: true).
    pub strict_previous_response_id: bool,
    /// If set, reject WebSocket upgrade requests with this HTTP status (for testing HTTP fallback).
    pub reject_websocket_upgrade_status: Option<u16>,
}

impl Default for ServerTuning {
    fn default() -> Self {
        Self {
            max_request_bytes: 64 * 1024 * 1024,
            ws_read_buffer_size: 16 * 1024,
            ws_max_message_size: 128 * 1024 * 1024,
            ws_max_frame_size: 32 * 1024 * 1024,
            http_keep_alive: true,
            max_tracked_sessions: 65_536,
            strict_previous_response_id: true,
            reject_websocket_upgrade_status: None,
        }
    }
}

pub(crate) struct ServerState {
    pub auth: AuthPolicy,
    pub control: ControlPlaneConfig,
    pub tuning: ServerTuning,
    pub handler: Arc<dyn TurnHandler>,
    #[cfg(feature = "rules")]
    pub rule_engine: Option<Arc<RuleEngine>>,
    pub custom_route: Option<CustomRouteFn>,
    pub metrics: Arc<ServerMetrics>,
    pub recorder: Arc<RequestRecorder>,
    pub stored_responses: Arc<StoredResponses>,
    pub sessions: Arc<SessionTracker>,
    pub profile: Arc<DynamicProfileManager>,
    pub rate_limiter: Arc<RateLimiter>,
    pub watchdog: Arc<ProtocolWatchdog>,
    #[cfg(feature = "tls")]
    pub tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
    #[cfg(feature = "proxy")]
    pub proxy_recorder: Option<Arc<ProxyRecorder>>,
    #[cfg(feature = "proxy")]
    pub cassette_replayer: Option<Arc<CassetteReplayer>>,
    pub panics: Mutex<Vec<String>>,
    pub next_seq: AtomicU64,
    pub next_conn_id: AtomicU64,
    pub shutdown: CancellationToken,
}

impl ServerState {
    pub(super) fn next_sequence(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub(super) fn next_connection_id(&self) -> u64 {
        self.next_conn_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub(super) fn record_panic(&self, message: String) {
        tracing::error!(panic = %message, "mock-ai handler/task panicked");
        self.panics
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(message);
    }

    pub(super) fn reset(&self) {
        self.metrics.reset();
        self.recorder.clear();
        self.stored_responses.clear();
        self.sessions.clear();
        self.profile.reset_clock();
        self.rate_limiter.reset();
        self.watchdog.clear();
        #[cfg(feature = "proxy")]
        if let Some(replayer) = &self.cassette_replayer {
            replayer.reset();
        }
        self.panics
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.next_seq.store(0, Ordering::Release);
        self.handler.reset();
    }

    fn ws_config(&self) -> WebSocketConfig {
        let mut cfg = WebSocketConfig::default();
        cfg.read_buffer_size = self.tuning.ws_read_buffer_size;
        cfg.write_buffer_size = self.tuning.ws_read_buffer_size;
        cfg.max_message_size = Some(self.tuning.ws_max_message_size);
        cfg.max_frame_size = Some(self.tuning.ws_max_frame_size);
        cfg
    }
}

pub(super) fn panic_payload_to_string(payload: Box<dyn Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_owned()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_owned()
    }
}

/// Spawn a background task whose panics are captured onto `ServerState` instead of silently lost.
pub(super) fn spawn_tracked<F>(state: Arc<ServerState>, fut: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        if let Err(payload) = AssertUnwindSafe(fut).catch_unwind().await {
            state.record_panic(panic_payload_to_string(payload));
        }
    });
}

/// Running local simulated AI server (HTTP + SSE + Responses WebSocket + Control Plane).
pub struct MockAiServer {
    addr: SocketAddr,
    state: Arc<ServerState>,
    interactive_rx: Option<mpsc::Receiver<TurnHandle>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl MockAiServer {
    pub(crate) async fn spawn(
        listener: TcpListener,
        state: Arc<ServerState>,
        interactive_rx: Option<mpsc::Receiver<TurnHandle>>,
    ) -> io::Result<Self> {
        let addr = listener.local_addr()?;
        let loop_state = state.clone();
        let task = tokio::spawn(async move {
            accept_loop(listener, loop_state).await;
        });
        Ok(Self {
            addr,
            state,
            interactive_rx,
            task: Some(task),
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn is_tls(&self) -> bool {
        #[cfg(feature = "tls")]
        {
            self.state.tls_acceptor.is_some()
        }
        #[cfg(not(feature = "tls"))]
        {
            false
        }
    }

    /// Root origin URL without trailing slash (e.g. `http://127.0.0.1:54321` or `https://...`).
    pub fn origin_url(&self) -> String {
        let scheme = if self.is_tls() { "https" } else { "http" };
        format!("{scheme}://{}", self.addr)
    }

    /// Standard OpenAI / Anthropic compatible base URL ending in `/v1`.
    pub fn base_url(&self) -> String {
        format!("{}/v1", self.origin_url())
    }

    /// WebSocket base URL for Responses API (e.g. `ws://.../v1/responses` or `wss://.../v1/responses`).
    pub fn responses_ws_url(&self) -> String {
        let scheme = if self.is_tls() { "wss" } else { "ws" };
        format!("{scheme}://{}/v1/responses", self.addr)
    }

    /// Receive the next interactive `TurnHandle` (available when started in interactive mode).
    pub async fn next_turn(&mut self) -> Option<TurnHandle> {
        self.interactive_rx.as_mut()?.recv().await
    }

    /// Take ownership of the interactive turn receiver (useful when splitting tasks).
    pub fn take_interactive_rx(&mut self) -> Option<mpsc::Receiver<TurnHandle>> {
        self.interactive_rx.take()
    }

    pub fn request_count(&self) -> u64 {
        self.state.metrics.total_requests.load(Ordering::Relaxed)
    }

    pub fn metrics(&self) -> MetricsSnapshot {
        self.state.metrics.snapshot()
    }

    pub fn recorded_requests(&self) -> Vec<RecordedRequest> {
        self.state.recorder.snapshot()
    }

    pub fn control_plane_requests(&self) -> Vec<RecordedControlRequest> {
        self.state.recorder.control_snapshot()
    }

    pub fn stored_response(&self, id: &str) -> Option<Value> {
        self.state.stored_responses.get(id)
    }

    /// Take and clear any recorded handler/task panics (prevents `shutdown()`/`Drop` from panicking).
    pub fn take_panics(&self) -> Vec<String> {
        std::mem::take(&mut *self.state.panics.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Panic immediately if any handler/connection task panicked while serving requests.
    pub fn assert_no_panics(&self) {
        let panics = self.take_panics();
        if !panics.is_empty() {
            panic!("mock-ai handler panicked: {}", panics.join("; "));
        }
    }

    pub fn reset(&self) {
        self.state.reset();
    }

    #[cfg(feature = "rules")]
    pub fn replace_rules(&self, rules: Vec<RuleSpec>) -> Result<(), ConfigError> {
        if let Some(engine) = &self.state.rule_engine {
            engine.replace_rules(rules)
        } else {
            Ok(())
        }
    }

    pub fn profile_snapshot(&self) -> ProfileSnapshot {
        self.state.profile.snapshot()
    }

    pub fn set_runtime_profile(&self, profile: Option<RuntimeProfile>) {
        self.state.profile.set_manual_override(profile);
    }

    pub fn set_schedule(&self, schedule: ScenarioSchedule) {
        self.state.profile.set_schedule(schedule);
    }

    pub fn update_rate_limit(&self, config: RateLimitConfig) {
        self.state.rate_limiter.update_config(config);
    }

    pub fn watchdog_snapshot(&self) -> WatchdogSnapshot {
        self.state.watchdog.snapshot()
    }

    pub fn clear_violations(&self) {
        self.state.watchdog.clear();
    }

    pub fn render_prometheus(&self) -> String {
        self.state
            .metrics
            .render_prometheus(self.state.watchdog.total_violations())
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.state.shutdown.clone()
    }

    /// Shut down the server, wait for all connection tasks to drain, and return any
    /// recorded handler/task panics without panicking during teardown.
    pub async fn shutdown_taking_panics(mut self) -> Vec<String> {
        self.state.shutdown.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        #[cfg(feature = "proxy")]
        if let Some(ref proxy) = self.state.proxy_recorder {
            proxy.flush().await;
        }
        self.take_panics()
    }

    pub async fn shutdown(self) {
        let panics = self.shutdown_taking_panics().await;
        assert!(
            panics.is_empty(),
            "mock-ai handler panicked: {}",
            panics.join("; ")
        );
    }
}

impl Drop for MockAiServer {
    fn drop(&mut self) {
        self.state.shutdown.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
        if !std::thread::panicking() {
            let panics = self.take_panics();
            if !panics.is_empty() {
                panic!("mock-ai handler panicked: {}", panics.join("; "));
            }
        }
    }
}

/// Ergonomic builder for constructing `MockAiServer` instances.
pub struct MockAiBuilder {
    bind_addr: SocketAddr,
    auth: AuthPolicy,
    control: ControlPlaneConfig,
    tuning: ServerTuning,
    recorder_mode: RecorderMode,
    latency: LatencyProfile,
    schedule: ScenarioSchedule,
    rate_limit: RateLimitConfig,
    watchdog: WatchdogConfig,
    #[cfg(feature = "tls")]
    tls: Option<TlsServerConfig>,
    #[cfg(feature = "proxy")]
    proxy_recorder: Option<Arc<ProxyRecorder>>,
    #[cfg(feature = "proxy")]
    cassette_replayer: Option<Arc<CassetteReplayer>>,
    handler: Option<Arc<dyn TurnHandler>>,
    #[cfg(feature = "rules")]
    rule_engine: Option<Arc<RuleEngine>>,
    custom_route: Option<CustomRouteFn>,
    interactive_rx: Option<mpsc::Receiver<TurnHandle>>,
}

impl Default for MockAiBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl MockAiBuilder {
    pub fn new() -> Self {
        Self {
            bind_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
            auth: AuthPolicy::AllowAll,
            control: ControlPlaneConfig::default(),
            tuning: ServerTuning::default(),
            recorder_mode: RecorderMode::Full,
            latency: LatencyProfile::default(),
            schedule: ScenarioSchedule::default(),
            rate_limit: RateLimitConfig::default(),
            watchdog: WatchdogConfig::default(),
            #[cfg(feature = "tls")]
            tls: None,
            #[cfg(feature = "proxy")]
            proxy_recorder: None,
            #[cfg(feature = "proxy")]
            cassette_replayer: None,
            handler: None,
            #[cfg(feature = "rules")]
            rule_engine: None,
            custom_route: None,
            interactive_rx: None,
        }
    }

    pub fn bind(mut self, addr: SocketAddr) -> Self {
        self.bind_addr = addr;
        self
    }

    pub fn auth(mut self, auth: AuthPolicy) -> Self {
        self.auth = auth;
        self
    }

    pub fn control(mut self, control: ControlPlaneConfig) -> Self {
        self.control = control;
        self
    }

    pub fn tuning(mut self, tuning: ServerTuning) -> Self {
        self.tuning = tuning;
        self
    }

    pub fn recorder(mut self, mode: RecorderMode) -> Self {
        self.recorder_mode = mode;
        self
    }

    pub fn handler(mut self, handler: Arc<dyn TurnHandler>) -> Self {
        self.handler = Some(handler);
        self
    }

    pub fn handler_fn<F>(self, f: F) -> Self
    where
        F: Fn(&NormalizedRequest, &TurnContext) -> TurnPlan + Send + Sync + 'static,
    {
        self.handler(Arc::new(FnHandler(f)))
    }

    pub fn handler_async<F, Fut>(self, f: F) -> Self
    where
        F: Fn(NormalizedRequest, TurnContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Option<TurnPlan>> + Send + 'static,
    {
        self.handler(Arc::new(AsyncFnHandler(f)))
    }

    pub fn scripted(self, plans: impl IntoIterator<Item = TurnPlan>) -> Self {
        self.handler(Arc::new(ScriptedHandler::new(plans)))
    }

    #[cfg(feature = "rules")]
    pub fn rules(
        mut self,
        specs: Vec<RuleSpec>,
        default_reply: Option<TurnPlan>,
    ) -> Result<Self, ConfigError> {
        let engine = Arc::new(RuleEngine::new(specs, default_reply)?);
        self.rule_engine = Some(engine.clone());
        self.handler = Some(engine);
        Ok(self)
    }

    pub fn workload(self, config: crate::workload::WorkloadConfig) -> Self {
        self.handler(Arc::new(crate::workload::WorkloadGenerator::new(config)))
    }

    pub fn interactive(mut self, capacity: usize) -> Self {
        let (handler, rx) = InteractiveHandler::channel(capacity);
        self.handler = Some(handler);
        self.interactive_rx = Some(rx);
        self
    }

    /// Start in interactive mode, while allowing `filter` to immediately reply to
    /// auxiliary requests (e.g. title/recap) without pushing them to `server.next_turn()`.
    pub fn interactive_filtered<F>(mut self, capacity: usize, filter: F) -> Self
    where
        F: Fn(&NormalizedRequest, &TurnContext) -> Option<TurnPlan> + Send + Sync + 'static,
    {
        let (interactive, rx) = InteractiveHandler::channel(capacity);
        self.handler = Some(Arc::new(ChainHandler::new(vec![
            Arc::new(FilterHandler(filter)),
            interactive,
        ])));
        self.interactive_rx = Some(rx);
        self
    }

    pub fn custom_route(mut self, route: CustomRouteFn) -> Self {
        self.custom_route = Some(route);
        self
    }

    pub fn latency_profile(mut self, profile: LatencyProfile) -> Self {
        self.latency = profile;
        self
    }

    pub fn schedule(mut self, schedule: ScenarioSchedule) -> Self {
        self.schedule = schedule;
        self
    }

    pub fn rate_limit(mut self, config: RateLimitConfig) -> Self {
        self.rate_limit = config;
        self
    }

    pub fn watchdog(mut self, config: WatchdogConfig) -> Self {
        self.watchdog = config;
        self
    }

    #[cfg(feature = "tls")]
    pub fn tls(mut self, config: TlsServerConfig) -> Self {
        self.tls = Some(config);
        self
    }

    #[cfg(feature = "proxy")]
    pub fn proxy_record(mut self, config: ProxyRecordConfig) -> Result<Self, String> {
        self.proxy_recorder = Some(Arc::new(ProxyRecorder::new(config)?));
        Ok(self)
    }

    #[cfg(feature = "proxy")]
    pub fn replay(mut self, config: ReplayConfig) -> Result<Self, String> {
        self.cassette_replayer = Some(Arc::new(CassetteReplayer::load(config)?));
        Ok(self)
    }

    #[cfg(feature = "rules")]
    pub fn with_rule_engine(mut self, engine: Arc<RuleEngine>) -> Self {
        self.rule_engine = Some(engine);
        self
    }

    pub async fn start(self) -> io::Result<MockAiServer> {
        let socket = match self.bind_addr {
            SocketAddr::V4(_) => tokio::net::TcpSocket::new_v4()?,
            SocketAddr::V6(_) => tokio::net::TcpSocket::new_v6()?,
        };
        let _ = socket.set_reuseaddr(true);
        socket.bind(self.bind_addr)?;
        let listener = socket.listen(4096)?;
        self.start_with_listener(listener).await
    }

    pub async fn start_with_listener(mut self, listener: TcpListener) -> io::Result<MockAiServer> {
        let handler: Arc<dyn TurnHandler> = self.handler.take().unwrap_or_else(|| {
            Arc::new(FnHandler(|req: &NormalizedRequest, ctx: &TurnContext| {
                TurnPlan::text(format!(
                    "mock reply to '{}' (turn {})",
                    req.last_user_text().unwrap_or(""),
                    ctx.session_turn
                ))
            }))
        });

        let stored_responses = Arc::new(StoredResponses::new(
            self.control.stored_responses_capacity,
            self.control.stored_responses_max_bytes,
        ));
        let sessions = Arc::new(SessionTracker::new(self.tuning.max_tracked_sessions));

        let base_profile = RuntimeProfile {
            latency: self.latency,
            chaos_override: None,
            rate_limit_override: None,
        };
        let state = Arc::new(ServerState {
            auth: self.auth,
            control: self.control,
            tuning: self.tuning,
            handler,
            #[cfg(feature = "rules")]
            rule_engine: self.rule_engine,
            custom_route: self.custom_route,
            metrics: Arc::new(ServerMetrics::default()),
            recorder: Arc::new(RequestRecorder::new(self.recorder_mode)),
            stored_responses,
            sessions,
            profile: Arc::new(DynamicProfileManager::new(base_profile, self.schedule)),
            rate_limiter: RateLimiter::new(self.rate_limit),
            watchdog: Arc::new(ProtocolWatchdog::new(self.watchdog)),
            #[cfg(feature = "tls")]
            tls_acceptor: self.tls.map(|t| t.acceptor()),
            #[cfg(feature = "proxy")]
            proxy_recorder: self.proxy_recorder,
            #[cfg(feature = "proxy")]
            cassette_replayer: self.cassette_replayer,
            panics: Mutex::new(Vec::new()),
            next_seq: AtomicU64::new(0),
            next_conn_id: AtomicU64::new(0),
            shutdown: CancellationToken::new(),
        });

        MockAiServer::spawn(listener, state, self.interactive_rx).await
    }
}

async fn accept_loop(listener: TcpListener, state: Arc<ServerState>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = state.shutdown.cancelled() => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((socket, _peer)) => {
                        let _ = socket.set_nodelay(true);
                        let conn_state = state.clone();
                        connections.spawn(async move {
                            handle_connection(socket, conn_state).await;
                        });
                    }
                    Err(err) => {
                        tracing::debug!(%err, "mock-ai accept error");
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
            }
            Some(joined) = connections.join_next(), if !connections.is_empty() => {
                if let Err(err) = joined && err.is_panic() {
                    state.record_panic(panic_payload_to_string(err.into_panic()));
                }
            }
        }
    }
    connections.abort_all();
    while let Some(joined) = connections.join_next().await {
        if let Err(err) = joined
            && err.is_panic()
        {
            state.record_panic(panic_payload_to_string(err.into_panic()));
        }
    }
}

pub(super) struct ActiveConnGuard(pub Arc<ServerMetrics>);
impl Drop for ActiveConnGuard {
    fn drop(&mut self) {
        self.0.active_connections.fetch_sub(1, Ordering::Relaxed);
    }
}

pub(super) struct ActiveStreamGuard(pub Arc<ServerMetrics>);
impl Drop for ActiveStreamGuard {
    fn drop(&mut self) {
        self.0.active_streams.fetch_sub(1, Ordering::Relaxed);
    }
}

pub(super) struct TurnCloseGuard(pub Option<CloseSignal>, pub Option<CloseSignal>);
impl Drop for TurnCloseGuard {
    fn drop(&mut self) {
        if let Some(sig) = &self.0 {
            sig.notify();
        }
        if let Some(sig) = &self.1 {
            sig.notify();
        }
    }
}

pub(super) struct PendingWsUpgrade {
    pub on_upgrade: hyper::upgrade::OnUpgrade,
    pub path: String,
    #[cfg(feature = "proxy")]
    pub path_and_query: String,
    pub headers: BTreeMap<String, String>,
    #[cfg(feature = "proxy")]
    pub proxied_upstream: Option<tokio_tungstenite::WebSocketStream<crate::tls::UpstreamWsStream>>,
}

async fn handle_connection(socket: tokio::net::TcpStream, state: Arc<ServerState>) {
    state
        .metrics
        .active_connections
        .fetch_add(1, Ordering::Relaxed);
    let _conn_guard = ActiveConnGuard(state.metrics.clone());
    let conn_id = state.next_connection_id();

    #[cfg(feature = "tls")]
    if let Some(ref acceptor) = state.tls_acceptor {
        let tls_stream = tokio::select! {
            _ = state.shutdown.cancelled() => return,
            res = tokio::time::timeout(Duration::from_secs(15), acceptor.accept(socket)) => match res {
                Ok(Ok(s)) => s,
                Ok(Err(err)) => {
                    tracing::debug!(%err, conn_id, "mock-ai TLS handshake failed");
                    return;
                }
                Err(_) => {
                    tracing::debug!(conn_id, "mock-ai TLS handshake timed out");
                    return;
                }
            }
        };
        serve_connection_io(tls_stream, conn_id, state).await;
        return;
    }

    serve_connection_io(socket, conn_id, state).await;
}

async fn serve_connection_io<S>(io: S, conn_id: u64, state: Arc<ServerState>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let pending_upgrade: Arc<Mutex<Option<PendingWsUpgrade>>> = Arc::new(Mutex::new(None));
    let service = service_fn({
        let state = state.clone();
        let pending_upgrade = pending_upgrade.clone();
        move |req: Request<Incoming>| {
            let state = state.clone();
            let pending_upgrade = pending_upgrade.clone();
            async move {
                Ok::<_, io::Error>(http::handle_http_request(req, state, pending_upgrade).await)
            }
        }
    });

    let conn_fut = http1::Builder::new()
        .keep_alive(state.tuning.http_keep_alive)
        .serve_connection(TokioIo::new(io), service)
        .with_upgrades();

    tokio::select! {
        _ = state.shutdown.cancelled() => return,
        res = conn_fut => {
            if let Err(err) = res {
                tracing::debug!(%err, conn_id, "mock-ai http connection ended");
            }
        }
    }

    let upgraded = pending_upgrade.lock().unwrap().take();
    if let Some(upgrade) = upgraded {
        match upgrade.on_upgrade.await {
            Ok(upgraded_io) => {
                let ws_stream = WebSocketStream::from_raw_socket(
                    TokioIo::new(upgraded_io),
                    Role::Server,
                    Some(state.ws_config()),
                )
                .await;
                #[cfg(feature = "proxy")]
                if let (Some(proxy), Some(upstream_ws)) =
                    (&state.proxy_recorder, upgrade.proxied_upstream)
                {
                    state.metrics.proxy_requests.fetch_add(1, Ordering::Relaxed);
                    if let Err(err) = proxy
                        .bridge_websocket(
                            ws_stream,
                            upstream_ws,
                            &upgrade.path_and_query,
                            &upgrade.headers,
                            state.shutdown.clone(),
                        )
                        .await
                    {
                        tracing::debug!(%err, conn_id, "mock-ai ws proxy error");
                    }
                    return;
                }
                ws::handle_responses_websocket(
                    ws_stream,
                    conn_id,
                    upgrade.path,
                    upgrade.headers,
                    state,
                )
                .await;
            }
            Err(err) => {
                tracing::debug!(%err, conn_id, "mock-ai ws upgrade failed");
            }
        }
    }
}

pub(super) fn collect_headers(headers: &hyper::HeaderMap) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for (k, v) in headers {
        if let Ok(s) = v.to_str() {
            map.insert(k.as_str().to_ascii_lowercase(), s.to_owned());
        }
    }
    map
}

pub(super) fn full_json(status: StatusCode, value: &Value) -> Response<BoxBody> {
    let bytes = Bytes::from(value.to_string());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(
            Full::new(bytes)
                .map_err(|never| match never {})
                .boxed_unsync(),
        )
        .unwrap()
}

pub(super) fn error_http_response(
    protocol: Protocol,
    spec: &HttpErrorSpec,
    metrics: &ServerMetrics,
) -> Response<BoxBody> {
    metrics.http_errors_emitted.fetch_add(1, Ordering::Relaxed);
    if spec.status == 429 {
        metrics.rate_limits_emitted.fetch_add(1, Ordering::Relaxed);
    }
    if spec.status == 400
        && (spec.code.as_deref() == Some("context_length_exceeded")
            || spec.raw_body.as_ref().is_some_and(|v| {
                let s = v.to_string();
                s.contains("context_length_exceeded") || s.contains("prompt is too long")
            })
            || spec.raw_text.as_ref().is_some_and(|s| {
                s.contains("context_length_exceeded") || s.contains("prompt is too long")
            }))
    {
        metrics
            .context_overflows_emitted
            .fetch_add(1, Ordering::Relaxed);
    }

    let (content_type, bytes) = if let Some(raw_text) = &spec.raw_text {
        (
            spec.content_type.as_deref().unwrap_or("text/plain"),
            Bytes::from(raw_text.clone()),
        )
    } else {
        let body = format_http_error_body(protocol, spec);
        (
            spec.content_type.as_deref().unwrap_or("application/json"),
            Bytes::from(body.to_string()),
        )
    };
    metrics
        .bytes_sent
        .fetch_add(bytes.len() as u64, Ordering::Relaxed);

    let status = StatusCode::from_u16(spec.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, bytes.len());
    if let Some(ms) = spec.retry_after_ms {
        builder = builder.header("retry-after-ms", ms.to_string());
    }
    if let Some(secs) = spec.retry_after_secs {
        builder = builder.header(header::RETRY_AFTER, secs.to_string());
    }
    for (k, v) in &spec.headers {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            builder = builder.header(name, val);
        }
    }
    builder
        .body(
            Full::new(bytes)
                .map_err(|never| match never {})
                .boxed_unsync(),
        )
        .unwrap()
}

pub(super) fn format_ws_error_frame(spec: &HttpErrorSpec) -> Value {
    if let Some(raw) = &spec.raw_body {
        json!({
            "type": "error",
            "status": spec.status,
            "error": raw.get("error").cloned().unwrap_or_else(|| raw.clone()),
        })
    } else {
        let message = spec
            .raw_text
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&spec.message);
        json!({
            "type": "error",
            "status": spec.status,
            "error": {
                "type": spec.error_type,
                "code": spec.code,
                "message": message,
            }
        })
    }
}

pub(super) fn sse_response(
    rx: mpsc::Receiver<Result<Frame<Bytes>, io::Error>>,
    extra_headers: &BTreeMap<String, String>,
    close_connection: bool,
) -> Response<BoxBody> {
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache");
    if close_connection {
        builder = builder.header(header::CONNECTION, "close");
    }
    for (k, v) in extra_headers {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            builder = builder.header(name, val);
        }
    }
    builder
        .body(StreamBody::new(stream).boxed_unsync())
        .unwrap()
}

pub(super) fn json_with_headers(
    value: Value,
    extra_headers: &BTreeMap<String, String>,
    close_connection: bool,
    metrics: &ServerMetrics,
) -> Response<BoxBody> {
    let bytes = Bytes::from(value.to_string());
    metrics
        .bytes_sent
        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, bytes.len());
    if close_connection {
        builder = builder.header(header::CONNECTION, "close");
    }
    for (k, v) in extra_headers {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            builder = builder.header(name, val);
        }
    }
    builder
        .body(
            Full::new(bytes)
                .map_err(|never| match never {})
                .boxed_unsync(),
        )
        .unwrap()
}

pub(super) struct TtftTracker<'a> {
    pub turn_started: Instant,
    pub first_delta_at: &'a mut Option<Instant>,
    pub recorded_ttft_ms: &'a mut Option<u64>,
}

impl TtftTracker<'_> {
    pub fn record_once(&mut self, metrics: &ServerMetrics) {
        if self.first_delta_at.is_none() {
            *self.first_delta_at = Some(Instant::now());
            let ttft = self.turn_started.elapsed().as_millis() as u64;
            metrics.ttft_ms.record(ttft);
            *self.recorded_ttft_ms = Some(ttft);
        }
    }
}

pub(super) struct FlushStatus {
    pub all_wire_frames_sent: bool,
    pub continued: bool,
}

pub(super) fn is_semantic_delta_frame(raw: &str) -> bool {
    let json_str = raw
        .lines()
        .find_map(|line| line.strip_prefix("data:").map(str::trim))
        .unwrap_or_else(|| raw.trim());
    let Ok(val) = serde_json::from_str::<Value>(json_str) else {
        return true;
    };
    if let Some(ev_type) = val.get("type").and_then(Value::as_str) {
        return !matches!(
            ev_type,
            "response.created"
                | "response.in_progress"
                | "response.output_item.added"
                | "response.content_part.added"
                | "message_start"
                | "content_block_start"
        );
    }
    true
}

pub(super) fn pacer_seed_for(req: &NormalizedRequest) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    req.session_key.hash(&mut h);
    req.sequence.hash(&mut h);
    h.finish()
}

pub(super) fn enqueue_interactive_command(
    pending: &mut std::collections::VecDeque<TurnEvent>,
    cmd: crate::handler::InteractiveCommand,
) {
    match cmd {
        crate::handler::InteractiveCommand::Event(ev) => pending.push_back(*ev),
        crate::handler::InteractiveCommand::Plan(plan) => {
            let inferred = plan.inferred_finish_reason();
            let mut has_terminal = false;
            for ev in plan.events {
                if matches!(
                    ev,
                    TurnEvent::Finish { .. }
                        | TurnEvent::HttpError(_)
                        | TurnEvent::MidStreamError(_)
                        | TurnEvent::DropConnection
                        | TurnEvent::TruncateEof
                        | TurnEvent::Stall
                ) {
                    has_terminal = true;
                }
                pending.push_back(ev);
            }
            if !has_terminal {
                pending.push_back(TurnEvent::Finish { reason: inferred });
            }
        }
    }
}

pub(super) fn plan_usage_hint(plan: &TurnPlan, req: &NormalizedRequest) -> Usage {
    for ev in &plan.events {
        if let TurnEvent::Usage(u) = ev {
            return u.clone();
        }
    }
    Usage::new(req.estimated_input_tokens.max(1), 0)
}

pub(super) fn semantic_event_bytes(ev: &TurnEvent) -> usize {
    match ev {
        TurnEvent::Text { text, .. } => text.len(),
        TurnEvent::Reasoning { text, .. } => text.len(),
        TurnEvent::Refusal { text } => text.len(),
        TurnEvent::ToolCall(tc) => tc.arguments_string().len() + tc.name.len(),
        TurnEvent::NativeCompaction(c) => c.summary.len().max(c.encrypted_content.len()),
        _ => 0,
    }
}

pub(super) fn classify_protocol(path: &str) -> Option<Protocol> {
    if path.ends_with("/chat/completions") {
        Some(Protocol::OpenaiChatCompletions)
    } else if is_responses_path(path) {
        Some(Protocol::OpenaiResponsesHttp)
    } else if path.ends_with("/messages") {
        Some(Protocol::AnthropicMessages)
    } else {
        None
    }
}

pub(super) fn is_responses_path(path: &str) -> bool {
    path == "/responses" || path == "/v1/responses" || path.ends_with("/responses")
}

pub(super) fn extract_stored_response_id(path: &str) -> Option<&str> {
    let rest = path
        .strip_prefix("/v1/responses/")
        .or_else(|| path.strip_prefix("/responses/"))?;
    if rest.is_empty() || rest.contains('/') {
        None
    } else {
        Some(rest)
    }
}

pub(super) fn default_response_id(protocol: Protocol, seq: u64) -> String {
    match protocol {
        Protocol::OpenaiChatCompletions => format!("chatcmpl_mock_{seq}"),
        Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => format!("resp_mock_{seq}"),
        Protocol::AnthropicMessages => format!("msg_mock_{seq}"),
    }
}

pub(super) fn jitter_ms(min_ms: u64, max_ms: u64) -> u64 {
    let lo = min_ms.min(max_ms);
    let hi = min_ms.max(max_ms);
    if hi == lo { lo } else { fastrand::u64(lo..=hi) }
}
