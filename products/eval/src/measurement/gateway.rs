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

//! Local loopback HTTP metering and admission gateway for Maka Host and external subjects.
//!
//! Binds `127.0.0.1:0`, authenticates per-attempt `<GATEWAY_CREDENTIAL>`, forwards request
//! payloads untouched using the real provider credential, parses streaming SSE and JSON
//! usage/admission facts, writes atomic HMAC-signed checkpoints, and enforces a synchronous
//! `stop_accepting()` cutoff while draining in-flight requests.

use crate::contract::JsonObject;
use crate::measurement::{
    NormalizedUsage, ProviderMeteringCounts, constant_time_eq, sign_metering_checkpoint,
};
use crate::store::write_atomic_bytes;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use url::Url;

pub const PROVIDER_USAGE_CHECKPOINT_SCHEMA: &str = "maka.external_provider_usage.v2";

type BoxBody = http_body_util::combinators::BoxBody<Bytes, Infallible>;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObservedRequestMetadata {
    pub model: Option<String>,
    pub tool_names: Vec<String>,
}

/// Inspects an OpenAI or Anthropic JSON request payload to observe the requested model and
/// exposed tool names without mutating or re-serializing the request body.
pub fn inspect_request_body(body: &[u8]) -> ObservedRequestMetadata {
    if body.is_empty() {
        return ObservedRequestMetadata::default();
    }
    let Ok(Value::Object(obj)) = serde_json::from_slice::<Value>(body) else {
        return ObservedRequestMetadata::default();
    };
    let model = obj
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let tool_names = obj
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| tools.iter().flat_map(extract_tool_name).collect())
        .unwrap_or_default();
    ObservedRequestMetadata { model, tool_names }
}

fn extract_tool_name(tool: &Value) -> Vec<String> {
    let Some(obj) = tool.as_object() else {
        return Vec::new();
    };
    if let Some(name) = obj.get("name").and_then(Value::as_str) {
        return vec![name.to_owned()];
    }
    if let Some(name) = obj
        .get("function")
        .and_then(Value::as_object)
        .and_then(|f| f.get("name"))
        .and_then(Value::as_str)
    {
        return vec![name.to_owned()];
    }
    if let Some(t) = obj.get("type").and_then(Value::as_str) {
        return vec![t.to_owned()];
    }
    Vec::new()
}

/// Determines whether a parsed provider JSON/SSE event proves the upstream provider
/// admitted an inference call.
pub fn is_inference_admission_event(event: &Map<String, Value>) -> bool {
    let object = event.get("object").and_then(Value::as_str);
    if matches!(
        object,
        Some("chat.completion") | Some("chat.completion.chunk")
    ) {
        return true;
    }
    if let Some(event_type) = event.get("type").and_then(Value::as_str)
        && matches!(
            event_type,
            "response.created"
                | "response.in_progress"
                | "response.output_item.added"
                | "response.content_part.added"
                | "response.output_text.delta"
                | "response.reasoning_text.delta"
                | "response.function_call_arguments.delta"
                | "response.completed"
        )
    {
        return true;
    }
    object == Some("response")
        && event
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        && (event.get("output").is_some_and(Value::is_array)
            || event.get("usage").is_some_and(Value::is_object))
}

/// Extracts a 6-counter `NormalizedUsage` snapshot from an OpenAI-compatible event/response.
pub fn usage_from_event(event: &Map<String, Value>) -> Option<NormalizedUsage> {
    let response = if event.get("type").and_then(Value::as_str) == Some("response.completed") {
        event
            .get("response")
            .and_then(Value::as_object)
            .unwrap_or(event)
    } else {
        event
    };
    let raw = response
        .get("usage")
        .and_then(Value::as_object)
        .or_else(|| event.get("usage").and_then(Value::as_object))?;

    let input = json_u64(raw.get("input_tokens").or_else(|| raw.get("prompt_tokens")));
    let output = json_u64(
        raw.get("output_tokens")
            .or_else(|| raw.get("completion_tokens")),
    );
    let input_details = raw
        .get("input_tokens_details")
        .and_then(Value::as_object)
        .or_else(|| raw.get("prompt_tokens_details").and_then(Value::as_object));
    let output_details = raw
        .get("output_tokens_details")
        .and_then(Value::as_object)
        .or_else(|| {
            raw.get("completion_tokens_details")
                .and_then(Value::as_object)
        });

    let cache_read = json_u64(
        raw.get("cache_read_input_tokens")
            .or_else(|| raw.get("prompt_cache_hit_tokens"))
            .or_else(|| input_details.and_then(|d| d.get("cached_tokens"))),
    );
    let cache_write = json_u64(
        raw.get("cache_creation_input_tokens")
            .or_else(|| raw.get("cache_write_input_tokens"))
            .or_else(|| input_details.and_then(|d| d.get("cache_write_tokens")))
            .or_else(|| input_details.and_then(|d| d.get("cache_creation_tokens"))),
    );
    let reasoning = json_u64(output_details.and_then(|d| d.get("reasoning_tokens")));
    let reported_total = json_u64(raw.get("total_tokens"));
    let total_tokens = if reported_total > 0 {
        reported_total
    } else {
        input.saturating_add(output)
    };
    Some(NormalizedUsage {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        reasoning_tokens: reasoning,
        total_tokens,
    })
}

fn json_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn merge_stream_usage(
    left: Option<NormalizedUsage>,
    right: Option<NormalizedUsage>,
) -> Option<NormalizedUsage> {
    match (left, right) {
        (None, r) => r,
        (l, None) => l,
        (Some(l), Some(r)) => Some(NormalizedUsage {
            input_tokens: l.input_tokens.max(r.input_tokens),
            output_tokens: l.output_tokens.max(r.output_tokens),
            cache_read_tokens: l.cache_read_tokens.max(r.cache_read_tokens),
            cache_write_tokens: l.cache_write_tokens.max(r.cache_write_tokens),
            reasoning_tokens: l.reasoning_tokens.max(r.reasoning_tokens),
            total_tokens: l.total_tokens.max(r.total_tokens),
        }),
    }
}

/// Incremental SSE / JSON response parser for a single model request.
#[derive(Debug, Default)]
pub struct UsageStreamParser {
    buffered: String,
    full_text: String,
    current: Option<NormalizedUsage>,
    admitted: bool,
}

impl UsageStreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, text: &str) {
        self.buffered.push_str(text);
        if self.full_text.len() < 512 * 1024 {
            self.full_text.push_str(text);
        }
        while let Some(newline) = self.buffered.find('\n') {
            let line = self.buffered[..newline].to_owned();
            self.buffered.drain(..=newline);
            self.consume_line(&line);
        }
    }

    pub fn admitted(&self) -> bool {
        self.admitted
    }

    pub fn finish(&mut self) -> (Option<NormalizedUsage>, bool) {
        if !self.buffered.trim().is_empty() {
            let tail = std::mem::take(&mut self.buffered);
            self.consume_line(&tail);
        }
        if !self.admitted
            && !self.full_text.trim().is_empty()
            && let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(self.full_text.trim())
        {
            self.admitted |= is_inference_admission_event(&obj);
            self.current = merge_stream_usage(self.current.take(), usage_from_event(&obj));
        }
        (self.current.clone(), self.admitted)
    }

    fn consume_line(&mut self, line: &str) {
        let trimmed = line.trim();
        let raw = trimmed
            .strip_prefix("data:")
            .map(str::trim_start)
            .unwrap_or(trimmed);
        if raw.is_empty() || raw == "[DONE]" {
            return;
        }
        let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(raw) else {
            return;
        };
        self.admitted |= is_inference_admission_event(&obj);
        self.current = merge_stream_usage(self.current.take(), usage_from_event(&obj));
    }
}

pub fn join_upstream_url(base_url: &str, request_uri: &str) -> Result<String, String> {
    let mut base = Url::parse(base_url).map_err(|e| format!("invalid upstream baseUrl: {e}"))?;
    let req_url = Url::parse(&format!(
        "http://maka-eval.local/{}",
        request_uri.trim_start_matches('/')
    ))
    .map_err(|e| format!("invalid request URI: {e}"))?;
    let base_path = base.path().trim_end_matches('/');
    let req_path = req_url.path().trim_start_matches('/');
    // Avoid duplicating path prefixes (such as `/v1` or `/api/v1`) when `base_url`
    // already carries that prefix and the client sends the full prefixed path.
    let combined_path = if !base_path.is_empty()
        && (req_url.path() == base_path || req_url.path().starts_with(&format!("{base_path}/")))
    {
        req_url.path().to_owned()
    } else if req_path.is_empty() {
        base_path.to_owned()
    } else {
        format!("{base_path}/{req_path}")
    };
    base.set_path(&combined_path);
    base.set_query(req_url.query());
    Ok(base.to_string())
}

fn rewrite_url_origin(target_url: &str, origin_override: &str) -> Result<String, String> {
    let target = Url::parse(target_url).map_err(|e| format!("invalid target URL: {e}"))?;
    let mut dest =
        Url::parse(origin_override).map_err(|e| format!("invalid origin override: {e}"))?;
    dest.set_path(target.path());
    dest.set_query(target.query());
    dest.set_fragment(None);
    Ok(dest.to_string())
}

pub const UPSTREAM_TARGET_HEADER: &str = "x-maka-eval-upstream-target";

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub upstream_base_url: String,
    pub transport_origin_override: Option<String>,
    pub upstream_api_key: String,
    pub profile: String,
    pub gateway_credential: String,
    pub checkpoint_path: Option<PathBuf>,
    pub checkpoint_secret: String,
}

#[derive(Debug, Default)]
struct GatewayCounters {
    total_usage: NormalizedUsage,
    requests: u64,
    in_flight_requests: u64,
    admitted_requests: u64,
    usage_requests: u64,
    settled: bool,
    models: BTreeSet<String>,
    tool_names: BTreeSet<String>,
}

impl GatewayCounters {
    fn snapshot(&self) -> ProviderMeteringCounts {
        ProviderMeteringCounts {
            usage: if self.usage_requests > 0 {
                Some(self.total_usage.clone())
            } else {
                None
            },
            settled: self.settled,
            requests: self.requests,
            in_flight_requests: self.in_flight_requests,
            admitted_requests: self.admitted_requests,
            usage_requests: self.usage_requests,
            models: self.models.iter().cloned().collect(),
            tool_names: self.tool_names.iter().cloned().collect(),
        }
    }
}

struct SharedGatewayState {
    config: GatewayConfig,
    client: reqwest::Client,
    accepting: AtomicBool,
    counters: Mutex<GatewayCounters>,
    checkpoint_lock: Mutex<()>,
    in_flight_zero: Notify,
}

impl SharedGatewayState {
    async fn persist_checkpoint(&self) {
        let Some(path) = &self.config.checkpoint_path else {
            return;
        };
        let _guard = self.checkpoint_lock.lock().await;
        let snap = self.counters.lock().await.snapshot();
        let Ok(Value::Object(mut body)) = serde_json::to_value(&snap) else {
            return;
        };
        body.insert(
            "schemaVersion".into(),
            Value::String(PROVIDER_USAGE_CHECKPOINT_SCHEMA.into()),
        );
        body.insert("profile".into(), Value::String(self.config.profile.clone()));
        let signed: JsonObject = sign_metering_checkpoint(&body, &self.config.checkpoint_secret);
        if let Ok(mut bytes) = serde_json::to_vec(&Value::Object(signed)) {
            bytes.push(b'\n');
            let _ = write_atomic_bytes(path, &bytes);
        }
    }

    fn is_authorized(&self, req: &Request<Incoming>) -> bool {
        let expected = self.config.gateway_credential.as_bytes();
        if expected.is_empty() {
            return true;
        }
        if let Some(auth) = req
            .headers()
            .get(hyper::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            && let Some(token) = auth.strip_prefix("Bearer ").map(str::trim)
            && constant_time_eq(token.as_bytes(), expected)
        {
            return true;
        }
        if let Some(api_key) = req.headers().get("x-api-key").and_then(|v| v.to_str().ok())
            && constant_time_eq(api_key.trim().as_bytes(), expected)
        {
            return true;
        }
        false
    }
}

/// Running local HTTP Eval Metering Gateway.
pub struct EvalMeteringGateway {
    addr: SocketAddr,
    gateway_credential: String,
    state: Arc<SharedGatewayState>,
    shutdown: CancellationToken,
    worker: Option<JoinHandle<()>>,
}

impl EvalMeteringGateway {
    pub async fn start(config: GatewayConfig) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|e| format!("failed to build gateway HTTP client: {e}"))?;

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("failed to bind metering gateway on 127.0.0.1:0: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("failed to read metering gateway local addr: {e}"))?;
        let gateway_credential = config.gateway_credential.clone();

        let state = Arc::new(SharedGatewayState {
            config,
            client,
            accepting: AtomicBool::new(true),
            counters: Mutex::new(GatewayCounters::default()),
            checkpoint_lock: Mutex::new(()),
            in_flight_zero: Notify::new(),
        });
        state.persist_checkpoint().await;

        let shutdown = CancellationToken::new();
        let worker_shutdown = shutdown.clone();
        let worker_state = state.clone();
        let worker = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = worker_shutdown.cancelled() => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else {
                            break;
                        };
                        let conn_state = worker_state.clone();
                        tokio::spawn(async move {
                            let service = service_fn(move |req: Request<Incoming>| {
                                handle_gateway_request(conn_state.clone(), req)
                            });
                            let _ = http1::Builder::new()
                                .serve_connection(TokioIo::new(stream), service)
                                .await;
                        });
                    }
                }
            }
        });

        Ok(Self {
            addr,
            gateway_credential,
            state,
            shutdown,
            worker: Some(worker),
        })
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    pub fn openai_v1_base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.addr.port())
    }

    /// Returns a loopback URL whose path matches `upstream_base_url` so provider route
    /// normalization in Maka sees the exact same path structure as the upstream endpoint.
    pub fn base_url_matching_upstream(&self, upstream_base_url: &str) -> String {
        let suffix = Url::parse(upstream_base_url)
            .ok()
            .map(|u| u.path().trim_end_matches('/').to_owned())
            .unwrap_or_else(|| "/v1".to_owned());
        format!("http://127.0.0.1:{}{}", self.addr.port(), suffix)
    }

    pub fn gateway_credential(&self) -> &str {
        &self.gateway_credential
    }

    /// Synchronously closes the admission window so any subsequent request receives HTTP 503
    /// without being forwarded or counted.
    pub fn stop_accepting(&self) {
        self.state.accepting.store(false, Ordering::SeqCst);
    }

    /// Closes admission, waits for all already-accepted in-flight requests to finish draining,
    /// marks the snapshot as `settled = true`, writes the final signed checkpoint, and returns
    /// the settled `ProviderMeteringCounts`.
    pub async fn report(&self) -> ProviderMeteringCounts {
        self.stop_accepting();
        loop {
            let notified = self.state.in_flight_zero.notified();
            {
                let mut counters = self.state.counters.lock().await;
                if counters.in_flight_requests == 0 {
                    counters.settled = true;
                    break;
                }
            }
            notified.await;
        }
        self.state.persist_checkpoint().await;
        self.state.counters.lock().await.snapshot()
    }

    pub async fn close(mut self) -> ProviderMeteringCounts {
        let counts = self.report().await;
        self.shutdown.cancel();
        if let Some(worker) = self.worker.take() {
            let _ = worker.await;
        }
        counts
    }
}

impl Drop for EvalMeteringGateway {
    fn drop(&mut self) {
        self.state.accepting.store(false, Ordering::SeqCst);
        self.shutdown.cancel();
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
    }
}

fn json_error_response(status: StatusCode, message: &str) -> Response<BoxBody> {
    let payload = serde_json::to_vec(&json!({ "error": message })).unwrap_or_default();
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(payload)).boxed())
        .unwrap()
}

async fn finish_in_flight(state: &SharedGatewayState) {
    let became_zero = {
        let mut counters = state.counters.lock().await;
        counters.in_flight_requests = counters.in_flight_requests.saturating_sub(1);
        counters.in_flight_requests == 0
    };
    state.persist_checkpoint().await;
    if became_zero {
        state.in_flight_zero.notify_waiters();
    }
}

async fn handle_gateway_request(
    state: Arc<SharedGatewayState>,
    req: Request<Incoming>,
) -> Result<Response<BoxBody>, Infallible> {
    if !state.accepting.load(Ordering::SeqCst) {
        return Ok(json_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider proxy has settled",
        ));
    }
    if !state.is_authorized(&req) {
        return Ok(json_error_response(
            StatusCode::UNAUTHORIZED,
            "invalid eval gateway credential",
        ));
    }

    {
        let mut counters = state.counters.lock().await;
        if !state.accepting.load(Ordering::SeqCst) {
            return Ok(json_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "provider proxy has settled",
            ));
        }
        counters.requests += 1;
        counters.in_flight_requests += 1;
    }
    state.persist_checkpoint().await;

    let method = req.method().clone();
    let uri_str = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_owned())
        .unwrap_or_else(|| "/".to_owned());
    let headers = req.headers().clone();

    let body_bytes = match req.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => {
            finish_in_flight(&state).await;
            return Ok(json_error_response(
                StatusCode::BAD_GATEWAY,
                "failed to read request body",
            ));
        }
    };

    let observed = inspect_request_body(&body_bytes);

    {
        let mut counters = state.counters.lock().await;
        if let Some(m) = &observed.model {
            counters.models.insert(m.clone());
        }
        for name in &observed.tool_names {
            counters.tool_names.insert(name.clone());
        }
    }

    let target_url = match join_upstream_url(&state.config.upstream_base_url, &uri_str) {
        Ok(u) => u,
        Err(_) => {
            finish_in_flight(&state).await;
            return Ok(json_error_response(
                StatusCode::BAD_GATEWAY,
                "invalid upstream URL",
            ));
        }
    };
    let connect_url = match &state.config.transport_origin_override {
        Some(origin) => match rewrite_url_origin(&target_url, origin) {
            Ok(u) => u,
            Err(_) => {
                finish_in_flight(&state).await;
                return Ok(json_error_response(
                    StatusCode::BAD_GATEWAY,
                    "invalid gateway transport origin override",
                ));
            }
        },
        None => target_url.clone(),
    };

    let reqwest_method =
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::POST);
    let mut upstream_req = state.client.request(reqwest_method, &connect_url);
    if state.config.transport_origin_override.is_some() {
        upstream_req = upstream_req.header(UPSTREAM_TARGET_HEADER, &target_url);
    }
    let uses_x_api_key =
        headers.contains_key("x-api-key") && !headers.contains_key(hyper::header::AUTHORIZATION);
    for (name, value) in &headers {
        let lower = name.as_str().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host"
                | "content-length"
                | "transfer-encoding"
                | "connection"
                | "authorization"
                | "x-api-key"
                | UPSTREAM_TARGET_HEADER
        ) {
            continue;
        }
        if let Ok(val_str) = value.to_str() {
            upstream_req = upstream_req.header(name.as_str(), val_str);
        }
    }
    if uses_x_api_key {
        upstream_req = upstream_req.header("x-api-key", &state.config.upstream_api_key);
    } else {
        upstream_req = upstream_req.header(
            "authorization",
            format!("Bearer {}", state.config.upstream_api_key),
        );
    }
    if !body_bytes.is_empty() {
        upstream_req = upstream_req.body(body_bytes.to_vec());
    }

    let mut upstream_resp = match upstream_req.send().await {
        Ok(r) => r,
        Err(_) => {
            finish_in_flight(&state).await;
            return Ok(json_error_response(
                StatusCode::BAD_GATEWAY,
                "provider proxy failed",
            ));
        }
    };

    let status_u16 = upstream_resp.status().as_u16();
    let is_ok = upstream_resp.status().is_success();
    let mut resp_builder =
        Response::builder().status(StatusCode::from_u16(status_u16).unwrap_or(StatusCode::OK));
    for (name, value) in upstream_resp.headers() {
        let lower = name.as_str().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "content-length" | "content-encoding" | "transfer-encoding" | "connection"
        ) {
            continue;
        }
        if let Ok(val_str) = value.to_str() {
            resp_builder = resp_builder.header(name.as_str(), val_str);
        }
    }

    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, Infallible>>(16);
    let stream_state = state.clone();
    tokio::spawn(async move {
        let mut parser = UsageStreamParser::new();
        let mut counted = false;

        while let Ok(Some(chunk)) = upstream_resp.chunk().await {
            let text = String::from_utf8_lossy(&chunk);
            parser.push(&text);
            if !counted && is_ok && parser.admitted() {
                counted = true;
                {
                    let mut counters = stream_state.counters.lock().await;
                    counters.admitted_requests += 1;
                }
                stream_state.persist_checkpoint().await;
            }
            if tx.send(Ok(Frame::data(chunk))).await.is_err() {
                break;
            }
        }

        let (usage, admitted) = parser.finish();
        if !counted && is_ok && admitted {
            counted = true;
            {
                let mut counters = stream_state.counters.lock().await;
                counters.admitted_requests += 1;
            }
            stream_state.persist_checkpoint().await;
        }
        if counted && let Some(u) = usage {
            let mut counters = stream_state.counters.lock().await;
            counters.usage_requests += 1;
            counters.total_usage.accumulate_exact(&u);
        }
        finish_in_flight(&stream_state).await;
    });

    let stream = tokio_stream_from_receiver(rx);
    let body = http_body_util::BodyExt::boxed(StreamBody::new(stream));
    Ok(resp_builder.body(body).unwrap())
}

fn tokio_stream_from_receiver<T>(
    mut rx: mpsc::Receiver<T>,
) -> impl futures_util::Stream<Item = T> + Send + Sync + 'static
where
    T: Send + 'static,
{
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::measurement::recover_external_metering_checkpoint;

    #[test]
    fn inspect_request_body_observes_model_and_all_tools_without_pruning() {
        let input = serde_json::to_vec(&json!({
            "model": "deepseek-chat",
            "tools": [
                {"type": "function", "function": {"name": "WebSearch"}},
                {"type": "function", "function": {"name": "ReadFile"}},
                {"name": "web_fetch", "type": "custom"},
                {"type": "web_search_20250305", "name": "lookup"}
            ]
        }))
        .unwrap();
        let observed = inspect_request_body(&input);
        assert_eq!(observed.model.as_deref(), Some("deepseek-chat"));
        assert_eq!(
            observed.tool_names,
            vec![
                "WebSearch".to_owned(),
                "ReadFile".to_owned(),
                "web_fetch".to_owned(),
                "lookup".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn gateway_authenticates_preserves_exact_payload_streams_usage_and_enforces_cutoff() {
        let mut parser = UsageStreamParser::new();
        parser.push(concat!(
            "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":25,\"prompt_cache_hit_tokens\":60,\"completion_tokens_details\":{\"reasoning_tokens\":10},\"total_tokens\":125}}\n\n",
            "data: [DONE]\n\n"
        ));
        let (parsed_usage, parsed_admitted) = parser.finish();
        assert!(parsed_admitted);
        assert_eq!(
            parsed_usage,
            Some(NormalizedUsage {
                input_tokens: 100,
                output_tokens: 25,
                cache_read_tokens: 60,
                cache_write_tokens: 0,
                reasoning_tokens: 10,
                total_tokens: 125,
            })
        );

        let expected_raw_body = br#"{"model":"deepseek-chat","tools":[{"type":"function","function":{"name":"WebSearch"}},{"type":"function","function":{"name":"Bash"}}]}"#.to_vec();
        let expected_for_server = expected_raw_body.clone();

        // Start a mock upstream OpenAI-compatible SSE server.
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        if std::net::TcpStream::connect(upstream_addr)
            .is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied)
        {
            return;
        }
        let upstream_task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = upstream_listener.accept().await else {
                    break;
                };
                let expected_bytes = expected_for_server.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<Incoming>| {
                        let expected_bytes = expected_bytes.clone();
                        async move {
                            assert_eq!(req.uri().path(), "/v1/chat/completions");
                            assert_eq!(
                                req.headers()
                                    .get("authorization")
                                    .and_then(|v| v.to_str().ok()),
                                Some("Bearer real-upstream-secret")
                            );
                            let body = req.into_body().collect().await.unwrap().to_bytes();
                            assert_eq!(body.as_ref(), expected_bytes.as_slice());

                            let sse = concat!(
                                "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n",
                                "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":25,\"prompt_cache_hit_tokens\":60,\"completion_tokens_details\":{\"reasoning_tokens\":10},\"total_tokens\":125}}\n\n",
                                "data: [DONE]\n\n"
                            );
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header("content-type", "text/event-stream")
                                    .body(Full::new(Bytes::from(sse)))
                                    .unwrap(),
                            )
                        }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });

        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let checkpoint_path = agent_dir.join("maka.provider-usage.json");
        let checkpoint_secret = "0123456789abcdef0123456789abcdef";

        let gateway = EvalMeteringGateway::start(GatewayConfig {
            upstream_base_url: format!("http://{upstream_addr}/v1"),
            transport_origin_override: None,
            upstream_api_key: "real-upstream-secret".into(),
            profile: "maka".into(),
            gateway_credential: "attempt-gateway-token".into(),
            checkpoint_path: Some(checkpoint_path),
            checkpoint_secret: checkpoint_secret.into(),
        })
        .await
        .unwrap();

        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        // 1. Unauthorized request is rejected with 401 and not counted.
        let unauth = client
            .post(format!("{}/chat/completions", gateway.openai_v1_base_url()))
            .header("authorization", "Bearer wrong-token")
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&json!({"model": "deepseek-chat"})).unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(unauth.status(), reqwest::StatusCode::UNAUTHORIZED);

        // 2. Authorized request preserves exact request bytes & tools, forwards upstream, and records SSE usage.
        let resp = client
            .post(format!("{}/chat/completions", gateway.openai_v1_base_url()))
            .header("authorization", "Bearer attempt-gateway-token")
            .header("content-type", "application/json")
            .body(expected_raw_body)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        let text = resp.text().await.unwrap();
        assert!(text.contains("[DONE]"));

        // 3. Stop accepting and verify subsequent requests get 503 without inflating counts.
        gateway.stop_accepting();
        let refused = client
            .post(format!("{}/chat/completions", gateway.openai_v1_base_url()))
            .header("authorization", "Bearer attempt-gateway-token")
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&json!({"model": "deepseek-chat"})).unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(refused.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);

        let counts = gateway.close().await;
        upstream_task.abort();

        assert!(counts.settled);
        assert_eq!(counts.requests, 1);
        assert_eq!(counts.admitted_requests, 1);
        assert_eq!(counts.usage_requests, 1);
        assert_eq!(counts.models, vec!["deepseek-chat".to_owned()]);
        assert_eq!(
            counts.tool_names,
            vec!["Bash".to_owned(), "WebSearch".to_owned()]
        );
        assert_eq!(
            counts.usage,
            Some(NormalizedUsage {
                input_tokens: 100,
                output_tokens: 25,
                cache_read_tokens: 60,
                cache_write_tokens: 0,
                reasoning_tokens: 10,
                total_tokens: 125,
            })
        );

        // Verify the HMAC-signed checkpoint on disk is recoverable.
        let recovered =
            recover_external_metering_checkpoint(tmp.path(), "maka", checkpoint_secret).unwrap();
        assert_eq!(recovered.counts, counts);
    }
}
