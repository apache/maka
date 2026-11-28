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

use crate::plan::FrameKind;
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
    /// Log-normal coefficient of variation for per-turn decode speed.
    pub tps_jitter_cv: f64,
    /// Probability [0.0, 1.0] of adding a thinking/network micro-stall to a decoding turn.
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
    ttft: Duration,
    decode_jitter: f64,
    decode_stall: Duration,
    decoded_bytes: usize,
    decode_started: Option<tokio::time::Instant>,
    non_streaming_output_bytes: Option<usize>,
}

impl TurnPacer {
    pub fn new(
        profile: LatencyProfile,
        seed: u64,
        in_flight: usize,
        explicit_ttft_ms: Option<u64>,
        explicit_chunk_delay_ms: Option<u64>,
    ) -> Self {
        let rng = fastrand::Rng::with_seed(seed);
        let mut decode_rng = rng.clone().fork();
        let decode_jitter = if profile.tps_jitter_cv > 0.0 && profile.tokens_per_sec > 0.0 {
            sample_lognormal_multiplier(&mut decode_rng, profile.tps_jitter_cv)
        } else {
            1.0
        };
        let decode_stall =
            if profile.micro_stall_prob > 0.0 && decode_rng.f64() < profile.micro_stall_prob {
                let (lo, hi) = profile.micro_stall_ms_range;
                Duration::from_millis(decode_rng.u64(lo..=hi.max(lo)))
            } else {
                Duration::ZERO
            };
        Self {
            profile,
            rng,
            in_flight,
            explicit_ttft_ms,
            explicit_chunk_delay_ms,
            ttft: Duration::ZERO,
            decode_jitter,
            decode_stall,
            decoded_bytes: 0,
            decode_started: None,
            non_streaming_output_bytes: None,
        }
    }

    /// `logical_seed` identifies a scenario lane, step, and attempt without using arrival order.
    pub fn new_deterministic(
        profile: LatencyProfile,
        logical_seed: u64,
        prompt_bytes: usize,
        cache_hit_ratio: f64,
        is_streaming: bool,
        output_bytes: usize,
    ) -> Self {
        let mut pacer = Self::new(profile, logical_seed, 0, None, None);
        let input_tokens = (prompt_bytes as u64).div_ceil(4);
        let cached_tokens = ((input_tokens as f64 * cache_hit_ratio.clamp(0.0, 1.0)).round()
            as u64)
            .min(input_tokens);
        pacer.compute_ttft(input_tokens - cached_tokens, cached_tokens);
        pacer.non_streaming_output_bytes = (!is_streaming).then_some(output_bytes);
        pacer
    }

    /// Streaming waits for prefill, while non-streaming waits for prefill and the entire decode.
    pub fn initial_delay(&self) -> Duration {
        match self.non_streaming_output_bytes {
            Some(bytes) => self.non_streaming_total_delay(bytes),
            None => self.ttft,
        }
    }

    pub fn non_streaming_total_delay(&self, output_bytes: usize) -> Duration {
        self.ttft.saturating_add(self.decode_budget(output_bytes))
    }

    pub fn sse_ping_interval(&self) -> Option<Duration> {
        (self.profile.sse_ping_interval_ms > 0)
            .then(|| Duration::from_millis(self.profile.sse_ping_interval_ms))
    }

    /// Compute TTFT for this turn taking prompt prefill, cache read, concurrency congestion, and jitter into account.
    pub fn compute_ttft(&mut self, uncached_tokens: u64, cached_tokens: u64) -> Duration {
        self.ttft = self.sample_ttft(uncached_tokens, cached_tokens);
        self.ttft
    }

    fn sample_ttft(&mut self, uncached_tokens: u64, cached_tokens: u64) -> Duration {
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

    /// Anchor decode after the first wire frame and charge semantic bytes against that clock.
    pub fn next_frame_deadline(
        &mut self,
        kind: FrameKind,
        semantic_bytes: usize,
        sent_at: tokio::time::Instant,
    ) -> Option<tokio::time::Instant> {
        if kind == FrameKind::Keepalive {
            return None;
        }
        let started = *self.decode_started.get_or_insert(sent_at);
        if kind != FrameKind::SemanticDelta || semantic_bytes == 0 {
            return None;
        }
        let first_delta = self.decoded_bytes == 0;
        self.decoded_bytes = self.decoded_bytes.saturating_add(semantic_bytes);
        if let Some(ms) = self.explicit_chunk_delay_ms {
            let mut delay = Duration::from_millis(ms);
            if first_delta {
                delay = delay.saturating_add(self.decode_stall);
            }
            return Some(sent_at + delay);
        }
        Some(started + self.decode_budget(self.decoded_bytes))
    }

    pub fn jitter_ms(&mut self, min_ms: u64, max_ms: u64) -> u64 {
        let lo = min_ms.min(max_ms);
        let hi = min_ms.max(max_ms);
        if lo == hi { lo } else { self.rng.u64(lo..=hi) }
    }

    fn decode_budget(&self, bytes: usize) -> Duration {
        if bytes == 0 {
            return Duration::ZERO;
        }
        if self.profile.tokens_per_sec <= 0.0 {
            return self.decode_stall;
        }
        let mut tps = self.profile.tokens_per_sec;
        if self.profile.concurrency_knee > 0 && self.in_flight > self.profile.concurrency_knee {
            let excess = (self.in_flight - self.profile.concurrency_knee) as f64
                / self.profile.concurrency_knee as f64;
            tps /= 1.0 + self.profile.tps_congestion_factor * excess;
        }
        let tokens = bytes as f64 / 4.0;
        let millis = (tokens / tps) * self.decode_jitter * 1000.0;
        // Round the cumulative budget once, at the timer's millisecond granularity.
        Duration::from_millis(millis.round() as u64).saturating_add(self.decode_stall)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_delays_follow_logical_attempts_across_interleavings() {
        fn pacer(seed: u64) -> TurnPacer {
            TurnPacer::new_deterministic(
                LatencyProfile::realistic_frontier(),
                seed,
                18_000,
                0.5,
                true,
                1_200,
            )
        }

        let now = tokio::time::Instant::now();
        let delta = |pacer: &mut TurnPacer, bytes| {
            pacer.next_frame_deadline(FrameKind::SemanticDelta, bytes, now)
        };
        let mut first = pacer(17);
        let mut second = pacer(18);
        let first_delays = (
            first.initial_delay(),
            delta(&mut first, 400),
            first.jitter_ms(10, 800),
            delta(&mut first, 800),
        );
        let second_delays = (
            second.initial_delay(),
            delta(&mut second, 400),
            second.jitter_ms(10, 800),
            delta(&mut second, 800),
        );
        assert_ne!(first_delays, second_delays);

        let mut second = pacer(18);
        let mut first = pacer(17);
        let second_chunk = delta(&mut second, 400);
        let first_chunk = delta(&mut first, 400);
        assert_eq!(
            first.next_frame_deadline(FrameKind::Lifecycle, 500, now),
            None
        );
        let second_jitter = second.jitter_ms(10, 800);
        assert_eq!(
            first_delays,
            (
                first.initial_delay(),
                first_chunk,
                first.jitter_ms(10, 800),
                delta(&mut first, 800),
            )
        );
        assert_eq!(
            second_delays,
            (
                second.initial_delay(),
                second_chunk,
                second_jitter,
                delta(&mut second, 800),
            )
        );
    }

    #[test]
    fn semantic_bytes_drive_streaming_and_full_decode() {
        let profile = LatencyProfile {
            base_ttft_ms: 100,
            prefill_tokens_per_sec: 100.0,
            cache_read_tokens_per_sec: 200.0,
            tokens_per_sec: 10.0,
            ..Default::default()
        };
        let mut streaming = TurnPacer::new_deterministic(profile.clone(), 1, 400, 0.5, true, 80);
        let first_frame = tokio::time::Instant::now();
        assert_eq!(streaming.initial_delay(), Duration::from_millis(850));
        assert_eq!(
            streaming.next_frame_deadline(FrameKind::Lifecycle, 500, first_frame),
            None
        );
        assert_eq!(
            streaming.next_frame_deadline(FrameKind::SemanticDelta, 20, first_frame),
            Some(first_frame + Duration::from_millis(500))
        );
        assert_eq!(
            streaming.next_frame_deadline(
                FrameKind::SemanticDelta,
                60,
                first_frame + Duration::from_millis(510),
            ),
            Some(first_frame + Duration::from_millis(2_000))
        );
        let json = TurnPacer::new_deterministic(profile, 1, 400, 0.5, false, 80);
        assert_eq!(json.initial_delay(), Duration::from_millis(2_850));
        assert_eq!(
            json.non_streaming_total_delay(160),
            Duration::from_millis(4_850)
        );
    }

    #[test]
    fn decode_budget_is_the_same_for_single_frame_fragmented_and_json_output() {
        let bytes = 64 * 1024;
        let profile = LatencyProfile {
            base_ttft_ms: 23,
            tokens_per_sec: 127.0,
            micro_stall_prob: 1.0,
            micro_stall_ms_range: (37, 37),
            ..Default::default()
        };
        for jitter in [0.0, 0.2] {
            let profile = LatencyProfile {
                tps_jitter_cv: jitter,
                ..profile.clone()
            };
            let pacer =
                |stream| TurnPacer::new_deterministic(profile.clone(), 17, 0, 0.0, stream, bytes);
            let mut single = pacer(true);
            let mut fragmented = pacer(true);
            let now = tokio::time::Instant::now();
            let single_decode = single
                .next_frame_deadline(FrameKind::SemanticDelta, bytes, now)
                .unwrap()
                - now;
            let fragmented_decode = (0..bytes)
                .filter_map(|_| fragmented.next_frame_deadline(FrameKind::SemanticDelta, 1, now))
                .last()
                .unwrap()
                - now;
            if jitter == 0.0 {
                assert_eq!(single_decode, Duration::from_millis(129_045));
            }
            assert_eq!(fragmented_decode, single_decode);
            assert_eq!(
                pacer(false).initial_delay() - single.initial_delay(),
                single_decode
            );
        }
    }
}
