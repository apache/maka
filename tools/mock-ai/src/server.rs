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

use crate::codec::{WireFrame, create_encoder, format_http_error_body};
use crate::control::{ControlPlaneConfig, CustomRouteFn, StoredResponses};
use crate::handler::{
    InteractiveHandler, InteractiveStream, SessionTracker, TurnContext, TurnDecision, TurnHandle,
    TurnHandler,
};
use crate::metrics::{
    MetricsSnapshot, RecordedRequest, RecorderMode, RequestRecorder, ServerMetrics,
};
use crate::pacing::{
    DynamicProfileManager, LatencyProfile, ProfileSnapshot, RuntimeProfile, ScenarioSchedule,
    TurnPacer,
};
use crate::plan::{HttpErrorSpec, TurnEvent, TurnPlan, Usage};
use crate::protocol::{AuthPolicy, NormalizedRequest, Protocol, Transport, normalize_request};
use crate::proxy::{
    CassetteReplayer, ProxyRecordConfig, ProxyRecorder, ReplayConfig, fingerprint_from_normalized,
};
use crate::ratelimit::{
    RateLimitConfig, RateLimitDecision, RateLimitHeaders, RateLimitLease, RateLimiter,
};
use crate::rules::{RuleEngine, RuleSpec};
use crate::schema_synth::{WirePoisonConfig, poison_sse_frame};
use crate::tls::TlsServerConfig;
use crate::watchdog::{ProtocolWatchdog, WatchdogConfig, WatchdogSnapshot};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_util::sync::CancellationToken;

type BoxBody = UnsyncBoxBody<Bytes, io::Error>;

/// Tuning knobs for high-concurrency and ultra-long-session workloads.
#[derive(Debug, Clone)]
pub struct ServerTuning {
    /// Maximum accepted HTTP request body size in bytes (default: 64 MiB).
    pub max_request_bytes: usize,
    /// Per-connection WebSocket read buffer capacity (default: 16 KiB to keep 10k WS connections lean).
    pub ws_read_buffer_size: usize,
    /// Maximum WebSocket message size (default: 128 MiB for large multimodal/long-context frames).
    pub ws_max_message_size: usize,
    /// Maximum single WebSocket frame size (default: 32 MiB).
    pub ws_max_frame_size: usize,
    /// Enable HTTP/1.1 keep-alive (default: true).
    pub http_keep_alive: bool,
    /// Max tracked session keys in `SessionTracker` (default: 65_536).
    pub max_tracked_sessions: usize,
    /// Reject `previous_response_id` on Responses when it neither exists in the same WS connection nor in `StoredResponses`.
    pub strict_previous_response_id: bool,
    /// Reject WebSocket upgrade requests with HTTP 426 / 400 (useful for testing WS -> HTTP fallback).
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
    pub rule_engine: Option<Arc<RuleEngine>>,
    pub custom_route: Option<CustomRouteFn>,
    pub metrics: Arc<ServerMetrics>,
    pub recorder: Arc<RequestRecorder>,
    pub stored_responses: Arc<StoredResponses>,
    pub sessions: Arc<SessionTracker>,
    pub profile: Arc<DynamicProfileManager>,
    pub rate_limiter: Arc<RateLimiter>,
    pub watchdog: Arc<ProtocolWatchdog>,
    pub tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
    pub proxy_recorder: Option<Arc<ProxyRecorder>>,
    pub cassette_replayer: Option<Arc<CassetteReplayer>>,
    pub next_seq: AtomicU64,
    pub next_conn_id: AtomicU64,
    pub shutdown: CancellationToken,
}

impl ServerState {
    fn next_sequence(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn next_connection_id(&self) -> u64 {
        self.next_conn_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn reset(&self) {
        self.metrics.reset();
        self.recorder.clear();
        self.stored_responses.clear();
        self.sessions.clear();
        self.profile.reset_clock();
        self.rate_limiter.reset();
        self.watchdog.clear();
        if let Some(replayer) = &self.cassette_replayer {
            replayer.reset();
        }
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
        self.state.tls_acceptor.is_some()
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

    pub fn metrics(&self) -> MetricsSnapshot {
        self.state.metrics.snapshot()
    }

    pub fn recorded_requests(&self) -> Vec<RecordedRequest> {
        self.state.recorder.snapshot()
    }

    pub fn stored_response(&self, id: &str) -> Option<Value> {
        self.state.stored_responses.get(id)
    }

    pub fn reset(&self) {
        self.state.reset();
    }

    pub fn replace_rules(&self, rules: Vec<RuleSpec>) -> Result<(), crate::rules::ConfigError> {
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

    pub async fn shutdown(mut self) {
        self.state.shutdown.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        if let Some(ref proxy) = self.state.proxy_recorder {
            proxy.flush().await;
        }
    }
}

impl Drop for MockAiServer {
    fn drop(&mut self) {
        self.state.shutdown.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
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
    tls: Option<TlsServerConfig>,
    proxy_recorder: Option<Arc<ProxyRecorder>>,
    cassette_replayer: Option<Arc<CassetteReplayer>>,
    handler: Option<Arc<dyn TurnHandler>>,
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
            tls: None,
            proxy_recorder: None,
            cassette_replayer: None,
            handler: None,
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
        self.handler(Arc::new(crate::handler::FnHandler(f)))
    }

    pub fn scripted(self, plans: impl IntoIterator<Item = TurnPlan>) -> Self {
        self.handler(Arc::new(crate::handler::ScriptedHandler::new(plans)))
    }

    pub fn rules(
        mut self,
        specs: Vec<RuleSpec>,
        default_reply: Option<TurnPlan>,
    ) -> Result<Self, crate::rules::ConfigError> {
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

    pub fn tls(mut self, config: TlsServerConfig) -> Self {
        self.tls = Some(config);
        self
    }

    pub fn proxy_record(mut self, config: ProxyRecordConfig) -> Result<Self, String> {
        self.proxy_recorder = Some(Arc::new(ProxyRecorder::new(config)?));
        Ok(self)
    }

    pub fn replay(mut self, config: ReplayConfig) -> Result<Self, String> {
        self.cassette_replayer = Some(Arc::new(CassetteReplayer::load(config)?));
        Ok(self)
    }

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
            Arc::new(crate::handler::FnHandler(
                |req: &NormalizedRequest, ctx: &TurnContext| {
                    TurnPlan::text(format!(
                        "mock reply to '{}' (turn {})",
                        req.last_user_text().unwrap_or(""),
                        ctx.session_turn
                    ))
                },
            ))
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
            rule_engine: self.rule_engine,
            custom_route: self.custom_route,
            metrics: Arc::new(ServerMetrics::default()),
            recorder: Arc::new(RequestRecorder::new(self.recorder_mode)),
            stored_responses,
            sessions,
            profile: Arc::new(DynamicProfileManager::new(base_profile, self.schedule)),
            rate_limiter: RateLimiter::new(self.rate_limit),
            watchdog: Arc::new(ProtocolWatchdog::new(self.watchdog)),
            tls_acceptor: self.tls.map(|t| t.acceptor()),
            proxy_recorder: self.proxy_recorder,
            cassette_replayer: self.cassette_replayer,
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
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

struct ActiveConnGuard(Arc<ServerMetrics>);
impl Drop for ActiveConnGuard {
    fn drop(&mut self) {
        self.0.active_connections.fetch_sub(1, Ordering::Relaxed);
    }
}

struct ActiveStreamGuard(Arc<ServerMetrics>);
impl Drop for ActiveStreamGuard {
    fn drop(&mut self) {
        self.0.active_streams.fetch_sub(1, Ordering::Relaxed);
    }
}

struct TurnCloseGuard(Option<crate::plan::CloseSignal>);
impl Drop for TurnCloseGuard {
    fn drop(&mut self) {
        if let Some(sig) = &self.0 {
            sig.notify();
        }
    }
}

struct PendingWsUpgrade {
    on_upgrade: hyper::upgrade::OnUpgrade,
    path: String,
    path_and_query: String,
    headers: BTreeMap<String, String>,
    proxied_upstream: Option<tokio_tungstenite::WebSocketStream<crate::tls::UpstreamWsStream>>,
}

async fn handle_connection(socket: tokio::net::TcpStream, state: Arc<ServerState>) {
    state
        .metrics
        .active_connections
        .fetch_add(1, Ordering::Relaxed);
    let _conn_guard = ActiveConnGuard(state.metrics.clone());
    let conn_id = state.next_connection_id();

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
    } else {
        serve_connection_io(socket, conn_id, state).await;
    }
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
            async move { Ok::<_, io::Error>(handle_http_request(req, state, pending_upgrade).await) }
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
                let ws = WebSocketStream::from_raw_socket(
                    TokioIo::new(upgraded_io),
                    Role::Server,
                    Some(state.ws_config()),
                )
                .await;
                if let (Some(proxy), Some(upstream_ws)) =
                    (&state.proxy_recorder, upgrade.proxied_upstream)
                {
                    state.metrics.proxy_requests.fetch_add(1, Ordering::Relaxed);
                    if let Err(err) = proxy
                        .bridge_websocket(
                            ws,
                            upstream_ws,
                            &upgrade.path_and_query,
                            &upgrade.headers,
                            state.shutdown.clone(),
                        )
                        .await
                    {
                        tracing::debug!(%err, conn_id, "mock-ai ws proxy error");
                    }
                } else {
                    handle_responses_websocket(ws, conn_id, upgrade.path, upgrade.headers, state)
                        .await;
                }
            }
            Err(err) => {
                tracing::debug!(%err, conn_id, "mock-ai ws upgrade failed");
            }
        }
    }
}

fn collect_headers(headers: &hyper::HeaderMap) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for (k, v) in headers {
        if let Ok(s) = v.to_str() {
            map.insert(k.as_str().to_ascii_lowercase(), s.to_owned());
        }
    }
    map
}

fn full_json(status: StatusCode, value: &Value) -> Response<BoxBody> {
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

fn error_http_response(
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
            }))
    {
        metrics
            .context_overflows_emitted
            .fetch_add(1, Ordering::Relaxed);
    }
    let body = format_http_error_body(protocol, spec);
    let bytes = Bytes::from(body.to_string());
    metrics
        .bytes_sent
        .fetch_add(bytes.len() as u64, Ordering::Relaxed);

    let status = StatusCode::from_u16(spec.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
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

async fn handle_http_request(
    mut req: Request<Incoming>,
    state: Arc<ServerState>,
    pending_upgrade: Arc<Mutex<Option<PendingWsUpgrade>>>,
) -> Response<BoxBody> {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let query = req.uri().query().map(str::to_owned);
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_owned())
        .unwrap_or_else(|| path.clone());
    let headers = collect_headers(req.headers());

    // 1) Prometheus /metrics and Admin routes (do not require provider API key)
    if method == Method::GET && path == "/metrics" {
        let body = state
            .metrics
            .render_prometheus(state.watchdog.total_violations());
        let bytes = Bytes::from(body);
        return Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                "text/plain; version=0.0.4; charset=utf-8",
            )
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(
                Full::new(bytes)
                    .map_err(|never| match never {})
                    .boxed_unsync(),
            )
            .unwrap();
    }
    if state.control.enable_admin_api && path.starts_with("/admin/") {
        state
            .metrics
            .control_plane_requests
            .fetch_add(1, Ordering::Relaxed);
        return handle_admin(method, &path, req, state).await;
    }

    // 2) Auth check for provider endpoints
    if !state.auth.verify(&headers) {
        let proto = classify_protocol(&path).unwrap_or(Protocol::OpenaiChatCompletions);
        return error_http_response(
            proto,
            &HttpErrorSpec::new(401, "authentication_error", "invalid API key"),
            &state.metrics,
        );
    }

    // 3) Responses WebSocket Upgrade on GET /v1/responses or /responses
    let is_ws_upgrade = headers
        .get("upgrade")
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if is_ws_upgrade && is_responses_path(&path) {
        if let Some(reject_status) = state.tuning.reject_websocket_upgrade_status {
            return error_http_response(
                Protocol::OpenaiResponsesWs,
                &HttpErrorSpec::new(
                    reject_status,
                    "websocket_unavailable",
                    "WebSocket upgrade rejected by mock server configuration",
                ),
                &state.metrics,
            );
        }
        let Some(ws_key) = headers.get("sec-websocket-key") else {
            return full_json(
                StatusCode::BAD_REQUEST,
                &json!({ "error": { "message": "missing Sec-WebSocket-Key" } }),
            );
        };
        let proxied_upstream = if let Some(ref proxy) = state.proxy_recorder {
            match proxy.connect_upstream_ws(&path_and_query, &headers).await {
                Ok(upstream_ws) => Some(upstream_ws),
                Err(err) => {
                    return full_json(
                        StatusCode::BAD_GATEWAY,
                        &json!({ "error": { "type": "proxy_error", "message": err } }),
                    );
                }
            }
        } else {
            None
        };
        let accept = derive_accept_key(ws_key.as_bytes());
        *pending_upgrade.lock().unwrap() = Some(PendingWsUpgrade {
            on_upgrade: hyper::upgrade::on(&mut req),
            path,
            path_and_query,
            headers,
            proxied_upstream,
        });
        state.metrics.ws_upgrades.fetch_add(1, Ordering::Relaxed);
        return Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, "websocket")
            .header("sec-websocket-accept", accept)
            .body(
                Full::new(Bytes::new())
                    .map_err(|never| match never {})
                    .boxed_unsync(),
            )
            .unwrap();
    }

    // 3b) Transparent HTTP proxy-record mode (forwards all provider endpoints to upstream & records cassette)
    if let Some(ref proxy) = state.proxy_recorder {
        let body_bytes = match Limited::new(req.into_body(), state.tuning.max_request_bytes)
            .collect()
            .await
        {
            Ok(collected) => collected.to_bytes(),
            Err(err) => {
                return full_json(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    &json!({ "error": { "message": format!("request body read error: {err}") } }),
                );
            }
        };
        state.metrics.proxy_requests.fetch_add(1, Ordering::Relaxed);
        let proto = (method == Method::POST)
            .then(|| classify_protocol(&path))
            .flatten();
        match proxy
            .forward_http(
                method.as_str(),
                &path_and_query,
                proto,
                &headers,
                body_bytes,
                state.shutdown.clone(),
            )
            .await
        {
            Ok(proxied) => {
                let metrics = state.metrics.clone();
                let rx = proxied.rx;
                let stream = futures_util::stream::unfold(rx, move |mut rx| {
                    let metrics = metrics.clone();
                    async move {
                        let item = rx.recv().await?;
                        let mapped = match item {
                            Ok(bytes) => {
                                metrics
                                    .bytes_sent
                                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                                Ok(Frame::data(bytes))
                            }
                            Err(msg) => Err(io::Error::other(msg)),
                        };
                        Some((mapped, rx))
                    }
                });
                let mut builder = Response::builder().status(
                    StatusCode::from_u16(proxied.status).unwrap_or(StatusCode::BAD_GATEWAY),
                );
                for (k, v) in proxied.headers {
                    if let (Ok(name), Ok(val)) = (
                        HeaderName::from_bytes(k.as_bytes()),
                        HeaderValue::from_str(&v),
                    ) {
                        builder = builder.header(name, val);
                    }
                }
                return builder
                    .body(StreamBody::new(stream).boxed_unsync())
                    .unwrap();
            }
            Err(err) => {
                return full_json(
                    StatusCode::BAD_GATEWAY,
                    &json!({ "error": { "type": "proxy_error", "message": err } }),
                );
            }
        }
    }

    // 4) Control plane GET/DELETE endpoints
    if method == Method::GET {
        if path == "/v1/models" || path == "/models" || path.ends_with("/models") {
            state
                .metrics
                .control_plane_requests
                .fetch_add(1, Ordering::Relaxed);
            let page = state.control.render_models_page(query.as_deref());
            return full_json(StatusCode::OK, &page);
        }
        if let Some(id) = extract_stored_response_id(&path) {
            state
                .metrics
                .control_plane_requests
                .fetch_add(1, Ordering::Relaxed);
            return match state.stored_responses.get(id) {
                Some(resp) => full_json(StatusCode::OK, &resp),
                None => full_json(
                    StatusCode::NOT_FOUND,
                    &json!({ "error": { "type": "not_found", "message": format!("response '{id}' not found") } }),
                ),
            };
        }
        if (path == "/api/usage/token/" || path == "/api/usage/token")
            && let Some(payload) = &state.control.relay_token_usage
        {
            state
                .metrics
                .control_plane_requests
                .fetch_add(1, Ordering::Relaxed);
            return full_json(StatusCode::OK, payload);
        }
        if path == "/v1/usage"
            && let Some(payload) = &state.control.v1_usage
        {
            state
                .metrics
                .control_plane_requests
                .fetch_add(1, Ordering::Relaxed);
            return full_json(StatusCode::OK, payload);
        }
        if let Some(payload) = state.control.extra_get_routes.get(&path) {
            state
                .metrics
                .control_plane_requests
                .fetch_add(1, Ordering::Relaxed);
            return full_json(StatusCode::OK, payload);
        }
    }

    if method == Method::DELETE
        && let Some(id) = extract_stored_response_id(&path)
    {
        state
            .metrics
            .control_plane_requests
            .fetch_add(1, Ordering::Relaxed);
        let deleted = state.stored_responses.delete(id);
        return if deleted {
            full_json(
                StatusCode::OK,
                &json!({ "id": id, "object": "response.deleted", "deleted": true }),
            )
        } else {
            full_json(
                StatusCode::NOT_FOUND,
                &json!({ "error": { "type": "not_found", "message": format!("response '{id}' not found") } }),
            )
        };
    }

    // 5) Read request body (supports chunked / streaming upload without requiring Content-Length)
    let body_bytes = match Limited::new(req.into_body(), state.tuning.max_request_bytes)
        .collect()
        .await
    {
        Ok(collected) => collected.to_bytes(),
        Err(err) => {
            return full_json(
                StatusCode::PAYLOAD_TOO_LARGE,
                &json!({ "error": { "message": format!("request body read error: {err}") } }),
            );
        }
    };

    // Custom dynamic route escape hatch
    if let Some(custom) = &state.custom_route
        && let Some((status, content_type, body)) =
            custom(method.as_str(), &path, &headers, &body_bytes)
    {
        state
            .metrics
            .control_plane_requests
            .fetch_add(1, Ordering::Relaxed);
        let bytes = Bytes::from(body);
        return Response::builder()
            .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(
                Full::new(bytes)
                    .map_err(|never| match never {})
                    .boxed_unsync(),
            )
            .unwrap();
    }

    // 6) Generation routes (POST /v1/chat/completions, /v1/responses, /v1/messages)
    let Some(protocol) = (method == Method::POST)
        .then(|| classify_protocol(&path))
        .flatten()
    else {
        return full_json(
            StatusCode::NOT_FOUND,
            &json!({ "error": { "type": "not_found", "message": format!("unknown route: {method} {path}") } }),
        );
    };

    let raw_body: Value = match serde_json::from_slice(&body_bytes) {
        Ok(val) => val,
        Err(err) => {
            return error_http_response(
                protocol,
                &HttpErrorSpec::new(
                    400,
                    "invalid_request_error",
                    format!("malformed JSON request body: {err}"),
                ),
                &state.metrics,
            );
        }
    };

    let seq = state.next_sequence();
    let normalized = normalize_request(
        seq,
        protocol,
        Transport::Http,
        path,
        headers,
        body_bytes.len(),
        raw_body,
    );
    let turn_started = Instant::now();
    state
        .metrics
        .record_protocol(protocol, normalized.prompt_bytes);
    state.recorder.record(&normalized);
    state.watchdog.inspect_request(&normalized);

    let effective_profile = state.profile.effective();

    // Stateful rate limit & concurrency admission
    let (rl_headers, rl_lease) = match state.rate_limiter.check_and_acquire(
        normalized.api_key(),
        &normalized.model,
        normalized.estimated_input_tokens,
        effective_profile.rate_limit_override.as_ref(),
    ) {
        RateLimitDecision::Allowed { headers, lease } => (headers, lease),
        RateLimitDecision::Rejected {
            retry_after_ms,
            reason,
            headers,
        } => {
            let mut spec = HttpErrorSpec::rate_limit(
                Some(retry_after_ms.div_ceil(1000).max(1)),
                format!("rate limit exceeded ({reason})"),
            )
            .with_retry_after_ms(retry_after_ms);
            for (k, v) in headers.to_header_pairs() {
                spec.headers.insert(k.to_string(), v);
            }
            state.metrics.record_dimension(
                protocol,
                &normalized.model,
                "429",
                normalized.estimated_input_tokens,
                0,
                0,
                None,
                Some(turn_started.elapsed().as_millis() as u64),
            );
            return error_http_response(protocol, &spec, &state.metrics);
        }
    };

    // Cassette replay mode (checked before strict previous_response_id so multi-turn recorded
    // Responses HTTP cassettes replay faithfully without pre-populating stored_responses, while
    // still rejecting requests whose previous_response_id disagrees with the recorded exchange).
    if let Some(ref replayer) = state.cassette_replayer {
        let fp = fingerprint_from_normalized(&normalized);
        let strict_prev =
            protocol == Protocol::OpenaiResponsesHttp && state.tuning.strict_previous_response_id;
        let expected_prev = normalized.previous_response_id.as_deref();
        if let Some(ex) = replayer
            .next_http_if(&fp, |candidate| {
                !strict_prev
                    || expected_prev == candidate.request_body["previous_response_id"].as_str()
            })
            .cloned()
        {
            state.metrics.replay_hits.fetch_add(1, Ordering::Relaxed);
            return execute_http_replay(
                normalized,
                ex,
                replayer.config().clone(),
                rl_headers,
                rl_lease,
                turn_started,
                state,
            );
        }
    }

    // Strict previous_response_id check for HTTP Responses
    if protocol == Protocol::OpenaiResponsesHttp
        && state.tuning.strict_previous_response_id
        && let Some(prev_id) = &normalized.previous_response_id
        && !state.stored_responses.contains(prev_id)
    {
        state
            .watchdog
            .record_invalid_previous_response_id(&normalized, prev_id);
        state.metrics.record_dimension(
            protocol,
            &normalized.model,
            "400",
            normalized.estimated_input_tokens,
            0,
            0,
            None,
            Some(turn_started.elapsed().as_millis() as u64),
        );
        return error_http_response(
            protocol,
            &HttpErrorSpec {
                status: 400,
                error_type: "invalid_request_error".into(),
                code: Some("previous_response_not_found".into()),
                message: format!("previous_response_id '{prev_id}' not found"),
                retry_after_secs: None,
                retry_after_ms: None,
                headers: BTreeMap::new(),
                raw_body: None,
            },
            &state.metrics,
        );
    }

    let session_turn = state.sessions.next_turn(&normalized.session_key);
    let ctx = TurnContext {
        global_turn: seq,
        session_turn,
        chaos_override: effective_profile.chaos_override.clone(),
    };

    let decision = match state.handler.handle(&normalized, &ctx).await {
        Some(d) => d,
        None => {
            return error_http_response(
                protocol,
                &HttpErrorSpec::new(
                    500,
                    "mock_handler_exhausted",
                    "no handler matched or scripted queue was exhausted",
                ),
                &state.metrics,
            );
        }
    };

    let store_flag = normalized.raw_body["store"].as_bool().unwrap_or(true);
    match decision {
        TurnDecision::Plan(plan) => {
            execute_http_plan(
                normalized,
                plan,
                store_flag,
                effective_profile.latency,
                rl_headers,
                rl_lease,
                turn_started,
                state,
            )
            .await
        }
        TurnDecision::Interactive(stream) => {
            execute_http_interactive(normalized, stream, store_flag, rl_headers, rl_lease, state)
                .await
        }
    }
}

fn execute_http_replay(
    req: NormalizedRequest,
    exchange: crate::proxy::RecordedExchange,
    replay_cfg: ReplayConfig,
    rl_headers: RateLimitHeaders,
    rl_lease: Option<RateLimitLease>,
    turn_started: Instant,
    state: Arc<ServerState>,
) -> Response<BoxBody> {
    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, io::Error>>(16);
    let mut headers = exchange.response_headers.clone();
    for (k, v) in rl_headers.to_header_pairs() {
        headers.insert(k.to_string(), v);
    }
    let status = StatusCode::from_u16(exchange.status).unwrap_or(StatusCode::OK);
    let state_clone = state.clone();

    tokio::spawn(async move {
        let _lease = rl_lease;
        state_clone
            .metrics
            .active_streams
            .fetch_add(1, Ordering::Relaxed);
        let _guard = ActiveStreamGuard(state_clone.metrics.clone());
        let mut first_recorded: Option<u64> = None;

        for chunk in exchange.chunks {
            let delay = replay_cfg.scaled_delay(chunk.delay_ms);
            if !delay.is_zero() {
                tokio::select! {
                    _ = state_clone.shutdown.cancelled() => break,
                    _ = tx.closed() => break,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
            let bytes = chunk.to_bytes();
            let len = bytes.len();
            if tx.send(Ok(Frame::data(bytes))).await.is_err() {
                break;
            }
            if first_recorded.is_none() {
                let ttft = turn_started.elapsed().as_millis() as u64;
                state_clone.metrics.ttft_ms.record(ttft);
                first_recorded = Some(ttft);
            }
            state_clone
                .metrics
                .bytes_sent
                .fetch_add(len as u64, Ordering::Relaxed);
        }
        let dur = turn_started.elapsed().as_millis() as u64;
        state_clone.metrics.turn_duration_ms.record(dur);
        state_clone.metrics.record_dimension(
            req.protocol,
            &req.model,
            &status.as_u16().to_string(),
            req.estimated_input_tokens,
            0,
            0,
            first_recorded,
            Some(dur),
        );
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    let mut builder = Response::builder().status(status);
    for (k, v) in &headers {
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

fn pacer_seed_for(req: &NormalizedRequest) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    req.session_key.hash(&mut h);
    req.sequence.hash(&mut h);
    h.finish()
}

fn plan_usage_hint(plan: &TurnPlan, req: &NormalizedRequest) -> Usage {
    for ev in &plan.events {
        if let TurnEvent::Usage(u) = ev {
            return u.clone();
        }
    }
    Usage::new(req.estimated_input_tokens.max(1), 0)
}

fn semantic_event_bytes(ev: &TurnEvent) -> usize {
    match ev {
        TurnEvent::Text { text, .. } => text.len(),
        TurnEvent::Reasoning { text, .. } => text.len(),
        TurnEvent::Refusal { text } => text.len(),
        TurnEvent::ToolCall(tc) => tc.arguments_string().len() + tc.name.len(),
        TurnEvent::NativeCompaction(c) => c.summary.len().max(c.encrypted_content.len()),
        _ => 0,
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_http_plan(
    req: NormalizedRequest,
    plan: TurnPlan,
    store_flag: bool,
    latency_profile: LatencyProfile,
    rl_headers: RateLimitHeaders,
    mut rl_lease: Option<RateLimitLease>,
    turn_started: Instant,
    state: Arc<ServerState>,
) -> Response<BoxBody> {
    // Handle pre-stream HTTP error (including optional leading Delay before error!)
    for (idx, ev) in plan.events.iter().enumerate() {
        match ev {
            TurnEvent::Delay { ms } if idx == 0 => {
                tokio::select! {
                    _ = state.shutdown.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_millis(*ms)) => {}
                }
            }
            TurnEvent::HttpError(spec) => {
                let status_label = spec.status.to_string();
                let mut enriched = spec.clone();
                for (k, v) in rl_headers.to_header_pairs() {
                    enriched.headers.entry(k.to_string()).or_insert(v);
                }
                state.metrics.record_dimension(
                    req.protocol,
                    &req.model,
                    &status_label,
                    req.estimated_input_tokens,
                    0,
                    0,
                    None,
                    Some(turn_started.elapsed().as_millis() as u64),
                );
                return error_http_response(req.protocol, &enriched, &state.metrics);
            }
            _ => break,
        }
    }

    let response_id = plan
        .response_id
        .clone()
        .unwrap_or_else(|| default_response_id(req.protocol, req.sequence));
    let model = plan
        .model_override
        .clone()
        .unwrap_or_else(|| req.model.clone());
    let inferred_finish = plan.inferred_finish_reason();
    let usage_hint = plan_usage_hint(&plan, &req);
    let cached_tokens = usage_hint.cache_read_tokens.unwrap_or(0);
    let uncached_tokens = usage_hint.input_tokens.saturating_sub(cached_tokens);
    let in_flight_sample = state.metrics.active_streams.load(Ordering::Relaxed) + 1;
    let mut pacer = TurnPacer::new(
        latency_profile,
        pacer_seed_for(&req),
        in_flight_sample,
        plan.ttft_ms,
        (plan.chunk_delay_ms > 0).then_some(plan.chunk_delay_ms),
    );
    let ttft_dur = pacer.compute_ttft(uncached_tokens, cached_tokens);

    let mut response_headers = plan.response_headers.clone();
    for (k, v) in rl_headers.to_header_pairs() {
        response_headers.entry(k.to_string()).or_insert(v);
    }

    let mut emitted_tool_ids = Vec::new();
    let mut emitted_compaction = false;
    let mut semantic_output_bytes = 0usize;
    if !req.stream {
        for ev in &plan.events {
            semantic_output_bytes += semantic_event_bytes(ev);
            match ev {
                TurnEvent::ToolCall(tc) => emitted_tool_ids.push(tc.id.clone()),
                TurnEvent::NativeCompaction(_) => emitted_compaction = true,
                _ => {}
            }
        }
    }

    // Non-streaming JSON HTTP response
    if !req.stream {
        if !ttft_dur.is_zero() {
            tokio::select! {
                _ = state.shutdown.cancelled() => {}
                _ = tokio::time::sleep(ttft_dur) => {}
            }
        }
        let mut encoder = create_encoder(req.protocol, response_id, model.clone(), false);
        let mut scratch = Vec::new();
        for ev in &plan.events {
            if let TurnEvent::Usage(u) = ev {
                encoder.push_event(TurnEvent::Usage(u.clone()), &mut scratch);
            }
        }
        for ev in plan.events {
            match ev {
                TurnEvent::Delay { ms } => {
                    tokio::select! {
                        _ = state.shutdown.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                    }
                }
                TurnEvent::JitterDelay { min_ms, max_ms } => {
                    let ms = jitter_ms(min_ms, max_ms);
                    if ms > 0 {
                        tokio::select! {
                            _ = state.shutdown.cancelled() => break,
                            _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                        }
                    }
                }
                TurnEvent::Stall => {
                    state.metrics.stalls_entered.fetch_add(1, Ordering::Relaxed);
                    state.shutdown.cancelled().await;
                    break;
                }
                TurnEvent::HttpError(spec) => {
                    return error_http_response(req.protocol, &spec, &state.metrics);
                }
                TurnEvent::NativeCompaction(c) => {
                    state
                        .metrics
                        .native_compactions_emitted
                        .fetch_add(1, Ordering::Relaxed);
                    encoder.push_event(TurnEvent::NativeCompaction(c), &mut scratch);
                }
                TurnEvent::Finish { reason } => {
                    let completion = encoder.finish(reason, &mut scratch);
                    if req.protocol.is_responses() && store_flag {
                        state.stored_responses.put(
                            completion.response_id.clone(),
                            completion.response_json.clone(),
                        );
                    }
                    let dur = turn_started.elapsed().as_millis() as u64;
                    state.metrics.ttft_ms.record(dur);
                    state.metrics.turn_duration_ms.record(dur);
                    let out_toks = usage_hint
                        .output_tokens
                        .max((semantic_output_bytes as u64) / 4);
                    if let Some(ref mut lease) = rl_lease {
                        lease.debit_output_tokens(out_toks);
                    }
                    state.metrics.record_dimension(
                        req.protocol,
                        &model,
                        "200",
                        usage_hint.input_tokens,
                        out_toks,
                        cached_tokens,
                        Some(dur),
                        Some(dur),
                    );
                    state.watchdog.record_turn_outcome(
                        &req,
                        &emitted_tool_ids,
                        emitted_compaction,
                        true,
                    );
                    return json_with_headers(
                        completion.response_json,
                        &response_headers,
                        plan.close_connection,
                        &state.metrics,
                    );
                }
                other => encoder.push_event(other, &mut scratch),
            }
        }
        let completion = encoder.finish(inferred_finish, &mut scratch);
        if req.protocol.is_responses() && store_flag {
            state.stored_responses.put(
                completion.response_id.clone(),
                completion.response_json.clone(),
            );
        }
        let dur = turn_started.elapsed().as_millis() as u64;
        state.metrics.ttft_ms.record(dur);
        state.metrics.turn_duration_ms.record(dur);
        let out_toks = usage_hint
            .output_tokens
            .max((semantic_output_bytes as u64) / 4);
        if let Some(ref mut lease) = rl_lease {
            lease.debit_output_tokens(out_toks);
        }
        state.metrics.record_dimension(
            req.protocol,
            &model,
            "200",
            usage_hint.input_tokens,
            out_toks,
            cached_tokens,
            Some(dur),
            Some(dur),
        );
        state
            .watchdog
            .record_turn_outcome(&req, &emitted_tool_ids, emitted_compaction, true);
        return json_with_headers(
            completion.response_json,
            &response_headers,
            plan.close_connection,
            &state.metrics,
        );
    }

    // Streaming SSE HTTP response
    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, io::Error>>(16);
    let close_connection = plan.close_connection;
    let protocol = req.protocol;
    let state_clone = state.clone();
    let on_close = plan.on_close.clone();
    let wire_poison = plan.wire_poison.clone();
    let ping_interval = pacer.sse_ping_interval();

    tokio::spawn(async move {
        let mut lease = rl_lease;
        state_clone
            .metrics
            .active_streams
            .fetch_add(1, Ordering::Relaxed);
        let _guard = ActiveStreamGuard(state_clone.metrics.clone());
        let _close_guard = TurnCloseGuard(on_close);

        let mut encoder = create_encoder(protocol, response_id, model.clone(), true);
        let mut frames = Vec::new();
        let mut frame_seq = 0usize;
        let mut first_delta_at: Option<Instant> = None;
        let mut recorded_ttft_ms: Option<u64> = None;
        let mut emitted_semantic_bytes = 0usize;

        // Dynamic TTFT wait with optional SSE keep-alive ping comments.
        // If client disconnects during TTFT (even right after a ping), abort cleanly WITHOUT recording TTFT!
        let mut aborted = false;
        if !ttft_dur.is_zero() {
            let deadline = tokio::time::Instant::now() + ttft_dur;
            loop {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    break;
                }
                let remaining = deadline - now;
                let step = ping_interval.map_or(remaining, |p| remaining.min(p));
                tokio::select! {
                    _ = state_clone.shutdown.cancelled() => { aborted = true; break; }
                    _ = tx.closed() => { aborted = true; break; }
                    _ = tokio::time::sleep(step) => {
                        if ping_interval.is_some() && tokio::time::Instant::now() < deadline {
                            let ping = if wire_poison.crlf_line_endings {
                                Bytes::from_static(b": keep-alive\r\n\r\n")
                            } else {
                                Bytes::from_static(b": keep-alive\n\n")
                            };
                            if tx.send(Ok(Frame::data(ping))).await.is_err() {
                                aborted = true;
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Pre-feed Usage so Anthropic message_start has exact input/cache tokens.
        if !aborted {
            for ev in &plan.events {
                if let TurnEvent::Usage(u) = ev {
                    encoder.push_event(TurnEvent::Usage(u.clone()), &mut frames);
                    break;
                }
            }
        }

        let mut explicit_finish = false;
        let mut intentional_fault = false;

        if !aborted {
            for ev in plan.events {
                if state_clone.shutdown.is_cancelled() || tx.is_closed() {
                    aborted = true;
                    break;
                }
                let ev_sem_bytes = semantic_event_bytes(&ev);
                match ev {
                    TurnEvent::Delay { ms } => {
                        tokio::select! {
                            _ = state_clone.shutdown.cancelled() => { aborted = true; break; }
                            _ = tx.closed() => { aborted = true; break; }
                            _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                        }
                    }
                    TurnEvent::JitterDelay { min_ms, max_ms } => {
                        let ms = jitter_ms(min_ms, max_ms);
                        if ms > 0 {
                            tokio::select! {
                                _ = state_clone.shutdown.cancelled() => { aborted = true; break; }
                                _ = tx.closed() => { aborted = true; break; }
                                _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                            }
                        }
                    }
                    TurnEvent::Stall => {
                        state_clone
                            .metrics
                            .stalls_entered
                            .fetch_add(1, Ordering::Relaxed);
                        intentional_fault = true;
                        tokio::select! {
                            _ = state_clone.shutdown.cancelled() => {}
                            _ = tx.closed() => {}
                        }
                        aborted = true;
                        break;
                    }
                    TurnEvent::DropConnection => {
                        state_clone
                            .metrics
                            .connection_drops_emitted
                            .fetch_add(1, Ordering::Relaxed);
                        intentional_fault = true;
                        let _ = tx
                            .send(Err(io::Error::new(
                                io::ErrorKind::ConnectionReset,
                                "mock-ai simulated connection drop",
                            )))
                            .await;
                        aborted = true;
                        break;
                    }
                    TurnEvent::TruncateEof => {
                        intentional_fault = true;
                        aborted = true;
                        break;
                    }
                    TurnEvent::MidStreamError(err) => {
                        state_clone
                            .metrics
                            .mid_stream_errors_emitted
                            .fetch_add(1, Ordering::Relaxed);
                        intentional_fault = true;
                        encoder.push_event(TurnEvent::MidStreamError(err), &mut frames);
                        if !flush_http_frames(
                            &tx,
                            &mut frames,
                            None,
                            0,
                            None,
                            &wire_poison,
                            &mut frame_seq,
                            &state_clone,
                        )
                        .await
                        {
                            aborted = true;
                            break;
                        }
                        explicit_finish = true;
                        break;
                    }
                    TurnEvent::Finish { reason } => {
                        let completion = encoder.finish(reason, &mut frames);
                        if protocol.is_responses() && store_flag {
                            state_clone
                                .stored_responses
                                .put(completion.response_id, completion.response_json);
                        }
                        if !flush_http_frames(
                            &tx,
                            &mut frames,
                            None,
                            0,
                            None,
                            &wire_poison,
                            &mut frame_seq,
                            &state_clone,
                        )
                        .await
                        {
                            aborted = true;
                            break;
                        }
                        explicit_finish = true;
                        break;
                    }
                    TurnEvent::NativeCompaction(c) => {
                        state_clone
                            .metrics
                            .native_compactions_emitted
                            .fetch_add(1, Ordering::Relaxed);
                        encoder.push_event(TurnEvent::NativeCompaction(c), &mut frames);
                        let mut ttft = TtftTracker {
                            turn_started,
                            first_delta_at: &mut first_delta_at,
                            recorded_ttft_ms: &mut recorded_ttft_ms,
                        };
                        let status = flush_http_frames_detailed(
                            &tx,
                            &mut frames,
                            Some(&mut pacer),
                            ev_sem_bytes,
                            Some(&mut ttft),
                            &wire_poison,
                            &mut frame_seq,
                            &state_clone,
                        )
                        .await;
                        if status.all_wire_frames_sent {
                            emitted_compaction = true;
                            emitted_semantic_bytes += ev_sem_bytes;
                        }
                        if !status.continued {
                            aborted = true;
                            break;
                        }
                    }
                    other => {
                        let maybe_tool_id = match &other {
                            TurnEvent::ToolCall(tc) => Some(tc.id.clone()),
                            _ => None,
                        };
                        encoder.push_event(other, &mut frames);
                        let mut ttft = TtftTracker {
                            turn_started,
                            first_delta_at: &mut first_delta_at,
                            recorded_ttft_ms: &mut recorded_ttft_ms,
                        };
                        let status = flush_http_frames_detailed(
                            &tx,
                            &mut frames,
                            Some(&mut pacer),
                            ev_sem_bytes,
                            Some(&mut ttft),
                            &wire_poison,
                            &mut frame_seq,
                            &state_clone,
                        )
                        .await;
                        if status.all_wire_frames_sent {
                            if let Some(tid) = maybe_tool_id {
                                emitted_tool_ids.push(tid);
                            }
                            emitted_semantic_bytes += ev_sem_bytes;
                        }
                        if !status.continued {
                            aborted = true;
                            break;
                        }
                    }
                }
            }
        }

        if !aborted && !explicit_finish && !encoder.is_finished() {
            let completion = encoder.finish(inferred_finish, &mut frames);
            if protocol.is_responses() && store_flag {
                state_clone
                    .stored_responses
                    .put(completion.response_id, completion.response_json);
            }
            if !flush_http_frames(
                &tx,
                &mut frames,
                None,
                0,
                None,
                &wire_poison,
                &mut frame_seq,
                &state_clone,
            )
            .await
            {
                aborted = true;
            }
        }

        let completed_cleanly = !aborted;
        if aborted && !intentional_fault {
            state_clone
                .metrics
                .abandoned_streams
                .fetch_add(1, Ordering::Relaxed);
        }
        let dur_ms = turn_started.elapsed().as_millis() as u64;
        state_clone.metrics.turn_duration_ms.record(dur_ms);
        let actual_out_tokens = if completed_cleanly {
            usage_hint
                .output_tokens
                .max((emitted_semantic_bytes as u64) / 4)
        } else {
            (emitted_semantic_bytes as u64) / 4
        };
        if let Some(first_at) = first_delta_at
            && actual_out_tokens > 0
        {
            let gen_secs = first_at.elapsed().as_secs_f64().max(0.001);
            let tps = ((actual_out_tokens as f64) / gen_secs).round().max(1.0) as u64;
            state_clone.metrics.effective_tps.record(tps);
        }
        if let Some(ref mut l) = lease {
            l.debit_output_tokens(actual_out_tokens);
        }
        let status_class = if completed_cleanly {
            "200"
        } else if intentional_fault {
            "fault"
        } else {
            "aborted"
        };
        state_clone.metrics.record_dimension(
            protocol,
            &model,
            status_class,
            usage_hint.input_tokens,
            actual_out_tokens,
            cached_tokens,
            recorded_ttft_ms,
            Some(dur_ms),
        );
        state_clone.watchdog.record_turn_outcome(
            &req,
            &emitted_tool_ids,
            emitted_compaction,
            completed_cleanly || intentional_fault,
        );
    });

    sse_response(rx, &response_headers, close_connection)
}

async fn execute_http_interactive(
    req: NormalizedRequest,
    mut stream: InteractiveStream,
    store_flag: bool,
    rl_headers: RateLimitHeaders,
    rl_lease: Option<RateLimitLease>,
    state: Arc<ServerState>,
) -> Response<BoxBody> {
    // Wait for the first event before committing HTTP status headers so TurnHandle::http_error works!
    let first = tokio::select! {
        _ = state.shutdown.cancelled() => {
            stream.closed.notify_one();
            return full_json(StatusCode::SERVICE_UNAVAILABLE, &json!({ "error": { "message": "server shutting down" } }));
        }
        ev = stream.events.recv() => ev,
    };

    let Some(first_event) = first else {
        stream.closed.notify_one();
        return error_http_response(
            req.protocol,
            &HttpErrorSpec::new(
                500,
                "mock_aborted",
                "interactive TurnHandle dropped before reply",
            ),
            &state.metrics,
        );
    };

    if let TurnEvent::HttpError(spec) = first_event {
        stream.closed.notify_one();
        return error_http_response(req.protocol, &spec, &state.metrics);
    }

    let response_id = stream
        .response_id
        .clone()
        .unwrap_or_else(|| default_response_id(req.protocol, req.sequence));
    let model = req.model.clone();
    let protocol = req.protocol;
    let mut headers = stream.response_headers.clone();
    for (k, v) in rl_headers.to_header_pairs() {
        headers.entry(k.to_string()).or_insert(v);
    }
    let close_connection = stream.close_connection;

    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, io::Error>>(16);
    let state_clone = state.clone();

    tokio::spawn(async move {
        let _lease = rl_lease;
        state_clone
            .metrics
            .active_streams
            .fetch_add(1, Ordering::Relaxed);
        let _guard = ActiveStreamGuard(state_clone.metrics.clone());

        let mut encoder = create_encoder(protocol, response_id, model, true);
        let mut frames = Vec::new();
        let mut pending = Some(first_event);

        loop {
            let ev = match pending.take() {
                Some(e) => e,
                None => {
                    tokio::select! {
                        _ = state_clone.shutdown.cancelled() => break,
                        _ = tx.closed() => break,
                        next = stream.events.recv() => match next {
                            Some(e) => e,
                            None => break,
                        }
                    }
                }
            };

            match ev {
                TurnEvent::Delay { ms } => {
                    tokio::select! {
                        _ = state_clone.shutdown.cancelled() => break,
                        _ = tx.closed() => break,
                        _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                    }
                }
                TurnEvent::Stall => {
                    state_clone
                        .metrics
                        .stalls_entered
                        .fetch_add(1, Ordering::Relaxed);
                    tokio::select! {
                        _ = state_clone.shutdown.cancelled() => break,
                        _ = tx.closed() => break,
                        next = stream.events.recv() => {
                            if let Some(next_ev) = next {
                                pending = Some(next_ev);
                                continue;
                            } else {
                                break;
                            }
                        }
                    }
                }
                TurnEvent::DropConnection => {
                    state_clone
                        .metrics
                        .connection_drops_emitted
                        .fetch_add(1, Ordering::Relaxed);
                    let _ = tx
                        .send(Err(io::Error::new(
                            io::ErrorKind::ConnectionReset,
                            "mock-ai interactive drop_connection",
                        )))
                        .await;
                    break;
                }
                TurnEvent::TruncateEof => break,
                TurnEvent::MidStreamError(err) => {
                    state_clone
                        .metrics
                        .mid_stream_errors_emitted
                        .fetch_add(1, Ordering::Relaxed);
                    encoder.push_event(TurnEvent::MidStreamError(err), &mut frames);
                    let mut seq = 0;
                    let _ = flush_http_frames(
                        &tx,
                        &mut frames,
                        None,
                        0,
                        None,
                        &WirePoisonConfig::default(),
                        &mut seq,
                        &state_clone,
                    )
                    .await;
                    break;
                }
                TurnEvent::Finish { reason } => {
                    let completion = encoder.finish(reason, &mut frames);
                    if protocol.is_responses() && store_flag {
                        state_clone
                            .stored_responses
                            .put(completion.response_id, completion.response_json);
                    }
                    let mut seq = 0;
                    let _ = flush_http_frames(
                        &tx,
                        &mut frames,
                        None,
                        0,
                        None,
                        &WirePoisonConfig::default(),
                        &mut seq,
                        &state_clone,
                    )
                    .await;
                    break;
                }
                TurnEvent::NativeCompaction(c) => {
                    state_clone
                        .metrics
                        .native_compactions_emitted
                        .fetch_add(1, Ordering::Relaxed);
                    encoder.push_event(TurnEvent::NativeCompaction(c), &mut frames);
                    let mut seq = 0;
                    if !flush_http_frames(
                        &tx,
                        &mut frames,
                        None,
                        0,
                        None,
                        &WirePoisonConfig::default(),
                        &mut seq,
                        &state_clone,
                    )
                    .await
                    {
                        break;
                    }
                }
                other => {
                    encoder.push_event(other, &mut frames);
                    let mut seq = 0;
                    if !flush_http_frames(
                        &tx,
                        &mut frames,
                        None,
                        0,
                        None,
                        &WirePoisonConfig::default(),
                        &mut seq,
                        &state_clone,
                    )
                    .await
                    {
                        break;
                    }
                }
            }
        }
        stream.closed.notify_one();
    });

    sse_response(rx, &headers, close_connection)
}

async fn handle_responses_websocket<S>(
    mut ws: WebSocketStream<S>,
    conn_id: u64,
    path: String,
    headers: BTreeMap<String, String>,
    state: Arc<ServerState>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    // Single latest continuable response ID on this WS connection for `store: false` turns.
    // Mirrors Maka's confirmed baseline semantics: continuing from a superseded ID or another
    // connection is rejected when `strict_previous_response_id == true`.
    let mut current_baseline_id: Option<String> = None;
    let mut turn_on_connection = 0usize;

    loop {
        let frame = tokio::select! {
            _ = state.shutdown.cancelled() => break,
            msg = ws.next() => msg,
        };
        let Some(Ok(msg)) = frame else {
            break;
        };
        match msg {
            WsMessage::Ping(payload) => {
                if ws.send(WsMessage::Pong(payload)).await.is_err() {
                    break;
                }
                continue;
            }
            WsMessage::Pong(_) => continue,
            WsMessage::Close(_) => break,
            WsMessage::Text(text) => {
                turn_on_connection += 1;
                let prompt_bytes = text.len();
                let raw_body: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(err) => {
                        let _ = ws
                            .send(WsMessage::text(
                                json!({
                                    "type": "error",
                                    "error": {
                                        "type": "invalid_request_error",
                                        "message": format!("invalid WS JSON frame: {err}"),
                                    }
                                })
                                .to_string(),
                            ))
                            .await;
                        break;
                    }
                };

                let seq = state.next_sequence();
                let normalized = normalize_request(
                    seq,
                    Protocol::OpenaiResponsesWs,
                    Transport::WebSocket {
                        connection_id: conn_id,
                        turn_on_connection,
                    },
                    path.clone(),
                    headers.clone(),
                    prompt_bytes,
                    raw_body,
                );
                let turn_started = Instant::now();
                state
                    .metrics
                    .record_protocol(Protocol::OpenaiResponsesWs, normalized.prompt_bytes);
                state.recorder.record(&normalized);
                state.watchdog.inspect_request(&normalized);

                let effective_profile = state.profile.effective();

                // Stateful rate-limit admission on WS turns
                let rl_lease = match state.rate_limiter.check_and_acquire(
                    normalized.api_key(),
                    &normalized.model,
                    normalized.estimated_input_tokens,
                    effective_profile.rate_limit_override.as_ref(),
                ) {
                    RateLimitDecision::Allowed { lease, .. } => lease,
                    RateLimitDecision::Rejected {
                        retry_after_ms,
                        reason,
                        ..
                    } => {
                        state
                            .metrics
                            .http_errors_emitted
                            .fetch_add(1, Ordering::Relaxed);
                        state
                            .metrics
                            .rate_limits_emitted
                            .fetch_add(1, Ordering::Relaxed);
                        state.metrics.record_dimension(
                            Protocol::OpenaiResponsesWs,
                            &normalized.model,
                            "429",
                            normalized.estimated_input_tokens,
                            0,
                            0,
                            None,
                            Some(turn_started.elapsed().as_millis() as u64),
                        );
                        let err_frame = json!({
                            "type": "error",
                            "status": 429,
                            "error": {
                                "type": "rate_limit_error",
                                "code": "rate_limit_exceeded",
                                "message": format!("rate limit exceeded ({reason}); retry_after_ms={retry_after_ms}"),
                            }
                        });
                        let _ = ws.send(WsMessage::text(err_frame.to_string())).await;
                        break;
                    }
                };

                // Validate previous_response_id against current connection baseline OR global stored responses.
                if state.tuning.strict_previous_response_id
                    && let Some(prev_id) = &normalized.previous_response_id
                    && current_baseline_id.as_deref() != Some(prev_id.as_str())
                    && !state.stored_responses.contains(prev_id)
                {
                    state
                        .watchdog
                        .record_invalid_previous_response_id(&normalized, prev_id);
                    state.metrics.record_dimension(
                        Protocol::OpenaiResponsesWs,
                        &normalized.model,
                        "400",
                        normalized.estimated_input_tokens,
                        0,
                        0,
                        None,
                        Some(turn_started.elapsed().as_millis() as u64),
                    );
                    let err_frame = json!({
                        "type": "error",
                        "error": {
                            "type": "invalid_request_error",
                            "code": "previous_response_not_found",
                            "message": format!("previous_response_id '{prev_id}' is not valid on this connection"),
                        }
                    });
                    let _ = ws.send(WsMessage::text(err_frame.to_string())).await;
                    break;
                }

                // Cassette WS replay mode (when configured and matched)
                if let Some(ref replayer) = state.cassette_replayer {
                    let fp = fingerprint_from_normalized(&normalized);
                    if let Some(ex) = replayer.next_ws(&fp) {
                        state.metrics.replay_hits.fetch_add(1, Ordering::Relaxed);
                        state.metrics.active_streams.fetch_add(1, Ordering::Relaxed);
                        let _stream_guard = ActiveStreamGuard(state.metrics.clone());
                        let _lease = rl_lease;
                        let mut ok = true;
                        let mut first_ttft: Option<u64> = None;
                        let mut last_resp_id: Option<String> = None;
                        for chunk in &ex.chunks {
                            let delay = replayer.config().scaled_delay(chunk.delay_ms);
                            if !delay.is_zero() {
                                tokio::select! {
                                    _ = state.shutdown.cancelled() => { ok = false; break; }
                                    _ = tokio::time::sleep(delay) => {}
                                }
                            }
                            let msg = if chunk.is_binary {
                                WsMessage::Binary(chunk.to_bytes())
                            } else {
                                if let Ok(v) = serde_json::from_str::<Value>(&chunk.data)
                                    && let Some(id) =
                                        v.pointer("/response/id").and_then(Value::as_str)
                                {
                                    last_resp_id = Some(id.to_string());
                                }
                                WsMessage::text(chunk.data.clone())
                            };
                            let byte_len = chunk.data.len();
                            if ws.send(msg).await.is_err() {
                                ok = false;
                                break;
                            }
                            if first_ttft.is_none() {
                                let ttft = turn_started.elapsed().as_millis() as u64;
                                state.metrics.ttft_ms.record(ttft);
                                first_ttft = Some(ttft);
                            }
                            state
                                .metrics
                                .bytes_sent
                                .fetch_add(byte_len as u64, Ordering::Relaxed);
                        }
                        let dur = turn_started.elapsed().as_millis() as u64;
                        state.metrics.turn_duration_ms.record(dur);
                        state.metrics.record_dimension(
                            Protocol::OpenaiResponsesWs,
                            &normalized.model,
                            if ok { "200" } else { "aborted" },
                            normalized.estimated_input_tokens,
                            0,
                            0,
                            first_ttft,
                            Some(dur),
                        );
                        if !ok {
                            break;
                        }
                        current_baseline_id = last_resp_id;
                        continue;
                    }
                }

                let session_turn = state.sessions.next_turn(&normalized.session_key);
                let ctx = TurnContext {
                    global_turn: seq,
                    session_turn,
                    chaos_override: effective_profile.chaos_override.clone(),
                };
                let store_flag = normalized.raw_body["store"].as_bool().unwrap_or(false);

                let decision = match state.handler.handle(&normalized, &ctx).await {
                    Some(d) => d,
                    None => {
                        let _ = ws
                            .send(WsMessage::text(
                                json!({
                                    "type": "error",
                                    "error": {
                                        "type": "server_error",
                                        "message": "mock handler exhausted",
                                    }
                                })
                                .to_string(),
                            ))
                            .await;
                        break;
                    }
                };

                state.metrics.active_streams.fetch_add(1, Ordering::Relaxed);
                let _stream_guard = ActiveStreamGuard(state.metrics.clone());

                let (reusable, completed_id) = match decision {
                    TurnDecision::Plan(plan) => {
                        run_ws_plan(
                            &mut ws,
                            &normalized,
                            plan,
                            store_flag,
                            effective_profile.latency,
                            rl_lease,
                            turn_started,
                            &state,
                        )
                        .await
                    }
                    TurnDecision::Interactive(stream) => {
                        let _lease = rl_lease;
                        run_ws_interactive(&mut ws, &normalized, stream, store_flag, &state).await
                    }
                };

                if reusable {
                    current_baseline_id = completed_id;
                } else {
                    break;
                }
            }
            WsMessage::Binary(_) | WsMessage::Frame(_) => break,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_ws_plan<S>(
    ws: &mut WebSocketStream<S>,
    req: &NormalizedRequest,
    plan: TurnPlan,
    store_flag: bool,
    latency_profile: LatencyProfile,
    mut rl_lease: Option<RateLimitLease>,
    turn_started: Instant,
    state: &Arc<ServerState>,
) -> (bool, Option<String>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let response_id = plan
        .response_id
        .clone()
        .unwrap_or_else(|| default_response_id(Protocol::OpenaiResponsesWs, req.sequence));
    let model = plan
        .model_override
        .clone()
        .unwrap_or_else(|| req.model.clone());
    let inferred_finish = plan.inferred_finish_reason();
    let _close_guard = TurnCloseGuard(plan.on_close.clone());

    let usage_hint = plan_usage_hint(&plan, req);
    let cached_tokens = usage_hint.cache_read_tokens.unwrap_or(0);
    let uncached_tokens = usage_hint.input_tokens.saturating_sub(cached_tokens);
    let in_flight_sample = state.metrics.active_streams.load(Ordering::Relaxed).max(1);
    let mut pacer = TurnPacer::new(
        latency_profile,
        pacer_seed_for(req),
        in_flight_sample,
        plan.ttft_ms,
        (plan.chunk_delay_ms > 0).then_some(plan.chunk_delay_ms),
    );
    let ttft_dur = pacer.compute_ttft(uncached_tokens, cached_tokens);

    let mut emitted_tool_ids = Vec::new();
    let mut emitted_compaction = false;

    // Dynamic TTFT wait (responsive to client WS close/ping and server shutdown)
    if !ttft_dur.is_zero() {
        let sleep = tokio::time::sleep(ttft_dur);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = state.shutdown.cancelled() => {
                    state.metrics.abandoned_streams.fetch_add(1, Ordering::Relaxed);
                    state.watchdog.record_turn_outcome(req, &emitted_tool_ids, emitted_compaction, false);
                    return (false, None);
                }
                _ = &mut sleep => break,
                msg = ws.next() => match msg {
                    Some(Ok(WsMessage::Ping(p))) => {
                        let _ = ws.send(WsMessage::Pong(p)).await;
                    }
                    None | Some(Ok(WsMessage::Close(_))) | Some(Err(_)) => {
                        state.metrics.abandoned_streams.fetch_add(1, Ordering::Relaxed);
                        state.watchdog.record_turn_outcome(req, &emitted_tool_ids, emitted_compaction, false);
                        return (false, None);
                    }
                    _ => {}
                }
            }
        }
    }

    let mut encoder = create_encoder(
        Protocol::OpenaiResponsesWs,
        response_id,
        model.clone(),
        true,
    );
    let mut frames = Vec::new();
    let mut first_delta_at: Option<Instant> = None;
    let mut recorded_ttft_ms: Option<u64> = None;
    let mut emitted_semantic_bytes = 0usize;

    for ev in plan.events {
        if state.shutdown.is_cancelled() {
            state
                .metrics
                .abandoned_streams
                .fetch_add(1, Ordering::Relaxed);
            state
                .watchdog
                .record_turn_outcome(req, &emitted_tool_ids, emitted_compaction, false);
            return (false, None);
        }
        let ev_sem_bytes = semantic_event_bytes(&ev);
        match ev {
            TurnEvent::Delay { ms } => {
                tokio::select! {
                    _ = state.shutdown.cancelled() => return (false, None),
                    _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                }
            }
            TurnEvent::JitterDelay { min_ms, max_ms } => {
                let ms = jitter_ms(min_ms, max_ms);
                if ms > 0 {
                    tokio::select! {
                        _ = state.shutdown.cancelled() => return (false, None),
                        _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                    }
                }
            }
            TurnEvent::Stall => {
                state.metrics.stalls_entered.fetch_add(1, Ordering::Relaxed);
                loop {
                    tokio::select! {
                        _ = state.shutdown.cancelled() => return (false, None),
                        msg = ws.next() => match msg {
                            Some(Ok(WsMessage::Ping(p))) => {
                                let _ = ws.send(WsMessage::Pong(p)).await;
                            }
                            None | Some(Ok(WsMessage::Close(_))) | Some(Err(_)) => return (false, None),
                            _ => {}
                        }
                    }
                }
            }
            TurnEvent::HttpError(spec) => {
                state
                    .metrics
                    .http_errors_emitted
                    .fetch_add(1, Ordering::Relaxed);
                if spec.status == 429 {
                    state
                        .metrics
                        .rate_limits_emitted
                        .fetch_add(1, Ordering::Relaxed);
                }
                let err_frame = if let Some(raw) = spec.raw_body {
                    json!({ "type": "error", "status": spec.status, "error": raw.get("error").cloned().unwrap_or(raw) })
                } else {
                    json!({
                        "type": "error",
                        "status": spec.status,
                        "error": {
                            "type": spec.error_type,
                            "code": spec.code,
                            "message": spec.message,
                        }
                    })
                };
                let _ = ws.send(WsMessage::text(err_frame.to_string())).await;
                state.metrics.record_dimension(
                    Protocol::OpenaiResponsesWs,
                    &model,
                    &spec.status.to_string(),
                    usage_hint.input_tokens,
                    0,
                    cached_tokens,
                    None,
                    Some(turn_started.elapsed().as_millis() as u64),
                );
                return (false, None);
            }
            TurnEvent::DropConnection => {
                state
                    .metrics
                    .connection_drops_emitted
                    .fetch_add(1, Ordering::Relaxed);
                return (false, None);
            }
            TurnEvent::TruncateEof => {
                let _ = ws.close(None).await;
                return (false, None);
            }
            TurnEvent::MidStreamError(err) => {
                state
                    .metrics
                    .mid_stream_errors_emitted
                    .fetch_add(1, Ordering::Relaxed);
                encoder.push_event(TurnEvent::MidStreamError(err), &mut frames);
                let _ = flush_ws_frames(ws, &mut frames, None, 0, None, state).await;
                return (false, None);
            }
            TurnEvent::Finish { reason } => {
                let completion = encoder.finish(reason, &mut frames);
                if store_flag {
                    state
                        .stored_responses
                        .put(completion.response_id.clone(), completion.response_json);
                }
                if !flush_ws_frames(ws, &mut frames, None, 0, None, state).await {
                    state
                        .metrics
                        .abandoned_streams
                        .fetch_add(1, Ordering::Relaxed);
                    state.watchdog.record_turn_outcome(
                        req,
                        &emitted_tool_ids,
                        emitted_compaction,
                        false,
                    );
                    return (false, None);
                }
                let dur = turn_started.elapsed().as_millis() as u64;
                state.metrics.turn_duration_ms.record(dur);
                let out_toks = usage_hint
                    .output_tokens
                    .max((emitted_semantic_bytes as u64) / 4);
                if let Some(first_at) = first_delta_at
                    && out_toks > 0
                {
                    let tps = ((out_toks as f64) / first_at.elapsed().as_secs_f64().max(0.001))
                        .round()
                        .max(1.0) as u64;
                    state.metrics.effective_tps.record(tps);
                }
                if let Some(ref mut lease) = rl_lease {
                    lease.debit_output_tokens(out_toks);
                }
                state.metrics.record_dimension(
                    Protocol::OpenaiResponsesWs,
                    &model,
                    "200",
                    usage_hint.input_tokens,
                    out_toks,
                    cached_tokens,
                    recorded_ttft_ms,
                    Some(dur),
                );
                state.watchdog.record_turn_outcome(
                    req,
                    &emitted_tool_ids,
                    emitted_compaction,
                    true,
                );
                return (completion.ws_reusable, Some(completion.response_id));
            }
            TurnEvent::NativeCompaction(c) => {
                state
                    .metrics
                    .native_compactions_emitted
                    .fetch_add(1, Ordering::Relaxed);
                encoder.push_event(TurnEvent::NativeCompaction(c), &mut frames);
                let mut ttft = TtftTracker {
                    turn_started,
                    first_delta_at: &mut first_delta_at,
                    recorded_ttft_ms: &mut recorded_ttft_ms,
                };
                let status = flush_ws_frames_detailed(
                    ws,
                    &mut frames,
                    Some(&mut pacer),
                    ev_sem_bytes,
                    Some(&mut ttft),
                    state,
                )
                .await;
                if status.all_wire_frames_sent {
                    emitted_compaction = true;
                    emitted_semantic_bytes += ev_sem_bytes;
                }
                if !status.continued {
                    state
                        .metrics
                        .abandoned_streams
                        .fetch_add(1, Ordering::Relaxed);
                    state.watchdog.record_turn_outcome(
                        req,
                        &emitted_tool_ids,
                        emitted_compaction,
                        false,
                    );
                    return (false, None);
                }
            }
            other => {
                let maybe_tool_id = match &other {
                    TurnEvent::ToolCall(tc) => Some(tc.id.clone()),
                    _ => None,
                };
                encoder.push_event(other, &mut frames);
                let mut ttft = TtftTracker {
                    turn_started,
                    first_delta_at: &mut first_delta_at,
                    recorded_ttft_ms: &mut recorded_ttft_ms,
                };
                let status = flush_ws_frames_detailed(
                    ws,
                    &mut frames,
                    Some(&mut pacer),
                    ev_sem_bytes,
                    Some(&mut ttft),
                    state,
                )
                .await;
                if status.all_wire_frames_sent {
                    if let Some(tid) = maybe_tool_id {
                        emitted_tool_ids.push(tid);
                    }
                    emitted_semantic_bytes += ev_sem_bytes;
                }
                if !status.continued {
                    state
                        .metrics
                        .abandoned_streams
                        .fetch_add(1, Ordering::Relaxed);
                    state.watchdog.record_turn_outcome(
                        req,
                        &emitted_tool_ids,
                        emitted_compaction,
                        false,
                    );
                    return (false, None);
                }
            }
        }
    }

    if !encoder.is_finished() {
        let completion = encoder.finish(inferred_finish, &mut frames);
        if store_flag {
            state
                .stored_responses
                .put(completion.response_id.clone(), completion.response_json);
        }
        if !flush_ws_frames(ws, &mut frames, None, 0, None, state).await {
            state
                .metrics
                .abandoned_streams
                .fetch_add(1, Ordering::Relaxed);
            state
                .watchdog
                .record_turn_outcome(req, &emitted_tool_ids, emitted_compaction, false);
            return (false, None);
        }
        let dur = turn_started.elapsed().as_millis() as u64;
        state.metrics.turn_duration_ms.record(dur);
        let out_toks = usage_hint
            .output_tokens
            .max((emitted_semantic_bytes as u64) / 4);
        if let Some(first_at) = first_delta_at
            && out_toks > 0
        {
            let tps = ((out_toks as f64) / first_at.elapsed().as_secs_f64().max(0.001))
                .round()
                .max(1.0) as u64;
            state.metrics.effective_tps.record(tps);
        }
        if let Some(ref mut lease) = rl_lease {
            lease.debit_output_tokens(out_toks);
        }
        state.metrics.record_dimension(
            Protocol::OpenaiResponsesWs,
            &model,
            "200",
            usage_hint.input_tokens,
            out_toks,
            cached_tokens,
            recorded_ttft_ms,
            Some(dur),
        );
        state
            .watchdog
            .record_turn_outcome(req, &emitted_tool_ids, emitted_compaction, true);
        return (completion.ws_reusable, Some(completion.response_id));
    }

    (false, None)
}

async fn run_ws_interactive<S>(
    ws: &mut WebSocketStream<S>,
    req: &NormalizedRequest,
    mut stream: InteractiveStream,
    store_flag: bool,
    state: &Arc<ServerState>,
) -> (bool, Option<String>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let response_id = stream
        .response_id
        .clone()
        .unwrap_or_else(|| default_response_id(Protocol::OpenaiResponsesWs, req.sequence));
    let mut encoder = create_encoder(
        Protocol::OpenaiResponsesWs,
        response_id,
        req.model.clone(),
        true,
    );
    let mut frames = Vec::new();
    let mut result = (false, None);

    loop {
        let ev = tokio::select! {
            _ = state.shutdown.cancelled() => break,
            next = stream.events.recv() => match next {
                Some(e) => e,
                None => break,
            }
        };
        match ev {
            TurnEvent::Delay { ms } => {
                tokio::select! {
                    _ = state.shutdown.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
                }
            }
            TurnEvent::Stall => {
                state.metrics.stalls_entered.fetch_add(1, Ordering::Relaxed);
                tokio::select! {
                    _ = state.shutdown.cancelled() => break,
                    msg = ws.next() => match msg {
                        None | Some(Ok(WsMessage::Close(_))) | Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
            TurnEvent::DropConnection => {
                state
                    .metrics
                    .connection_drops_emitted
                    .fetch_add(1, Ordering::Relaxed);
                break;
            }
            TurnEvent::TruncateEof => {
                let _ = ws.close(None).await;
                break;
            }
            TurnEvent::HttpError(spec) => {
                let err_frame = json!({
                    "type": "error",
                    "status": spec.status,
                    "error": {
                        "type": spec.error_type,
                        "code": spec.code,
                        "message": spec.message,
                    }
                });
                let _ = ws.send(WsMessage::text(err_frame.to_string())).await;
                break;
            }
            TurnEvent::MidStreamError(err) => {
                state
                    .metrics
                    .mid_stream_errors_emitted
                    .fetch_add(1, Ordering::Relaxed);
                encoder.push_event(TurnEvent::MidStreamError(err), &mut frames);
                let _ = flush_ws_frames(ws, &mut frames, None, 0, None, state).await;
                break;
            }
            TurnEvent::Finish { reason } => {
                let completion = encoder.finish(reason, &mut frames);
                if store_flag {
                    state
                        .stored_responses
                        .put(completion.response_id.clone(), completion.response_json);
                }
                if flush_ws_frames(ws, &mut frames, None, 0, None, state).await {
                    result = (completion.ws_reusable, Some(completion.response_id));
                }
                break;
            }
            TurnEvent::NativeCompaction(c) => {
                state
                    .metrics
                    .native_compactions_emitted
                    .fetch_add(1, Ordering::Relaxed);
                encoder.push_event(TurnEvent::NativeCompaction(c), &mut frames);
                if !flush_ws_frames(ws, &mut frames, None, 0, None, state).await {
                    break;
                }
            }
            other => {
                encoder.push_event(other, &mut frames);
                if !flush_ws_frames(ws, &mut frames, None, 0, None, state).await {
                    break;
                }
            }
        }
    }

    stream.closed.notify_one();
    result
}

struct TtftTracker<'a> {
    turn_started: Instant,
    first_delta_at: &'a mut Option<Instant>,
    recorded_ttft_ms: &'a mut Option<u64>,
}

impl TtftTracker<'_> {
    fn record_once(&mut self, metrics: &ServerMetrics) {
        if self.first_delta_at.is_none() {
            *self.first_delta_at = Some(Instant::now());
            let ttft = self.turn_started.elapsed().as_millis() as u64;
            metrics.ttft_ms.record(ttft);
            *self.recorded_ttft_ms = Some(ttft);
        }
    }
}

struct FlushStatus {
    all_wire_frames_sent: bool,
    continued: bool,
}

fn is_semantic_delta_frame(raw: &str) -> bool {
    // Extract the JSON payload from either an SSE frame (`data: {...}`) or raw WS JSON text
    // and check its protocol `type` field directly instead of substring-scanning message content.
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

#[allow(clippy::too_many_arguments)]
async fn flush_http_frames(
    tx: &mpsc::Sender<Result<Frame<Bytes>, io::Error>>,
    frames: &mut Vec<WireFrame>,
    pacer: Option<&mut TurnPacer>,
    semantic_bytes: usize,
    ttft: Option<&mut TtftTracker<'_>>,
    wire_poison: &WirePoisonConfig,
    frame_seq: &mut usize,
    state: &ServerState,
) -> bool {
    flush_http_frames_detailed(
        tx,
        frames,
        pacer,
        semantic_bytes,
        ttft,
        wire_poison,
        frame_seq,
        state,
    )
    .await
    .continued
}

#[allow(clippy::too_many_arguments)]
async fn flush_http_frames_detailed(
    tx: &mpsc::Sender<Result<Frame<Bytes>, io::Error>>,
    frames: &mut Vec<WireFrame>,
    mut pacer: Option<&mut TurnPacer>,
    semantic_bytes: usize,
    mut ttft: Option<&mut TtftTracker<'_>>,
    wire_poison: &WirePoisonConfig,
    frame_seq: &mut usize,
    state: &ServerState,
) -> FlushStatus {
    let total_frames = frames.len();
    let per_frame_sem_bytes = if semantic_bytes > 0 {
        (semantic_bytes / total_frames.max(1)).max(1)
    } else {
        0
    };
    let mut sent_frames = 0usize;
    for frame in frames.drain(..) {
        let raw_bytes = match frame {
            WireFrame::Sse(b) | WireFrame::Raw(b) => b,
            WireFrame::WsText(s) => Bytes::from(format!("data: {s}\n\n")),
        };
        let is_delta =
            semantic_bytes > 0 && is_semantic_delta_frame(&String::from_utf8_lossy(&raw_bytes));
        let chunks = if wire_poison.is_active() {
            let s = String::from_utf8_lossy(&raw_bytes).into_owned();
            poison_sse_frame(s, wire_poison, *frame_seq)
        } else {
            vec![raw_bytes]
        };
        *frame_seq = frame_seq.wrapping_add(1);

        for chunk in chunks {
            let len = chunk.len();
            if tx.send(Ok(Frame::data(chunk))).await.is_err() {
                return FlushStatus {
                    all_wire_frames_sent: false,
                    continued: false,
                };
            }
            state
                .metrics
                .bytes_sent
                .fetch_add(len as u64, Ordering::Relaxed);
        }
        sent_frames += 1;

        // Record TTFT right after first actual semantic delta frame is sent, BEFORE pacing sleep.
        if is_delta && let Some(ref mut tracker) = ttft {
            tracker.record_once(&state.metrics);
        }

        if is_delta
            && let Some(ref mut p) = pacer
            && per_frame_sem_bytes > 0
        {
            let delay = p.next_chunk_delay(per_frame_sem_bytes);
            if !delay.is_zero() {
                tokio::select! {
                    _ = state.shutdown.cancelled() => return FlushStatus {
                        all_wire_frames_sent: sent_frames == total_frames,
                        continued: false,
                    },
                    _ = tx.closed() => return FlushStatus {
                        all_wire_frames_sent: sent_frames == total_frames,
                        continued: false,
                    },
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
    FlushStatus {
        all_wire_frames_sent: true,
        continued: true,
    }
}

async fn flush_ws_frames<S>(
    ws: &mut WebSocketStream<S>,
    frames: &mut Vec<WireFrame>,
    pacer: Option<&mut TurnPacer>,
    semantic_bytes: usize,
    ttft: Option<&mut TtftTracker<'_>>,
    state: &ServerState,
) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    flush_ws_frames_detailed(ws, frames, pacer, semantic_bytes, ttft, state)
        .await
        .continued
}

async fn flush_ws_frames_detailed<S>(
    ws: &mut WebSocketStream<S>,
    frames: &mut Vec<WireFrame>,
    mut pacer: Option<&mut TurnPacer>,
    semantic_bytes: usize,
    mut ttft: Option<&mut TtftTracker<'_>>,
    state: &ServerState,
) -> FlushStatus
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let total_frames = frames.len();
    let per_frame_sem_bytes = if semantic_bytes > 0 {
        (semantic_bytes / total_frames.max(1)).max(1)
    } else {
        0
    };
    let mut sent_frames = 0usize;
    for frame in frames.drain(..) {
        let len = frame.byte_len();
        let text = match frame {
            WireFrame::WsText(s) => s,
            WireFrame::Sse(b) | WireFrame::Raw(b) => String::from_utf8_lossy(&b).into_owned(),
        };
        let is_delta = semantic_bytes > 0 && is_semantic_delta_frame(&text);
        if ws.send(WsMessage::text(text)).await.is_err() {
            return FlushStatus {
                all_wire_frames_sent: false,
                continued: false,
            };
        }
        sent_frames += 1;
        state
            .metrics
            .bytes_sent
            .fetch_add(len as u64, Ordering::Relaxed);
        if is_delta && let Some(ref mut tracker) = ttft {
            tracker.record_once(&state.metrics);
        }
        if is_delta
            && let Some(ref mut p) = pacer
            && per_frame_sem_bytes > 0
        {
            let delay = p.next_chunk_delay(per_frame_sem_bytes);
            if !delay.is_zero() {
                tokio::select! {
                    _ = state.shutdown.cancelled() => return FlushStatus {
                        all_wire_frames_sent: sent_frames == total_frames,
                        continued: false,
                    },
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
    FlushStatus {
        all_wire_frames_sent: true,
        continued: true,
    }
}

fn sse_response(
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

fn json_with_headers(
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

async fn handle_admin(
    method: Method,
    path: &str,
    req: Request<Incoming>,
    state: Arc<ServerState>,
) -> Response<BoxBody> {
    match (method, path) {
        (Method::GET, "/admin/health") => full_json(StatusCode::OK, &json!({ "ok": true })),
        (Method::GET, "/admin/metrics") => {
            full_json(StatusCode::OK, &json!(state.metrics.snapshot()))
        }
        (Method::GET, "/admin/requests") => {
            full_json(StatusCode::OK, &json!(state.recorder.snapshot()))
        }
        (Method::POST, "/admin/reset") => {
            state.reset();
            full_json(StatusCode::OK, &json!({ "reset": true }))
        }
        (Method::GET, "/admin/rules") => {
            let rules = state
                .rule_engine
                .as_ref()
                .map(|e| e.rule_specs())
                .unwrap_or_default();
            full_json(StatusCode::OK, &json!(rules))
        }
        (Method::PUT, "/admin/rules") => {
            let Some(engine) = &state.rule_engine else {
                return full_json(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "server is not configured with a RuleEngine" }),
                );
            };
            let bytes = match Limited::new(req.into_body(), 8 * 1024 * 1024)
                .collect()
                .await
            {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let specs: Vec<RuleSpec> = match serde_json::from_slice(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid rules JSON: {e}") }),
                    );
                }
            };
            match engine.replace_rules(specs) {
                Ok(()) => full_json(StatusCode::OK, &json!({ "updated": true })),
                Err(e) => full_json(StatusCode::BAD_REQUEST, &json!({ "error": e.to_string() })),
            }
        }
        (Method::GET, "/admin/profile") => {
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::PUT, "/admin/profile") => {
            let bytes = match Limited::new(req.into_body(), 1024 * 1024).collect().await {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let profile: RuntimeProfile = match serde_json::from_slice(&bytes) {
                Ok(p) => p,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid profile JSON: {e}") }),
                    );
                }
            };
            state.profile.set_manual_override(Some(profile));
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::DELETE, "/admin/profile") => {
            state.profile.set_manual_override(None);
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::PUT, "/admin/schedule") => {
            let bytes = match Limited::new(req.into_body(), 1024 * 1024).collect().await {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let schedule: ScenarioSchedule = match serde_json::from_slice(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid schedule JSON: {e}") }),
                    );
                }
            };
            state.profile.set_schedule(schedule);
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::GET, "/admin/ratelimit") => {
            full_json(StatusCode::OK, &json!(state.rate_limiter.config()))
        }
        (Method::PUT, "/admin/ratelimit") => {
            let bytes = match Limited::new(req.into_body(), 1024 * 1024).collect().await {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let cfg: RateLimitConfig = match serde_json::from_slice(&bytes) {
                Ok(c) => c,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid ratelimit JSON: {e}") }),
                    );
                }
            };
            state.rate_limiter.update_config(cfg);
            full_json(StatusCode::OK, &json!(state.rate_limiter.config()))
        }
        (Method::GET, "/admin/violations") => {
            full_json(StatusCode::OK, &json!(state.watchdog.snapshot()))
        }
        (Method::DELETE, "/admin/violations") => {
            state.watchdog.clear();
            full_json(StatusCode::OK, &json!({ "cleared": true }))
        }
        _ => full_json(
            StatusCode::NOT_FOUND,
            &json!({ "error": format!("unknown admin route: {path}") }),
        ),
    }
}

fn classify_protocol(path: &str) -> Option<Protocol> {
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

fn is_responses_path(path: &str) -> bool {
    path == "/responses" || path == "/v1/responses" || path.ends_with("/responses")
}

fn extract_stored_response_id(path: &str) -> Option<&str> {
    let rest = path
        .strip_prefix("/v1/responses/")
        .or_else(|| path.strip_prefix("/responses/"))?;
    if rest.is_empty() || rest.contains('/') {
        None
    } else {
        Some(rest)
    }
}

fn default_response_id(protocol: Protocol, seq: u64) -> String {
    match protocol {
        Protocol::OpenaiChatCompletions => format!("chatcmpl_mock_{seq}"),
        Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => format!("resp_mock_{seq}"),
        Protocol::AnthropicMessages => format!("msg_mock_{seq}"),
    }
}

fn jitter_ms(min_ms: u64, max_ms: u64) -> u64 {
    let lo = min_ms.min(max_ms);
    let hi = min_ms.max(max_ms);
    if hi == lo { lo } else { fastrand::u64(lo..=hi) }
}
