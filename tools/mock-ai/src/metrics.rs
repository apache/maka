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
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, RwLock};

/// Controls how much request history is retained in memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RecorderMode {
    /// Retain every request (convenient for unit/integration tests).
    #[default]
    Full,
    /// Retain only the most recent requests within entry & byte budgets.
    Ring {
        capacity: usize,
        #[serde(default = "default_ring_max_bytes")]
        max_bytes: usize,
    },
    /// Retain zero request payloads; keep atomic counters only (for 10k+ concurrency load tests).
    MetricsOnly,
}

fn default_ring_max_bytes() -> usize {
    64 * 1024 * 1024
}

/// Compact record of an observed control-plane or custom HTTP request (e.g. `GET /v1/models`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedControlRequest {
    pub method: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    pub headers: BTreeMap<String, String>,
}

/// Compact record of an observed model turn request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRequest {
    pub sequence: u64,
    pub protocol: Protocol,
    pub path: String,
    pub model: String,
    pub session_key: String,
    pub stream: bool,
    pub prompt_bytes: usize,
    pub headers: BTreeMap<String, String>,
    pub raw_body: Value,
}

impl From<&NormalizedRequest> for RecordedRequest {
    fn from(req: &NormalizedRequest) -> Self {
        Self {
            sequence: req.sequence,
            protocol: req.protocol,
            path: req.path.clone(),
            model: req.model.clone(),
            session_key: req.session_key.clone(),
            stream: req.stream,
            prompt_bytes: req.prompt_bytes,
            headers: req.headers.clone(),
            raw_body: req.raw_body.clone(),
        }
    }
}

/// Exponential bucket boundaries for latency histograms (ms): 0ms up to 120s.
const LATENCY_BOUNDS: &[u64] = &[
    1, 2, 5, 10, 20, 35, 50, 75, 100, 150, 200, 300, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000,
    7_500, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 120_000,
];

/// Exponential bucket boundaries for byte-size histograms (256B up to 64MiB).
const BYTES_BOUNDS: &[u64] = &[
    256, 512, 1_024, 2_048, 4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144, 524_288,
    1_048_576, 2_097_152, 4_194_304, 8_388_608, 16_777_216, 33_554_432, 67_108_864,
];

/// Bucket boundaries for effective streaming throughput (tokens/sec).
const TPS_BOUNDS: &[u64] = &[
    1, 5, 10, 20, 35, 50, 75, 100, 150, 250, 500, 1_000, 2_500, 5_000, 10_000, 50_000,
];

/// Summary percentiles computed from a lock-free `AtomicHistogram`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistogramSummary {
    pub count: u64,
    pub sum: u64,
    pub avg: u64,
    pub p50: u64,
    pub p90: u64,
    pub p95: u64,
    pub p99: u64,
    pub max: u64,
}

/// Lock-free fixed-bucket atomic histogram with zero heap allocations on record.
pub struct AtomicHistogram {
    bounds: &'static [u64],
    buckets: Vec<AtomicU64>,
    count: AtomicU64,
    sum: AtomicU64,
    max: AtomicU64,
}

impl AtomicHistogram {
    pub fn new(bounds: &'static [u64]) -> Self {
        let mut buckets = Vec::with_capacity(bounds.len() + 1);
        for _ in 0..=bounds.len() {
            buckets.push(AtomicU64::new(0));
        }
        Self {
            bounds,
            buckets,
            count: AtomicU64::new(0),
            sum: AtomicU64::new(0),
            max: AtomicU64::new(0),
        }
    }

    pub fn record(&self, value: u64) {
        let idx = self.bounds.partition_point(|&b| b < value);
        self.buckets[idx].fetch_add(1, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
        self.sum.fetch_add(value, Ordering::Relaxed);
        self.max.fetch_max(value, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> HistogramSummary {
        let count = self.count.load(Ordering::Relaxed);
        if count == 0 {
            return HistogramSummary::default();
        }
        let sum = self.sum.load(Ordering::Relaxed);
        let max = self.max.load(Ordering::Relaxed);
        let counts: Vec<u64> = self
            .buckets
            .iter()
            .map(|b| b.load(Ordering::Relaxed))
            .collect();
        let pct = |q: f64| -> u64 {
            let target = ((count as f64) * q).ceil().max(1.0) as u64;
            let mut acc = 0u64;
            for (i, c) in counts.iter().enumerate() {
                acc += *c;
                if acc >= target {
                    return self.bounds.get(i).copied().unwrap_or(max).min(max);
                }
            }
            max
        };
        HistogramSummary {
            count,
            sum,
            avg: sum / count,
            p50: pct(0.50),
            p90: pct(0.90),
            p95: pct(0.95),
            p99: pct(0.99),
            max,
        }
    }

    pub fn reset(&self) {
        for b in &self.buckets {
            b.store(0, Ordering::Relaxed);
        }
        self.count.store(0, Ordering::Relaxed);
        self.sum.store(0, Ordering::Relaxed);
        self.max.store(0, Ordering::Relaxed);
    }

    fn write_prometheus(&self, out: &mut String, name: &str, help: &str) {
        let _ = writeln!(out, "# HELP {name} {help}");
        let _ = writeln!(out, "# TYPE {name} histogram");
        self.write_prometheus_series(out, name, "");
    }

    fn write_prometheus_series(&self, out: &mut String, name: &str, labels_prefix: &str) {
        let mut cumulative = 0u64;
        for (i, bound) in self.bounds.iter().enumerate() {
            cumulative += self.buckets[i].load(Ordering::Relaxed);
            if labels_prefix.is_empty() {
                let _ = writeln!(out, "{name}_bucket{{le=\"{bound}\"}} {cumulative}");
            } else {
                let _ = writeln!(
                    out,
                    "{name}_bucket{{{labels_prefix},le=\"{bound}\"}} {cumulative}"
                );
            }
        }
        cumulative += self.buckets[self.bounds.len()].load(Ordering::Relaxed);
        if labels_prefix.is_empty() {
            let _ = writeln!(out, "{name}_bucket{{le=\"+Inf\"}} {cumulative}");
            let _ = writeln!(out, "{name}_sum {}", self.sum.load(Ordering::Relaxed));
            let _ = writeln!(out, "{name}_count {}", self.count.load(Ordering::Relaxed));
        } else {
            let _ = writeln!(
                out,
                "{name}_bucket{{{labels_prefix},le=\"+Inf\"}} {cumulative}"
            );
            let _ = writeln!(
                out,
                "{name}_sum{{{labels_prefix}}} {}",
                self.sum.load(Ordering::Relaxed)
            );
            let _ = writeln!(
                out,
                "{name}_count{{{labels_prefix}}} {}",
                self.count.load(Ordering::Relaxed)
            );
        }
    }
}

/// Per-(protocol, model, status_class) dimensional counter & latency slice.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionCounter {
    pub protocol: String,
    pub model: String,
    pub status_class: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub ttft_ms: HistogramSummary,
    pub turn_duration_ms: HistogramSummary,
}

struct DimensionState {
    protocol: String,
    model: String,
    status_class: String,
    requests: AtomicU64,
    input_tokens: AtomicU64,
    output_tokens: AtomicU64,
    cache_read_tokens: AtomicU64,
    ttft_ms: AtomicHistogram,
    turn_duration_ms: AtomicHistogram,
}

impl DimensionState {
    fn new(protocol: String, model: String, status_class: String) -> Self {
        Self {
            protocol,
            model,
            status_class,
            requests: AtomicU64::new(0),
            input_tokens: AtomicU64::new(0),
            output_tokens: AtomicU64::new(0),
            cache_read_tokens: AtomicU64::new(0),
            ttft_ms: AtomicHistogram::new(LATENCY_BOUNDS),
            turn_duration_ms: AtomicHistogram::new(LATENCY_BOUNDS),
        }
    }

    fn snapshot(&self) -> DimensionCounter {
        DimensionCounter {
            protocol: self.protocol.clone(),
            model: self.model.clone(),
            status_class: self.status_class.clone(),
            requests: self.requests.load(Ordering::Relaxed),
            input_tokens: self.input_tokens.load(Ordering::Relaxed),
            output_tokens: self.output_tokens.load(Ordering::Relaxed),
            cache_read_tokens: self.cache_read_tokens.load(Ordering::Relaxed),
            ttft_ms: self.ttft_ms.snapshot(),
            turn_duration_ms: self.turn_duration_ms.snapshot(),
        }
    }
}

const MAX_DIMENSION_KEYS: usize = 256;

/// Point-in-time snapshot of server metrics (safe to serialize over `/admin/metrics`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub active_connections: usize,
    pub active_streams: usize,
    pub total_requests: u64,
    pub chat_completions_requests: u64,
    pub responses_http_requests: u64,
    pub responses_ws_turns: u64,
    pub anthropic_requests: u64,
    pub control_plane_requests: u64,
    pub ws_upgrades: u64,
    pub http_errors_emitted: u64,
    pub rate_limits_emitted: u64,
    pub context_overflows_emitted: u64,
    pub mid_stream_errors_emitted: u64,
    pub connection_drops_emitted: u64,
    pub stalls_entered: u64,
    pub native_compactions_emitted: u64,
    pub abandoned_streams: u64,
    pub proxy_requests: u64,
    pub replay_hits: u64,
    pub bytes_received: u64,
    pub bytes_sent: u64,
    pub ttft_ms: HistogramSummary,
    pub turn_duration_ms: HistogramSummary,
    pub prompt_bytes: HistogramSummary,
    pub effective_tps: HistogramSummary,
    pub by_dimension: Vec<DimensionCounter>,
}

/// Lock-free atomic metrics updated on every request/stream event.
pub struct ServerMetrics {
    pub active_connections: AtomicUsize,
    pub active_streams: AtomicUsize,
    pub total_requests: AtomicU64,
    pub chat_completions_requests: AtomicU64,
    pub responses_http_requests: AtomicU64,
    pub responses_ws_turns: AtomicU64,
    pub anthropic_requests: AtomicU64,
    pub control_plane_requests: AtomicU64,
    pub ws_upgrades: AtomicU64,
    pub http_errors_emitted: AtomicU64,
    pub rate_limits_emitted: AtomicU64,
    pub context_overflows_emitted: AtomicU64,
    pub mid_stream_errors_emitted: AtomicU64,
    pub connection_drops_emitted: AtomicU64,
    pub stalls_entered: AtomicU64,
    pub native_compactions_emitted: AtomicU64,
    pub abandoned_streams: AtomicU64,
    pub proxy_requests: AtomicU64,
    pub replay_hits: AtomicU64,
    pub bytes_received: AtomicU64,
    pub bytes_sent: AtomicU64,
    pub ttft_ms: AtomicHistogram,
    pub turn_duration_ms: AtomicHistogram,
    pub prompt_bytes_hist: AtomicHistogram,
    pub effective_tps: AtomicHistogram,
    dimensions: RwLock<HashMap<(String, String, String), std::sync::Arc<DimensionState>>>,
}

impl Default for ServerMetrics {
    fn default() -> Self {
        Self {
            active_connections: AtomicUsize::new(0),
            active_streams: AtomicUsize::new(0),
            total_requests: AtomicU64::new(0),
            chat_completions_requests: AtomicU64::new(0),
            responses_http_requests: AtomicU64::new(0),
            responses_ws_turns: AtomicU64::new(0),
            anthropic_requests: AtomicU64::new(0),
            control_plane_requests: AtomicU64::new(0),
            ws_upgrades: AtomicU64::new(0),
            http_errors_emitted: AtomicU64::new(0),
            rate_limits_emitted: AtomicU64::new(0),
            context_overflows_emitted: AtomicU64::new(0),
            mid_stream_errors_emitted: AtomicU64::new(0),
            connection_drops_emitted: AtomicU64::new(0),
            stalls_entered: AtomicU64::new(0),
            native_compactions_emitted: AtomicU64::new(0),
            abandoned_streams: AtomicU64::new(0),
            proxy_requests: AtomicU64::new(0),
            replay_hits: AtomicU64::new(0),
            bytes_received: AtomicU64::new(0),
            bytes_sent: AtomicU64::new(0),
            ttft_ms: AtomicHistogram::new(LATENCY_BOUNDS),
            turn_duration_ms: AtomicHistogram::new(LATENCY_BOUNDS),
            prompt_bytes_hist: AtomicHistogram::new(BYTES_BOUNDS),
            effective_tps: AtomicHistogram::new(TPS_BOUNDS),
            dimensions: RwLock::new(HashMap::new()),
        }
    }
}

impl ServerMetrics {
    pub fn record_protocol(&self, protocol: Protocol, prompt_bytes: usize) {
        self.total_requests.fetch_add(1, Ordering::Relaxed);
        self.bytes_received
            .fetch_add(prompt_bytes as u64, Ordering::Relaxed);
        self.prompt_bytes_hist.record(prompt_bytes as u64);
        match protocol {
            Protocol::OpenaiChatCompletions => {
                self.chat_completions_requests
                    .fetch_add(1, Ordering::Relaxed);
            }
            Protocol::OpenaiResponsesHttp => {
                self.responses_http_requests.fetch_add(1, Ordering::Relaxed);
            }
            Protocol::OpenaiResponsesWs => {
                self.responses_ws_turns.fetch_add(1, Ordering::Relaxed);
            }
            Protocol::AnthropicMessages => {
                self.anthropic_requests.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_dimension(
        &self,
        protocol: Protocol,
        model: &str,
        status_class: &str,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        ttft_ms: Option<u64>,
        turn_duration_ms: Option<u64>,
    ) {
        let proto = protocol_label(protocol).to_string();
        let model_label = if model.is_empty() {
            "unknown".to_string()
        } else {
            model.to_string()
        };
        let status = status_class.to_string();
        let lookup_key = (proto.clone(), model_label.clone(), status.clone());
        let entry = if let Some(existing) = self
            .dimensions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&lookup_key)
            .cloned()
        {
            existing
        } else {
            let mut guard = self.dimensions.write().unwrap_or_else(|e| e.into_inner());
            let key = if guard.len() >= MAX_DIMENSION_KEYS && !guard.contains_key(&lookup_key) {
                (proto, "_other_".to_string(), status)
            } else {
                lookup_key
            };
            guard
                .entry(key.clone())
                .or_insert_with(|| std::sync::Arc::new(DimensionState::new(key.0, key.1, key.2)))
                .clone()
        };
        entry.requests.fetch_add(1, Ordering::Relaxed);
        entry
            .input_tokens
            .fetch_add(input_tokens, Ordering::Relaxed);
        entry
            .output_tokens
            .fetch_add(output_tokens, Ordering::Relaxed);
        entry
            .cache_read_tokens
            .fetch_add(cache_read_tokens, Ordering::Relaxed);
        if let Some(t) = ttft_ms {
            entry.ttft_ms.record(t);
        }
        if let Some(d) = turn_duration_ms {
            entry.turn_duration_ms.record(d);
        }
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        let entries: Vec<std::sync::Arc<DimensionState>> = self
            .dimensions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        let mut by_dimension: Vec<DimensionCounter> =
            entries.iter().map(|e| e.snapshot()).collect();
        by_dimension.sort_by(|a, b| {
            (&a.protocol, &a.model, &a.status_class).cmp(&(&b.protocol, &b.model, &b.status_class))
        });
        MetricsSnapshot {
            active_connections: self.active_connections.load(Ordering::Relaxed),
            active_streams: self.active_streams.load(Ordering::Relaxed),
            total_requests: self.total_requests.load(Ordering::Relaxed),
            chat_completions_requests: self.chat_completions_requests.load(Ordering::Relaxed),
            responses_http_requests: self.responses_http_requests.load(Ordering::Relaxed),
            responses_ws_turns: self.responses_ws_turns.load(Ordering::Relaxed),
            anthropic_requests: self.anthropic_requests.load(Ordering::Relaxed),
            control_plane_requests: self.control_plane_requests.load(Ordering::Relaxed),
            ws_upgrades: self.ws_upgrades.load(Ordering::Relaxed),
            http_errors_emitted: self.http_errors_emitted.load(Ordering::Relaxed),
            rate_limits_emitted: self.rate_limits_emitted.load(Ordering::Relaxed),
            context_overflows_emitted: self.context_overflows_emitted.load(Ordering::Relaxed),
            mid_stream_errors_emitted: self.mid_stream_errors_emitted.load(Ordering::Relaxed),
            connection_drops_emitted: self.connection_drops_emitted.load(Ordering::Relaxed),
            stalls_entered: self.stalls_entered.load(Ordering::Relaxed),
            native_compactions_emitted: self.native_compactions_emitted.load(Ordering::Relaxed),
            abandoned_streams: self.abandoned_streams.load(Ordering::Relaxed),
            proxy_requests: self.proxy_requests.load(Ordering::Relaxed),
            replay_hits: self.replay_hits.load(Ordering::Relaxed),
            bytes_received: self.bytes_received.load(Ordering::Relaxed),
            bytes_sent: self.bytes_sent.load(Ordering::Relaxed),
            ttft_ms: self.ttft_ms.snapshot(),
            turn_duration_ms: self.turn_duration_ms.snapshot(),
            prompt_bytes: self.prompt_bytes_hist.snapshot(),
            effective_tps: self.effective_tps.snapshot(),
            by_dimension,
        }
    }

    pub fn reset(&self) {
        self.reset_counters();
    }

    pub fn reset_counters(&self) {
        self.total_requests.store(0, Ordering::Relaxed);
        self.chat_completions_requests.store(0, Ordering::Relaxed);
        self.responses_http_requests.store(0, Ordering::Relaxed);
        self.responses_ws_turns.store(0, Ordering::Relaxed);
        self.anthropic_requests.store(0, Ordering::Relaxed);
        self.control_plane_requests.store(0, Ordering::Relaxed);
        self.ws_upgrades.store(0, Ordering::Relaxed);
        self.http_errors_emitted.store(0, Ordering::Relaxed);
        self.rate_limits_emitted.store(0, Ordering::Relaxed);
        self.context_overflows_emitted.store(0, Ordering::Relaxed);
        self.mid_stream_errors_emitted.store(0, Ordering::Relaxed);
        self.connection_drops_emitted.store(0, Ordering::Relaxed);
        self.stalls_entered.store(0, Ordering::Relaxed);
        self.native_compactions_emitted.store(0, Ordering::Relaxed);
        self.abandoned_streams.store(0, Ordering::Relaxed);
        self.proxy_requests.store(0, Ordering::Relaxed);
        self.replay_hits.store(0, Ordering::Relaxed);
        self.bytes_received.store(0, Ordering::Relaxed);
        self.bytes_sent.store(0, Ordering::Relaxed);
        self.ttft_ms.reset();
        self.turn_duration_ms.reset();
        self.prompt_bytes_hist.reset();
        self.effective_tps.reset();
        self.dimensions
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// Render Prometheus text exposition format (0.0.4) for scraping via `GET /metrics`.
    pub fn render_prometheus(&self, watchdog_violations: u64) -> String {
        let s = self.snapshot();
        let mut out = String::with_capacity(4096);
        let _ = writeln!(
            out,
            "# HELP mock_ai_active_connections Active TCP/WS connections"
        );
        let _ = writeln!(out, "# TYPE mock_ai_active_connections gauge");
        let _ = writeln!(out, "mock_ai_active_connections {}", s.active_connections);

        let _ = writeln!(
            out,
            "# HELP mock_ai_active_streams Active in-flight model turns"
        );
        let _ = writeln!(out, "# TYPE mock_ai_active_streams gauge");
        let _ = writeln!(out, "mock_ai_active_streams {}", s.active_streams);

        let _ = writeln!(
            out,
            "# HELP mock_ai_requests_total Total model turn requests"
        );
        let _ = writeln!(out, "# TYPE mock_ai_requests_total counter");
        let _ = writeln!(out, "mock_ai_requests_total {}", s.total_requests);

        let _ = writeln!(
            out,
            "# HELP mock_ai_errors_total Emitted fault/error counters"
        );
        let _ = writeln!(out, "# TYPE mock_ai_errors_total counter");
        let _ = writeln!(
            out,
            "mock_ai_errors_total{{kind=\"http\"}} {}",
            s.http_errors_emitted
        );
        let _ = writeln!(
            out,
            "mock_ai_errors_total{{kind=\"rate_limit\"}} {}",
            s.rate_limits_emitted
        );
        let _ = writeln!(
            out,
            "mock_ai_errors_total{{kind=\"context_overflow\"}} {}",
            s.context_overflows_emitted
        );
        let _ = writeln!(
            out,
            "mock_ai_errors_total{{kind=\"mid_stream\"}} {}",
            s.mid_stream_errors_emitted
        );
        let _ = writeln!(
            out,
            "mock_ai_errors_total{{kind=\"connection_drop\"}} {}",
            s.connection_drops_emitted
        );
        let _ = writeln!(
            out,
            "mock_ai_errors_total{{kind=\"abandoned_stream\"}} {}",
            s.abandoned_streams
        );

        let _ = writeln!(
            out,
            "# HELP mock_ai_native_compactions_total Native server-side compactions emitted"
        );
        let _ = writeln!(out, "# TYPE mock_ai_native_compactions_total counter");
        let _ = writeln!(
            out,
            "mock_ai_native_compactions_total {}",
            s.native_compactions_emitted
        );

        let _ = writeln!(
            out,
            "# HELP mock_ai_watchdog_violations_total Protocol invariant violations detected"
        );
        let _ = writeln!(out, "# TYPE mock_ai_watchdog_violations_total counter");
        let _ = writeln!(
            out,
            "mock_ai_watchdog_violations_total {watchdog_violations}"
        );

        let _ = writeln!(out, "# HELP mock_ai_bytes_total Bytes received and sent");
        let _ = writeln!(out, "# TYPE mock_ai_bytes_total counter");
        let _ = writeln!(
            out,
            "mock_ai_bytes_total{{direction=\"received\"}} {}",
            s.bytes_received
        );
        let _ = writeln!(
            out,
            "mock_ai_bytes_total{{direction=\"sent\"}} {}",
            s.bytes_sent
        );

        if !s.by_dimension.is_empty() {
            let _ = writeln!(
                out,
                "# HELP mock_ai_dimension_requests_total Requests by protocol, model, and status"
            );
            let _ = writeln!(out, "# TYPE mock_ai_dimension_requests_total counter");
            for d in &s.by_dimension {
                let m = escape_prom_label(&d.model);
                let _ = writeln!(
                    out,
                    "mock_ai_dimension_requests_total{{protocol=\"{}\",model=\"{m}\",status=\"{}\"}} {}",
                    d.protocol, d.status_class, d.requests
                );
            }
            let _ = writeln!(
                out,
                "# HELP mock_ai_dimension_tokens_total Tokens by protocol, model, and kind"
            );
            let _ = writeln!(out, "# TYPE mock_ai_dimension_tokens_total counter");
            for d in &s.by_dimension {
                let m = escape_prom_label(&d.model);
                let _ = writeln!(
                    out,
                    "mock_ai_dimension_tokens_total{{protocol=\"{}\",model=\"{m}\",kind=\"input\"}} {}",
                    d.protocol, d.input_tokens
                );
                let _ = writeln!(
                    out,
                    "mock_ai_dimension_tokens_total{{protocol=\"{}\",model=\"{m}\",kind=\"output\"}} {}",
                    d.protocol, d.output_tokens
                );
                let _ = writeln!(
                    out,
                    "mock_ai_dimension_tokens_total{{protocol=\"{}\",model=\"{m}\",kind=\"cache_read\"}} {}",
                    d.protocol, d.cache_read_tokens
                );
            }
        }

        self.ttft_ms.write_prometheus(
            &mut out,
            "mock_ai_ttft_ms",
            "Time to first token in milliseconds",
        );
        self.turn_duration_ms.write_prometheus(
            &mut out,
            "mock_ai_turn_duration_ms",
            "Total model turn duration in milliseconds",
        );
        self.prompt_bytes_hist.write_prometheus(
            &mut out,
            "mock_ai_prompt_bytes",
            "Incoming request prompt payload bytes",
        );
        self.effective_tps.write_prometheus(
            &mut out,
            "mock_ai_effective_tps",
            "Measured effective streaming output tokens per second",
        );

        let dim_entries: Vec<std::sync::Arc<DimensionState>> = self
            .dimensions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        if !dim_entries.is_empty() {
            let _ = writeln!(
                out,
                "# HELP mock_ai_dimension_ttft_ms Per-model TTFT histogram in ms"
            );
            let _ = writeln!(out, "# TYPE mock_ai_dimension_ttft_ms histogram");
            for d in &dim_entries {
                if d.ttft_ms.count.load(Ordering::Relaxed) > 0 {
                    let m = escape_prom_label(&d.model);
                    let lbl = format!(
                        "protocol=\"{}\",model=\"{m}\",status=\"{}\"",
                        d.protocol, d.status_class
                    );
                    d.ttft_ms
                        .write_prometheus_series(&mut out, "mock_ai_dimension_ttft_ms", &lbl);
                }
            }
            let _ = writeln!(
                out,
                "# HELP mock_ai_dimension_turn_duration_ms Per-model turn duration histogram in ms"
            );
            let _ = writeln!(out, "# TYPE mock_ai_dimension_turn_duration_ms histogram");
            for d in &dim_entries {
                if d.turn_duration_ms.count.load(Ordering::Relaxed) > 0 {
                    let m = escape_prom_label(&d.model);
                    let lbl = format!(
                        "protocol=\"{}\",model=\"{m}\",status=\"{}\"",
                        d.protocol, d.status_class
                    );
                    d.turn_duration_ms.write_prometheus_series(
                        &mut out,
                        "mock_ai_dimension_turn_duration_ms",
                        &lbl,
                    );
                }
            }
        }
        out
    }
}

fn protocol_label(p: Protocol) -> &'static str {
    match p {
        Protocol::OpenaiChatCompletions => "chat_completions",
        Protocol::OpenaiResponsesHttp => "responses_http",
        Protocol::OpenaiResponsesWs => "responses_ws",
        Protocol::AnthropicMessages => "anthropic_messages",
    }
}

fn escape_prom_label(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

enum RecordedEntry {
    Model(RecordedRequest),
    Control {
        entry: RecordedControlRequest,
        bytes: usize,
    },
}

impl RecordedEntry {
    fn bytes(&self) -> usize {
        match self {
            Self::Model(r) => r.prompt_bytes,
            Self::Control { bytes, .. } => *bytes,
        }
    }
}

struct RecorderInner {
    entries: VecDeque<RecordedEntry>,
    retained_bytes: usize,
}

/// Thread-safe request recorder supporting unbounded, byte-and-entry bounded ring, or zero-overhead metrics-only mode.
pub struct RequestRecorder {
    mode: RecorderMode,
    inner: Mutex<RecorderInner>,
}

impl RequestRecorder {
    pub fn new(mode: RecorderMode) -> Self {
        Self {
            mode,
            inner: Mutex::new(RecorderInner {
                entries: VecDeque::new(),
                retained_bytes: 0,
            }),
        }
    }

    pub fn mode(&self) -> RecorderMode {
        self.mode
    }

    fn push_entry(&self, entry: RecordedEntry) {
        let bytes = entry.bytes();
        match self.mode {
            RecorderMode::MetricsOnly => {}
            RecorderMode::Full => {
                let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                guard.retained_bytes = guard.retained_bytes.saturating_add(bytes);
                guard.entries.push_back(entry);
            }
            RecorderMode::Ring {
                capacity,
                max_bytes,
            } => {
                if capacity == 0 || max_bytes == 0 || bytes > max_bytes {
                    return;
                }
                let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                while guard.entries.len() >= capacity
                    || (guard.retained_bytes.saturating_add(bytes) > max_bytes
                        && !guard.entries.is_empty())
                {
                    if let Some(evicted) = guard.entries.pop_front() {
                        guard.retained_bytes = guard.retained_bytes.saturating_sub(evicted.bytes());
                    }
                }
                guard.retained_bytes = guard.retained_bytes.saturating_add(bytes);
                guard.entries.push_back(entry);
            }
        }
    }

    pub fn record(&self, req: &NormalizedRequest) {
        if matches!(self.mode, RecorderMode::MetricsOnly) {
            return;
        }
        self.push_entry(RecordedEntry::Model(RecordedRequest::from(req)));
    }

    pub fn record_control(
        &self,
        method: &str,
        path: &str,
        query: Option<&str>,
        headers: &BTreeMap<String, String>,
    ) {
        if matches!(self.mode, RecorderMode::MetricsOnly) {
            return;
        }
        let bytes = method.len()
            + path.len()
            + query.map_or(0, str::len)
            + headers
                .iter()
                .map(|(k, v)| k.len() + v.len())
                .sum::<usize>();
        let entry = RecordedControlRequest {
            method: method.to_owned(),
            path: path.to_owned(),
            query: query.map(str::to_owned),
            headers: headers.clone(),
        };
        self.push_entry(RecordedEntry::Control { entry, bytes });
    }

    pub fn snapshot(&self) -> Vec<RecordedRequest> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .iter()
            .filter_map(|e| match e {
                RecordedEntry::Model(r) => Some(r.clone()),
                RecordedEntry::Control { .. } => None,
            })
            .collect()
    }

    pub fn control_snapshot(&self) -> Vec<RecordedControlRequest> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .iter()
            .filter_map(|e| match e {
                RecordedEntry::Control { entry, .. } => Some(entry.clone()),
                RecordedEntry::Model(_) => None,
            })
            .collect()
    }

    pub fn clear(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.entries.clear();
        guard.retained_bytes = 0;
    }
}
