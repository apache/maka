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

use crate::protocol::{NormalizedRequest, Protocol, Transport};
use crate::routing::{
    AttemptId, CallId, LogicalLane, RequestUse, ResponseId, Revision, RunId, SessionId, SideKind,
    StepId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

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

macro_rules! metric_labels {
    ($name:ident { $( $variant:ident => $label:literal ),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $label)] $variant),+
        }

        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $label),+
                }
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::Unclassified
            }
        }
    };
}

metric_labels!(RequestPurpose {
    Main => "main",
    Title => "title",
    Probe => "probe",
    SummaryAux => "summary_aux",
    Side => "side",
    Compact => "compact",
    CountTokens => "count_tokens",
    Warmup => "warmup",
    Control => "control",
    Unclassified => "unclassified",
});

impl From<&RequestUse> for RequestPurpose {
    fn from(request_use: &RequestUse) -> Self {
        match request_use {
            RequestUse::Main => Self::Main,
            RequestUse::Side(SideKind::Title) => Self::Title,
            RequestUse::Side(SideKind::Probe) => Self::Probe,
            RequestUse::Side(SideKind::SummaryAux) => Self::SummaryAux,
            RequestUse::Side(SideKind::Custom(_)) => Self::Side,
            RequestUse::Compact(_) => Self::Compact,
            RequestUse::Control => Self::Control,
        }
    }
}

metric_labels!(AttemptOutcome {
    Completed => "completed",
    Rejected => "rejected",
    RateLimited => "rate_limited",
    InjectedFault => "injected_fault",
    ClientDisconnected => "client_disconnected",
    ServerShutdown => "server_shutdown",
    ParseFailed => "parse_failed",
    TransportError => "transport_error",
    Unclassified => "unclassified",
});

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum MetricStatus {
    Code(u16),
    Fault,
    Aborted,
    Unknown,
}

impl MetricStatus {
    fn from_legacy(status: &str) -> (Self, AttemptOutcome) {
        match status {
            "fault" => (Self::Fault, AttemptOutcome::InjectedFault),
            "aborted" => (Self::Aborted, AttemptOutcome::ClientDisconnected),
            _ => match status.parse::<u16>() {
                Ok(code @ 200..=299) => (Self::Code(code), AttemptOutcome::Completed),
                Ok(429) => (Self::Code(429), AttemptOutcome::RateLimited),
                Ok(code @ (100..=199 | 300..=599)) => (Self::Code(code), AttemptOutcome::Rejected),
                _ => (Self::Unknown, AttemptOutcome::Unclassified),
            },
        }
    }

    fn label(self) -> String {
        match self {
            Self::Code(code) => code.to_string(),
            Self::Fault => "fault".into(),
            Self::Aborted => "aborted".into(),
            Self::Unknown => "unknown".into(),
        }
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct DimensionKey {
    protocol: &'static str,
    model: String,
    status: MetricStatus,
    purpose: RequestPurpose,
    outcome: AttemptOutcome,
}

impl DimensionKey {
    fn prometheus_labels(&self) -> String {
        format!(
            "protocol=\"{}\",model=\"{}\",status=\"{}\",purpose=\"{}\",outcome=\"{}\"",
            self.protocol,
            escape_prom_label(&self.model),
            self.status.label(),
            self.purpose.as_str(),
            self.outcome.as_str(),
        )
    }
}

/// Counter and latency slice grouped by request dimensions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionCounter {
    pub protocol: String,
    pub model: String,
    pub status_class: String,
    #[serde(default)]
    pub purpose: RequestPurpose,
    #[serde(default)]
    pub outcome: AttemptOutcome,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub ttft_ms: HistogramSummary,
    pub turn_duration_ms: HistogramSummary,
}

struct DimensionState {
    key: DimensionKey,
    requests: AtomicU64,
    input_tokens: AtomicU64,
    output_tokens: AtomicU64,
    cache_read_tokens: AtomicU64,
    ttft_ms: AtomicHistogram,
    turn_duration_ms: AtomicHistogram,
}

impl DimensionState {
    fn new(key: DimensionKey) -> Self {
        Self {
            key,
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
            protocol: self.key.protocol.into(),
            model: self.key.model.clone(),
            status_class: self.key.status.label(),
            purpose: self.key.purpose,
            outcome: self.key.outcome,
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
const MAX_OVERFLOW_DIMENSION_KEYS: usize = 256;
const MAX_MODEL_LABEL_BYTES: usize = 128;

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
    generation: AtomicU64,
    generation_gate: RwLock<()>,
    dimensions: RwLock<HashMap<DimensionKey, Arc<DimensionState>>>,
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
            generation: AtomicU64::new(0),
            generation_gate: RwLock::new(()),
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
        let (status, outcome) = MetricStatus::from_legacy(status_class);
        self.record_dimension_sample(
            protocol,
            model,
            status,
            RequestPurpose::Unclassified,
            outcome,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            ttft_ms,
            turn_duration_ms,
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_dimension_with_labels(
        &self,
        protocol: Protocol,
        model: &str,
        status: Option<u16>,
        purpose: RequestPurpose,
        outcome: AttemptOutcome,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        ttft_ms: Option<u64>,
        turn_duration_ms: Option<u64>,
    ) {
        let status = match status {
            Some(code @ 100..=599) => MetricStatus::Code(code),
            _ => MetricStatus::Unknown,
        };
        self.record_dimension_sample(
            protocol,
            model,
            status,
            purpose,
            outcome,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            ttft_ms,
            turn_duration_ms,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn record_dimension_sample(
        &self,
        protocol: Protocol,
        model: &str,
        status: MetricStatus,
        purpose: RequestPurpose,
        outcome: AttemptOutcome,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        ttft_ms: Option<u64>,
        turn_duration_ms: Option<u64>,
    ) {
        let model = match model {
            "" => "unknown",
            model if model.len() > MAX_MODEL_LABEL_BYTES => "_other_",
            model => model,
        };
        let mut key = DimensionKey {
            protocol: protocol_label(protocol),
            model: model.into(),
            status,
            purpose,
            outcome,
        };
        let dims = self.dimensions.read().unwrap_or_else(|e| e.into_inner());
        let entry = if let Some(existing) = dims.get(&key) {
            existing.clone()
        } else {
            drop(dims);
            let mut dims = self.dimensions.write().unwrap_or_else(|e| e.into_inner());
            if dims.len() >= MAX_DIMENSION_KEYS && !dims.contains_key(&key) {
                key.model = "_other_".into();
                if dims.len() >= MAX_DIMENSION_KEYS + MAX_OVERFLOW_DIMENSION_KEYS
                    && !dims.contains_key(&key)
                {
                    key = DimensionKey {
                        protocol: "other",
                        model: "_other_".into(),
                        status: MetricStatus::Unknown,
                        purpose: RequestPurpose::Unclassified,
                        outcome: AttemptOutcome::Unclassified,
                    };
                }
            }
            dims.entry(key.clone())
                .or_insert_with(|| Arc::new(DimensionState::new(key)))
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

    fn dimension_entries(&self) -> Vec<Arc<DimensionState>> {
        let mut entries: Vec<_> = self
            .dimensions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        entries.sort_unstable_by(|a, b| a.key.cmp(&b.key));
        entries
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        self.snapshot_with_dimensions(&self.dimension_entries())
    }

    fn snapshot_with_dimensions(&self, entries: &[Arc<DimensionState>]) -> MetricsSnapshot {
        let by_dimension = entries.iter().map(|entry| entry.snapshot()).collect();
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

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Apply synchronous metric updates in the generation captured at request entry.
    pub fn record_for_generation(&self, generation: u64, record: impl FnOnce(&Self)) -> bool {
        if self.generation() != generation {
            return false;
        }
        let _guard = self
            .generation_gate
            .read()
            .unwrap_or_else(|e| e.into_inner());
        if self.generation() != generation {
            return false;
        }
        record(self);
        true
    }

    pub fn reset(&self) {
        self.reset_counters();
    }

    pub fn reset_counters(&self) {
        let _guard = self
            .generation_gate
            .write()
            .unwrap_or_else(|e| e.into_inner());
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
        self.generation.fetch_add(1, Ordering::Release);
    }

    /// Render Prometheus text exposition format (0.0.4) for scraping via `GET /metrics`.
    pub fn render_prometheus(&self, watchdog_violations: u64) -> String {
        let dim_entries = self.dimension_entries();
        let s = self.snapshot_with_dimensions(&dim_entries);
        let labels: Vec<_> = dim_entries
            .iter()
            .map(|entry| entry.key.prometheus_labels())
            .collect();
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

        if !dim_entries.is_empty() {
            let _ = writeln!(
                out,
                "# HELP mock_ai_dimension_requests_total Requests by protocol, model, status, purpose and outcome"
            );
            let _ = writeln!(out, "# TYPE mock_ai_dimension_requests_total counter");
            for (d, labels) in s.by_dimension.iter().zip(&labels) {
                let _ = writeln!(
                    out,
                    "mock_ai_dimension_requests_total{{{labels}}} {}",
                    d.requests
                );
            }
            let _ = writeln!(
                out,
                "# HELP mock_ai_dimension_tokens_total Tokens by request dimensions and kind"
            );
            let _ = writeln!(out, "# TYPE mock_ai_dimension_tokens_total counter");
            for (d, labels) in s.by_dimension.iter().zip(&labels) {
                for (kind, value) in [
                    ("input", d.input_tokens),
                    ("output", d.output_tokens),
                    ("cache_read", d.cache_read_tokens),
                ] {
                    let _ = writeln!(
                        out,
                        "mock_ai_dimension_tokens_total{{{labels},kind=\"{kind}\"}} {value}"
                    );
                }
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

        if !dim_entries.is_empty() {
            let _ = writeln!(
                out,
                "# HELP mock_ai_dimension_ttft_ms Per-model TTFT histogram in ms"
            );
            let _ = writeln!(out, "# TYPE mock_ai_dimension_ttft_ms histogram");
            for (d, labels) in dim_entries.iter().zip(&labels) {
                if d.ttft_ms.count.load(Ordering::Relaxed) > 0 {
                    d.ttft_ms.write_prometheus_series(
                        &mut out,
                        "mock_ai_dimension_ttft_ms",
                        labels,
                    );
                }
            }
            let _ = writeln!(
                out,
                "# HELP mock_ai_dimension_turn_duration_ms Per-model turn duration histogram in ms"
            );
            let _ = writeln!(out, "# TYPE mock_ai_dimension_turn_duration_ms histogram");
            for (d, labels) in dim_entries.iter().zip(&labels) {
                if d.turn_duration_ms.count.load(Ordering::Relaxed) > 0 {
                    d.turn_duration_ms.write_prometheus_series(
                        &mut out,
                        "mock_ai_dimension_turn_duration_ms",
                        labels,
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
    Model(Arc<RecordedRequest>),
    Control(Arc<RecordedControlRequest>),
}

struct RecorderInner {
    entries: VecDeque<(RecordedEntry, usize)>,
    retained_bytes: usize,
}

/// Thread-safe request recorder supporting a full history, a bounded ring, or metrics only.
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

    fn push_entry(&self, bytes: usize, make_entry: impl FnOnce() -> RecordedEntry) {
        if matches!(self.mode, RecorderMode::MetricsOnly)
            || matches!(self.mode, RecorderMode::Ring { capacity, max_bytes }
                if capacity == 0 || max_bytes == 0 || bytes > max_bytes)
        {
            return;
        }

        let entry = make_entry();
        let mut evicted = Vec::new();
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let RecorderMode::Ring {
            capacity,
            max_bytes,
        } = self.mode
        {
            while guard.entries.len() >= capacity || guard.retained_bytes > max_bytes - bytes {
                let (old, old_bytes) = guard.entries.pop_front().expect("ring exceeds its budget");
                guard.retained_bytes -= old_bytes;
                evicted.push(old);
            }
            guard.retained_bytes += bytes;
        }
        guard.entries.push_back((entry, bytes));
        drop(guard);
        drop(evicted);
    }

    pub fn record(&self, req: &NormalizedRequest) {
        let bytes = req.prompt_bytes.max(req.size_breakdown.body_bytes);
        self.push_entry(bytes, || {
            RecordedEntry::Model(Arc::new(RecordedRequest::from(req)))
        });
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
        self.push_entry(bytes, || {
            RecordedEntry::Control(Arc::new(RecordedControlRequest {
                method: method.to_owned(),
                path: path.to_owned(),
                query: query.map(str::to_owned),
                headers: headers.clone(),
            }))
        });
    }

    pub fn snapshot(&self) -> Vec<RecordedRequest> {
        let entries: Vec<_> = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .iter()
            .filter_map(|(entry, _)| match entry {
                RecordedEntry::Model(request) => Some(request.clone()),
                RecordedEntry::Control(_) => None,
            })
            .collect();
        entries.into_iter().map(|entry| (*entry).clone()).collect()
    }

    pub fn control_snapshot(&self) -> Vec<RecordedControlRequest> {
        let entries: Vec<_> = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .iter()
            .filter_map(|(entry, _)| match entry {
                RecordedEntry::Control(request) => Some(request.clone()),
                RecordedEntry::Model(_) => None,
            })
            .collect();
        entries.into_iter().map(|entry| (*entry).clone()).collect()
    }

    pub fn clear(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::mem::take(&mut guard.entries);
        guard.retained_bytes = 0;
        drop(guard);
        drop(previous);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RunClock {
    started_at: Instant,
}

impl RunClock {
    pub fn new(started_at: Instant) -> Self {
        Self { started_at }
    }

    pub fn elapsed_ns(&self) -> u64 {
        self.started_at.elapsed().as_nanos().min(u64::MAX as u128) as u64
    }
}

impl Default for RunClock {
    fn default() -> Self {
        Self::new(Instant::now())
    }
}

/// All timestamps are monotonic nanoseconds relative to the owning run's start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptSpan {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub lane: Option<LogicalLane>,
    pub step_id: Option<StepId>,
    pub revision: Option<Revision>,
    pub attempt: Option<AttemptId>,
    pub connection_id: Option<u64>,
    pub response_id: Option<ResponseId>,
    pub parent_response_id: Option<ResponseId>,
    pub purpose: RequestPurpose,
    pub protocol: Protocol,
    pub transport: Transport,
    pub fault_id: Option<String>,
    pub outcome: AttemptOutcome,
    pub retry_reason: Option<String>,
    pub confirmed_call_ids: Vec<CallId>,
    pub checkpoint_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adopted_checkpoint_id: Option<String>,
    pub headers_received_ns: u64,
    pub body_read_ns: Option<u64>,
    pub parsed_ns: Option<u64>,
    pub admitted_ns: Option<u64>,
    pub plan_ready_ns: Option<u64>,
    pub first_byte_ns: Option<u64>,
    pub first_semantic_delta_ns: Option<u64>,
    pub last_frame_consumed_ns: Option<u64>,
    pub body_dropped_ns: Option<u64>,
    /// End of an attempt that has no body/transport endpoint, such as a parsing failure.
    pub finished_ns: Option<u64>,
    pub simulated_delay_ns: u64,
    pub actual_sleep_ns: u64,
    pub backpressure_wait_ns: u64,
    pub request_wire_bytes: u64,
    pub response_wire_bytes: u64,
    pub effective_context_bytes: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub reasoning_tokens: u64,
}

impl AttemptSpan {
    pub fn new(
        run_id: RunId,
        session_id: SessionId,
        protocol: Protocol,
        transport: Transport,
        headers_received_ns: u64,
    ) -> Self {
        let connection_id = match &transport {
            Transport::Http => None,
            Transport::WebSocket { connection_id, .. } => Some(*connection_id),
        };
        Self {
            run_id,
            session_id,
            protocol,
            transport,
            headers_received_ns,
            connection_id,
            lane: None,
            step_id: None,
            revision: None,
            attempt: None,
            response_id: None,
            parent_response_id: None,
            purpose: RequestPurpose::default(),
            fault_id: None,
            outcome: AttemptOutcome::default(),
            retry_reason: None,
            confirmed_call_ids: Vec::new(),
            checkpoint_id: None,
            adopted_checkpoint_id: None,
            body_read_ns: None,
            parsed_ns: None,
            admitted_ns: None,
            plan_ready_ns: None,
            first_byte_ns: None,
            first_semantic_delta_ns: None,
            last_frame_consumed_ns: None,
            body_dropped_ns: None,
            finished_ns: None,
            simulated_delay_ns: 0,
            actual_sleep_ns: 0,
            backpressure_wait_ns: 0,
            request_wire_bytes: 0,
            response_wire_bytes: 0,
            effective_context_bytes: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            reasoning_tokens: 0,
        }
    }

    fn interval(&self) -> Option<(u64, u64)> {
        let end = self
            .body_dropped_ns
            .max(self.last_frame_consumed_ns)
            .max(self.finished_ns)?;
        (end > self.headers_received_ns).then_some((self.headers_received_ns, end))
    }

    fn retained_bytes(&self) -> usize {
        let strings = [
            Some(&self.run_id.0),
            Some(&self.session_id.0),
            self.lane.as_ref().map(|id| &id.0),
            self.step_id.as_ref().map(|id| &id.0),
            self.response_id.as_ref().map(|id| &id.0),
            self.parent_response_id.as_ref().map(|id| &id.0),
            self.fault_id.as_ref(),
            self.retry_reason.as_ref(),
            self.checkpoint_id.as_ref(),
            self.adopted_checkpoint_id.as_ref(),
        ];
        size_of::<TimelineItem>()
            + strings
                .into_iter()
                .flatten()
                .map(String::capacity)
                .sum::<usize>()
            + self.confirmed_call_ids.capacity() * size_of::<CallId>()
            + self
                .confirmed_call_ids
                .iter()
                .map(|id| id.0.capacity())
                .sum::<usize>()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptBytesPoint {
    pub headers_received_ns: u64,
    pub purpose: RequestPurpose,
    pub request_wire_bytes: u64,
    pub effective_context_bytes: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributionSummary {
    pub mock_service_sum_ns: u64,
    pub mock_service_sum_by_purpose_ns: BTreeMap<RequestPurpose, u64>,
    pub outside_mock_wall_ns: u64,
    pub mock_union_ns: u64,
    /// Number of clipped intervals that overlap an earlier interval in start order.
    pub overlapping_intervals_count: usize,
    pub prompt_bytes_trajectory: Vec<PromptBytesPoint>,
}

/// Sum the full attempt durations and independently measure the occupied portion of the wall window.
pub fn compute_attribution(
    wall_start_ns: u64,
    wall_end_ns: u64,
    spans: &[AttemptSpan],
) -> AttributionSummary {
    let mut summary = AttributionSummary::default();
    let mut intervals = Vec::with_capacity(spans.len());
    for span in spans {
        if let Some((start, end)) = span.interval() {
            let duration = end - start;
            summary.mock_service_sum_ns = summary.mock_service_sum_ns.saturating_add(duration);
            let purpose_sum = summary
                .mock_service_sum_by_purpose_ns
                .entry(span.purpose)
                .or_default();
            *purpose_sum = purpose_sum.saturating_add(duration);
            let start = start.max(wall_start_ns);
            let end = end.min(wall_end_ns);
            if start < end {
                intervals.push((start, end));
            }
        }
        summary.prompt_bytes_trajectory.push(PromptBytesPoint {
            headers_received_ns: span.headers_received_ns,
            purpose: span.purpose,
            request_wire_bytes: span.request_wire_bytes,
            effective_context_bytes: span.effective_context_bytes,
        });
    }
    intervals.sort_unstable();
    let mut covered_until = wall_start_ns;
    for (start, end) in intervals {
        if start < covered_until {
            summary.overlapping_intervals_count += 1;
        }
        summary.mock_union_ns += end.saturating_sub(start.max(covered_until));
        covered_until = covered_until.max(end);
    }
    summary.outside_mock_wall_ns =
        wall_end_ns.saturating_sub(wall_start_ns) - summary.mock_union_ns;
    summary
        .prompt_bytes_trajectory
        .sort_by_key(|point| point.headers_received_ns);
    summary
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    pub cursor: u64,
    #[serde(flatten)]
    pub span: AttemptSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTelemetrySummary {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub cursor: u64,
    pub finalized: bool,
    pub attempts: u64,
    pub retained: usize,
    pub retained_bytes: usize,
    pub dropped: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListPage {
    pub items: Vec<SessionTelemetrySummary>,
    pub next_cursor: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetailPage {
    pub items: Vec<TimelineItem>,
    /// Exclusive resume cursor, including dropped attempts when the page reaches the end.
    pub next_cursor: u64,
    pub oldest_cursor: Option<u64>,
    pub dropped: u64,
    pub summary: SessionTelemetrySummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SessionTelemetryError {
    #[error("session telemetry capacity exhausted")]
    Capacity,
    #[error("session telemetry belongs to a different run")]
    RunMismatch,
    #[error("session telemetry is not registered")]
    Unregistered,
    #[error("session telemetry is finalized")]
    Finalized,
}

#[derive(Default)]
struct SessionTimeline {
    items: VecDeque<(Arc<TimelineItem>, usize)>,
    attempts: u64,
    retained_bytes: usize,
    dropped: u64,
    finalized: bool,
}

struct TelemetrySession {
    cursor: u64,
    run_id: RunId,
    session_id: SessionId,
    timeline: Mutex<SessionTimeline>,
}

impl TelemetrySession {
    fn summary(&self, state: &SessionTimeline) -> SessionTelemetrySummary {
        SessionTelemetrySummary {
            run_id: self.run_id.clone(),
            session_id: self.session_id.clone(),
            cursor: self.cursor,
            attempts: state.attempts,
            retained: state.items.len(),
            retained_bytes: state.retained_bytes,
            dropped: state.dropped,
            finalized: state.finalized,
        }
    }
}

#[derive(Default)]
struct TelemetryIndex {
    by_id: HashMap<String, Arc<TelemetrySession>>,
    by_cursor: BTreeMap<u64, Arc<TelemetrySession>>,
    last_cursor: u64,
}

pub struct SessionTelemetryStore {
    max_sessions: usize,
    max_entries_per_session: usize,
    max_bytes_per_session: usize,
    sessions: RwLock<TelemetryIndex>,
}

impl SessionTelemetryStore {
    pub fn new(
        max_sessions: usize,
        max_entries_per_session: usize,
        max_bytes_per_session: usize,
    ) -> Self {
        Self {
            max_sessions,
            max_entries_per_session,
            max_bytes_per_session,
            sessions: RwLock::new(TelemetryIndex::default()),
        }
    }

    pub fn register_session(
        &self,
        run_id: &RunId,
        session_id: &SessionId,
    ) -> Result<(), SessionTelemetryError> {
        let session = self.session_for_run(run_id, session_id)?;
        let state = session.timeline.lock().unwrap_or_else(|e| e.into_inner());
        if state.finalized {
            return Err(SessionTelemetryError::Finalized);
        }
        Ok(())
    }

    fn get_session(&self, session_id: &str) -> Option<Arc<TelemetrySession>> {
        self.sessions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .by_id
            .get(session_id)
            .cloned()
    }

    fn session_for_run(
        &self,
        run_id: &RunId,
        session_id: &SessionId,
    ) -> Result<Arc<TelemetrySession>, SessionTelemetryError> {
        let session = if let Some(session) = self.get_session(&session_id.0) {
            session
        } else {
            let mut index = self.sessions.write().unwrap_or_else(|e| e.into_inner());
            if let Some(session) = index.by_id.get(&session_id.0) {
                session.clone()
            } else {
                if index.by_id.len() >= self.max_sessions {
                    return Err(SessionTelemetryError::Capacity);
                }
                index.last_cursor += 1;
                let session = Arc::new(TelemetrySession {
                    cursor: index.last_cursor,
                    run_id: run_id.clone(),
                    session_id: session_id.clone(),
                    timeline: Mutex::default(),
                });
                index.by_id.insert(session_id.0.clone(), session.clone());
                index.by_cursor.insert(session.cursor, session.clone());
                session
            }
        };
        if &session.run_id != run_id {
            return Err(SessionTelemetryError::RunMismatch);
        }
        Ok(session)
    }

    /// Returns the cursor even when the attempt exceeds the configured retention budget.
    pub fn record(&self, span: AttemptSpan) -> Result<u64, SessionTelemetryError> {
        let session = self
            .get_session(&span.session_id.0)
            .ok_or(SessionTelemetryError::Unregistered)?;
        if session.run_id != span.run_id {
            return Err(SessionTelemetryError::RunMismatch);
        }
        let bytes = span.retained_bytes();
        let mut state = session.timeline.lock().unwrap_or_else(|e| e.into_inner());
        if state.finalized {
            return Err(SessionTelemetryError::Finalized);
        }
        state.attempts += 1;
        let cursor = state.attempts;
        if self.max_entries_per_session == 0 || bytes > self.max_bytes_per_session {
            state.dropped += 1;
            return Ok(cursor);
        }
        while state.items.len() >= self.max_entries_per_session
            || state.retained_bytes > self.max_bytes_per_session - bytes
        {
            let (_, old_bytes) = state
                .items
                .pop_front()
                .expect("timeline exceeds its budget");
            state.retained_bytes -= old_bytes;
            state.dropped += 1;
        }
        state
            .items
            .push_back((Arc::new(TimelineItem { cursor, span }), bytes));
        state.retained_bytes += bytes;
        Ok(cursor)
    }

    pub fn list_sessions(
        &self,
        run_filter: Option<&str>,
        cursor: Option<u64>,
        limit: usize,
    ) -> SessionListPage {
        use std::ops::Bound::{Excluded, Unbounded};

        let index = self.sessions.read().unwrap_or_else(|e| e.into_inner());
        let mut matches = index
            .by_cursor
            .range((Excluded(cursor.unwrap_or(0)), Unbounded))
            .map(|(_, session)| session)
            .filter(|session| run_filter.is_none_or(|run| session.run_id.0 == run));
        let sessions: Vec<_> = matches.by_ref().take(limit).cloned().collect();
        let next_cursor = if matches.next().is_some() {
            sessions.last().map(|session| session.cursor)
        } else {
            None
        };
        drop(index);
        let items = sessions
            .into_iter()
            .map(|session| {
                let state = session.timeline.lock().unwrap_or_else(|e| e.into_inner());
                session.summary(&state)
            })
            .collect();
        SessionListPage { items, next_cursor }
    }

    pub fn session_detail(
        &self,
        session_id: &str,
        after_cursor: Option<u64>,
        limit: usize,
    ) -> Option<SessionDetailPage> {
        let session = self.get_session(session_id)?;
        let state = session.timeline.lock().unwrap_or_else(|e| e.into_inner());
        let after = after_cursor.unwrap_or(0);
        let start = state
            .items
            .partition_point(|(item, _)| item.cursor <= after);
        let items: Vec<_> = state
            .items
            .range(start..)
            .take(limit)
            .map(|(item, _)| item.clone())
            .collect();
        let next_cursor = if start + items.len() == state.items.len() {
            after.max(state.attempts)
        } else {
            items.last().map_or(after, |item| item.cursor)
        };
        let oldest_cursor = state.items.front().map(|(item, _)| item.cursor);
        let summary = session.summary(&state);
        drop(state);
        Some(SessionDetailPage {
            items: items.into_iter().map(|item| (*item).clone()).collect(),
            next_cursor,
            oldest_cursor,
            dropped: summary.dropped,
            summary,
        })
    }

    pub fn finalize(&self, session_id: &str) -> Option<SessionTelemetrySummary> {
        let session = self.get_session(session_id)?;
        let mut state = session.timeline.lock().unwrap_or_else(|e| e.into_inner());
        state.finalized = true;
        Some(session.summary(&state))
    }

    /// Reclaim a finalized session after the exporter has acknowledged its final cursor.
    pub fn acknowledge_export(
        &self,
        session_id: &str,
        session_cursor: u64,
        through_cursor: u64,
    ) -> bool {
        let Some(session) = self
            .get_session(session_id)
            .filter(|session| session.cursor == session_cursor)
        else {
            return false;
        };
        {
            let state = session.timeline.lock().unwrap_or_else(|e| e.into_inner());
            if !state.finalized || through_cursor != state.attempts {
                return false;
            }
        }
        let mut index = self.sessions.write().unwrap_or_else(|e| e.into_inner());
        if index
            .by_id
            .get(session_id)
            .is_none_or(|current| current.cursor != session_cursor)
        {
            return false;
        }
        index.by_id.remove(session_id);
        index.by_cursor.remove(&session_cursor);
        drop(index);
        true
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::protocol::normalize_request;
    use serde_json::json;

    fn span(session: &str, start: u64, end: u64) -> AttemptSpan {
        let mut span = AttemptSpan::new(
            RunId("run".into()),
            SessionId(session.into()),
            Protocol::OpenaiResponsesHttp,
            Transport::Http,
            start,
        );
        span.finished_ns = Some(end);
        span.purpose = RequestPurpose::Main;
        span.outcome = AttemptOutcome::Completed;
        span
    }

    #[test]
    fn prometheus_samples_are_unique_for_mixed_statuses_and_purposes() {
        let metrics = ServerMetrics::default();
        let protocol = Protocol::OpenaiResponsesHttp;
        for status in ["200", "429", "503"] {
            metrics.record_dimension(protocol, "\"model\\\n", status, 23, 2, 1, Some(4), Some(9));
        }
        for (purpose, outcome) in [
            (RequestPurpose::Title, AttemptOutcome::Completed),
            (RequestPurpose::Title, AttemptOutcome::InjectedFault),
            (RequestPurpose::Main, AttemptOutcome::Completed),
        ] {
            metrics.record_dimension_with_labels(
                protocol,
                "\"model\\\n",
                Some(200),
                purpose,
                outcome,
                7,
                1,
                0,
                Some(3),
                Some(8),
            );
        }
        let output = metrics.render_prometheus(0);
        let mut samples = HashSet::new();
        for line in output
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
        {
            let sample = line.rsplit_once(' ').unwrap().0;
            assert!(
                samples.insert(sample),
                "duplicate Prometheus sample: {sample}"
            );
        }
        for status in ["200", "429", "503"] {
            assert!(samples.iter().any(|sample| {
                sample.starts_with("mock_ai_dimension_tokens_total{")
                    && sample.contains(&format!("status=\"{status}\""))
                    && sample.contains("model=\"\\\"model\\\\\\n\"")
            }));
        }
        assert!(samples.iter().any(|sample| {
            sample.starts_with("mock_ai_dimension_ttft_ms_bucket{")
                && sample.contains("purpose=\"title\",outcome=\"injected_fault\"")
        }));
    }

    #[test]
    fn attribution_measures_union_inside_wall_and_sums_failed_attempts() {
        let mut main = span("session", 5, 105);
        main.effective_context_bytes = 500;
        let mut title = span("session", 20, 80);
        title.purpose = RequestPurpose::Title;
        let mut failed = span("session", 130, 150);
        failed.outcome = AttemptOutcome::RateLimited;
        let summary = compute_attribution(10, 140, &[failed, title, main]);
        assert_eq!(summary.mock_service_sum_ns, 180);
        assert_eq!(
            summary.mock_service_sum_by_purpose_ns,
            BTreeMap::from([(RequestPurpose::Main, 120), (RequestPurpose::Title, 60),])
        );
        assert_eq!(summary.mock_union_ns, 105);
        assert_eq!(summary.outside_mock_wall_ns, 25);
        assert_eq!(summary.overlapping_intervals_count, 1);
        assert_eq!(
            summary
                .prompt_bytes_trajectory
                .iter()
                .map(|point| (point.headers_received_ns, point.effective_context_bytes))
                .collect::<Vec<_>>(),
            [(5, 500), (20, 0), (130, 0)]
        );
    }

    #[test]
    fn session_ring_enforces_both_budgets_and_exports_across_gaps() {
        let base = size_of::<TimelineItem>();
        let store = SessionTelemetryStore::new(3, 2, 3 * base + 128);
        let run = RunId("run".into());
        store
            .register_session(&run, &SessionId("session".into()))
            .unwrap();
        for start in 0..4 {
            store.record(span("session", start, start + 1)).unwrap();
        }

        let first = store.session_detail("session", None, 1).unwrap();
        assert_eq!(
            (first.oldest_cursor, first.next_cursor, first.dropped),
            (Some(3), 3, 2)
        );
        assert_eq!(first.items[0].span.headers_received_ns, 2);
        let second = store
            .session_detail("session", Some(first.next_cursor), 1)
            .unwrap();
        assert_eq!(second.items[0].cursor, 4);

        let mut large = span("session", 4, 5);
        large.response_id = Some(ResponseId("r".repeat(base + 128)));
        store.record(large).unwrap();
        let mut oversized = span("session", 5, 6);
        oversized.response_id = Some(ResponseId("r".repeat(4 * base)));
        store.record(oversized).unwrap();
        let tail = store
            .session_detail("session", Some(second.next_cursor), 10)
            .unwrap();
        assert_eq!(
            (tail.oldest_cursor, tail.next_cursor, tail.dropped),
            (Some(5), 6, 5)
        );
        assert_eq!(
            tail.items
                .iter()
                .map(|item| item.cursor)
                .collect::<Vec<_>>(),
            [5]
        );

        let other = RunId("other-run".into());
        store
            .register_session(&other, &SessionId("other-session".into()))
            .unwrap();
        store
            .register_session(&run, &SessionId("second-session".into()))
            .unwrap();
        store.record(span("second-session", 0, 1)).unwrap();
        assert_eq!(
            store.register_session(&run, &SessionId("over-capacity".into())),
            Err(SessionTelemetryError::Capacity)
        );
        let finalized = store.finalize("session").unwrap();
        assert_eq!(
            store.record(span("session", 6, 7)),
            Err(SessionTelemetryError::Finalized)
        );
        let page = store.list_sessions(Some("run"), None, 1);
        assert_eq!(page.items, std::slice::from_ref(&finalized));
        let next = store.list_sessions(Some("run"), page.next_cursor, 1);
        assert_eq!(next.items[0].session_id.0, "second-session");
        assert!(next.next_cursor.is_none());
        assert!(!store.acknowledge_export("session", finalized.cursor, 5));
        assert!(store.acknowledge_export("session", finalized.cursor, tail.next_cursor));
        assert!(store.session_detail("session", None, 10).is_none());
        assert_eq!(
            store.record(span("session", 6, 7)),
            Err(SessionTelemetryError::Unregistered)
        );
        store
            .register_session(&other, &SessionId("session".into()))
            .unwrap();
    }

    #[test]
    fn request_recorder_keeps_small_requests_when_an_oversize_body_arrives() {
        let recorder = RequestRecorder::new(RecorderMode::Ring {
            capacity: 2,
            max_bytes: 130,
        });
        let make_request = |sequence, text: &str| {
            let body = json!({"model": "model", "input": text});
            normalize_request(
                sequence,
                Protocol::OpenaiResponsesHttp,
                Transport::Http,
                "/v1/responses".into(),
                BTreeMap::new(),
                body.to_string().into(),
                body,
            )
        };
        recorder.record(&make_request(1, "one"));
        recorder.record(&make_request(2, &"large".repeat(50)));
        recorder.record(&make_request(3, "three"));
        assert_eq!(
            recorder
                .snapshot()
                .into_iter()
                .map(|record| record.sequence)
                .collect::<Vec<_>>(),
            [1, 3]
        );
    }

    #[test]
    fn reset_excludes_completions_from_the_previous_generation() {
        let metrics = ServerMetrics::default();
        let old = metrics.generation();
        assert!(metrics.record_for_generation(old, |metrics| metrics.ttft_ms.record(10)));
        metrics.reset();
        assert!(!metrics.record_for_generation(old, |metrics| metrics.ttft_ms.record(11)));
        assert!(
            metrics
                .record_for_generation(metrics.generation(), |metrics| metrics.ttft_ms.record(7))
        );
        let snapshot = metrics.snapshot();
        assert_eq!((snapshot.ttft_ms.count, snapshot.ttft_ms.sum), (1, 7));
    }
}
