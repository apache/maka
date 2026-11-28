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

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Isolation scope for stateful rate-limit token buckets and concurrency caps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RateLimitScope {
    /// Single bucket shared across all requests to the server.
    #[default]
    Global,
    /// Separate bucket per API key / bearer token.
    PerApiKey,
    /// Separate bucket per requested model ID.
    PerModel,
    /// Separate bucket per (API key, model ID) pair.
    PerApiKeyAndModel,
}

/// Stateful RPM / ITPM / OTPM / concurrency quota configuration.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RateLimitConfig {
    pub enabled: bool,
    pub scope: RateLimitScope,
    /// Requests per minute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpm: Option<u64>,
    /// Optional request burst capacity (defaults to `rpm`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpm_burst: Option<u64>,
    /// Input tokens per minute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub itpm: Option<u64>,
    /// Output tokens per minute (debited upon turn completion; negative debt delays subsequent turns).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub otpm: Option<u64>,
    /// Maximum concurrent in-flight turns per bucket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent: Option<usize>,
    /// Maximum number of distinct scope keys retained in memory (prevents unbounded growth).
    #[serde(default = "default_max_buckets")]
    pub max_buckets: usize,
}

fn default_max_buckets() -> usize {
    16_384
}

impl RateLimitConfig {
    pub fn is_active(&self) -> bool {
        self.enabled
            && (self.rpm.is_some()
                || self.itpm.is_some()
                || self.otpm.is_some()
                || self.max_concurrent.is_some())
    }
}

/// Standard provider rate-limit response headers (`x-ratelimit-*`).
#[derive(Debug, Clone, Default)]
pub struct RateLimitHeaders {
    pub limit_requests: Option<u64>,
    pub remaining_requests: Option<u64>,
    pub reset_requests_ms: Option<u64>,
    pub limit_tokens: Option<u64>,
    pub remaining_tokens: Option<u64>,
    pub reset_tokens_ms: Option<u64>,
}

impl RateLimitHeaders {
    pub fn to_header_pairs(&self) -> Vec<(&'static str, String)> {
        let mut out = Vec::with_capacity(6);
        if let Some(v) = self.limit_requests {
            out.push(("x-ratelimit-limit-requests", v.to_string()));
        }
        if let Some(v) = self.remaining_requests {
            out.push(("x-ratelimit-remaining-requests", v.to_string()));
        }
        if let Some(v) = self.reset_requests_ms {
            out.push(("x-ratelimit-reset-requests", format!("{v}ms")));
        }
        if let Some(v) = self.limit_tokens {
            out.push(("x-ratelimit-limit-tokens", v.to_string()));
        }
        if let Some(v) = self.remaining_tokens {
            out.push(("x-ratelimit-remaining-tokens", v.to_string()));
        }
        if let Some(v) = self.reset_tokens_ms {
            out.push(("x-ratelimit-reset-tokens", format!("{v}ms")));
        }
        out
    }
}

/// RAII guard for a concurrency slot and its output-token accounting.
pub struct RateLimitLease {
    limiter: Arc<RateLimiter>,
    bucket_key: Arc<str>,
    generation: u64,
    output_tokens_debited: bool,
}

impl RateLimitLease {
    /// Debit actual emitted output tokens against OTPM for this turn.
    pub fn debit_output_tokens(&mut self, output_tokens: u64) {
        if self.output_tokens_debited {
            return;
        }
        self.output_tokens_debited = true;
        if output_tokens > 0 {
            self.limiter
                .debit_output(&self.bucket_key, self.generation, output_tokens);
        }
    }
}

impl Drop for RateLimitLease {
    fn drop(&mut self) {
        self.limiter.release_slot(&self.bucket_key, self.generation);
    }
}

pub enum RateLimitDecision {
    Allowed {
        headers: RateLimitHeaders,
        lease: Option<RateLimitLease>,
    },
    Rejected {
        retry_after_ms: u64,
        reason: &'static str,
        headers: RateLimitHeaders,
    },
}

struct TokenBucket {
    tokens: f64,
    capacity: f64,
    rate_per_sec: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(per_minute: u64, burst: Option<u64>, now: Instant) -> Self {
        let cap = burst.unwrap_or(per_minute).max(1) as f64;
        Self {
            tokens: cap,
            capacity: cap,
            rate_per_sec: (per_minute.max(1) as f64) / 60.0,
            last_refill: now,
        }
    }

    fn sync_config(&mut self, per_minute: u64, burst: Option<u64>, now: Instant) {
        self.refill(now);
        let cap = burst.unwrap_or(per_minute).max(1) as f64;
        self.capacity = cap;
        self.rate_per_sec = (per_minute.max(1) as f64) / 60.0;
        if self.tokens > self.capacity {
            self.tokens = self.capacity;
        }
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now
            .saturating_duration_since(self.last_refill)
            .as_secs_f64();
        if elapsed > 0.0 {
            self.tokens = (self.tokens + elapsed * self.rate_per_sec).min(self.capacity);
            self.last_refill = now;
        }
    }

    fn check_needed_ms(&mut self, cost: f64, now: Instant) -> Option<u64> {
        self.refill(now);
        // Clamp cost to capacity so a single oversized request can still pass once bucket is full
        // instead of permanently deadlocking forever.
        let effective_cost = cost.min(self.capacity);
        if self.tokens >= effective_cost {
            None
        } else {
            let deficit = effective_cost - self.tokens;
            let wait_ms = ((deficit / self.rate_per_sec) * 1000.0).ceil().max(1.0) as u64;
            Some(wait_ms)
        }
    }

    fn consume(&mut self, cost: f64) {
        self.tokens = (self.tokens - cost).max(-self.capacity);
    }

    fn remaining(&self) -> u64 {
        self.tokens.max(0.0).floor() as u64
    }

    fn reset_ms(&self) -> u64 {
        if self.tokens >= self.capacity {
            0
        } else {
            (((self.capacity - self.tokens) / self.rate_per_sec) * 1000.0)
                .ceil()
                .max(1.0) as u64
        }
    }
}

struct BucketState {
    rpm: Option<TokenBucket>,
    itpm: Option<TokenBucket>,
    otpm: Option<TokenBucket>,
    in_flight: usize,
    evict_at: Option<Instant>,
}

impl BucketState {
    fn new(cfg: &RateLimitConfig, now: Instant) -> Self {
        Self {
            rpm: cfg.rpm.map(|v| TokenBucket::new(v, cfg.rpm_burst, now)),
            itpm: cfg.itpm.map(|v| TokenBucket::new(v, None, now)),
            otpm: cfg.otpm.map(|v| TokenBucket::new(v, None, now)),
            in_flight: 0,
            evict_at: None,
        }
    }

    fn sync_config(&mut self, cfg: &RateLimitConfig, now: Instant) {
        match (&mut self.rpm, cfg.rpm) {
            (Some(b), Some(v)) => b.sync_config(v, cfg.rpm_burst, now),
            (None, Some(v)) => self.rpm = Some(TokenBucket::new(v, cfg.rpm_burst, now)),
            (Some(_), None) => self.rpm = None,
            (None, None) => {}
        }
        match (&mut self.itpm, cfg.itpm) {
            (Some(b), Some(v)) => b.sync_config(v, None, now),
            (None, Some(v)) => self.itpm = Some(TokenBucket::new(v, None, now)),
            (Some(_), None) => self.itpm = None,
            (None, None) => {}
        }
        match (&mut self.otpm, cfg.otpm) {
            (Some(b), Some(v)) => b.sync_config(v, None, now),
            (None, Some(v)) => self.otpm = Some(TokenBucket::new(v, None, now)),
            (Some(_), None) => self.otpm = None,
            (None, None) => {}
        }
    }

    fn headers(&self, cfg: &RateLimitConfig) -> RateLimitHeaders {
        let (limit_tokens, remaining_tokens, reset_tokens_ms) = match (&self.itpm, &self.otpm) {
            (Some(i), Some(o)) => (
                Some(cfg.itpm.unwrap_or(0).saturating_add(cfg.otpm.unwrap_or(0))),
                Some(i.remaining().min(o.remaining())),
                Some(i.reset_ms().max(o.reset_ms())),
            ),
            (Some(i), None) => (cfg.itpm, Some(i.remaining()), Some(i.reset_ms())),
            (None, Some(o)) => (cfg.otpm, Some(o.remaining()), Some(o.reset_ms())),
            (None, None) => (None, None, None),
        };
        RateLimitHeaders {
            limit_requests: cfg.rpm,
            remaining_requests: self.rpm.as_ref().map(TokenBucket::remaining),
            reset_requests_ms: self.rpm.as_ref().map(TokenBucket::reset_ms),
            limit_tokens,
            remaining_tokens,
            reset_tokens_ms,
        }
    }
}

#[derive(Default)]
struct BucketTable {
    entries: HashMap<Arc<str>, BucketState>,
    // One deadline per idle bucket. A bucket is evictable only after all its quotas refill.
    idle: BTreeSet<(Instant, Arc<str>)>,
}

impl BucketTable {
    fn evict_refilled(&mut self, now: Instant) -> bool {
        if self.idle.first().is_none_or(|(at, _)| *at > now) {
            return false;
        }
        let (_, key) = self.idle.pop_first().expect("eligible deadline exists");
        self.entries.remove(&key);
        true
    }

    fn index_idle(&mut self, key: Arc<str>, now: Instant) {
        let state = self.entries.get_mut(&key).expect("indexed bucket exists");
        let mut ready_at = now;
        for bucket in [&state.rpm, &state.itpm, &state.otpm].into_iter().flatten() {
            let seconds = (bucket.capacity - bucket.tokens) / bucket.rate_per_sec;
            let Some(at) = Duration::try_from_secs_f64(seconds)
                .ok()
                .and_then(|delay| delay.checked_add(Duration::from_nanos(u64::from(seconds > 0.0))))
                .and_then(|delay| bucket.last_refill.checked_add(delay))
            else {
                return;
            };
            ready_at = ready_at.max(at);
        }
        state.evict_at = Some(ready_at);
        self.idle.insert((ready_at, key));
    }
}

/// Stateful, runtime-reconfigurable token bucket and concurrency rate limiter.
pub struct RateLimiter {
    active: AtomicBool,
    generation: AtomicU64,
    config: RwLock<RateLimitConfig>,
    buckets: Mutex<BucketTable>,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Arc<Self> {
        let active = AtomicBool::new(config.is_active());
        Arc::new(Self {
            active,
            generation: AtomicU64::new(0),
            config: RwLock::new(config),
            buckets: Mutex::new(BucketTable::default()),
        })
    }

    pub fn config(&self) -> RateLimitConfig {
        self.config
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn update_config(&self, config: RateLimitConfig) {
        let active = config.is_active();
        let mut guard = self.config.write().unwrap_or_else(|e| e.into_inner());
        *guard = config;
        self.active.store(active, Ordering::Release);
    }

    pub fn reset(&self) {
        let mut guard = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        let old = std::mem::take(&mut *guard);
        self.generation.fetch_add(1, Ordering::Release);
        drop(guard);
        drop(old);
    }

    /// Evaluate admission for a single model turn. Optionally uses a phase-level override config.
    pub fn check_and_acquire(
        self: &Arc<Self>,
        api_key: &str,
        model: &str,
        estimated_input_tokens: u64,
        override_cfg: Option<&RateLimitConfig>,
    ) -> RateLimitDecision {
        if override_cfg.is_none() && !self.active.load(Ordering::Acquire) {
            return RateLimitDecision::Allowed {
                headers: RateLimitHeaders::default(),
                lease: None,
            };
        }
        let cfg = match override_cfg {
            Some(c) => c.clone(),
            None => self.config(),
        };
        if !cfg.is_active() {
            return RateLimitDecision::Allowed {
                headers: RateLimitHeaders::default(),
                lease: None,
            };
        }

        let key = bucket_key(cfg.scope, api_key, model);
        let mut guard = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let key = if let Some((key, _)) = guard.entries.get_key_value(key.as_str()) {
            key.clone()
        } else {
            let max_buckets = cfg.max_buckets.max(1);
            if guard.entries.len() >= max_buckets
                && (!guard.evict_refilled(now) || guard.entries.len() >= max_buckets)
            {
                return RateLimitDecision::Rejected {
                    retry_after_ms: 250,
                    reason: "rate_limit_table_full",
                    headers: RateLimitHeaders::default(),
                };
            }
            let key: Arc<str> = key.into();
            guard
                .entries
                .insert(key.clone(), BucketState::new(&cfg, now));
            key
        };

        let BucketTable { entries, idle } = &mut *guard;
        let state = entries.get_mut(&key).expect("admitted bucket exists");
        if let Some(at) = state.evict_at.take() {
            idle.remove(&(at, key.clone()));
        }
        state.sync_config(&cfg, now);

        // 1. Check concurrency cap first.
        if let Some(max_conc) = cfg.max_concurrent
            && state.in_flight >= max_conc
        {
            let headers = state.headers(&cfg);
            if state.in_flight == 0 {
                guard.index_idle(key, now);
            }
            return RateLimitDecision::Rejected {
                retry_after_ms: 250,
                reason: "max_concurrent_requests",
                headers,
            };
        }

        // 2. Check RPM, ITPM, and OTPM debt before consuming any bucket (atomic all-or-nothing check).
        let mut wait_ms: Option<(u64, &'static str)> = None;
        if let Some(ref mut rpm) = state.rpm
            && let Some(ms) = rpm.check_needed_ms(1.0, now)
        {
            wait_ms = Some((ms, "requests_per_minute"));
        }
        if let Some(ref mut itpm) = state.itpm {
            let cost = estimated_input_tokens.max(1) as f64;
            if let Some(ms) = itpm.check_needed_ms(cost, now)
                && wait_ms.is_none_or(|(prev, _)| ms > prev)
            {
                wait_ms = Some((ms, "input_tokens_per_minute"));
            }
        }
        if let Some(ref mut otpm) = state.otpm {
            // Require bucket to be non-negative before admitting another turn.
            if let Some(ms) = otpm.check_needed_ms(1.0, now)
                && wait_ms.is_none_or(|(prev, _)| ms > prev)
            {
                wait_ms = Some((ms, "output_tokens_per_minute"));
            }
        }

        if let Some((retry_after_ms, reason)) = wait_ms {
            let headers = state.headers(&cfg);
            if state.in_flight == 0 {
                guard.index_idle(key, now);
            }
            return RateLimitDecision::Rejected {
                retry_after_ms,
                reason,
                headers,
            };
        }

        // 3. Admit: consume RPM + ITPM and acquire concurrency slot.
        if let Some(ref mut rpm) = state.rpm {
            rpm.consume(1.0);
        }
        if let Some(ref mut itpm) = state.itpm {
            itpm.consume(estimated_input_tokens.max(1) as f64);
        }
        state.in_flight += 1;
        let headers = state.headers(&cfg);
        let generation = self.generation.load(Ordering::Acquire);

        RateLimitDecision::Allowed {
            headers,
            lease: Some(RateLimitLease {
                limiter: self.clone(),
                bucket_key: key,
                generation,
                output_tokens_debited: false,
            }),
        }
    }

    fn release_slot(&self, key: &Arc<str>, generation: u64) {
        let Some(mut guard) = self.buckets_for_generation(generation) else {
            return;
        };
        let state = guard.entries.get_mut(key).expect("leased bucket exists");
        state.in_flight -= 1;
        if state.in_flight == 0 {
            guard.index_idle(key.clone(), Instant::now());
        }
    }

    fn debit_output(&self, key: &Arc<str>, generation: u64, output_tokens: u64) {
        let Some(mut guard) = self.buckets_for_generation(generation) else {
            return;
        };
        let state = guard.entries.get_mut(key).expect("leased bucket exists");
        if let Some(otpm) = &mut state.otpm {
            otpm.refill(Instant::now());
            otpm.consume(output_tokens as f64);
        }
    }

    fn buckets_for_generation(
        &self,
        generation: u64,
    ) -> Option<std::sync::MutexGuard<'_, BucketTable>> {
        if self.generation.load(Ordering::Acquire) != generation {
            return None;
        }
        let guard = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        (self.generation.load(Ordering::Relaxed) == generation).then_some(guard)
    }
}

fn bucket_key(scope: RateLimitScope, api_key: &str, model: &str) -> String {
    match scope {
        RateLimitScope::Global => "global".into(),
        RateLimitScope::PerApiKey => format!("key:{api_key}"),
        RateLimitScope::PerModel => format!("model:{model}"),
        RateLimitScope::PerApiKeyAndModel => format!("key:{api_key}|model:{model}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acquire(limiter: &Arc<RateLimiter>, model: &str) -> RateLimitLease {
        match limiter.check_and_acquire("", model, 1, None) {
            RateLimitDecision::Allowed {
                lease: Some(lease), ..
            } => lease,
            _ => panic!("expected a lease for {model}"),
        }
    }

    #[test]
    fn full_table_can_reuse_idle_refilled_buckets_but_keeps_active_slots_and_debt() {
        let limiter = RateLimiter::new(RateLimitConfig {
            enabled: true,
            scope: RateLimitScope::PerModel,
            max_concurrent: Some(1),
            max_buckets: 1,
            ..Default::default()
        });
        let first = acquire(&limiter, "first");
        assert!(matches!(
            limiter.check_and_acquire("", "second", 1, None),
            RateLimitDecision::Rejected {
                reason: "rate_limit_table_full",
                ..
            }
        ));
        drop(first);

        limiter.update_config(RateLimitConfig {
            rpm: Some(1),
            ..limiter.config()
        });
        drop(acquire(&limiter, "second"));
        assert!(matches!(
            limiter.check_and_acquire("", "third", 1, None),
            RateLimitDecision::Rejected {
                reason: "rate_limit_table_full",
                ..
            }
        ));
    }

    #[test]
    fn stale_lease_neither_releases_new_slot_nor_debits_new_quota() {
        let limiter = RateLimiter::new(RateLimitConfig {
            enabled: true,
            max_concurrent: Some(1),
            otpm: Some(1),
            max_buckets: 1,
            ..Default::default()
        });
        let mut old = acquire(&limiter, "model");
        limiter.reset();
        let current = acquire(&limiter, "model");
        old.debit_output_tokens(10);
        drop(old);
        assert!(matches!(
            limiter.check_and_acquire("", "model", 1, None),
            RateLimitDecision::Rejected {
                reason: "max_concurrent_requests",
                ..
            }
        ));
        drop(current);
        drop(acquire(&limiter, "model"));
    }
}
