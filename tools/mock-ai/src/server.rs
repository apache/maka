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

use crate::codec::{WireEncoder, create_encoder_with_options, format_http_error_body_for_profile};
use crate::control::{ControlPlaneConfig, CustomRouteFn, StoredResponses};
use crate::handler::{
    AsyncFnHandler, ChainHandler, FilterHandler, FnHandler, InteractiveHandler, ScriptedHandler,
    SessionTracker, TurnContext, TurnDecision, TurnHandle, TurnHandler,
};
use crate::metrics::SessionTelemetryStore;
use crate::metrics::{
    AttemptOutcome, AttemptSpan, MetricsSnapshot, RecordedControlRequest, RecordedRequest,
    RecorderMode, RequestPurpose, RequestRecorder, RunClock, ServerMetrics,
};
use crate::pacing::{
    DynamicProfileManager, LatencyProfile, ProfileSnapshot, RuntimeProfile, ScenarioSchedule,
};
use crate::plan::{
    CompactionOutput, HttpErrorSpec, ProviderDialectProfile, TurnEvent, TurnPlan, Usage,
};
use crate::protocol::{AuthPolicy, NormalizedRequest, Protocol, Transport};
#[cfg(feature = "proxy")]
use crate::proxy::{CassetteReplayer, ProxyRecordConfig, ProxyRecorder, ReplayConfig};
use crate::ratelimit::{RateLimitConfig, RateLimiter};
use crate::routing::{
    CompactKind, EndpointKind, IdentityError, IdentityRequest, LineageStore, ParsedRoute,
    PrincipalId, RequestClassifier, RequestUse, ResponseId, ResponseLineage, Revision, RouteScope,
    RunId, SessionId, SessionIdentityResolver, SessionRegistry, SideKind,
};
#[cfg(feature = "rules")]
use crate::rules::{ConfigError, RuleEngine, RuleSpec};
use crate::scenario::{ScenarioEngine, ScenarioSpec};
use crate::schema_synth::WirePoisonConfig;
#[cfg(feature = "tls")]
use crate::tls::TlsServerConfig;
use crate::watchdog::{
    HistorySize, ProtocolWatchdog, StreamCloseReason, WatchdogConfig, WatchdogSnapshot,
};
use bytes::Bytes;
use futures_util::FutureExt;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{self, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::any::Any;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::io;
use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::{Notify, mpsc};
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
    pub active_bg_tasks: AtomicUsize,
    pub bg_tasks_drained: Notify,
    pub next_seq: AtomicU64,
    pub next_conn_id: AtomicU64,
    pub shutdown: CancellationToken,
    benchmark: RwLock<BenchmarkRouting>,
    classifier: RequestClassifier,
    telemetry: SessionTelemetryStore,
    scenario: Option<ScenarioEngine>,
    strict_benchmark: bool,
    dialect: Option<ProviderDialectProfile>,
    clock: RunClock,
    unknown_routes: AtomicU64,
}

impl ServerState {
    fn render_prometheus(&self) -> String {
        use std::fmt::Write;
        let mut output = self
            .metrics
            .render_prometheus(self.watchdog.total_violations());
        writeln!(output, "# TYPE mock_ai_unknown_routes_total counter").unwrap();
        writeln!(
            output,
            "mock_ai_unknown_routes_total {}",
            self.unknown_routes.load(Ordering::Relaxed)
        )
        .unwrap();
        output
    }

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

    pub(super) fn reset(&self) -> bool {
        let mut benchmark = self.benchmark.write().unwrap();
        if !benchmark.sessions.is_empty() {
            return false;
        }
        self.metrics.reset();
        self.unknown_routes.store(0, Ordering::Relaxed);
        benchmark.lineage = LineageStore::default();
        self.recorder.clear();
        self.stored_responses.clear();
        self.sessions.clear();
        self.profile.reset_clock();
        self.rate_limiter.reset();
        self.watchdog.reset_all();
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
        true
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

#[derive(Default)]
struct BenchmarkRouting {
    registry: SessionRegistry,
    lineage: LineageStore,
    responses: HashMap<SessionId, ResponseBodies>,
    sessions: HashMap<SessionId, Arc<SessionActivity>>,
    runs: HashMap<RunId, (u64, usize)>,
}

#[derive(Default)]
struct ResponseBodies {
    order: VecDeque<ResponseId>,
    entries: HashMap<ResponseId, (Arc<Value>, usize)>,
    bytes: usize,
}

impl ResponseBodies {
    fn insert(
        &mut self,
        id: ResponseId,
        value: Value,
        bytes: usize,
        capacity: usize,
        max_bytes: usize,
    ) -> Vec<Arc<Value>> {
        let mut retired = Vec::new();
        while self.order.len() >= capacity || (max_bytes > 0 && self.bytes > max_bytes - bytes) {
            let id = self
                .order
                .pop_front()
                .expect("full response bucket has a head");
            let (response, bytes) = self.entries.remove(&id).expect("queued response exists");
            self.bytes -= bytes;
            retired.push(response);
        }
        self.order.push_back(id.clone());
        self.entries.insert(id, (Arc::new(value), bytes));
        self.bytes += bytes;
        retired
    }

    fn remove(&mut self, id: &ResponseId) -> Option<Arc<Value>> {
        let (response, bytes) = self.entries.remove(id)?;
        self.order.retain(|entry| entry != id);
        self.bytes -= bytes;
        Some(response)
    }
}

struct SessionActivity {
    attempts: AtomicUsize,
    run_start_ns: u64,
    registered_ns: u64,
    finalized_ns: AtomicU64,
}

impl ServerState {
    fn resolve_identity(
        &self,
        attempt: &Attempt,
        scope: Option<&RouteScope>,
        headers: &BTreeMap<String, String>,
        body: &Value,
        previous: Option<&ResponseId>,
        bind_connection: bool,
    ) -> Result<(), Box<HttpErrorSpec>> {
        if !self.strict_benchmark && !self.control.enable_admin_api && scope.is_none() {
            return Ok(());
        }
        let principal = match &self.auth {
            AuthPolicy::ApiKey { token } => Some(token.as_str()),
            AuthPolicy::Header { name, .. } => {
                headers.get(&name.to_ascii_lowercase()).map(String::as_str)
            }
            _ => headers
                .get("authorization")
                .and_then(|value| value.trim().split_once(' '))
                .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
                .map(|(_, value)| value)
                .or_else(|| headers.get("x-api-key").map(String::as_str))
                .or_else(|| headers.get("api-key").map(String::as_str)),
        }
        .filter(|value| !value.is_empty())
        .map(|value| PrincipalId(value.into()));
        let connection_id = attempt.connection_id();
        let routing = self.benchmark.read().unwrap();
        if routing.sessions.is_empty() && !self.strict_benchmark && scope.is_none() {
            return Ok(());
        }
        let result = SessionIdentityResolver::new(&routing.registry, &routing.lineage).resolve(
            IdentityRequest {
                scope,
                principal: principal.as_ref(),
                headers,
                body,
                previous_response_id: previous,
                connection_id,
            },
        );
        match result {
            Ok(session) => {
                let session_id = session.session_id.clone();
                attempt.attach(session, &routing.sessions[&session_id]);
                drop(routing);
                if bind_connection && let Some(conn) = connection_id {
                    self.benchmark
                        .write()
                        .unwrap()
                        .registry
                        .bind_connection(conn, &session_id)
                        .map_err(identity_error)?;
                }
                Ok(())
            }
            Err(IdentityError::Unroutable) if !self.strict_benchmark => Ok(()),
            Err(error) => Err(identity_error(error)),
        }
    }

    fn classify(
        &self,
        route: &ParsedRoute<'_>,
        request: &mut NormalizedRequest,
        attempt: &Attempt,
    ) -> RequestUse {
        let data = attempt.0.data.lock().unwrap();
        if let Some(span) = &data.span {
            request.session_key.clone_from(&span.session_id.0);
        }
        let purpose = self
            .classifier
            .classify(route, request, data.harness.as_deref());
        if data.span.is_none()
            && matches!(
                purpose,
                RequestUse::Compact(CompactKind::ResponsesTrigger | CompactKind::AnthropicNative)
            )
        {
            // Existing interactive scripts handle in-band compaction themselves.
            return RequestUse::Main;
        }
        purpose
    }

    fn check_parent(
        &self,
        req: &NormalizedRequest,
        attempt: &Attempt,
        legacy_baseline: Option<&str>,
    ) -> Result<Option<ResponseLineage>, Box<HttpErrorSpec>> {
        let Some(parent) = req
            .previous_response_id
            .as_ref()
            .filter(|_| req.protocol.is_responses())
        else {
            return Ok(None);
        };
        if let Some(owner) = attempt.owner() {
            return self
                .benchmark
                .read()
                .unwrap()
                .lineage
                .resolve_parent(&owner, &ResponseId(parent.clone()), attempt.connection_id())
                .cloned()
                .map(Some)
                .map_err(|_| {
                    Box::new(crate::schema_synth::previous_response_not_found_error(
                        req.protocol,
                        parent,
                    ))
                });
        }
        if !self.tuning.strict_previous_response_id
            || legacy_baseline == Some(parent)
            || self.stored_responses.contains(parent)
        {
            return Ok(None);
        }
        Err(Box::new(
            crate::schema_synth::previous_response_not_found_error(req.protocol, parent),
        ))
    }

    fn publish_response(
        &self,
        req: &NormalizedRequest,
        attempt: &Attempt,
        id: String,
        response: Value,
        store: bool,
        history: HistorySize,
    ) {
        if !req.protocol.is_responses() || !attempt.can_publish() {
            return;
        }
        let (owner, parent_id, revision) = {
            let data = attempt.0.data.lock().unwrap();
            let owner = data.span.as_ref().map(|span| span.session_id.clone());
            let parent_id = data.admitted_parent_id.clone();
            let revision = data
                .span
                .as_ref()
                .and_then(|span| span.revision.clone())
                .unwrap_or(Revision(0));
            (owner, parent_id, revision)
        };
        let size = store
            .then(|| self.stored_responses.admitted_size(&response))
            .flatten();
        let Some(owner) = owner else {
            if let Some(bytes) = size {
                attempt.record(|_| {
                    self.stored_responses
                        .insert_sized(None, id, response, bytes)
                });
            }
            return;
        };
        let id = ResponseId(id);
        let mut routing = self.benchmark.write().unwrap();
        if let Some(previous) = routing.lineage.owner(&id) {
            // A scenario retry can materialize the same logical response on a new connection.
            if previous != &owner {
                tracing::error!(response_id = %id, "response ID belongs to another session");
            } else if let Some(conn) = attempt.connection_id() {
                routing.lineage.observe_on_connection(conn, &id);
            }
            return;
        }
        let lineage = ResponseLineage {
            response_id: id.clone(),
            owner_session: owner.clone(),
            parent_id,
            logical_revision: revision,
            effective_context_tokens: history.tokens,
            effective_context_bytes: history.bytes,
            resumable: store,
            store_readable: store,
            created_on_conn: attempt.connection_id(),
        };
        if let Err(error) = routing.lineage.insert_admitted(lineage) {
            tracing::warn!(%error, "response lineage publication failed");
            return;
        }
        let retired = if let Some(bytes) = size {
            routing.responses.entry(owner).or_default().insert(
                id,
                response,
                bytes,
                self.control.stored_responses_capacity,
                self.control.stored_responses_max_bytes,
            )
        } else {
            Vec::new()
        };
        drop(routing);
        drop(retired);
    }

    fn dialect_for(&self, protocol: Protocol) -> ProviderDialectProfile {
        use ProviderDialectProfile::*;
        match protocol {
            Protocol::AnthropicMessages => AnthropicMessages,
            Protocol::OpenaiResponsesHttp | Protocol::OpenaiResponsesWs => OpenAiResponses,
            Protocol::OpenaiChatCompletions => self.dialect.unwrap_or(if self.strict_benchmark {
                StandardOpenAi
            } else {
                DeepSeekChat
            }),
        }
    }

    fn encoder(&self, req: &NormalizedRequest, id: String, model: String) -> Box<dyn WireEncoder> {
        let dialect = self.dialect_for(req.protocol);
        if !self.strict_benchmark && self.dialect.is_none() {
            let mut options = req.options.clone();
            if req.protocol == Protocol::OpenaiChatCompletions
                && req.raw_body.get("stream_options").is_none()
            {
                options.stream_include_usage = true;
            }
            if req.protocol.is_responses() && req.raw_body.get("include").is_none() {
                options.include.push("reasoning.encrypted_content".into());
            }
            return create_encoder_with_options(
                req.protocol,
                id,
                model,
                req.stream,
                &options,
                dialect,
            );
        }
        create_encoder_with_options(req.protocol, id, model, req.stream, &req.options, dialect)
    }

    async fn decide(
        &self,
        req: &NormalizedRequest,
        purpose: &RequestUse,
        profile: &RuntimeProfile,
        attempt: &Attempt,
        parent: Option<&ResponseLineage>,
    ) -> Result<TurnDecision, Box<HttpErrorSpec>> {
        if let RequestUse::Side(kind) = purpose {
            let summary = || self.compaction(req, None).summary;
            let text = match kind {
                SideKind::Title if req.protocol == Protocol::AnthropicMessages => {
                    r#"{"title":"Benchmark task"}"#.into()
                }
                SideKind::Title => "Benchmark task".into(),
                SideKind::Probe => "OK".into(),
                SideKind::SummaryAux => summary(),
                SideKind::Custom(name) => format!("Mock {name}"),
            };
            return Ok(TurnDecision::Plan(TurnPlan::text(text)));
        }
        if purpose == &RequestUse::Control {
            return Ok(TurnDecision::Plan(TurnPlan::text("OK")));
        }
        if let RequestUse::Compact(kind) = purpose {
            let output = self.compaction(req, Some(attempt));
            let mut plan = match kind {
                CompactKind::ClientSummary => {
                    attempt.0.data.lock().unwrap().summary_checkpoint = Some(output.id);
                    attempt.buffering(output.summary.len());
                    TurnPlan::text(output.summary)
                }
                _ => TurnPlan::new().push_compaction(output),
            };
            if let Some(scenario) = &self.scenario {
                scenario.configure_streaming(&mut plan);
            }
            return Ok(TurnDecision::Plan(plan));
        }
        if let Some(scenario) = &self.scenario {
            let evaluation = match parent {
                Some(parent) => scenario.evaluate_with_parent_revision(
                    &req.session_key,
                    req,
                    crate::scenario::Revision(parent.logical_revision.0 as usize),
                ),
                None => scenario.evaluate_normalized(&req.session_key, req),
            }
            .map_err(|err| {
                Box::new(match err {
                    crate::scenario::ScenarioError::UnknownParent(id) => {
                        crate::schema_synth::previous_response_not_found_error(req.protocol, &id)
                    }
                    _ => HttpErrorSpec::new(422, "scenario_request_error", err.to_string()),
                })
            })?;
            if let Some(checkpoint) = &evaluation.adopted_checkpoint_id {
                attempt.checkpoint_adopted(req, checkpoint, parent);
            }
            attempt.scenario(scenario, &evaluation);
            return Ok(TurnDecision::Plan(evaluation.plan));
        }
        if let Some(spec) = self
            .handler
            .reject_before_turn(req, profile.chaos_override.as_ref())
        {
            return Ok(TurnDecision::Plan(TurnPlan::http_error(spec)));
        }
        let mut session_turn = 0;
        if !attempt.record(|_| session_turn = self.sessions.next_turn(&req.session_key)) {
            return Err(Box::new(HttpErrorSpec::new(
                503,
                "server_error",
                "mock server was reset during admission",
            )));
        }
        let ctx = TurnContext {
            global_turn: req.sequence,
            session_turn,
            chaos_override: profile.chaos_override.clone(),
        };
        self.handler
            .handle_admitted(req, &ctx)
            .await
            .ok_or_else(|| {
                Box::new(HttpErrorSpec::new(
                    500,
                    "mock_handler_exhausted",
                    "no handler matched or scripted queue was exhausted",
                ))
            })
    }

    fn compaction(&self, req: &NormalizedRequest, attempt: Option<&Attempt>) -> CompactionOutput {
        if let Some((revision, output)) = self
            .scenario
            .as_ref()
            .and_then(|scenario| scenario.compaction_output(&req.session_key))
        {
            if let Some(attempt) = attempt {
                attempt.with_span(|span, _| span.revision = Some(Revision(revision.0 as u64)));
            }
            return output;
        }
        let id = format!("cmp_{}", req.sequence);
        let summary = match req.last_user_text() {
            Some(text) => format!(
                "Continue the task: {}",
                text.chars().take(160).collect::<String>()
            ),
            None => "Continue the benchmark task.".into(),
        };
        CompactionOutput {
            encrypted_content: format!("mock:{id}"),
            summary,
            id,
            signature: None,
            pause_after_compaction: req.protocol == Protocol::AnthropicMessages,
        }
    }
}

fn identity_error(error: IdentityError) -> Box<HttpErrorSpec> {
    let (status, code) = match error {
        IdentityError::Conflict { .. } => (400, "session_identity_conflict"),
        IdentityError::PrincipalMismatch(_) => (400, "session_principal_mismatch"),
        _ => (422, "session_unroutable"),
    };
    let mut spec = HttpErrorSpec::new(status, "invalid_request_error", error.to_string());
    spec.code = Some(code.into());
    Box::new(spec)
}

fn endpoint_protocol(endpoint: &EndpointKind) -> Option<Protocol> {
    match endpoint {
        EndpointKind::ChatCompletions => Some(Protocol::OpenaiChatCompletions),
        EndpointKind::AnthropicMessages | EndpointKind::AnthropicCountTokens => {
            Some(Protocol::AnthropicMessages)
        }
        EndpointKind::ResponsesCreate
        | EndpointKind::ResponsesCompact
        | EndpointKind::GetResponse(_)
        | EndpointKind::DeleteResponse(_) => Some(Protocol::OpenaiResponsesHttp),
        EndpointKind::ResponsesWs => Some(Protocol::OpenaiResponsesWs),
        _ => None,
    }
}

#[derive(Clone)]
struct Attempt(Arc<AttemptInner>);

struct AttemptInner {
    state: Arc<ServerState>,
    started: Instant,
    headers_ns: u64,
    generation: u64,
    protocol: Protocol,
    transport: Transport,
    data: Mutex<AttemptData>,
}

#[derive(Default)]
struct AttemptData {
    activity: Option<Arc<SessionActivity>>,
    span: Option<AttemptSpan>,
    harness: Option<String>,
    purpose: RequestPurpose,
    model: Option<String>,
    status: Option<u16>,
    outcome: AttemptOutcome,
    body_read_ns: Option<u64>,
    wire_bytes: usize,
    audit: Option<Arc<NormalizedRequest>>,
    compaction_before: Option<HistorySize>,
    compacted_bytes: Option<usize>,
    admitted_parent_id: Option<ResponseId>,
    summary_checkpoint: Option<String>,
    response_bytes: u64,
    first_delta_elapsed: Option<Duration>,
    usage: Usage,
    pacer_seed: Option<u64>,
}

impl Attempt {
    fn new(
        state: &Arc<ServerState>,
        protocol: Protocol,
        transport: Transport,
        started: Instant,
        headers_ns: u64,
    ) -> Self {
        Self(Arc::new(AttemptInner {
            state: state.clone(),
            started,
            headers_ns,
            generation: state.metrics.generation(),
            protocol,
            transport,
            data: Mutex::default(),
        }))
    }

    fn rejected_ws_message(&self, bytes: usize) -> Self {
        let state = &self.0.state;
        let rejection = Self::new(
            state,
            self.0.protocol,
            self.0.transport.clone(),
            Instant::now(),
            state.clock.elapsed_ns(),
        );
        let active = self.0.data.lock().unwrap();
        if let (Some(span), Some(activity)) = (&active.span, &active.activity) {
            let mut data = rejection.0.data.lock().unwrap();
            let mut rejected_span = AttemptSpan::new(
                span.run_id.clone(),
                span.session_id.clone(),
                span.protocol,
                span.transport.clone(),
                rejection.0.headers_ns.saturating_sub(activity.run_start_ns),
            );
            rejected_span.lane.clone_from(&span.lane);
            data.span = Some(rejected_span);
            data.activity = Some(activity.clone());
            activity.attempts.fetch_add(1, Ordering::Relaxed);
        }
        rejection.body_read(bytes);
        rejection.outcome(AttemptOutcome::Rejected, Some(400));
        rejection
    }

    fn attach(
        &self,
        registration: &crate::routing::SessionRegistration,
        activity: &Arc<SessionActivity>,
    ) {
        let mut data = self.0.data.lock().unwrap();
        if data.span.is_some() {
            return;
        }
        let mut span = AttemptSpan::new(
            registration.run_id.clone(),
            registration.session_id.clone(),
            self.0.protocol,
            self.0.transport.clone(),
            self.0.headers_ns.saturating_sub(activity.run_start_ns),
        );
        span.lane = Some(registration.logical_lane.clone());
        span.body_read_ns = data
            .body_read_ns
            .map(|time| time.saturating_sub(activity.run_start_ns));
        span.request_wire_bytes = data.wire_bytes as u64;
        activity.attempts.fetch_add(1, Ordering::Relaxed);
        data.activity = Some(activity.clone());
        data.harness = Some(registration.harness.clone());
        data.span = Some(span);
    }

    fn owner(&self) -> Option<SessionId> {
        self.0
            .data
            .lock()
            .unwrap()
            .span
            .as_ref()
            .map(|span| span.session_id.clone())
    }

    fn record(&self, record: impl FnOnce(&ServerMetrics)) -> bool {
        self.0
            .state
            .metrics
            .record_for_generation(self.0.generation, record)
    }

    fn connection_id(&self) -> Option<u64> {
        match self.0.transport {
            Transport::Http => None,
            Transport::WebSocket { connection_id, .. } => Some(connection_id),
        }
    }

    fn with_span(&self, update: impl FnOnce(&mut AttemptSpan, u64)) {
        let mut data = self.0.data.lock().unwrap();
        let start = data
            .activity
            .as_ref()
            .map_or(0, |activity| activity.run_start_ns);
        if let Some(span) = &mut data.span {
            update(span, self.0.state.clock.elapsed_ns().saturating_sub(start));
        }
    }

    fn body_read(&self, bytes: usize) {
        let mut data = self.0.data.lock().unwrap();
        let now = self.0.state.clock.elapsed_ns();
        data.body_read_ns = Some(now);
        data.wire_bytes = bytes;
        let start = data
            .activity
            .as_ref()
            .map_or(0, |activity| activity.run_start_ns);
        if let Some(span) = &mut data.span {
            span.body_read_ns = Some(now.saturating_sub(start));
            span.request_wire_bytes = bytes as u64;
        }
    }

    fn classified(&self, req: &NormalizedRequest, purpose: RequestPurpose) {
        let mut data = self.0.data.lock().unwrap();
        data.purpose = purpose;
        data.model = Some(req.model.clone());
        data.usage.input_tokens = req.estimated_input_tokens;
        let start = data
            .activity
            .as_ref()
            .map_or(0, |activity| activity.run_start_ns);
        if let Some(span) = &mut data.span {
            span.parsed_ns = Some(self.0.state.clock.elapsed_ns().saturating_sub(start));
            span.parent_response_id = req.previous_response_id.clone().map(ResponseId);
            span.effective_context_bytes = req.size_breakdown.history_bytes as u64;
        }
    }

    fn admitted(&self, parent: Option<&ResponseLineage>) {
        let mut data = self.0.data.lock().unwrap();
        data.admitted_parent_id = parent.map(|parent| parent.response_id.clone());
        let start = data
            .activity
            .as_ref()
            .map_or(0, |activity| activity.run_start_ns);
        let warmup = data.purpose == RequestPurpose::Warmup;
        if let Some(span) = &mut data.span {
            span.admitted_ns = Some(self.0.state.clock.elapsed_ns().saturating_sub(start));
            if let Some(parent) = parent {
                span.effective_context_bytes += parent.effective_context_bytes as u64;
                if warmup {
                    span.revision = Some(parent.logical_revision.clone());
                }
            }
        }
    }

    fn ready(&self, id: Option<&str>) {
        self.with_span(|span, now| {
            span.plan_ready_ns.get_or_insert(now);
            if let Some(id) = id {
                span.response_id = Some(ResponseId(id.into()));
            }
        });
    }

    fn scenario(
        &self,
        scenario: &ScenarioEngine,
        evaluation: &crate::scenario::ScenarioEvaluation,
    ) {
        let mut data = self.0.data.lock().unwrap();
        let step = &scenario.spec().steps[evaluation.decision.recipe.step_index()].id;
        if let Some(span) = &mut data.span {
            span.confirmed_call_ids = evaluation
                .confirmed_call_ids
                .iter()
                .cloned()
                .map(crate::routing::CallId)
                .collect();
            if let Some(fault) = evaluation.fault {
                span.fault_id = Some(format!("{step}/{}:{fault:?}", evaluation.attempt));
            }
            span.step_id = Some(crate::routing::StepId(step.clone()));
            span.revision = Some(Revision(evaluation.decision.revision.0 as u64));
            span.attempt = Some(crate::routing::AttemptId(u64::from(evaluation.attempt)));
            if evaluation.replayed {
                span.retry_reason = Some("scenario_replay".into());
            }
        }
        if let Some(lane) = data.span.as_ref().and_then(|span| span.lane.as_ref()) {
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            scenario.spec().seed.hash(&mut hash);
            lane.hash(&mut hash);
            step.hash(&mut hash);
            evaluation.attempt.hash(&mut hash);
            data.pacer_seed = Some(hash.finish());
        }
    }

    fn seed(&self, req: &NormalizedRequest) -> u64 {
        self.0
            .data
            .lock()
            .unwrap()
            .pacer_seed
            .unwrap_or_else(|| pacer_seed_for(req))
    }

    fn usage(&self, usage: Usage) {
        self.0.data.lock().unwrap().usage = usage;
    }

    fn outcome(&self, outcome: AttemptOutcome, status: Option<u16>) {
        let mut data = self.0.data.lock().unwrap();
        data.outcome = outcome;
        data.status = status.or(data.status);
    }

    fn frame(&self, bytes: usize, semantic: bool) {
        let mut data = self.0.data.lock().unwrap();
        data.response_bytes += bytes as u64;
        if semantic && data.first_delta_elapsed.is_none() {
            data.first_delta_elapsed = Some(self.0.started.elapsed());
        }
        let start = data
            .activity
            .as_ref()
            .map_or(0, |activity| activity.run_start_ns);
        if let Some(span) = &mut data.span {
            let now = self.0.state.clock.elapsed_ns().saturating_sub(start);
            span.first_byte_ns.get_or_insert(now);
            if semantic {
                span.first_semantic_delta_ns.get_or_insert(now);
            }
            span.last_frame_consumed_ns = Some(now);
            span.response_wire_bytes += bytes as u64;
        }
    }

    fn buffering(&self, bytes: usize) {
        self.0.data.lock().unwrap().compacted_bytes = Some(bytes);
    }

    fn sleep_recorded(&self, requested: Duration, elapsed: Duration) {
        self.with_span(|span, _| {
            span.simulated_delay_ns += requested.as_nanos() as u64;
            span.actual_sleep_ns += elapsed.as_nanos() as u64;
        });
    }

    fn audit(&self, req: Arc<NormalizedRequest>, purpose: &RequestUse, before: HistorySize) {
        let state = &self.0.state;
        state
            .metrics
            .record_for_generation(self.0.generation, |_| match purpose {
                RequestUse::Main => {
                    state.watchdog.inspect_request(&req);
                    self.0.data.lock().unwrap().audit = Some(req);
                }
                RequestUse::Compact(_) => {
                    state.watchdog.on_compaction_requested(&req, before);
                    self.0.data.lock().unwrap().compaction_before = Some(before);
                }
                _ => {}
            });
    }

    fn call(&self, id: &str, delivered: bool) {
        self.0
            .state
            .metrics
            .record_for_generation(self.0.generation, |_| {
                let data = self.0.data.lock().unwrap();
                if let Some(req) = &data.audit {
                    if delivered {
                        self.0.state.watchdog.on_call_delivered_complete(req, id);
                    } else {
                        self.0.state.watchdog.on_call_issued(req, id);
                    }
                }
            });
    }

    fn compaction(&self, id: String) {
        self.with_span(|span, _| span.checkpoint_id = Some(id));
    }

    fn checkpoint_adopted(
        &self,
        req: &NormalizedRequest,
        id: &str,
        parent: Option<&ResponseLineage>,
    ) {
        let after = parent
            .filter(|parent| parent.response_id.0.starts_with("resp_compact_"))
            .map(|parent| HistorySize {
                bytes: parent.effective_context_bytes,
                tokens: parent.effective_context_tokens,
            });
        self.record(|_| self.0.state.watchdog.on_compaction_adopted(req, id, after));
        self.with_span(|span, _| span.adopted_checkpoint_id = Some(id.into()));
    }

    fn compaction_delivered(&self, req: &NormalizedRequest, id: &str) {
        let before = self.0.data.lock().unwrap().compaction_before;
        self.0
            .state
            .metrics
            .record_for_generation(self.0.generation, |_| {
                let watchdog = &self.0.state.watchdog;
                if self.owner().is_some() {
                    watchdog.on_compaction_issued(
                        req,
                        id,
                        before.unwrap_or_else(|| HistorySize::from_request(req)),
                    );
                } else {
                    watchdog.record_turn_outcome(req, &[], true, true);
                }
            });
        self.compaction(id.into());
    }
}

impl Drop for AttemptInner {
    fn drop(&mut self) {
        let data = self.data.get_mut().unwrap();
        let outcome = match data.outcome {
            AttemptOutcome::Unclassified if self.state.shutdown.is_cancelled() => {
                AttemptOutcome::ServerShutdown
            }
            AttemptOutcome::Unclassified => AttemptOutcome::ClientDisconnected,
            outcome => outcome,
        };
        let duration_ms = self.started.elapsed().as_millis() as u64;
        let ttft_ms = data
            .first_delta_elapsed
            .map(|elapsed| elapsed.as_millis() as u64);
        self.state
            .metrics
            .record_for_generation(self.generation, |metrics| {
                metrics
                    .bytes_sent
                    .fetch_add(data.response_bytes, Ordering::Relaxed);
                if let Some(ttft) = ttft_ms {
                    metrics.ttft_ms.record(ttft);
                }
                if let Some(req) = &data.audit {
                    if matches!(outcome, AttemptOutcome::ClientDisconnected) {
                        metrics.abandoned_streams.fetch_add(1, Ordering::Relaxed);
                    }
                    let reason = match outcome {
                        AttemptOutcome::Completed => StreamCloseReason::Completed,
                        AttemptOutcome::InjectedFault => StreamCloseReason::InjectedFault,
                        AttemptOutcome::ServerShutdown => StreamCloseReason::ServerShutdown,
                        AttemptOutcome::ClientDisconnected => StreamCloseReason::ClientDisconnected,
                        _ => StreamCloseReason::InjectedFault,
                    };
                    self.state.watchdog.on_stream_closed(req, reason);
                }
                if let Some(model) = &data.model {
                    metrics.turn_duration_ms.record(duration_ms);
                    if let Some(first) = data.first_delta_elapsed
                        && data.usage.output_tokens > 0
                    {
                        let seconds = self
                            .started
                            .elapsed()
                            .saturating_sub(first)
                            .as_secs_f64()
                            .max(0.001);
                        metrics.effective_tps.record(
                            (data.usage.output_tokens as f64 / seconds).round().max(1.0) as u64,
                        );
                    }
                    metrics.record_dimension_with_labels(
                        self.protocol,
                        model,
                        data.status,
                        data.purpose,
                        outcome,
                        data.usage.input_tokens,
                        data.usage.output_tokens,
                        data.usage.cache_read_tokens.unwrap_or(0),
                        ttft_ms,
                        Some(duration_ms),
                    );
                }
            });
        if let (Some(mut span), Some(activity)) = (data.span.take(), data.activity.take()) {
            span.outcome = outcome;
            span.purpose = data.purpose;
            let finished = self
                .state
                .clock
                .elapsed_ns()
                .saturating_sub(activity.run_start_ns);
            span.finished_ns = Some(finished);
            if span.connection_id.is_some() && span.first_byte_ns.is_some() {
                span.body_dropped_ns.get_or_insert(finished);
            }
            span.input_tokens = data.usage.input_tokens;
            span.output_tokens = data.usage.output_tokens;
            span.cache_read_tokens = data.usage.cache_read_tokens.unwrap_or(0);
            span.cache_creation_tokens = data.usage.cache_creation_tokens.unwrap_or(0);
            span.reasoning_tokens = data.usage.reasoning_tokens.unwrap_or(0);
            if let Err(error) = self.state.telemetry.record(span) {
                tracing::error!(%error, "could not record benchmark attempt");
            }
            activity.attempts.fetch_sub(1, Ordering::Release);
        }
    }
}

fn effective_history(req: &NormalizedRequest, parent: Option<&ResponseLineage>) -> HistorySize {
    let mut history = HistorySize::from_request(req);
    if let Some(parent) = parent {
        history.bytes = history.bytes.saturating_add(parent.effective_context_bytes);
        history.tokens = history
            .tokens
            .saturating_add(parent.effective_context_tokens);
    }
    history
}

fn turn_pacer(
    req: &NormalizedRequest,
    plan: &TurnPlan,
    usage: &Usage,
    attempt: &Attempt,
    profile: LatencyProfile,
    in_flight: usize,
) -> crate::pacing::TurnPacer {
    let mut pacer = crate::pacing::TurnPacer::new(
        profile,
        attempt.seed(req),
        in_flight,
        plan.ttft_ms,
        (plan.chunk_delay_ms > 0).then_some(plan.chunk_delay_ms),
    );
    let cached = usage.cache_read_tokens.unwrap_or(0);
    pacer.compute_ttft(usage.input_tokens.saturating_sub(cached), cached);
    pacer
}

#[derive(Clone)]
enum DeliveredItem {
    Tool(String),
    Compaction { id: String, bytes: usize },
}

impl DeliveredItem {
    fn from_event(event: &TurnEvent) -> Option<Self> {
        match event {
            TurnEvent::ToolCall(call) => Some(Self::Tool(call.id.clone())),
            TurnEvent::NativeCompaction(output) => Some(Self::Compaction {
                id: output.id.clone(),
                bytes: output.summary.len().max(output.encrypted_content.len()),
            }),
            _ => None,
        }
    }

    fn issued(&self, attempt: &Attempt) {
        if let Self::Tool(id) = self {
            attempt.call(id, false);
        }
    }

    fn deliver(self, attempt: &Attempt, req: &NormalizedRequest) {
        match self {
            Self::Tool(id) => attempt.call(&id, true),
            Self::Compaction { mut id, bytes } => {
                attempt.record(|metrics| {
                    metrics
                        .native_compactions_emitted
                        .fetch_add(1, Ordering::Relaxed);
                });
                if id.is_empty() {
                    id = format!("cmp_{}", req.sequence);
                }
                attempt.compaction_delivered(req, &id);
                attempt.0.data.lock().unwrap().compacted_bytes = Some(bytes);
            }
        }
    }
}

impl Attempt {
    #[cfg(feature = "proxy")]
    fn lane(&self) -> Option<crate::routing::LogicalLane> {
        self.0
            .data
            .lock()
            .unwrap()
            .span
            .as_ref()
            .and_then(|span| span.lane.clone())
    }

    #[cfg(feature = "proxy")]
    fn replay_lane(
        &self,
        headers: &BTreeMap<String, String>,
    ) -> Option<crate::routing::LogicalLane> {
        self.lane().or_else(|| {
            headers
                .get(crate::proxy::SCOPE_LANE_HEADER)
                .cloned()
                .map(crate::routing::LogicalLane)
        })
    }

    fn can_publish(&self) -> bool {
        matches!(
            self.0.data.lock().unwrap().purpose,
            RequestPurpose::Main | RequestPurpose::Compact | RequestPurpose::Warmup
        )
    }

    fn has_summary(&self) -> bool {
        self.0.data.lock().unwrap().summary_checkpoint.is_some()
    }

    fn deliver_summary(&self, req: &NormalizedRequest) {
        let checkpoint = self.0.data.lock().unwrap().summary_checkpoint.take();
        if let Some(id) = checkpoint {
            self.compaction_delivered(req, &id);
        }
    }

    fn http_status(&self, status: u16) {
        let mut data = self.0.data.lock().unwrap();
        data.status.get_or_insert(status);
        if data.outcome == AttemptOutcome::Unclassified {
            data.outcome = match status {
                101 => AttemptOutcome::Completed,
                429 => AttemptOutcome::RateLimited,
                503 if self.0.state.shutdown.is_cancelled() => AttemptOutcome::ServerShutdown,
                400..=599 => AttemptOutcome::Rejected,
                _ => return,
            };
        }
    }

    fn body_completed(&self) {
        let mut data = self.0.data.lock().unwrap();
        if data.outcome == AttemptOutcome::Unclassified {
            data.outcome = AttemptOutcome::Completed;
        }
    }

    fn expects_semantic_body(&self) -> bool {
        let data = self.0.data.lock().unwrap();
        data.status == Some(200)
            && matches!(
                data.purpose,
                RequestPurpose::Main
                    | RequestPurpose::Title
                    | RequestPurpose::Probe
                    | RequestPurpose::SummaryAux
                    | RequestPurpose::Side
                    | RequestPurpose::Compact
            )
    }

    fn response_history(&self, mut history: HistorySize, output: usize) -> HistorySize {
        if let Some(compacted) = self.0.data.lock().unwrap().compacted_bytes {
            return HistorySize {
                bytes: compacted,
                tokens: (compacted as u64).div_ceil(4),
            };
        }
        history.bytes = history.bytes.saturating_add(output);
        history.tokens = history.tokens.saturating_add((output as u64).div_ceil(4));
        history
    }

    fn backpressure(&self, elapsed: Duration) {
        self.with_span(|span, _| span.backpressure_wait_ns += elapsed.as_nanos() as u64);
    }

    async fn wait(&self, delay: Duration, closed: impl Future<Output = ()>) -> bool {
        self.wait_until(tokio::time::Instant::now() + delay, closed)
            .await
    }

    async fn wait_until(
        &self,
        deadline: tokio::time::Instant,
        closed: impl Future<Output = ()>,
    ) -> bool {
        let now = tokio::time::Instant::now();
        if deadline <= now {
            return !self.0.state.shutdown.is_cancelled();
        }
        let started = Instant::now();
        let completed = tokio::select! {
            _ = self.0.state.shutdown.cancelled() => false,
            _ = closed => false,
            _ = tokio::time::sleep_until(deadline) => true,
        };
        self.sleep_recorded(deadline - now, started.elapsed());
        completed
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

struct BgTaskGuard(Arc<ServerState>);

impl Drop for BgTaskGuard {
    fn drop(&mut self) {
        if self.0.active_bg_tasks.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.bg_tasks_drained.notify_waiters();
        }
    }
}

/// Spawn a background task whose panics are captured onto `ServerState` and whose
/// lifetime is awaited before `shutdown()` / `shutdown_taking_panics()` collects panics.
pub(super) fn spawn_tracked<F>(state: Arc<ServerState>, fut: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    state.active_bg_tasks.fetch_add(1, Ordering::AcqRel);
    tokio::spawn(async move {
        let _bg_guard = BgTaskGuard(state.clone());
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
        assert!(
            self.state.reset(),
            "export and delete benchmark sessions before resetting"
        );
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
        self.state.watchdog.clear_violations();
    }

    pub fn render_prometheus(&self) -> String {
        self.state.render_prometheus()
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.state.shutdown.clone()
    }

    /// Shut down the server, wait for all connection tasks and SSE writers to drain,
    /// and return any recorded handler/task panics without panicking during teardown.
    pub async fn shutdown_taking_panics(mut self) -> Vec<String> {
        self.state.shutdown.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        // Connections are now fully drained so no new background writers can be spawned;
        // wait for every in-flight writer (and its panic capture) to finish before reading panics.
        loop {
            let notified = self.state.bg_tasks_drained.notified();
            if self.state.active_bg_tasks.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
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
    scenario: Option<ScenarioSpec>,
    scenario_streaming: (usize, WirePoisonConfig),
    strict_benchmark: bool,
    dialect: Option<ProviderDialectProfile>,
    classifier: RequestClassifier,
    has_workload: bool,
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
            scenario: None,
            scenario_streaming: (0, WirePoisonConfig::default()),
            strict_benchmark: false,
            dialect: None,
            classifier: RequestClassifier::default(),
            has_workload: false,
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

    pub fn workload(mut self, config: crate::workload::WorkloadConfig) -> Self {
        self.has_workload = true;
        self.handler(Arc::new(crate::workload::WorkloadGenerator::new(config)))
    }

    #[cfg(feature = "rules")]
    pub(crate) fn with_workload_flag(mut self, has_workload: bool) -> Self {
        self.has_workload = has_workload;
        self
    }

    pub fn scenario(mut self, spec: ScenarioSpec) -> Self {
        self.scenario = Some(spec);
        self
    }

    /// Configure chunking and wire framing for scenario responses.
    pub fn scenario_streaming(mut self, chunk_chars: usize, poison: WirePoisonConfig) -> Self {
        self.scenario_streaming = (chunk_chars, poison);
        self
    }

    pub fn strict_benchmark(mut self, enabled: bool) -> Self {
        self.strict_benchmark = enabled;
        self
    }

    pub fn provider_dialect(mut self, dialect: ProviderDialectProfile) -> Self {
        self.dialect = Some(dialect);
        self
    }

    pub fn request_classifier(mut self, classifier: RequestClassifier) -> Self {
        self.classifier = classifier;
        self
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
        if self.scenario.is_some() && self.has_workload {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "scenario and workload are mutually exclusive",
            ));
        }
        #[cfg(feature = "proxy")]
        if self.scenario.is_some()
            && (self.proxy_recorder.is_some() || self.cassette_replayer.is_some())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "scenario cannot be combined with proxy or replay",
            ));
        }
        let strict_benchmark = self.strict_benchmark || self.scenario.is_some();
        let (chunk_chars, wire_poison) = self.scenario_streaming;
        let scenario = self
            .scenario
            .map(|spec| {
                ScenarioEngine::new(spec, "mock-ai")
                    .map(|engine| engine.with_streaming(chunk_chars, wire_poison))
            })
            .transpose()
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
        if strict_benchmark {
            self.control.enable_admin_api = true;
        }
        let telemetry =
            SessionTelemetryStore::new(self.tuning.max_tracked_sessions, 4096, 8 * 1024 * 1024);
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
            active_bg_tasks: AtomicUsize::new(0),
            bg_tasks_drained: Notify::new(),
            next_seq: AtomicU64::new(0),
            next_conn_id: AtomicU64::new(0),
            shutdown: CancellationToken::new(),
            benchmark: RwLock::default(),
            classifier: self.classifier,
            telemetry,
            scenario,
            strict_benchmark,
            dialect: self.dialect,
            clock: RunClock::default(),
            unknown_routes: AtomicU64::new(0),
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

pub(super) struct TurnCloseGuard {
    _primary: crate::handler::CloseSignalGuard,
    secondary: crate::handler::CloseSignalGuard,
}

impl TurnCloseGuard {
    pub(super) fn new(primary: crate::handler::CloseSignalGuard) -> Self {
        Self {
            _primary: primary,
            secondary: crate::handler::CloseSignalGuard(None),
        }
    }

    pub(super) fn attach(&mut self, secondary: crate::handler::CloseSignalGuard) {
        self.secondary = secondary;
    }
}

pub(super) struct PendingWsUpgrade {
    pub on_upgrade: hyper::upgrade::OnUpgrade,
    pub path: String,
    pub scope: Option<RouteScope>,
    pub canonical_offset: usize,
    pub query: Option<String>,
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
                    upgrade.scope,
                    upgrade.canonical_offset,
                    upgrade.query,
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

fn error_http_response(
    protocol: Protocol,
    spec: &HttpErrorSpec,
    attempt: &Attempt,
) -> Response<BoxBody> {
    let state = &attempt.0.state;
    attempt.record(|metrics| {
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
    });
    let (content_type, bytes) = if let Some(raw_text) = &spec.raw_text {
        (
            spec.content_type.as_deref().unwrap_or("text/plain"),
            Bytes::from(raw_text.clone()),
        )
    } else {
        let body = format_http_error_body_for_profile(state.dialect_for(protocol), spec);
        (
            spec.content_type.as_deref().unwrap_or("application/json"),
            Bytes::from(body.to_string()),
        )
    };
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
    body: BoxBody,
    extra_headers: &BTreeMap<String, String>,
    close_connection: bool,
) -> Response<BoxBody> {
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
    builder.body(body).unwrap()
}

pub(super) fn json_with_headers(
    value: &Value,
    extra_headers: &BTreeMap<String, String>,
    close_connection: bool,
) -> Response<BoxBody> {
    let bytes = Bytes::from(value.to_string());
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

pub(super) struct FlushStatus {
    pub all_wire_frames_sent: bool,
    pub continued: bool,
}

pub(super) fn pacer_seed_for(req: &NormalizedRequest) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    req.session_key.hash(&mut h);
    req.sequence.hash(&mut h);
    h.finish()
}

fn event_usage(event: &TurnEvent) -> Option<&Usage> {
    match event {
        TurnEvent::Usage(usage) => Some(usage),
        TurnEvent::UsageWithIterations(usage) => Some(&usage.totals),
        _ => None,
    }
}

fn initial_usage(events: &[TurnEvent], req: &NormalizedRequest) -> TurnEvent {
    events
        .iter()
        .find(|event| event_usage(event).is_some())
        .cloned()
        .unwrap_or_else(|| TurnEvent::Usage(Usage::new(req.estimated_input_tokens.max(1), 0)))
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
