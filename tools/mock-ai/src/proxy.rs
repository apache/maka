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

use crate::protocol::{NormalizedRequest, Protocol};
use crate::routing::{
    LogicalLane, ParsedRoute, is_local_control_path, is_runner_routing_header, strip_scope_prefix,
};
use base64::Engine as _;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, mpsc};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_util::sync::CancellationToken;

const DEFAULT_REDACTED_HEADERS: &[&str] = &[
    "authorization",
    "x-api-key",
    "api-key",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-auth-token",
];

const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "host",
];
const FINGERPRINT_VERSION: u32 = 2;
const FINGERPRINT_HEX_LEN: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExchangeKind {
    Http,
    WebSocketTurn,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExchangeOutcome {
    #[default]
    Completed,
    Truncated,
    UpstreamError,
    ClientDisconnected,
}

/// Single recorded response chunk with relative delay from the previous chunk (or turn start).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedChunk {
    pub delay_ms: u64,
    #[serde(default)]
    pub is_binary: bool,
    pub data: String,
}

impl TimedChunk {
    pub fn from_bytes(delay_ms: u64, bytes: &[u8]) -> Self {
        match std::str::from_utf8(bytes) {
            Ok(s) => Self {
                delay_ms,
                is_binary: false,
                data: s.to_string(),
            },
            Err(_) => Self::from_binary(delay_ms, bytes),
        }
    }

    fn from_binary(delay_ms: u64, bytes: &[u8]) -> Self {
        Self {
            delay_ms,
            is_binary: true,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }

    pub fn to_bytes(&self) -> Bytes {
        if self.is_binary {
            Bytes::from(
                base64::engine::general_purpose::STANDARD
                    .decode(&self.data)
                    .unwrap_or_default(),
            )
        } else {
            Bytes::from(self.data.clone())
        }
    }
}

/// One recorded HTTP or WebSocket exchange stored as a single line in an NDJSON cassette.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedExchange {
    pub kind: ExchangeKind,
    pub fingerprint: String,
    #[serde(default)]
    pub fingerprint_version: u32,
    pub method: String,
    /// Canonical provider path and optional query as sent by the proxy.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<Protocol>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_lane: Option<LogicalLane>,
    pub model: String,
    #[serde(default)]
    pub request_headers: BTreeMap<String, String>,
    #[serde(default)]
    pub request_body: Value,
    pub status: u16,
    #[serde(default)]
    pub outcome: ExchangeOutcome,
    #[serde(default)]
    pub response_headers: BTreeMap<String, String>,
    pub chunks: Vec<TimedChunk>,
}

/// Transparent upstream proxy recording configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRecordConfig {
    /// Upstream provider base URL (e.g. `https://api.openai.com` or `http://127.0.0.1:9000`).
    pub upstream_base_url: String,
    /// NDJSON output cassette path.
    pub cassette_path: PathBuf,
    /// Additional lowercase header names to redact beyond the built-in auth/cookie list.
    #[serde(default)]
    pub extra_redact_headers: Vec<String>,
    /// Optional upstream auth header override `(name, value)` (injected when forwarding, never saved).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_auth_header: Option<(String, String)>,
    /// Maximum recorded response bytes per exchange (default 16 MiB).
    #[serde(default = "default_max_record_bytes")]
    pub max_record_bytes_per_exchange: usize,
    /// Optional custom CA certificate PEM bytes for verifying self-signed/private TLS upstreams.
    #[serde(skip)]
    pub upstream_ca_cert_pem: Option<Vec<u8>>,
}

fn default_max_record_bytes() -> usize {
    16 * 1024 * 1024
}

impl ProxyRecordConfig {
    pub fn new(upstream_base_url: impl Into<String>, cassette_path: impl Into<PathBuf>) -> Self {
        Self {
            upstream_base_url: upstream_base_url.into().trim_end_matches('/').to_string(),
            cassette_path: cassette_path.into(),
            extra_redact_headers: Vec::new(),
            upstream_auth_header: None,
            max_record_bytes_per_exchange: default_max_record_bytes(),
            upstream_ca_cert_pem: None,
        }
    }

    pub fn with_upstream_ca_pem(mut self, pem: impl Into<Vec<u8>>) -> Self {
        self.upstream_ca_cert_pem = Some(pem.into());
        self
    }

    pub fn with_upstream_ca_file(mut self, path: &Path) -> Result<Self, String> {
        let pem = std::fs::read(path)
            .map_err(|e| format!("failed to read upstream CA {}: {e}", path.display()))?;
        self.upstream_ca_cert_pem = Some(pem);
        Ok(self)
    }

    pub fn redact_headers(&self, headers: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for (k, v) in headers {
            let lower = k.to_ascii_lowercase();
            if is_runner_routing_header(&lower) {
                continue;
            }
            let sensitive = DEFAULT_REDACTED_HEADERS.contains(&lower.as_str())
                || self
                    .extra_redact_headers
                    .iter()
                    .any(|extra| extra.eq_ignore_ascii_case(&lower));
            if sensitive {
                out.insert(lower, "[REDACTED]".into());
            } else {
                out.insert(lower, v.clone());
            }
        }
        out
    }
}

/// Strategy for selecting which recorded exchange to replay for an incoming request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayMatchMode {
    /// Match exchanges strictly in recorded order (wraps if `loop_cassette == true`).
    #[default]
    Sequential,
    /// Match by request fingerprint, with optional sequential fallback in permissive replay.
    Fingerprint,
}

/// Configuration for cassette replay mode.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayConfig {
    pub cassette_path: PathBuf,
    #[serde(default)]
    pub match_mode: ReplayMatchMode,
    /// Playback speed multiplier: `1.0` = recorded real-time, `10.0` = 10x faster, `0.0` = instant.
    #[serde(default = "default_speed")]
    pub speed_multiplier: f64,
    /// Maximum delay in ms per chunk after scaling (prevents long recorded pauses from stalling tests).
    #[serde(default = "default_max_chunk_delay_ms")]
    pub max_chunk_delay_ms: u64,
    /// Loop sequential cursor when reaching the end of the cassette.
    #[serde(default = "default_true")]
    pub loop_cassette: bool,
    /// When `match_mode == Fingerprint`, fall back to sequential replay if no fingerprint matches.
    #[serde(default = "default_true")]
    pub fallback_to_sequential: bool,
    /// Require a matching, untruncated recording and consume it only once.
    #[serde(default)]
    pub strict_replay: bool,
}

fn default_speed() -> f64 {
    1.0
}
fn default_max_chunk_delay_ms() -> u64 {
    10_000
}
fn default_true() -> bool {
    true
}

impl ReplayConfig {
    pub fn new(cassette_path: impl Into<PathBuf>) -> Self {
        Self {
            cassette_path: cassette_path.into(),
            match_mode: ReplayMatchMode::Sequential,
            speed_multiplier: 1.0,
            max_chunk_delay_ms: default_max_chunk_delay_ms(),
            loop_cassette: true,
            fallback_to_sequential: true,
            strict_replay: false,
        }
    }

    pub fn with_speed(mut self, speed: f64) -> Self {
        self.speed_multiplier = speed;
        self
    }

    pub fn with_match_mode(mut self, mode: ReplayMatchMode) -> Self {
        self.match_mode = mode;
        self
    }

    pub fn with_strict_replay(mut self) -> Self {
        self.strict_replay = true;
        self
    }

    pub fn scaled_delay(&self, recorded_delay_ms: u64) -> Duration {
        if recorded_delay_ms == 0
            || self.speed_multiplier <= 0.0
            || !self.speed_multiplier.is_finite()
        {
            return Duration::ZERO;
        }
        let scaled = ((recorded_delay_ms as f64) / self.speed_multiplier).round() as u64;
        Duration::from_millis(scaled.min(self.max_chunk_delay_ms))
    }
}

/// Compute a provider request fingerprint independently of the runner URL prefix.
pub fn compute_fingerprint(
    kind: ExchangeKind,
    method: &str,
    path_and_query: &str,
    model: &str,
    body: &Value,
) -> String {
    compute_fingerprint_for_lane(kind, method, path_and_query, model, body, None)
}

pub fn compute_fingerprint_for_lane(
    kind: ExchangeKind,
    method: &str,
    path_and_query: &str,
    model: &str,
    body: &Value,
    scope_lane: Option<&LogicalLane>,
) -> String {
    canonical_request_fingerprint(CanonicalRequest {
        kind,
        method,
        path_and_query,
        protocol: None,
        model,
        body,
        headers: &BTreeMap::new(),
        scope_lane: scope_lane.map(|lane| lane.0.as_str()),
    })
}

struct CanonicalRequest<'a> {
    kind: ExchangeKind,
    method: &'a str,
    path_and_query: &'a str,
    protocol: Option<Protocol>,
    model: &'a str,
    body: &'a Value,
    headers: &'a BTreeMap<String, String>,
    scope_lane: Option<&'a str>,
}

fn request_protocol(kind: ExchangeKind, method: &str, provider_path: &str) -> Option<Protocol> {
    if kind == ExchangeKind::WebSocketTurn {
        return Some(Protocol::OpenaiResponsesWs);
    }
    let path = provider_path
        .split_once('?')
        .map_or(provider_path, |(path, _)| path);
    match (method, path.strip_prefix("/v1").unwrap_or(path)) {
        ("POST", "/chat/completions") => Some(Protocol::OpenaiChatCompletions),
        ("POST", "/responses" | "/responses/compact") => Some(Protocol::OpenaiResponsesHttp),
        ("POST", "/messages" | "/messages/count_tokens") => Some(Protocol::AnthropicMessages),
        _ => None,
    }
}

fn protocol_headers(protocol: Option<Protocol>) -> &'static [&'static str] {
    match protocol {
        Some(Protocol::AnthropicMessages) => &["anthropic-beta", "anthropic-version"],
        Some(_) => &["openai-beta", "openai-version"],
        None => &[],
    }
}

fn request_header<'a>(headers: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .or_else(|| {
            headers
                .iter()
                .find_map(|(key, value)| key.eq_ignore_ascii_case(name).then_some(value))
        })
        .map(String::as_str)
}

fn hash_field(hasher: &mut Sha256, field: &str) {
    hasher.update((field.len() as u64).to_be_bytes());
    hasher.update(field.as_bytes());
}

fn exchange_kind_label(kind: ExchangeKind) -> &'static str {
    match kind {
        ExchangeKind::Http => "http",
        ExchangeKind::WebSocketTurn => "ws",
    }
}

fn canonical_request_fingerprint(request: CanonicalRequest<'_>) -> String {
    let path = strip_scope_prefix(request.path_and_query);
    let protocol = request
        .protocol
        .or_else(|| request_protocol(request.kind, request.method, &path));
    let mut hasher = Sha256::new();
    hasher.update(FINGERPRINT_VERSION.to_be_bytes());
    for field in [
        exchange_kind_label(request.kind),
        request.method,
        &path,
        protocol.map_or("", Protocol::as_str),
        request.model,
    ] {
        hash_field(&mut hasher, field);
    }
    // Use a presence marker so that absent and empty settings remain distinct.
    for field in std::iter::once(request.scope_lane).chain(
        protocol_headers(protocol)
            .iter()
            .map(|name| request_header(request.headers, name).map(str::trim)),
    ) {
        match field {
            Some(value) => {
                hasher.update([1]);
                hash_field(&mut hasher, value);
            }
            None => hasher.update([0]),
        }
    }
    // Include provider extensions alongside the common fields. Cache affinity is per run.
    if let Value::Object(body) = request.body {
        hash_object(&mut hasher, body, Some("prompt_cache_key"));
    } else {
        hash_json(&mut hasher, request.body);
    }
    use std::fmt::Write as _;
    let mut fingerprint = String::with_capacity(FINGERPRINT_HEX_LEN);
    for byte in hasher.finalize() {
        write!(fingerprint, "{byte:02x}").expect("writing to a String");
    }
    fingerprint
}

fn hash_json(hasher: &mut Sha256, value: &Value) {
    match value {
        Value::Null => hasher.update(b"n"),
        Value::Bool(value) => hasher.update(if *value { b"t" } else { b"f" }),
        Value::Number(value) => {
            hasher.update(b"d");
            hash_field(hasher, &value.to_string());
        }
        Value::String(value) => {
            hasher.update(b"s");
            hash_field(hasher, value);
        }
        Value::Array(values) => {
            hasher.update(b"a");
            hasher.update((values.len() as u64).to_be_bytes());
            for value in values {
                hash_json(hasher, value);
            }
        }
        Value::Object(object) => hash_object(hasher, object, None),
    }
}

fn hash_object(hasher: &mut Sha256, object: &serde_json::Map<String, Value>, omit: Option<&str>) {
    let len = object.len() - usize::from(omit.is_some_and(|key| object.contains_key(key)));
    hasher.update(b"o");
    hasher.update((len as u64).to_be_bytes());
    let entries = object.iter().filter(|(key, _)| Some(key.as_str()) != omit);
    let hash_entry = |(key, value): (&String, &Value)| {
        hash_field(hasher, key);
        hash_json(hasher, value);
    };
    // Map order can depend on Cargo feature unification for serde_json.
    if entries.clone().is_sorted_by(|(a, _), (b, _)| a <= b) {
        entries.for_each(hash_entry);
    } else {
        let mut entries: Vec<_> = entries.collect();
        entries.sort_unstable_by_key(|(key, _)| *key);
        entries.into_iter().for_each(hash_entry);
    }
}

// Verify that the old recorder saved the lane it hashed and used the path with its query.
fn legacy_fingerprint_matches(exchange: &RecordedExchange, scope_lane: Option<&str>) -> bool {
    let mut hasher = Sha256::new();
    let kind = exchange_kind_label(exchange.kind);
    let body = &exchange.request_body;
    for field in [kind, &exchange.method, &exchange.path, &exchange.model] {
        hash_field(&mut hasher, field);
    }
    if let Some(lane) = scope_lane {
        hash_field(&mut hasher, "scope_lane");
        hash_field(&mut hasher, lane);
    }
    for (name, field) in [
        (
            "system",
            body.get("system").or_else(|| body.get("instructions")),
        ),
        (
            "history",
            body.get("messages").or_else(|| body.get("input")),
        ),
        ("tools", body.get("tools")),
        ("previous_response_id", body.get("previous_response_id")),
        ("stream", body.get("stream")),
        ("stream_options", body.get("stream_options")),
        ("tool_choice", body.get("tool_choice")),
        ("parallel_tool_calls", body.get("parallel_tool_calls")),
        ("reasoning", body.get("reasoning")),
        ("reasoning_effort", body.get("reasoning_effort")),
        ("include", body.get("include")),
        ("generate", body.get("generate")),
        ("store", body.get("store")),
        ("context_management", body.get("context_management")),
        ("max_output_tokens", body.get("max_output_tokens")),
        ("max_completion_tokens", body.get("max_completion_tokens")),
        ("max_tokens", body.get("max_tokens")),
    ] {
        if let Some(value) = field {
            hash_field(&mut hasher, name);
            hash_field(&mut hasher, &value.to_string());
        }
    }
    format!(
        "{:016x}",
        u64::from_be_bytes(hasher.finalize()[..8].try_into().unwrap())
    ) == exchange.fingerprint
}

fn normalized_exchange_kind(req: &NormalizedRequest) -> (ExchangeKind, &'static str) {
    if req.protocol == Protocol::OpenaiResponsesWs {
        (ExchangeKind::WebSocketTurn, "WS")
    } else {
        (ExchangeKind::Http, "POST")
    }
}

/// Fixture lane label used for capture independently of per-run IDs.
pub const SCOPE_LANE_HEADER: &str = "x-maka-bench-lane";

pub fn fingerprint_from_normalized(req: &NormalizedRequest) -> String {
    let (kind, method) = normalized_exchange_kind(req);
    canonical_request_fingerprint(CanonicalRequest {
        kind,
        method,
        path_and_query: &req.path,
        protocol: Some(req.protocol),
        model: req.raw_body["model"].as_str().unwrap_or(""),
        body: &req.raw_body,
        headers: &req.headers,
        scope_lane: request_header(&req.headers, SCOPE_LANE_HEADER),
    })
}

pub fn fingerprint_from_route(
    req: &NormalizedRequest,
    method: &str,
    route: &ParsedRoute<'_>,
    scope_lane: Option<&LogicalLane>,
) -> String {
    let (kind, normalized_method) = normalized_exchange_kind(req);
    let method = if kind == ExchangeKind::WebSocketTurn {
        normalized_method
    } else {
        method
    };
    canonical_request_fingerprint(CanonicalRequest {
        kind,
        method,
        path_and_query: &route.canonical_path_and_query(),
        protocol: Some(req.protocol),
        model: req.raw_body["model"].as_str().unwrap_or(""),
        body: &req.raw_body,
        headers: &req.headers,
        scope_lane: scope_lane
            .map(|lane| lane.0.as_str())
            .or_else(|| request_header(&req.headers, SCOPE_LANE_HEADER)),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ReplayError {
    #[error("cassette fingerprint miss")]
    Miss,
    #[error("cassette replay exhausted")]
    Exhausted,
    #[error("cassette recording was truncated")]
    Truncated,
    #[error("cassette exchange does not match the request constraints")]
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ReplayBodyError {
    #[error("cassette recording was truncated")]
    Truncated,
    #[error("recorded upstream HTTP stream failed")]
    UpstreamError,
    #[error("recorded client disconnected before HTTP stream completion")]
    ClientDisconnected,
}

impl RecordedExchange {
    /// Emit the captured HTTP prefix at recorded intervals, then reproduce its termination.
    pub fn replay_http_body(
        self,
        config: ReplayConfig,
    ) -> impl futures_util::Stream<Item = Result<Bytes, ReplayBodyError>> {
        let terminal_error = match self.outcome {
            ExchangeOutcome::Completed => None,
            ExchangeOutcome::Truncated => Some(ReplayBodyError::Truncated),
            ExchangeOutcome::UpstreamError => Some(ReplayBodyError::UpstreamError),
            ExchangeOutcome::ClientDisconnected => Some(ReplayBodyError::ClientDisconnected),
        };
        futures_util::stream::unfold(
            (self.chunks.into_iter(), config, terminal_error),
            |(mut chunks, config, error)| async move {
                if let Some(chunk) = chunks.next() {
                    let delay = config.scaled_delay(chunk.delay_ms);
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                    return Some((Ok(chunk.to_bytes()), (chunks, config, error)));
                }
                error.map(|err| (Err(err), (chunks, config, None)))
            },
        )
    }
}

struct PendingGuard {
    pending: Arc<AtomicUsize>,
    drained: Arc<Notify>,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if self.pending.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.drained.notify_waiters();
        }
    }
}

/// Append-only NDJSON writer for captured exchanges with deterministic flush-on-shutdown.
pub struct CassetteWriter {
    path: PathBuf,
    write_lock: Arc<Mutex<()>>,
    pending: Arc<AtomicUsize>,
    drained: Arc<Notify>,
}

impl CassetteWriter {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Arc::new(Mutex::new(())),
            pending: Arc::new(AtomicUsize::new(0)),
            drained: Arc::new(Notify::new()),
        }
    }

    /// Reserve an in-flight write slot (useful for detached recording tasks that will call `append`).
    pub fn track_in_flight(&self) -> impl Drop + Send + 'static {
        self.pending.fetch_add(1, Ordering::AcqRel);
        PendingGuard {
            pending: self.pending.clone(),
            drained: self.drained.clone(),
        }
    }

    /// Wait until all in-flight cassette writes have flushed to disk.
    pub async fn flush(&self) {
        loop {
            let notified = self.drained.notified();
            if self.pending.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }

    pub async fn append(&self, exchange: RecordedExchange) -> Result<(), String> {
        let path = self.path.clone();
        let lock = self.write_lock.clone();
        let _guard = self.track_in_flight();
        tokio::task::spawn_blocking(move || {
            let _guard = _guard;
            let line = serde_json::to_string(&exchange)
                .map_err(|e| format!("failed to serialize cassette line: {e}"))?;
            let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(parent) = path.parent()
                && !parent.as_os_str().is_empty()
            {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("failed to create cassette dir: {e}"))?;
            }
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("failed to open cassette {}: {e}", path.display()))?;
            writeln!(file, "{line}").map_err(|e| format!("failed to write cassette line: {e}"))?;
            file.flush()
                .map_err(|e| format!("failed to flush cassette: {e}"))?;
            Ok(())
        })
        .await
        .map_err(|e| format!("cassette writer task join error: {e}"))?
    }
}

/// Loaded in-memory NDJSON cassette with sequential and fingerprint lookup.
pub struct CassetteReplayer {
    config: ReplayConfig,
    http_exchanges: Vec<RecordedExchange>,
    ws_exchanges: Vec<RecordedExchange>,
    http_cursor: AtomicUsize,
    ws_cursor: AtomicUsize,
    http_by_fp: HashMap<String, Vec<usize>>,
    ws_by_fp: HashMap<String, Vec<usize>>,
    http_fp_cursors: Mutex<HashMap<String, usize>>,
    ws_fp_cursors: Mutex<HashMap<String, usize>>,
}

impl CassetteReplayer {
    pub fn load(config: ReplayConfig) -> Result<Self, String> {
        let indexed = config.match_mode == ReplayMatchMode::Fingerprint;
        let exchanges = read_ndjson(&config.cassette_path, indexed || config.strict_replay)?;
        let mut http_exchanges = Vec::new();
        let mut ws_exchanges = Vec::new();
        let mut http_by_fp: HashMap<String, Vec<usize>> = HashMap::new();
        let mut ws_by_fp: HashMap<String, Vec<usize>> = HashMap::new();

        for ex in exchanges {
            let (list, by_fp) = match ex.kind {
                ExchangeKind::Http => (&mut http_exchanges, &mut http_by_fp),
                ExchangeKind::WebSocketTurn => (&mut ws_exchanges, &mut ws_by_fp),
            };
            if indexed {
                by_fp
                    .entry(ex.fingerprint.clone())
                    .or_default()
                    .push(list.len());
            }
            list.push(ex);
        }

        Ok(Self {
            config,
            http_exchanges,
            ws_exchanges,
            http_cursor: AtomicUsize::new(0),
            ws_cursor: AtomicUsize::new(0),
            http_by_fp,
            ws_by_fp,
            http_fp_cursors: Mutex::default(),
            ws_fp_cursors: Mutex::default(),
        })
    }

    pub fn config(&self) -> &ReplayConfig {
        &self.config
    }

    pub fn http_len(&self) -> usize {
        self.http_exchanges.len()
    }

    pub fn ws_len(&self) -> usize {
        self.ws_exchanges.len()
    }

    pub fn reset(&self) {
        self.http_cursor.store(0, Ordering::Relaxed);
        self.ws_cursor.store(0, Ordering::Relaxed);
        self.http_fp_cursors.lock().unwrap().clear();
        self.ws_fp_cursors.lock().unwrap().clear();
    }

    pub fn next_http(&self, fingerprint: &str) -> Option<&RecordedExchange> {
        self.next_http_if(fingerprint, |_| true)
    }

    /// Select the next HTTP exchange only if the caller accepts it.
    pub fn next_http_if(
        &self,
        fingerprint: &str,
        accept: impl Fn(&RecordedExchange) -> bool,
    ) -> Option<&RecordedExchange> {
        self.legacy_selection(self.try_next_http_if(fingerprint, accept))
    }

    pub fn next_ws(&self, fingerprint: &str) -> Option<&RecordedExchange> {
        self.legacy_selection(self.try_next_ws(fingerprint))
    }

    fn legacy_selection<'a>(
        &self,
        result: Result<&'a RecordedExchange, ReplayError>,
    ) -> Option<&'a RecordedExchange> {
        if self.config.strict_replay
            && let Err(err) = &result
        {
            tracing::warn!("strict cassette replay: {err}");
        }
        result.ok()
    }

    pub fn try_next_http(&self, fingerprint: &str) -> Result<&RecordedExchange, ReplayError> {
        self.try_next_http_if(fingerprint, |_| true)
    }

    pub fn try_next_http_if(
        &self,
        fingerprint: &str,
        accept: impl Fn(&RecordedExchange) -> bool,
    ) -> Result<&RecordedExchange, ReplayError> {
        self.select(ExchangeKind::Http, fingerprint, accept)
    }

    pub fn try_next_ws(&self, fingerprint: &str) -> Result<&RecordedExchange, ReplayError> {
        self.try_next_ws_if(fingerprint, |_| true)
    }

    pub fn try_next_ws_if(
        &self,
        fingerprint: &str,
        accept: impl Fn(&RecordedExchange) -> bool,
    ) -> Result<&RecordedExchange, ReplayError> {
        self.select(ExchangeKind::WebSocketTurn, fingerprint, accept)
    }

    fn select(
        &self,
        kind: ExchangeKind,
        fingerprint: &str,
        accept: impl Fn(&RecordedExchange) -> bool,
    ) -> Result<&RecordedExchange, ReplayError> {
        let (list, cursor, by_fp, fp_cursors) = match kind {
            ExchangeKind::Http => (
                &self.http_exchanges,
                &self.http_cursor,
                &self.http_by_fp,
                &self.http_fp_cursors,
            ),
            ExchangeKind::WebSocketTurn => (
                &self.ws_exchanges,
                &self.ws_cursor,
                &self.ws_by_fp,
                &self.ws_fp_cursors,
            ),
        };
        let strict = self.config.strict_replay;
        let looping = self.config.loop_cassette && !strict;
        let validate = |candidate: &RecordedExchange| {
            if strict && candidate.outcome == ExchangeOutcome::Truncated {
                Err(ReplayError::Truncated)
            } else if !accept(candidate) {
                Err(ReplayError::Rejected)
            } else {
                Ok(())
            }
        };
        if self.config.match_mode == ReplayMatchMode::Fingerprint {
            if let Some(indices) = by_fp.get(fingerprint) {
                let mut fp_map = fp_cursors.lock().unwrap();
                let slot = fp_map.entry(fingerprint.to_owned()).or_insert(0);
                let pos = if looping {
                    *slot % indices.len()
                } else {
                    *slot
                };
                let idx = *indices.get(pos).ok_or(ReplayError::Exhausted)?;
                let candidate = &list[idx];
                validate(candidate)?;
                *slot += 1;
                return Ok(candidate);
            }
            if strict || !self.config.fallback_to_sequential {
                return Err(ReplayError::Miss);
            }
        }

        // Rejected requests leave the current exchange available for the matching request.
        loop {
            let idx = cursor.load(Ordering::Acquire);
            let target = if looping && !list.is_empty() {
                idx % list.len()
            } else {
                idx
            };
            let candidate = list.get(target).ok_or(ReplayError::Exhausted)?;
            if strict && candidate.fingerprint != fingerprint {
                return Err(ReplayError::Miss);
            }
            validate(candidate)?;
            if cursor
                .compare_exchange(idx, idx + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Ok(candidate);
            }
        }
    }
}

pub fn load_ndjson(path: &Path) -> Result<Vec<RecordedExchange>, String> {
    read_ndjson(path, false)
}

fn read_ndjson(path: &Path, require_fingerprint: bool) -> Result<Vec<RecordedExchange>, String> {
    let file =
        File::open(path).map_err(|e| format!("failed to open cassette {}: {e}", path.display()))?;
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for (idx, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| format!("failed reading line {}: {e}", idx + 1))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let invalid_json = |e| format!("invalid cassette JSON at line {}: {e}", idx + 1);
        let ex = if require_fingerprint {
            let raw = serde_json::from_str(trimmed).map_err(invalid_json)?;
            prepare_recorded_fingerprint(raw)
                .map_err(|err| format!("cassette incompatible at line {}: {err}", idx + 1))?
        } else {
            serde_json::from_str(trimmed).map_err(invalid_json)?
        };
        out.push(ex);
    }
    Ok(out)
}

fn prepare_recorded_fingerprint(raw: Value) -> Result<RecordedExchange, String> {
    if !raw["requestHeaders"].is_object() {
        return Err("fingerprint matching requires recorded requestHeaders".into());
    }
    if raw.get("requestBody").is_none() {
        return Err("fingerprint matching requires recorded requestBody".into());
    }
    let mut exchange: RecordedExchange =
        serde_json::from_value(raw).map_err(|err| err.to_string())?;
    if exchange.fingerprint.is_empty() || !exchange.path.starts_with('/') {
        return Err("missing recorded fingerprint or provider path".into());
    }
    if exchange.fingerprint_version == FINGERPRINT_VERSION {
        if exchange.fingerprint.len() != FINGERPRINT_HEX_LEN
            || !exchange
                .fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("fingerprint version 2 requires a lowercase SHA-256 key".into());
        }
        return Ok(exchange);
    }
    if exchange.fingerprint_version > FINGERPRINT_VERSION {
        return Err(format!(
            "unsupported fingerprint version {}",
            exchange.fingerprint_version
        ));
    }
    let path = strip_scope_prefix(&exchange.path);
    let protocol = exchange
        .protocol
        .or_else(|| request_protocol(exchange.kind, &exchange.method, &path));
    if protocol.is_some() && !exchange.request_body.is_object() {
        return Err("legacy recording is missing its JSON request body".into());
    }
    if protocol_headers(protocol)
        .iter()
        .any(|name| request_header(&exchange.request_headers, name) == Some("[REDACTED]"))
    {
        return Err(
            "legacy recording has redacted protocol headers; re-record the cassette".into(),
        );
    }
    let scope_lane = exchange
        .scope_lane
        .as_ref()
        .map(|lane| lane.0.as_str())
        .or_else(|| request_header(&exchange.request_headers, SCOPE_LANE_HEADER));
    if scope_lane == Some("[REDACTED]") || !legacy_fingerprint_matches(&exchange, scope_lane) {
        return Err(
            "legacy fingerprint cannot be reconstructed from the recorded request (path/query or scope lane unavailable); re-record the cassette"
                .into(),
        );
    }
    exchange.fingerprint = canonical_request_fingerprint(CanonicalRequest {
        kind: exchange.kind,
        method: &exchange.method,
        path_and_query: &path,
        protocol,
        model: &exchange.model,
        body: &exchange.request_body,
        headers: &exchange.request_headers,
        scope_lane,
    });
    exchange.fingerprint_version = FINGERPRINT_VERSION;
    Ok(exchange)
}

/// Transparent HTTP + WebSocket upstream proxy recorder (supports HTTP, HTTPS, WS, and WSS).
pub struct ProxyRecorder {
    config: ProxyRecordConfig,
    client: reqwest::Client,
    tls_connector: tokio_rustls::TlsConnector,
    writer: Arc<CassetteWriter>,
}

pub struct ProxiedHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub rx: mpsc::Receiver<Result<Bytes, String>>,
}

impl ProxyRecorder {
    pub fn new(config: ProxyRecordConfig) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_gzip()
            .no_brotli()
            .no_deflate();
        if let Some(ref ca_pem) = config.upstream_ca_cert_pem {
            let certs = reqwest::Certificate::from_pem_bundle(ca_pem)
                .map_err(|e| format!("invalid upstream CA certificate for reqwest: {e}"))?;
            builder = builder.tls_certs_only(certs);
        }
        let client = builder
            .build()
            .map_err(|e| format!("failed to build upstream reqwest client: {e}"))?;
        let tls_connector =
            crate::tls::build_tls_connector(config.upstream_ca_cert_pem.as_deref())?;
        let writer = Arc::new(CassetteWriter::new(config.cassette_path.clone()));
        Ok(Self {
            config,
            client,
            tls_connector,
            writer,
        })
    }

    pub fn config(&self) -> &ProxyRecordConfig {
        &self.config
    }

    /// Wait until all in-flight HTTP and WebSocket cassette writes have flushed to disk.
    pub async fn flush(&self) {
        self.writer.flush().await;
    }

    /// Forward an HTTP request upstream, streaming response chunks back immediately while recording timing.
    pub async fn forward_http(
        &self,
        method: &str,
        path_and_query: &str,
        protocol: Option<Protocol>,
        headers: &BTreeMap<String, String>,
        raw_body: Bytes,
        shutdown: CancellationToken,
    ) -> Result<ProxiedHttpResponse, String> {
        let canonical = provider_path_and_query(path_and_query)?;
        let url = reqwest::Url::parse(&format!("{}{canonical}", self.config.upstream_base_url))
            .map_err(|e| format!("invalid upstream HTTP URL: {e}"))?;
        if canonical != path_and_query && is_local_control_path(url.path()) {
            return Err(SCOPED_CONTROL_ERROR.into());
        }
        let req_method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|e| format!("invalid HTTP method {method}: {e}"))?;
        let mut builder = self.client.request(req_method, url.clone());

        for (k, v) in headers {
            let lower = k.to_ascii_lowercase();
            if HOP_BY_HOP_HEADERS.contains(&lower.as_str())
                || lower == "accept-encoding"
                || is_runner_routing_header(&lower)
            {
                continue;
            }
            if let Some((ref override_k, _)) = self.config.upstream_auth_header
                && override_k.eq_ignore_ascii_case(&lower)
            {
                continue;
            }
            builder = builder.header(k.as_str(), v.as_str());
        }
        if let Some((ref override_k, ref override_v)) = self.config.upstream_auth_header {
            builder = builder.header(override_k.as_str(), override_v.as_str());
        }
        if !raw_body.is_empty() {
            builder = builder.body(raw_body.clone());
        }

        let started = Instant::now();
        let resp = builder
            .send()
            .await
            .map_err(|e| format!("upstream request to {url} failed: {e}"))?;
        let status = resp.status().as_u16();
        let mut resp_headers_map = BTreeMap::new();
        let mut resp_headers_vec = Vec::new();
        for (k, v) in resp.headers() {
            let name = k.as_str().to_ascii_lowercase();
            if HOP_BY_HOP_HEADERS.contains(&name.as_str()) {
                continue;
            }
            if let Ok(val) = v.to_str() {
                resp_headers_map.insert(name.clone(), val.to_string());
                resp_headers_vec.push((name, val.to_string()));
            }
        }

        let req_json: Value = serde_json::from_slice(&raw_body).unwrap_or(Value::Null);
        let model = req_json
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let scope_lane = request_header(headers, SCOPE_LANE_HEADER);
        let fingerprint = canonical_request_fingerprint(CanonicalRequest {
            kind: ExchangeKind::Http,
            method,
            path_and_query: &canonical,
            protocol,
            model: &model,
            body: &req_json,
            headers,
            scope_lane,
        });
        let scope_lane = scope_lane.map(|lane| LogicalLane(lane.into()));
        let path = canonical.into_owned();

        let redacted_req_headers = self.config.redact_headers(headers);
        let redacted_resp_headers = self.config.redact_headers(&resp_headers_map);
        let writer = self.writer.clone();
        let max_record = self.config.max_record_bytes_per_exchange;
        let method_owned = method.to_string();

        let (tx, rx) = mpsc::channel::<Result<Bytes, String>>(32);
        let in_flight_guard = writer.track_in_flight();
        tokio::spawn(async move {
            let _in_flight_guard = in_flight_guard;
            let mut stream = resp.bytes_stream();
            let mut chunks = Vec::new();
            let mut recorded_bytes = 0usize;
            let mut outcome = ExchangeOutcome::Completed;
            let mut last_tick = started;

            loop {
                let next_item = tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => {
                        if outcome == ExchangeOutcome::Completed {
                            outcome = ExchangeOutcome::ClientDisconnected;
                        }
                        break;
                    }
                    _ = tx.closed() => {
                        if outcome == ExchangeOutcome::Completed {
                            outcome = ExchangeOutcome::ClientDisconnected;
                        }
                        break;
                    }
                    item = stream.next() => item,
                };
                let Some(item) = next_item else {
                    break;
                };
                match item {
                    Ok(chunk) => {
                        let now = Instant::now();
                        let delay_ms = now.saturating_duration_since(last_tick).as_millis() as u64;
                        last_tick = now;
                        if outcome != ExchangeOutcome::Truncated {
                            if recorded_bytes.saturating_add(chunk.len()) <= max_record {
                                recorded_bytes = recorded_bytes.saturating_add(chunk.len());
                                chunks.push(TimedChunk::from_bytes(delay_ms, &chunk));
                            } else {
                                // Stop recording once capped so we never save a broken stream with missing middle + terminal.
                                outcome = ExchangeOutcome::Truncated;
                            }
                        }
                        if tx.send(Ok(chunk)).await.is_err() {
                            if outcome == ExchangeOutcome::Completed {
                                outcome = ExchangeOutcome::ClientDisconnected;
                            }
                            break;
                        }
                    }
                    Err(err) => {
                        if outcome != ExchangeOutcome::Truncated {
                            outcome = ExchangeOutcome::UpstreamError;
                        }
                        let _ = tx.send(Err(format!("upstream stream error: {err}"))).await;
                        break;
                    }
                }
            }

            drop(tx);
            let exchange = RecordedExchange {
                kind: ExchangeKind::Http,
                fingerprint,
                fingerprint_version: FINGERPRINT_VERSION,
                method: method_owned,
                path,
                protocol,
                scope_lane,
                model,
                request_headers: redacted_req_headers,
                request_body: req_json,
                status,
                outcome,
                response_headers: redacted_resp_headers,
                chunks,
            };
            if let Err(err) = writer.append(exchange).await {
                tracing::warn!("proxy cassette write failed: {err}");
            }
        });

        Ok(ProxiedHttpResponse {
            status,
            headers: resp_headers_vec,
            rx,
        })
    }

    /// Bridge an upgraded client WebSocket connection to an upstream `ws://` endpoint and record each turn.
    pub async fn proxy_websocket<S>(
        &self,
        client_ws: tokio_tungstenite::WebSocketStream<S>,
        path_and_query: &str,
        headers: &BTreeMap<String, String>,
    ) -> Result<(), String>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let upstream_ws = self.connect_upstream_ws(path_and_query, headers).await?;
        self.bridge_websocket(
            client_ws,
            upstream_ws,
            path_and_query,
            headers,
            CancellationToken::new(),
        )
        .await
    }

    /// Establish the upstream ws:// or wss:// connection BEFORE accepting the client's 101 upgrade.
    pub async fn connect_upstream_ws(
        &self,
        path_and_query: &str,
        headers: &BTreeMap<String, String>,
    ) -> Result<tokio_tungstenite::WebSocketStream<crate::tls::UpstreamWsStream>, String> {
        let ws_base = if let Some(rest) = self.config.upstream_base_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else if let Some(rest) = self.config.upstream_base_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else {
            self.config.upstream_base_url.clone()
        };
        let canonical = provider_path_and_query(path_and_query)?;
        let url = format!("{ws_base}{canonical}");

        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut req = url
            .into_client_request()
            .map_err(|e| format!("invalid upstream ws url: {e}"))?;
        for (k, v) in headers {
            let lower = k.to_ascii_lowercase();
            if HOP_BY_HOP_HEADERS.contains(&lower.as_str())
                || lower.starts_with("sec-websocket-")
                || is_runner_routing_header(&lower)
            {
                continue;
            }
            if let Some((ref override_k, _)) = self.config.upstream_auth_header
                && override_k.eq_ignore_ascii_case(&lower)
            {
                continue;
            }
            if let (Ok(hk), Ok(hv)) = (
                tokio_tungstenite::tungstenite::http::header::HeaderName::from_bytes(
                    lower.as_bytes(),
                ),
                tokio_tungstenite::tungstenite::http::header::HeaderValue::from_str(v),
            ) {
                req.headers_mut().insert(hk, hv);
            }
        }
        if let Some((ref override_k, ref override_v)) = self.config.upstream_auth_header
            && let (Ok(hk), Ok(hv)) = (
                tokio_tungstenite::tungstenite::http::header::HeaderName::from_bytes(
                    override_k.as_bytes(),
                ),
                tokio_tungstenite::tungstenite::http::header::HeaderValue::from_str(override_v),
            )
        {
            req.headers_mut().insert(hk, hv);
        }

        crate::tls::connect_ws_upstream(req, &self.tls_connector).await
    }

    /// Bridge an upgraded client WebSocket to an already-connected upstream WebSocket,
    /// recording completed turns in connection order while forwarding frames.
    pub async fn bridge_websocket<S>(
        &self,
        client_ws: tokio_tungstenite::WebSocketStream<S>,
        upstream_ws: tokio_tungstenite::WebSocketStream<crate::tls::UpstreamWsStream>,
        path_and_query: &str,
        headers: &BTreeMap<String, String>,
        shutdown: CancellationToken,
    ) -> Result<(), String>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let canonical = provider_path_and_query(path_and_query)?;
        let scope_lane = request_header(headers, SCOPE_LANE_HEADER);
        let redacted_headers = self.config.redact_headers(headers);
        let max_record = self.config.max_record_bytes_per_exchange;
        let (mut client_tx, mut client_rx) = client_ws.split();
        let (mut upstream_tx, mut upstream_rx) = upstream_ws.split();

        let (completed_tx, mut completed_rx) = mpsc::channel(16);
        let writer = self.writer.clone();
        tokio::spawn(async move {
            while let Some((exchange, _in_flight)) = completed_rx.recv().await {
                if let Err(err) = writer.append(exchange).await {
                    tracing::warn!("ws proxy cassette write failed: {err}");
                }
            }
        });
        let enqueue = |job| async {
            completed_tx
                .send(job)
                .await
                .map_err(|_| "ws cassette writer stopped".to_owned())
        };
        let track =
            |turn: WsRecording, outcome| (turn.finish(outcome), self.writer.track_in_flight());

        let mut active_turn: Option<WsRecording> = None;
        let outcome = loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break ExchangeOutcome::ClientDisconnected,
                incoming = client_rx.next() => {
                    let Some(Ok(msg)) = incoming else {
                        break ExchangeOutcome::ClientDisconnected;
                    };
                    if let WsMessage::Text(text) = &msg {
                        if let Some(turn) = active_turn.take() {
                            enqueue(track(turn, ExchangeOutcome::Truncated)).await?;
                        }
                        let body: Value = serde_json::from_str(text).unwrap_or(Value::Null);
                        let model = body["model"].as_str().unwrap_or("").to_owned();
                        let fingerprint = canonical_request_fingerprint(CanonicalRequest {
                            kind: ExchangeKind::WebSocketTurn,
                            method: "WS",
                            path_and_query: &canonical,
                            protocol: Some(Protocol::OpenaiResponsesWs),
                            model: &model,
                            body: &body,
                            headers,
                            scope_lane,
                        });
                        active_turn = Some(WsRecording {
                            exchange: RecordedExchange {
                                kind: ExchangeKind::WebSocketTurn,
                                fingerprint,
                                fingerprint_version: FINGERPRINT_VERSION,
                                method: "WS".into(),
                                path: canonical.to_string(),
                                protocol: Some(Protocol::OpenaiResponsesWs),
                                scope_lane: scope_lane.map(|lane| LogicalLane(lane.into())),
                                model,
                                request_headers: redacted_headers.clone(),
                                request_body: body,
                                status: 200,
                                outcome: ExchangeOutcome::Completed,
                                response_headers: BTreeMap::new(),
                                chunks: Vec::new(),
                            },
                            last_tick: Instant::now(),
                            recorded_bytes: 0,
                        });
                    }
                    let is_close = matches!(msg, WsMessage::Close(_));
                    let sent = upstream_tx.send(msg).await;
                    if is_close {
                        break ExchangeOutcome::ClientDisconnected;
                    }
                    if sent.is_err() {
                        break ExchangeOutcome::UpstreamError;
                    }
                }
                incoming = upstream_rx.next() => {
                    let Some(Ok(msg)) = incoming else {
                        break ExchangeOutcome::UpstreamError;
                    };
                    let terminal = active_turn.is_some()
                        && matches!(&msg, WsMessage::Text(text) if is_ws_terminal_frame(text));
                    if let Some(turn) = &mut active_turn {
                        turn.record(&msg, max_record);
                    }

                    let is_close = matches!(msg, WsMessage::Close(_));
                    let recording = if terminal {
                        active_turn.take().map(|turn| track(turn, ExchangeOutcome::Completed))
                    } else {
                        None
                    };
                    let sent = client_tx.send(msg).await;
                    if let Some(job) = recording {
                        enqueue(job).await?;
                    }
                    if is_close {
                        break ExchangeOutcome::UpstreamError;
                    }
                    if sent.is_err() {
                        break ExchangeOutcome::ClientDisconnected;
                    }
                }
            }
        };

        if let Some(turn) = active_turn {
            enqueue(track(turn, outcome)).await?;
        }

        Ok(())
    }
}

const SCOPED_CONTROL_ERROR: &str = "scoped requests cannot access local control endpoints";

fn provider_path_and_query(raw: &str) -> Result<std::borrow::Cow<'_, str>, String> {
    let canonical = strip_scope_prefix(raw);
    let (path, _) = canonical.split_once('?').unwrap_or((&canonical, ""));
    if canonical != raw && is_local_control_path(path) {
        return Err(SCOPED_CONTROL_ERROR.into());
    }
    Ok(canonical)
}

struct WsRecording {
    exchange: RecordedExchange,
    last_tick: Instant,
    recorded_bytes: usize,
}

impl WsRecording {
    fn record(&mut self, message: &WsMessage, limit: usize) {
        let len = match message {
            WsMessage::Text(text) => text.len(),
            WsMessage::Binary(bytes) => bytes.len(),
            _ => return,
        };
        if self.exchange.outcome == ExchangeOutcome::Truncated {
            return;
        }
        if self.recorded_bytes.saturating_add(len) > limit {
            self.exchange.outcome = ExchangeOutcome::Truncated;
            return;
        }
        let now = Instant::now();
        let delay_ms = now.saturating_duration_since(self.last_tick).as_millis() as u64;
        self.last_tick = now;
        self.recorded_bytes += len;
        self.exchange.chunks.push(match message {
            WsMessage::Text(text) => TimedChunk {
                delay_ms,
                is_binary: false,
                data: text.to_string(),
            },
            WsMessage::Binary(bytes) => TimedChunk::from_binary(delay_ms, bytes),
            _ => unreachable!("only data frames are recorded"),
        });
    }

    fn finish(mut self, outcome: ExchangeOutcome) -> RecordedExchange {
        if self.exchange.outcome != ExchangeOutcome::Truncated {
            self.exchange.outcome = outcome;
        }
        self.exchange
    }
}

fn is_ws_terminal_frame(txt: &str) -> bool {
    let Ok(val) = serde_json::from_str::<Value>(txt) else {
        return false;
    };
    matches!(
        val.get("type").and_then(Value::as_str),
        Some(
            "response.completed"
                | "response.done"
                | "response.incomplete"
                | "response.failed"
                | "error"
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fingerprint_follows_provider_path_query_semantics_and_logical_lane() {
        let body = json!({"messages":[{"role":"user","content":"hello"}], "stream":true});
        let lane = LogicalLane("stable-lane".into());
        let fingerprint = |path, body: &Value, lane| {
            compute_fingerprint_for_lane(ExchangeKind::Http, "POST", path, "model", body, lane)
        };
        let first = fingerprint(
            "/s/run1/a/v1/chat/completions?version=1",
            &body,
            Some(&lane),
        );
        assert_eq!(
            first,
            fingerprint(
                "/s/run2/b/v1/chat/completions?version=1",
                &body,
                Some(&lane)
            )
        );
        assert_ne!(
            first,
            fingerprint("/v1/chat/completions?version=2", &body, Some(&lane))
        );
        assert_ne!(
            first,
            fingerprint("/v1/chat/completions?version=1", &body, None)
        );
        for (option, value) in [
            ("stream", json!(false)),
            ("tool_choice", json!("none")),
            ("parallel_tool_calls", json!(false)),
            ("reasoning", json!({"effort":"low"})),
            ("include", json!(["reasoning.encrypted_content"])),
        ] {
            let mut changed = body.clone();
            changed[option] = value;
            assert_ne!(
                first,
                fingerprint("/v1/chat/completions?version=1", &changed, Some(&lane)),
                "{option}"
            );
        }
    }

    fn recording(fingerprint: &str, outcome: ExchangeOutcome) -> RecordedExchange {
        RecordedExchange {
            kind: ExchangeKind::Http,
            fingerprint: fingerprint.into(),
            fingerprint_version: FINGERPRINT_VERSION,
            method: "POST".into(),
            path: "/v1/responses".into(),
            protocol: Some(Protocol::OpenaiResponsesHttp),
            scope_lane: None,
            model: "model".into(),
            request_headers: BTreeMap::new(),
            request_body: json!({"input":"fixture"}),
            status: 200,
            outcome,
            response_headers: BTreeMap::new(),
            chunks: vec![TimedChunk::from_bytes(0, b"prefix")],
        }
    }

    #[tokio::test]
    async fn strict_replay_distinguishes_response_formats_and_provider_headers() {
        let path = std::env::temp_dir().join(format!(
            "maka-mock-ai-{}-{}.ndjson",
            std::process::id(),
            fastrand::u64(..),
        ));
        let upstream = crate::MockAiBuilder::new()
            .custom_route(Arc::new(|_, path, headers, body| {
                let body: Value = serde_json::from_slice(body).unwrap();
                let format = match path {
                    "/v1/chat/completions" => body["response_format"]["type"].as_str(),
                    "/v1/responses" => body["text"]["format"]["type"].as_str(),
                    "/v1/messages" => headers.get("anthropic-beta").map(String::as_str),
                    _ => return None,
                };
                Some(crate::control::CustomResponse::text(
                    200,
                    format.unwrap().to_string(),
                ))
            }))
            .start()
            .await
            .unwrap();
        let recorder = crate::MockAiBuilder::new()
            .proxy_record(ProxyRecordConfig::new(upstream.origin_url(), &path))
            .unwrap()
            .start()
            .await
            .unwrap();
        let cases = [
            (
                "/chat/completions",
                json!({"model":"model", "messages":[{"role":"user","content":"hi"}],
                       "response_format":{"type":"text"}}),
                None,
                "text",
            ),
            (
                "/chat/completions",
                json!({"model":"model", "messages":[{"role":"user","content":"hi"}],
                       "response_format":{"type":"json_object"}}),
                None,
                "json_object",
            ),
            (
                "/responses",
                json!({"model":"model", "input":"hi", "text":{"format":{"type":"text"}}}),
                None,
                "text",
            ),
            (
                "/responses",
                json!({"model":"model", "input":"hi", "text":{"format":{"type":"json_object"}}}),
                None,
                "json_object",
            ),
            (
                "/messages",
                json!({"model":"model", "messages":[{"role":"user","content":"hi"}], "max_tokens":8}),
                Some("first-beta"),
                "first-beta",
            ),
            (
                "/messages",
                json!({"model":"model", "messages":[{"role":"user","content":"hi"}], "max_tokens":8}),
                Some("second-beta"),
                "second-beta",
            ),
        ];
        let client = reqwest::Client::new();
        let send = |base: String, (path, body, beta, _): &(&str, Value, Option<&str>, &str)| {
            let mut request = client
                .post(format!("{base}{path}?variant=1"))
                .header(SCOPE_LANE_HEADER, "fixture-lane")
                .header("content-type", "application/json")
                .body(body.to_string());
            if let Some(beta) = beta {
                request = request.header("anthropic-beta", *beta);
            }
            request
        };
        for case in &cases {
            let response = send(recorder.base_url(), case).send().await.unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.text().await.unwrap(), case.3);
        }
        recorder.shutdown().await;
        upstream.shutdown().await;

        let exchanges = load_ndjson(&path).unwrap();
        assert_eq!(exchanges.len(), cases.len());
        assert!(exchanges.iter().all(|exchange| {
            exchange.fingerprint_version == 2
                && exchange
                    .scope_lane
                    .as_ref()
                    .is_some_and(|lane| lane.0 == "fixture-lane")
        }));
        let replay = crate::MockAiBuilder::new()
            .replay(
                ReplayConfig::new(&path)
                    .with_match_mode(ReplayMatchMode::Fingerprint)
                    .with_strict_replay(),
            )
            .unwrap()
            .start()
            .await
            .unwrap();
        std::fs::remove_file(path).unwrap();
        for case in cases.iter().rev() {
            let response = send(replay.base_url(), case).send().await.unwrap();
            let status = response.status();
            let body = response.text().await.unwrap();
            assert_eq!(status, 200, "{body}");
            assert_eq!(body, case.3);
        }
        replay.shutdown().await;
    }

    #[test]
    fn replay_rebuilds_legacy_fingerprints_from_captured_requests() {
        let path = std::env::temp_dir().join(format!(
            "maka-mock-ai-{}-{}.ndjson",
            std::process::id(),
            fastrand::u64(..),
        ));
        let mut text = json!({
            "kind":"http", "fingerprint":"444b7668ab871a1b",
            "method":"POST", "path":"/v1/responses", "model":"model",
            "requestHeaders":{},
            "requestBody":{"model":"model", "input":"fixture", "text":{"format":{"type":"text"}}},
            "status":200, "chunks":[{"delayMs":0, "data":"plain text"}]
        });
        let plain_body = text["requestBody"].clone();
        let mut object = text.clone();
        object["fingerprintVersion"] = json!(1);
        object["requestBody"]["text"]["format"]["type"] = json!("json_object");
        object["chunks"][0]["data"] = json!("JSON object");
        std::fs::write(&path, format!("{text}\n{object}")).unwrap();
        let config = ReplayConfig::new(&path)
            .with_match_mode(ReplayMatchMode::Fingerprint)
            .with_strict_replay();
        let replay = CassetteReplayer::load(config.clone()).unwrap();
        let fingerprint =
            |body| compute_fingerprint(ExchangeKind::Http, "POST", "/v1/responses", "model", body);
        for (body, expected) in [
            (&object["requestBody"], "JSON object"),
            (&plain_body, "plain text"),
        ] {
            let exchange = replay.try_next_http(&fingerprint(body)).unwrap();
            assert_eq!(exchange.chunks[0].data, expected);
        }

        for legacy_key in [
            "740f6f69133b0227", // The recorder stripped a lane that it hashed.
            "d100b0c6244cef32", // The earliest recorder always discarded query.
        ] {
            text["fingerprint"] = json!(legacy_key);
            std::fs::write(&path, text.to_string()).unwrap();
            let error = CassetteReplayer::load(config.clone()).err().unwrap();
            assert!(error.contains("cassette incompatible at line 1"), "{error}");
            assert!(error.contains("cannot be reconstructed"), "{error}");
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn fingerprint_and_strict_load_reject_incomplete_legacy_requests() {
        let path = std::env::temp_dir().join(format!(
            "maka-mock-ai-{}-{}.ndjson",
            std::process::id(),
            fastrand::u64(..),
        ));
        let mut legacy =
            serde_json::to_value(recording("d100b0c6244cef32", ExchangeOutcome::Completed))
                .unwrap();
        legacy["fingerprintVersion"] = json!(0);
        for missing in ["requestHeaders", "requestBody"] {
            let mut incomplete = legacy.clone();
            incomplete.as_object_mut().unwrap().remove(missing);
            std::fs::write(&path, incomplete.to_string()).unwrap();
            for config in [
                ReplayConfig::new(&path).with_match_mode(ReplayMatchMode::Fingerprint),
                ReplayConfig::new(&path).with_strict_replay(),
            ] {
                let error = CassetteReplayer::load(config).err().unwrap();
                assert!(error.contains("cassette incompatible at line 1"), "{error}");
                assert!(error.contains(missing), "{error}");
            }
            let sequential = CassetteReplayer::load(ReplayConfig::new(&path)).unwrap();
            let exchange = sequential.try_next_http("anything").unwrap();
            assert_eq!(exchange.chunks[0].data, "prefix");
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn strict_replay_never_falls_back_wraps_or_accepts_truncation() {
        let path = std::env::temp_dir().join(format!(
            "maka-mock-ai-{}-{}.ndjson",
            std::process::id(),
            fastrand::u64(..),
        ));
        let first = "a".repeat(64);
        let second = "b".repeat(64);
        let lines = [
            recording(&first, ExchangeOutcome::Completed),
            recording(&second, ExchangeOutcome::Truncated),
        ]
        .map(|exchange| serde_json::to_string(&exchange).unwrap())
        .join("\n");
        std::fs::write(&path, lines).unwrap();
        let replay = CassetteReplayer::load(
            ReplayConfig::new(&path)
                .with_match_mode(ReplayMatchMode::Fingerprint)
                .with_strict_replay(),
        );
        std::fs::remove_file(path).unwrap();
        let replay = replay.unwrap();

        assert_eq!(
            replay.try_next_http("missing").unwrap_err(),
            ReplayError::Miss
        );
        assert_eq!(replay.try_next_http(&first).unwrap().fingerprint, first);
        assert_eq!(
            replay.try_next_http(&first).unwrap_err(),
            ReplayError::Exhausted
        );
        assert_eq!(
            replay.try_next_http(&second).unwrap_err(),
            ReplayError::Truncated
        );
    }

    #[tokio::test]
    async fn scoped_http_preserves_provider_query_and_headers() {
        let upstream = crate::MockAiBuilder::new().start().await.unwrap();
        let path = std::env::temp_dir().join(format!(
            "maka-mock-ai-{}-{}.ndjson",
            std::process::id(),
            fastrand::u64(..),
        ));
        let proxy =
            ProxyRecorder::new(ProxyRecordConfig::new(upstream.origin_url(), &path)).unwrap();
        let headers = BTreeMap::from([
            ("x-maka-bench-session".into(), "fixture-session".into()),
            ("x-maka-session-id".into(), "fixture-session".into()),
            ("openai-beta".into(), "responses=experimental".into()),
        ]);
        let mut response = proxy
            .forward_http(
                "GET",
                "/s/run/session/v1/models?client_version=1",
                None,
                &headers,
                Bytes::new(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.rx.recv().await {
            bytes.extend(chunk.unwrap());
        }
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["models"][0]["slug"], "mock-model");
        let recorded = upstream.control_plane_requests();
        assert_eq!(recorded[0].path, "/v1/models");
        assert_eq!(recorded[0].query.as_deref(), Some("client_version=1"));
        assert_eq!(recorded[0].headers["openai-beta"], "responses=experimental");
        assert!(!recorded[0].headers.contains_key("x-maka-bench-session"));
        assert!(!recorded[0].headers.contains_key("x-maka-session-id"));

        for path in ["/s/run/session/metrics", "/s/run/session/v1/%2e%2e/metrics"] {
            let result = proxy
                .forward_http(
                    "GET",
                    path,
                    None,
                    &headers,
                    Bytes::new(),
                    CancellationToken::new(),
                )
                .await;
            assert_eq!(result.err().as_deref(), Some(SCOPED_CONTROL_ERROR));
        }

        proxy.flush().await;
        let recorded = load_ndjson(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(recorded[0].path, "/v1/models?client_version=1");
        upstream.shutdown().await;
    }

    #[tokio::test]
    async fn http_replay_emits_recorded_prefix_and_then_clean_eof_or_body_error() {
        for (outcome, terminal_error) in [
            (ExchangeOutcome::Completed, None),
            (ExchangeOutcome::Truncated, Some(ReplayBodyError::Truncated)),
            (
                ExchangeOutcome::UpstreamError,
                Some(ReplayBodyError::UpstreamError),
            ),
            (
                ExchangeOutcome::ClientDisconnected,
                Some(ReplayBodyError::ClientDisconnected),
            ),
        ] {
            let config = ReplayConfig::new("unused").with_speed(0.0);
            let replay = recording("http", outcome).replay_http_body(config);
            let mut replay = std::pin::pin!(replay);
            assert_eq!(replay.next().await, Some(Ok(Bytes::from_static(b"prefix"))));
            assert_eq!(replay.next().await, terminal_error.map(Err));
            if terminal_error.is_some() {
                assert_eq!(replay.next().await, None);
            }
        }
    }
}
