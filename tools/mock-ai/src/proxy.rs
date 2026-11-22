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
            Err(_) => Self {
                delay_ms,
                is_binary: true,
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            },
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
    pub method: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<Protocol>,
    pub model: String,
    #[serde(default)]
    pub request_headers: BTreeMap<String, String>,
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
    /// Match by request fingerprint `(kind, path, model, message_count, last_user)`, with optional sequential fallback.
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

/// Compute a stable fingerprint for matching requests across runs despite volatile headers/IDs.
pub fn compute_fingerprint(
    kind: ExchangeKind,
    method: &str,
    path: &str,
    model: &str,
    body: &Value,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(match kind {
        ExchangeKind::Http => b"http|" as &[u8],
        ExchangeKind::WebSocketTurn => b"ws|" as &[u8],
    });
    hasher.update(method.as_bytes());
    hasher.update(b"|");
    hasher.update(path.as_bytes());
    hasher.update(b"|");
    hasher.update(model.as_bytes());
    hasher.update(b"|");
    // Hash semantic request content (system/instructions, declared tools, and full message/input
    // sequence) while ignoring volatile transport/cache fields so distinct prompts never collide.
    if let Some(sys) = body.get("system").or_else(|| body.get("instructions")) {
        hasher.update(b"sys:");
        hasher.update(sys.to_string().as_bytes());
        hasher.update(b"|");
    }
    if let Some(tools) = body.get("tools") {
        hasher.update(b"tools:");
        hasher.update(tools.to_string().as_bytes());
        hasher.update(b"|");
    }
    if let Some(prev) = body.get("previous_response_id").and_then(Value::as_str) {
        hasher.update(b"prev:");
        hasher.update(prev.as_bytes());
        hasher.update(b"|");
    }
    if let Some(msgs) = body.get("messages").or_else(|| body.get("input")) {
        hasher.update(b"msgs:");
        hasher.update(msgs.to_string().as_bytes());
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(16);
    for b in &digest[..8] {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

pub fn fingerprint_from_normalized(req: &NormalizedRequest) -> String {
    let kind = if req.protocol == Protocol::OpenaiResponsesWs {
        ExchangeKind::WebSocketTurn
    } else {
        ExchangeKind::Http
    };
    let method = if kind == ExchangeKind::WebSocketTurn {
        "WS"
    } else {
        "POST"
    };
    compute_fingerprint(kind, method, &req.path, &req.model, &req.raw_body)
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
    fp_cursors: Mutex<HashMap<String, usize>>,
}

impl CassetteReplayer {
    pub fn load(config: ReplayConfig) -> Result<Self, String> {
        let exchanges = load_ndjson(&config.cassette_path)?;
        let mut http_exchanges = Vec::new();
        let mut ws_exchanges = Vec::new();
        let mut http_by_fp: HashMap<String, Vec<usize>> = HashMap::new();
        let mut ws_by_fp: HashMap<String, Vec<usize>> = HashMap::new();

        for ex in exchanges {
            match ex.kind {
                ExchangeKind::Http => {
                    let idx = http_exchanges.len();
                    http_by_fp
                        .entry(ex.fingerprint.clone())
                        .or_default()
                        .push(idx);
                    http_exchanges.push(ex);
                }
                ExchangeKind::WebSocketTurn => {
                    let idx = ws_exchanges.len();
                    ws_by_fp
                        .entry(ex.fingerprint.clone())
                        .or_default()
                        .push(idx);
                    ws_exchanges.push(ex);
                }
            }
        }

        Ok(Self {
            config,
            http_exchanges,
            ws_exchanges,
            http_cursor: AtomicUsize::new(0),
            ws_cursor: AtomicUsize::new(0),
            http_by_fp,
            ws_by_fp,
            fp_cursors: Mutex::new(HashMap::new()),
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
        self.fp_cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    pub fn next_http(&self, fingerprint: &str) -> Option<&RecordedExchange> {
        self.next_http_if(fingerprint, |_| true)
    }

    /// Select the next HTTP exchange only if `accept` returns true; never advances cursors on rejection.
    pub fn next_http_if(
        &self,
        fingerprint: &str,
        accept: impl Fn(&RecordedExchange) -> bool,
    ) -> Option<&RecordedExchange> {
        self.select(
            &self.http_exchanges,
            &self.http_cursor,
            &self.http_by_fp,
            fingerprint,
            accept,
        )
    }

    pub fn next_ws(&self, fingerprint: &str) -> Option<&RecordedExchange> {
        self.select(
            &self.ws_exchanges,
            &self.ws_cursor,
            &self.ws_by_fp,
            fingerprint,
            |_| true,
        )
    }

    fn select<'a>(
        &'a self,
        list: &'a [RecordedExchange],
        cursor: &AtomicUsize,
        by_fp: &HashMap<String, Vec<usize>>,
        fingerprint: &str,
        accept: impl Fn(&RecordedExchange) -> bool,
    ) -> Option<&'a RecordedExchange> {
        if list.is_empty() {
            return None;
        }
        if self.config.match_mode == ReplayMatchMode::Fingerprint {
            if let Some(indices) = by_fp.get(fingerprint) {
                let mut fp_map = self.fp_cursors.lock().unwrap_or_else(|e| e.into_inner());
                let slot = fp_map.entry(fingerprint.to_string()).or_insert(0);
                let pos = if *slot < indices.len() {
                    *slot
                } else if self.config.loop_cassette {
                    *slot % indices.len()
                } else {
                    indices.len() - 1
                };
                let candidate = list.get(indices[pos])?;
                if !accept(candidate) {
                    return None;
                }
                if *slot < indices.len() || self.config.loop_cassette {
                    *slot += 1;
                }
                return Some(candidate);
            }
            if !self.config.fallback_to_sequential {
                return None;
            }
        }

        // Atomically peek-and-validate before advancing sequential cursor so a rejected request
        // (e.g. mismatched previous_response_id) never consumes the next recorded exchange.
        loop {
            let idx = cursor.load(Ordering::Acquire);
            let target = if idx < list.len() {
                idx
            } else if self.config.loop_cassette {
                idx % list.len()
            } else {
                return None;
            };
            let candidate = list.get(target)?;
            if !accept(candidate) {
                return None;
            }
            if cursor
                .compare_exchange(idx, idx + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Some(candidate);
            }
        }
    }
}

pub fn load_ndjson(path: &Path) -> Result<Vec<RecordedExchange>, String> {
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
        let ex: RecordedExchange = serde_json::from_str(trimmed)
            .map_err(|e| format!("invalid cassette JSON at line {}: {e}", idx + 1))?;
        out.push(ex);
    }
    Ok(out)
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
        let url = format!("{}{}", self.config.upstream_base_url, path_and_query);
        let req_method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|e| format!("invalid HTTP method {method}: {e}"))?;
        let mut builder = self.client.request(req_method, &url);

        for (k, v) in headers {
            let lower = k.to_ascii_lowercase();
            if HOP_BY_HOP_HEADERS.contains(&lower.as_str()) || lower == "accept-encoding" {
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
        let path_only = path_and_query
            .split('?')
            .next()
            .unwrap_or(path_and_query)
            .to_string();
        let fingerprint =
            compute_fingerprint(ExchangeKind::Http, method, &path_only, &model, &req_json);

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
            let mut truncated = false;
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
                        if !truncated {
                            if recorded_bytes.saturating_add(chunk.len()) <= max_record {
                                recorded_bytes = recorded_bytes.saturating_add(chunk.len());
                                chunks.push(TimedChunk::from_bytes(delay_ms, &chunk));
                            } else {
                                // Stop recording once capped so we never save a broken stream with missing middle + terminal.
                                truncated = true;
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
                        outcome = ExchangeOutcome::UpstreamError;
                        let _ = tx.send(Err(format!("upstream stream error: {err}"))).await;
                        break;
                    }
                }
            }

            let exchange = RecordedExchange {
                kind: ExchangeKind::Http,
                fingerprint,
                method: method_owned,
                path: path_only,
                protocol,
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
        let ws_base = if let Some(rest) = self.config.upstream_base_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else if let Some(rest) = self.config.upstream_base_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else {
            self.config.upstream_base_url.clone()
        };
        let url = format!("{ws_base}{path_and_query}");

        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut req = url
            .into_client_request()
            .map_err(|e| format!("invalid upstream ws url: {e}"))?;
        for (k, v) in headers {
            let lower = k.to_ascii_lowercase();
            if HOP_BY_HOP_HEADERS.contains(&lower.as_str()) || lower.starts_with("sec-websocket-") {
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
                tokio_tungstenite::tungstenite::http::HeaderValue::from_str(v),
            ) {
                req.headers_mut().insert(hk, hv);
            }
        }
        if let Some((ref override_k, ref override_v)) = self.config.upstream_auth_header
            && let (Ok(hk), Ok(hv)) = (
                tokio_tungstenite::tungstenite::http::header::HeaderName::from_bytes(
                    override_k.as_bytes(),
                ),
                tokio_tungstenite::tungstenite::http::HeaderValue::from_str(override_v),
            )
        {
            req.headers_mut().insert(hk, hv);
        }

        let upstream_ws = crate::tls::connect_ws_upstream(req, &self.tls_connector).await?;
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
        let url = format!("{ws_base}{path_and_query}");

        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut req = url
            .into_client_request()
            .map_err(|e| format!("invalid upstream ws url: {e}"))?;
        for (k, v) in headers {
            let lower = k.to_ascii_lowercase();
            if HOP_BY_HOP_HEADERS.contains(&lower.as_str()) || lower.starts_with("sec-websocket-") {
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
    /// flushing each completed turn immediately upon terminal frames so shutdown never drops it.
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
        let (mut client_tx, mut client_rx) = client_ws.split();
        let (mut upstream_tx, mut upstream_rx) = upstream_ws.split();
        let path_only = path_and_query
            .split('?')
            .next()
            .unwrap_or(path_and_query)
            .to_string();
        let redacted_headers = self.config.redact_headers(headers);

        struct WsTurnBuf {
            fp: String,
            model: String,
            req_body: Value,
            last_tick: Instant,
            chunks: Vec<TimedChunk>,
            recorded_bytes: usize,
            outcome: ExchangeOutcome,
        }
        let max_record = self.config.max_record_bytes_per_exchange;
        let mut active_turn: Option<WsTurnBuf> = None;

        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => {
                    if let Some(ref mut turn) = active_turn
                        && turn.outcome == ExchangeOutcome::Completed
                    {
                        turn.outcome = ExchangeOutcome::ClientDisconnected;
                    }
                    break;
                }
                c_msg = client_rx.next() => {
                    match c_msg {
                        Some(Ok(msg)) => {
                            if let WsMessage::Text(ref txt) = msg {
                                if let Some(turn) = active_turn.take() {
                                    let ex = RecordedExchange {
                                        kind: ExchangeKind::WebSocketTurn,
                                        fingerprint: turn.fp,
                                        method: "WS".into(),
                                        path: path_only.clone(),
                                        protocol: Some(Protocol::OpenaiResponsesWs),
                                        model: turn.model,
                                        request_headers: redacted_headers.clone(),
                                        request_body: turn.req_body,
                                        status: 200,
                                        outcome: turn.outcome,
                                        response_headers: BTreeMap::new(),
                                        chunks: turn.chunks,
                                    };
                                    if let Err(err) = self.writer.append(ex).await {
                                        tracing::warn!("ws proxy cassette write failed: {err}");
                                    }
                                }
                                let body: Value = serde_json::from_str(txt).unwrap_or(Value::Null);
                                let model = body.get("model").and_then(Value::as_str).unwrap_or("").to_string();
                                let fp = compute_fingerprint(ExchangeKind::WebSocketTurn, "WS", &path_only, &model, &body);
                                active_turn = Some(WsTurnBuf {
                                    fp,
                                    model,
                                    req_body: body,
                                    last_tick: Instant::now(),
                                    chunks: Vec::new(),
                                    recorded_bytes: 0,
                                    outcome: ExchangeOutcome::Completed,
                                });
                            }
                            let is_close = matches!(msg, WsMessage::Close(_));
                            if upstream_tx.send(msg).await.is_err() || is_close {
                                break;
                            }
                        }
                        _ => {
                            if let Some(ref mut turn) = active_turn
                                && turn.outcome == ExchangeOutcome::Completed {
                                    turn.outcome = ExchangeOutcome::ClientDisconnected;
                                }
                            break;
                        }
                    }
                }
                u_msg = upstream_rx.next() => {
                    match u_msg {
                        Some(Ok(msg)) => {
                            let mut is_terminal = false;
                            if let Some(ref mut turn) = active_turn {
                                match &msg {
                                    WsMessage::Text(txt) => {
                                        is_terminal = is_ws_terminal_frame(txt);
                                        if turn.outcome != ExchangeOutcome::Truncated {
                                            let now = Instant::now();
                                            let delay = now.saturating_duration_since(turn.last_tick).as_millis() as u64;
                                            turn.last_tick = now;
                                            if turn.recorded_bytes.saturating_add(txt.len()) <= max_record {
                                                turn.recorded_bytes += txt.len();
                                                turn.chunks.push(TimedChunk {
                                                    delay_ms: delay,
                                                    is_binary: false,
                                                    data: txt.to_string(),
                                                });
                                            } else {
                                                turn.outcome = ExchangeOutcome::Truncated;
                                            }
                                        }
                                    }
                                    WsMessage::Binary(bin)
                                        if turn.outcome != ExchangeOutcome::Truncated =>
                                    {
                                        let now = Instant::now();
                                        let delay = now.saturating_duration_since(turn.last_tick).as_millis() as u64;
                                        turn.last_tick = now;
                                        if turn.recorded_bytes.saturating_add(bin.len()) <= max_record {
                                            turn.recorded_bytes += bin.len();
                                            turn.chunks.push(TimedChunk::from_bytes(delay, bin));
                                        } else {
                                            turn.outcome = ExchangeOutcome::Truncated;
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            let is_close = matches!(msg, WsMessage::Close(_));
                            // Flush terminal turn BEFORE delivering the terminal frame to the client
                            // so immediate post-turn shutdown/replay always sees the persisted record.
                            if is_terminal
                                && let Some(turn) = active_turn.take()
                            {
                                let ex = RecordedExchange {
                                    kind: ExchangeKind::WebSocketTurn,
                                    fingerprint: turn.fp,
                                    method: "WS".into(),
                                    path: path_only.clone(),
                                    protocol: Some(Protocol::OpenaiResponsesWs),
                                    model: turn.model,
                                    request_headers: redacted_headers.clone(),
                                    request_body: turn.req_body,
                                    status: 200,
                                    outcome: turn.outcome,
                                    response_headers: BTreeMap::new(),
                                    chunks: turn.chunks,
                                };
                                if let Err(err) = self.writer.append(ex).await {
                                    tracing::warn!("ws proxy cassette write failed: {err}");
                                }
                            }
                            if client_tx.send(msg).await.is_err() || is_close {
                                break;
                            }
                        }
                        _ => {
                            if let Some(ref mut turn) = active_turn
                                && turn.outcome == ExchangeOutcome::Completed {
                                    turn.outcome = ExchangeOutcome::UpstreamError;
                                }
                            break;
                        }
                    }
                }
            }
        }

        if let Some(turn) = active_turn.take()
            && !turn.chunks.is_empty()
        {
            let ex = RecordedExchange {
                kind: ExchangeKind::WebSocketTurn,
                fingerprint: turn.fp,
                method: "WS".into(),
                path: path_only,
                protocol: Some(Protocol::OpenaiResponsesWs),
                model: turn.model,
                request_headers: redacted_headers,
                request_body: turn.req_body,
                status: 200,
                outcome: turn.outcome,
                response_headers: BTreeMap::new(),
                chunks: turn.chunks,
            };
            if let Err(err) = self.writer.append(ex).await {
                tracing::warn!("ws proxy cassette write failed: {err}");
            }
        }

        Ok(())
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
