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

use crate::ratelimit::RateLimitConfig;
use crate::workload::ChaosConfig;
use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// Physics-inspired TTFT, TPS, concurrency congestion, and micro-stall latency profile.
///
/// All parameters are optional/zero-safe so default unit tests run with zero artificial delay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LatencyProfile {
    /// Fixed minimum TTFT in milliseconds before prefill/jitter.
    pub base_ttft_ms: u64,
    /// Prompt prefill throughput for uncached input tokens (tokens/sec). 0 disables prefill scaling.
    pub prefill_tokens_per_sec: f64,
    /// Prefill throughput for cached input tokens (tokens/sec). 0 disables cached scaling.
    pub cache_read_tokens_per_sec: f64,
    /// Log-normal coefficient of variation for TTFT long-tail jitter (e.g. 0.25 = realistic p95/p99).
    pub ttft_jitter_cv: f64,
    /// Hard cap on computed TTFT in milliseconds (prevents extreme tail outliers from hanging tests).
    pub ttft_max_ms: u64,
    /// Concurrency threshold where queueing/contention begins. 0 disables congestion scaling.
    pub concurrency_knee: usize,
    /// Multiplier for quadratic TTFT growth above `concurrency_knee`.
    pub ttft_congestion_factor: f64,
    /// Degradation factor for TPS above `concurrency_knee`: `tps / (1 + factor * excess_ratio)`.
    pub tps_congestion_factor: f64,
    /// Target streaming generation speed in tokens/sec (approx 4 chars/token). 0 = unlimited/instant.
    pub tokens_per_sec: f64,
    /// Log-normal coefficient of variation for per-chunk inter-token timing jitter.
    pub tps_jitter_cv: f64,
    /// Probability [0.0, 1.0] of inserting a mid-stream thinking/network micro-stall before a chunk.
    pub micro_stall_prob: f64,
    /// Micro-stall duration range (min_ms, max_ms).
    pub micro_stall_ms_range: (u64, u64),
    /// Interval in ms for emitting SSE `: keep-alive\n\n` comments during long TTFT waits. 0 disables.
    pub sse_ping_interval_ms: u64,
}

impl Default for LatencyProfile {
    fn default() -> Self {
        Self {
            base_ttft_ms: 0,
            prefill_tokens_per_sec: 0.0,
            cache_read_tokens_per_sec: 0.0,
            ttft_jitter_cv: 0.0,
            ttft_max_ms: 60_000,
            concurrency_knee: 0,
            ttft_congestion_factor: 1.0,
            tps_congestion_factor: 0.5,
            tokens_per_sec: 0.0,
            tps_jitter_cv: 0.0,
            micro_stall_prob: 0.0,
            micro_stall_ms_range: (0, 0),
            sse_ping_interval_ms: 0,
        }
    }
}

impl LatencyProfile {
    /// Realistic frontier-model streaming profile (~350ms base TTFT, 85 TPS, mild tail jitter).
    pub fn realistic_frontier() -> Self {
        Self {
            base_ttft_ms: 350,
            prefill_tokens_per_sec: 40_000.0,
            cache_read_tokens_per_sec: 200_000.0,
            ttft_jitter_cv: 0.25,
            ttft_max_ms: 30_000,
            concurrency_knee: 64,
            ttft_congestion_factor: 1.5,
            tps_congestion_factor: 0.6,
            tokens_per_sec: 85.0,
            tps_jitter_cv: 0.2,
            micro_stall_prob: 0.02,
            micro_stall_ms_range: (150, 800),
            sse_ping_interval_ms: 5_000,
        }
    }

    /// Degraded upstream incident profile (high TTFT, low TPS, frequent stalls).
    pub fn degraded_incident() -> Self {
        Self {
            base_ttft_ms: 2_500,
            prefill_tokens_per_sec: 8_000.0,
            cache_read_tokens_per_sec: 40_000.0,
            ttft_jitter_cv: 0.5,
            ttft_max_ms: 45_000,
            concurrency_knee: 16,
            ttft_congestion_factor: 2.5,
            tps_congestion_factor: 1.2,
            tokens_per_sec: 15.0,
            tps_jitter_cv: 0.4,
            micro_stall_prob: 0.10,
            micro_stall_ms_range: (500, 2_500),
            sse_ping_interval_ms: 2_000,
        }
    }

    pub fn is_zero(&self) -> bool {
        self.base_ttft_ms == 0
            && self.prefill_tokens_per_sec <= 0.0
            && self.cache_read_tokens_per_sec <= 0.0
            && self.tokens_per_sec <= 0.0
            && self.micro_stall_prob <= 0.0
    }
}

/// Runtime-tunable profile combining latency physics and optional chaos/rate-limit overrides.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeProfile {
    pub latency: LatencyProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chaos_override: Option<ChaosConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_override: Option<RateLimitConfig>,
}

/// Single time-activated phase in a `ScenarioSchedule`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioPhase {
    /// Human-readable phase name (e.g. "baseline", "incident-spike", "recovery").
    pub name: String,
    /// Activation offset in seconds from server start (or last `/admin/reset`).
    pub at_secs: u64,
    #[serde(default)]
    pub profile: RuntimeProfile,
}

/// Time-phased traffic wave schedule that automatically transitions profiles over elapsed time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScenarioSchedule {
    /// Ordered phases by `at_secs`.
    pub phases: Vec<ScenarioPhase>,
    /// Optional cycle length in seconds; when set, elapsed time wraps modulo `repeat_cycle_secs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_cycle_secs: Option<u64>,
}

impl ScenarioSchedule {
    /// Built-in 3-phase incident wave: 60s baseline -> 60s severe degradation -> 60s recovery (repeating).
    pub fn incident_wave() -> Self {
        Self {
            phases: vec![
                ScenarioPhase {
                    name: "baseline".into(),
                    at_secs: 0,
                    profile: RuntimeProfile {
                        latency: LatencyProfile::realistic_frontier(),
                        chaos_override: Some(ChaosConfig::default()),
                        rate_limit_override: None,
                    },
                },
                ScenarioPhase {
                    name: "incident-spike".into(),
                    at_secs: 60,
                    profile: RuntimeProfile {
                        latency: LatencyProfile::degraded_incident(),
                        chaos_override: Some(ChaosConfig {
                            rate_limit_rate: 0.15,
                            rate_limit_retry_after_ms: 200,
                            server_error_rate: 0.05,
                            mid_stream_error_rate: 0.03,
                            drop_connection_rate: 0.02,
                            truncate_eof_rate: 0.0,
                            ..Default::default()
                        }),
                        rate_limit_override: None,
                    },
                },
                ScenarioPhase {
                    name: "recovery".into(),
                    at_secs: 120,
                    profile: RuntimeProfile {
                        latency: LatencyProfile::realistic_frontier(),
                        chaos_override: Some(ChaosConfig::default()),
                        rate_limit_override: None,
                    },
                },
            ],
            repeat_cycle_secs: Some(180),
        }
    }

    pub fn active_phase(&self, elapsed_secs: u64) -> Option<&ScenarioPhase> {
        if self.phases.is_empty() {
            return None;
        }
        let t = match self.repeat_cycle_secs {
            Some(cycle) if cycle > 0 => elapsed_secs % cycle,
            _ => elapsed_secs,
        };
        let mut best: Option<&ScenarioPhase> = None;
        for phase in &self.phases {
            if phase.at_secs <= t && best.is_none_or(|b| phase.at_secs >= b.at_secs) {
                best = Some(phase);
            }
        }
        best
    }
}

/// Snapshot returned by `GET /admin/profile`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSnapshot {
    pub elapsed_secs: u64,
    pub active_phase: Option<String>,
    pub manual_override_active: bool,
    pub effective: RuntimeProfile,
    pub schedule: ScenarioSchedule,
}

/// Thread-safe runtime manager resolving the active `RuntimeProfile` from manual overrides or schedule.
pub struct DynamicProfileManager {
    inner: RwLock<ProfileState>,
}

struct ProfileState {
    started_at: Instant,
    base: RuntimeProfile,
    manual_override: Option<RuntimeProfile>,
    schedule: ScenarioSchedule,
}

impl DynamicProfileManager {
    pub fn new(base: RuntimeProfile, schedule: ScenarioSchedule) -> Self {
        Self {
            inner: RwLock::new(ProfileState {
                started_at: Instant::now(),
                base,
                manual_override: None,
                schedule,
            }),
        }
    }

    pub fn effective(&self) -> RuntimeProfile {
        let guard = self.inner.read().unwrap_or_else(|e| e.into_inner());
        if let Some(ref manual) = guard.manual_override {
            return manual.clone();
        }
        let elapsed = guard.started_at.elapsed().as_secs();
        if let Some(phase) = guard.schedule.active_phase(elapsed) {
            return phase.profile.clone();
        }
        guard.base.clone()
    }

    pub fn set_manual_override(&self, profile: Option<RuntimeProfile>) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.manual_override = profile;
    }

    pub fn set_schedule(&self, schedule: ScenarioSchedule) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.schedule = schedule;
        guard.started_at = Instant::now();
    }

    pub fn reset_clock(&self) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.started_at = Instant::now();
        guard.manual_override = None;
    }

    pub fn snapshot(&self) -> ProfileSnapshot {
        let guard = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let elapsed = guard.started_at.elapsed().as_secs();
        let active_phase = if guard.manual_override.is_some() {
            None
        } else {
            guard.schedule.active_phase(elapsed).map(|p| p.name.clone())
        };
        let effective = if let Some(ref manual) = guard.manual_override {
            manual.clone()
        } else if let Some(phase) = guard.schedule.active_phase(elapsed) {
            phase.profile.clone()
        } else {
            guard.base.clone()
        };
        ProfileSnapshot {
            elapsed_secs: elapsed,
            active_phase,
            manual_override_active: guard.manual_override.is_some(),
            effective,
            schedule: guard.schedule.clone(),
        }
    }
}

/// Per-turn pacing calculator driven by a deterministic PRNG and `LatencyProfile`.
pub struct TurnPacer {
    profile: LatencyProfile,
    rng: fastrand::Rng,
    in_flight: usize,
    explicit_ttft_ms: Option<u64>,
    explicit_chunk_delay_ms: Option<u64>,
}

impl TurnPacer {
    pub fn new(
        profile: LatencyProfile,
        seed: u64,
        in_flight: usize,
        explicit_ttft_ms: Option<u64>,
        explicit_chunk_delay_ms: Option<u64>,
    ) -> Self {
        Self {
            profile,
            rng: fastrand::Rng::with_seed(seed),
            in_flight,
            explicit_ttft_ms,
            explicit_chunk_delay_ms,
        }
    }

    pub fn sse_ping_interval(&self) -> Option<Duration> {
        (self.profile.sse_ping_interval_ms > 0)
            .then(|| Duration::from_millis(self.profile.sse_ping_interval_ms))
    }

    /// Compute TTFT for this turn taking prompt prefill, cache read, concurrency congestion, and jitter into account.
    pub fn compute_ttft(&mut self, uncached_tokens: u64, cached_tokens: u64) -> Duration {
        if let Some(ms) = self.explicit_ttft_ms {
            return Duration::from_millis(ms);
        }
        if self.profile.is_zero() {
            return Duration::ZERO;
        }
        let mut ttft = self.profile.base_ttft_ms as f64;
        if self.profile.prefill_tokens_per_sec > 0.0 && uncached_tokens > 0 {
            ttft += (uncached_tokens as f64 / self.profile.prefill_tokens_per_sec) * 1000.0;
        }
        if self.profile.cache_read_tokens_per_sec > 0.0 && cached_tokens > 0 {
            ttft += (cached_tokens as f64 / self.profile.cache_read_tokens_per_sec) * 1000.0;
        }
        // Quadratic concurrency congestion above `concurrency_knee`.
        if self.profile.concurrency_knee > 0 && self.in_flight > self.profile.concurrency_knee {
            let excess = (self.in_flight - self.profile.concurrency_knee) as f64
                / self.profile.concurrency_knee as f64;
            ttft *= 1.0 + self.profile.ttft_congestion_factor * excess * excess;
        }
        if self.profile.ttft_jitter_cv > 0.0 && ttft > 0.0 {
            ttft *= sample_lognormal_multiplier(&mut self.rng, self.profile.ttft_jitter_cv);
        }
        let cap = if self.profile.ttft_max_ms > 0 {
            self.profile.ttft_max_ms as f64
        } else {
            f64::MAX
        };
        let clamped = ttft.clamp(0.0, cap).round() as u64;
        Duration::from_millis(clamped)
    }

    /// Compute streaming delay for an emitted chunk of `payload_bytes`, including TPS degradation, jitter, and micro-stalls.
    pub fn next_chunk_delay(&mut self, payload_bytes: usize) -> Duration {
        let mut delay_ms = if let Some(ms) = self.explicit_chunk_delay_ms {
            ms as f64
        } else if self.profile.tokens_per_sec > 0.0 && payload_bytes > 0 {
            let mut effective_tps = self.profile.tokens_per_sec;
            if self.profile.concurrency_knee > 0 && self.in_flight > self.profile.concurrency_knee {
                let excess = (self.in_flight - self.profile.concurrency_knee) as f64
                    / self.profile.concurrency_knee as f64;
                effective_tps /= 1.0 + self.profile.tps_congestion_factor * excess;
            }
            // Approximate 4 UTF-8 bytes per token, minimum 0.5 token per delta chunk.
            let est_tokens = (payload_bytes as f64 / 4.0).max(0.5);
            let mut ms = (est_tokens / effective_tps.max(0.1)) * 1000.0;
            if self.profile.tps_jitter_cv > 0.0 {
                ms *= sample_lognormal_multiplier(&mut self.rng, self.profile.tps_jitter_cv);
            }
            ms
        } else {
            0.0
        };

        // Optional mid-stream micro-stall.
        if self.profile.micro_stall_prob > 0.0 && self.rng.f64() < self.profile.micro_stall_prob {
            let (lo, hi) = self.profile.micro_stall_ms_range;
            let hi = hi.max(lo);
            let stall = if hi > lo { self.rng.u64(lo..=hi) } else { lo };
            delay_ms += stall as f64;
        }

        if delay_ms <= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_millis(delay_ms.round().min(60_000.0) as u64)
        }
    }
}

/// Sample a log-normal multiplier with mean = 1.0 and coefficient of variation `cv` using Box-Muller.
fn sample_lognormal_multiplier(rng: &mut fastrand::Rng, cv: f64) -> f64 {
    let cv = cv.clamp(0.0, 2.0);
    if cv <= 0.0 {
        return 1.0;
    }
    let sigma2 = (1.0 + cv * cv).ln();
    let sigma = sigma2.sqrt();
    let mu = -0.5 * sigma2;
    let u1 = rng.f64().clamp(1e-12, 1.0 - 1e-12);
    let u2 = rng.f64();
    let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
    (mu + sigma * z).exp().clamp(0.05, 20.0)
}
