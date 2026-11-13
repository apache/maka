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

//! Token usage preservation, admission boundary accounting, checkpoint HMAC
//! verification, receipt-vs-proxy reconciliation, and standardized pricing.

use crate::contract::{ContractError, JsonObject, exact_object, nonnegative_u64, sha256_hex};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub mod gateway;
pub use gateway::*;

pub const METERING_CHECKPOINT_LIMIT_BYTES: usize = 64 * 1024;
pub const COST_USD_TOLERANCE: f64 = 1e-9;

/// Exact 6-counter normalized token usage.
///
/// Each counter is preserved as reported by the provider or receipt; `total_tokens`
/// is never synthesized or overwritten by summing the other five counters.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
}

impl NormalizedUsage {
    pub fn decode(value: &Value, where_label: &str) -> Result<Self, ContractError> {
        let obj = exact_object(
            value,
            where_label,
            &[
                "inputTokens",
                "outputTokens",
                "cacheReadTokens",
                "cacheWriteTokens",
                "reasoningTokens",
                "totalTokens",
            ],
            &[],
        )?;
        Ok(Self {
            input_tokens: nonnegative_u64(
                obj.get("inputTokens").unwrap(),
                &format!("{where_label}.inputTokens"),
            )?,
            output_tokens: nonnegative_u64(
                obj.get("outputTokens").unwrap(),
                &format!("{where_label}.outputTokens"),
            )?,
            cache_read_tokens: nonnegative_u64(
                obj.get("cacheReadTokens").unwrap(),
                &format!("{where_label}.cacheReadTokens"),
            )?,
            cache_write_tokens: nonnegative_u64(
                obj.get("cacheWriteTokens").unwrap(),
                &format!("{where_label}.cacheWriteTokens"),
            )?,
            reasoning_tokens: nonnegative_u64(
                obj.get("reasoningTokens").unwrap(),
                &format!("{where_label}.reasoningTokens"),
            )?,
            total_tokens: nonnegative_u64(
                obj.get("totalTokens").unwrap(),
                &format!("{where_label}.totalTokens"),
            )?,
        })
    }

    /// Accumulates another `NormalizedUsage` record counter-by-counter without
    /// synthesizing `total_tokens` from the component fields.
    pub fn accumulate_exact(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(other.cache_write_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeteringState {
    Complete,
    LowerBound,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TokenBasis {
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "lower-bound")]
    LowerBound,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PricingRates {
    pub input_per_million: f64,
    pub output_per_million: f64,
    pub cache_read_per_million: f64,
    pub cache_write_per_million: f64,
}

/// Published DeepSeek V4 Flash prices in USD per million tokens (off-peak band).
pub const DEEPSEEK_V4_FLASH_COST: PricingRates = PricingRates {
    input_per_million: 0.22,
    output_per_million: 0.66,
    cache_read_per_million: 0.007,
    cache_write_per_million: 0.22,
};

pub fn deepseek_cost_usd(usage: &NormalizedUsage) -> f64 {
    price_usage_usd(usage, &DEEPSEEK_V4_FLASH_COST)
}

pub fn price_usage_usd(usage: &NormalizedUsage, rates: &PricingRates) -> f64 {
    let cached = usage
        .cache_read_tokens
        .saturating_add(usage.cache_write_tokens);
    let uncached = usage.input_tokens.saturating_sub(cached);
    ((uncached as f64) * rates.input_per_million
        + (usage.cache_read_tokens as f64) * rates.cache_read_per_million
        + (usage.cache_write_tokens as f64) * rates.cache_write_per_million
        + (usage.output_tokens as f64) * rates.output_per_million)
        / 1_000_000.0
}

pub fn costs_match_within_tolerance(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(a), Some(b)) => (a - b).abs() <= COST_USD_TOLERANCE,
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderMeteringCounts {
    pub usage: Option<NormalizedUsage>,
    pub settled: bool,
    pub requests: u64,
    pub in_flight_requests: u64,
    pub admitted_requests: u64,
    pub usage_requests: u64,
    pub models: Vec<String>,
    pub tool_names: Vec<String>,
}

impl ProviderMeteringCounts {
    pub fn validate(&self) -> bool {
        if self.settled && self.in_flight_requests > 0 {
            return false;
        }
        if self.in_flight_requests > self.requests
            || self.admitted_requests > self.requests
            || self.usage_requests > self.admitted_requests
        {
            return false;
        }
        if self.usage_requests > 0 && self.usage.is_none() {
            return false;
        }
        true
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedMetering {
    pub settled_requests: u64,
    pub missing_usage_requests: u64,
    pub usage_complete: bool,
    pub cost_usd: Option<f64>,
    pub token_basis: TokenBasis,
    pub metering_state: MeteringState,
}

pub fn derive_metering(counts: &ProviderMeteringCounts) -> DerivedMetering {
    let usage_complete = counts.settled
        && counts.admitted_requests > 0
        && counts.usage_requests == counts.admitted_requests;
    let cost_usd = match (&counts.usage, usage_complete) {
        (Some(u), true) => Some(deepseek_cost_usd(u)),
        _ => None,
    };
    let metering_state = match (&counts.usage, usage_complete) {
        (Some(_), true) => MeteringState::Complete,
        (Some(_), false) => MeteringState::LowerBound,
        (None, _) => MeteringState::Unknown,
    };
    DerivedMetering {
        settled_requests: counts.requests.saturating_sub(counts.in_flight_requests),
        missing_usage_requests: counts
            .admitted_requests
            .saturating_sub(counts.usage_requests),
        usage_complete,
        cost_usd,
        token_basis: if usage_complete {
            TokenBasis::Complete
        } else {
            TokenBasis::LowerBound
        },
        metering_state,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RequestLedgerEntry {
    admitted: bool,
    in_flight: bool,
    usage: Option<NormalizedUsage>,
    model: Option<String>,
}

/// Tracks request admission across the trial execution cutoff, deduplicating
/// repeated checkpoints and reconciling Host receipts against proxy metering
/// without double-counting.
#[derive(Debug, Clone, Default)]
pub struct AdmissionBoundaryLedger {
    cutoff_closed: bool,
    settled: bool,
    requests: BTreeMap<String, RequestLedgerEntry>,
    seen_checkpoint_digests: BTreeSet<String>,
    latest_checkpoint: Option<ProviderMeteringCounts>,
    tool_names: BTreeSet<String>,
}

impl AdmissionBoundaryLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_admission_closed(&self) -> bool {
        self.cutoff_closed
    }

    /// Closes admission for new requests at the execution deadline/cancellation
    /// boundary while allowing already-admitted in-flight requests to drain.
    pub fn close_admission(&mut self) {
        self.cutoff_closed = true;
    }

    /// Attempts to admit a request with `request_id`. Returns `true` if admitted,
    /// or `false` if the admission boundary has already closed. Idempotent for an
    /// already-recorded `request_id`.
    pub fn record_request_start(&mut self, request_id: impl Into<String>) -> bool {
        let id = request_id.into();
        if let Some(existing) = self.requests.get(&id) {
            return existing.admitted;
        }
        let admitted = !self.cutoff_closed;
        self.requests.insert(
            id,
            RequestLedgerEntry {
                admitted,
                in_flight: admitted,
                usage: None,
                model: None,
            },
        );
        admitted
    }

    /// Records the settlement of an admitted request. Duplicate settlements for
    /// the same `request_id` (e.g. from both a Host receipt and a proxy log) are
    /// reconciled idempotently without double-counting tokens.
    pub fn settle_request(
        &mut self,
        request_id: &str,
        usage: Option<NormalizedUsage>,
        model: Option<String>,
    ) -> Result<(), ContractError> {
        let Some(entry) = self.requests.get_mut(request_id) else {
            return Err(ContractError::Invalid(format!(
                "unknown request_id in metering settlement: {request_id}"
            )));
        };
        if !entry.admitted {
            return Ok(());
        }
        entry.in_flight = false;
        if let (Some(existing), Some(incoming)) = (&entry.usage, &usage) {
            if existing != incoming {
                return Err(ContractError::Invalid(format!(
                    "conflicting usage between receipt and proxy for request {request_id}"
                )));
            }
        } else if entry.usage.is_none() {
            entry.usage = usage;
        }
        if entry.model.is_none() {
            entry.model = model;
        }
        Ok(())
    }

    /// Ingests a proxy checkpoint snapshot. Duplicate snapshots with the same
    /// canonical digest are ignored so repeated checkpoint reads never inflate counts.
    pub fn ingest_checkpoint(&mut self, counts: ProviderMeteringCounts) -> bool {
        let serialized = serde_json::to_vec(&counts).unwrap_or_default();
        let digest = sha256_hex(&serialized);
        if !self.seen_checkpoint_digests.insert(digest) {
            return false;
        }
        self.latest_checkpoint = Some(counts);
        true
    }

    pub fn mark_proxy_settled(&mut self) {
        if self.requests.values().all(|r| !r.in_flight) {
            self.settled = true;
        }
    }

    pub fn snapshot(&self) -> ProviderMeteringCounts {
        if self.requests.is_empty()
            && let Some(cp) = &self.latest_checkpoint
        {
            return cp.clone();
        }
        let requests = self.requests.len() as u64;
        let in_flight_requests = self.requests.values().filter(|r| r.in_flight).count() as u64;
        let admitted_requests = self.requests.values().filter(|r| r.admitted).count() as u64;
        let mut usage_requests = 0u64;
        let mut accumulated = NormalizedUsage::default();
        let mut models = BTreeSet::new();

        for entry in self.requests.values().filter(|r| r.admitted) {
            if let Some(u) = &entry.usage {
                usage_requests += 1;
                accumulated.accumulate_exact(u);
            }
            if let Some(m) = &entry.model {
                models.insert(m.clone());
            }
        }

        ProviderMeteringCounts {
            usage: if usage_requests > 0 {
                Some(accumulated)
            } else {
                None
            },
            settled: self.settled && in_flight_requests == 0,
            requests,
            in_flight_requests,
            admitted_requests,
            usage_requests,
            models: models.into_iter().collect(),
            tool_names: self.tool_names.iter().cloned().collect(),
        }
    }
}

/// Reconciles Host-reported usage with proxy-recovered usage without double-counting.
///
/// - When both Host receipts and proxy counts are settled and complete, they must agree;
///   otherwise reconciliation reports `MeteringState::LowerBound` with the conservative record.
/// - When the Host died before settling receipts, the verified proxy checkpoint provides
///   either `Complete` (if the proxy settled with all admitted requests accounted for) or
///   `LowerBound` usage.
pub fn reconcile_host_and_proxy_usage(
    host_usage: Option<&NormalizedUsage>,
    host_settled: bool,
    proxy_counts: Option<&ProviderMeteringCounts>,
) -> (Option<NormalizedUsage>, MeteringState, Option<f64>) {
    match (host_usage, host_settled, proxy_counts) {
        (Some(h), true, Some(p)) => {
            let derived = derive_metering(p);
            if derived.usage_complete {
                if p.usage.as_ref() == Some(h) {
                    (
                        Some(h.clone()),
                        MeteringState::Complete,
                        Some(deepseek_cost_usd(h)),
                    )
                } else {
                    (Some(h.clone()), MeteringState::LowerBound, None)
                }
            } else {
                (
                    Some(h.clone()),
                    MeteringState::Complete,
                    Some(deepseek_cost_usd(h)),
                )
            }
        }
        (Some(h), true, None) => (
            Some(h.clone()),
            MeteringState::Complete,
            Some(deepseek_cost_usd(h)),
        ),
        (Some(h), false, Some(p)) => {
            let derived = derive_metering(p);
            if derived.usage_complete {
                (p.usage.clone(), MeteringState::Complete, derived.cost_usd)
            } else {
                (
                    p.usage.clone().or_else(|| Some(h.clone())),
                    MeteringState::LowerBound,
                    None,
                )
            }
        }
        (Some(h), false, None) => (Some(h.clone()), MeteringState::LowerBound, None),
        (None, _, Some(p)) => {
            let derived = derive_metering(p);
            (p.usage.clone(), derived.metering_state, derived.cost_usd)
        }
        (None, _, None) => (None, MeteringState::Unknown, None),
    }
}

/// Computes RFC 2104 HMAC-SHA256 in hex.
pub fn hmac_sha256_hex(secret: &[u8], message: &[u8]) -> String {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0u8; BLOCK_SIZE];
    if secret.len() > BLOCK_SIZE {
        let digest = Sha256::digest(secret);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..secret.len()].copy_from_slice(secret);
    }

    let mut ipad = [0x36u8; BLOCK_SIZE];
    let mut opad = [0x5cu8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    hex::encode(outer.finalize())
}

pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn sign_metering_checkpoint(body: &JsonObject, secret: &str) -> JsonObject {
    let serialized = serde_json::to_string(&Value::Object(body.clone()))
        .expect("serializing JsonObject cannot fail");
    let mac = hmac_sha256_hex(secret.as_bytes(), serialized.as_bytes());
    let mut signed = body.clone();
    signed.insert("mac".into(), Value::String(mac));
    signed
}

pub fn metering_checkpoint_mac_matches(record: &JsonObject, secret: &str) -> bool {
    let Some(mac) = record.get("mac").and_then(Value::as_str) else {
        return false;
    };
    if mac.len() != 64 || !mac.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return false;
    }
    let mut body = record.clone();
    body.remove("mac");
    let serialized = match serde_json::to_string(&Value::Object(body)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let expected = hmac_sha256_hex(secret.as_bytes(), serialized.as_bytes());
    constant_time_eq(expected.as_bytes(), mac.as_bytes())
}

/// Reads a bounded regular file while refusing symlinks (`O_NOFOLLOW` on unix)
/// and oversized or empty files.
pub fn read_bounded_regular_file(path: &Path, limit_bytes: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let symlink_meta = std::fs::symlink_metadata(path).ok()?;
    if !symlink_meta.file_type().is_file() {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > (limit_bytes as u64) {
        return None;
    }
    let size = meta.len() as usize;
    let mut buf = Vec::with_capacity(size);
    file.read_to_end(&mut buf).ok()?;
    if buf.len() != size {
        return None;
    }
    Some(buf)
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecoveredExternalMetering {
    pub usage: Option<NormalizedUsage>,
    pub cost_usd: Option<f64>,
    pub admitted_requests: u64,
    pub metering_state: MeteringState,
    pub counts: ProviderMeteringCounts,
    pub artifact: JsonObject,
}

pub fn recover_external_metering_checkpoint(
    trial_path: &Path,
    profile: &str,
    metering_secret: &str,
) -> Option<RecoveredExternalMetering> {
    let rel_path = format!("agent/{profile}.provider-usage.json");
    let full_path = trial_path.join(&rel_path);
    let bytes = read_bounded_regular_file(&full_path, METERING_CHECKPOINT_LIMIT_BYTES)?;
    let parsed: Value = serde_json::from_slice(&bytes).ok()?;
    let checkpoint = exact_object(
        &parsed,
        "external metering checkpoint",
        &[
            "schemaVersion",
            "profile",
            "usage",
            "settled",
            "requests",
            "inFlightRequests",
            "admittedRequests",
            "usageRequests",
            "models",
            "toolNames",
            "mac",
        ],
        &[],
    )
    .ok()?;
    if checkpoint.get("schemaVersion").and_then(Value::as_str)
        != Some("maka.external_provider_usage.v2")
        || checkpoint.get("profile").and_then(Value::as_str) != Some(profile)
        || !metering_checkpoint_mac_matches(checkpoint, metering_secret)
    {
        return None;
    }
    let usage = match checkpoint.get("usage")? {
        Value::Null => None,
        u => Some(NormalizedUsage::decode(u, "external usage").ok()?),
    };
    let settled = checkpoint.get("settled")?.as_bool()?;
    let requests = nonnegative_u64(checkpoint.get("requests")?, "requests").ok()?;
    let in_flight_requests =
        nonnegative_u64(checkpoint.get("inFlightRequests")?, "inFlightRequests").ok()?;
    let admitted_requests =
        nonnegative_u64(checkpoint.get("admittedRequests")?, "admittedRequests").ok()?;
    let usage_requests = nonnegative_u64(checkpoint.get("usageRequests")?, "usageRequests").ok()?;
    let models = checkpoint
        .get("models")?
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect::<Option<Vec<String>>>()?;
    let tool_names = checkpoint
        .get("toolNames")?
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect::<Option<Vec<String>>>()?;

    let counts = ProviderMeteringCounts {
        usage: usage.clone(),
        settled,
        requests,
        in_flight_requests,
        admitted_requests,
        usage_requests,
        models: models.clone(),
        tool_names: tool_names.clone(),
    };
    if !counts.validate() {
        return None;
    }
    let derived = derive_metering(&counts);
    let mut artifact = Map::new();
    artifact.insert(
        "kind".into(),
        Value::String("provider-metering-recovery".into()),
    );
    artifact.insert("profile".into(), Value::String(profile.into()));
    artifact.insert("path".into(), Value::String(rel_path));
    artifact.insert("bytes".into(), Value::from(bytes.len() as u64));
    artifact.insert("sha256".into(), Value::String(sha256_hex(&bytes)));
    artifact.insert("requests".into(), Value::from(counts.requests));
    artifact.insert(
        "settledRequests".into(),
        Value::from(derived.settled_requests),
    );
    artifact.insert(
        "inFlightRequests".into(),
        Value::from(counts.in_flight_requests),
    );
    artifact.insert(
        "admittedRequests".into(),
        Value::from(counts.admitted_requests),
    );
    artifact.insert("usageRequests".into(), Value::from(counts.usage_requests));
    artifact.insert(
        "missingUsageRequests".into(),
        Value::from(derived.missing_usage_requests),
    );
    artifact.insert("usageComplete".into(), Value::Bool(derived.usage_complete));
    artifact.insert(
        "tokenBasis".into(),
        serde_json::to_value(derived.token_basis).ok()?,
    );
    artifact.insert(
        "models".into(),
        Value::Array(models.into_iter().map(Value::String).collect()),
    );
    artifact.insert(
        "toolNames".into(),
        Value::Array(tool_names.into_iter().map(Value::String).collect()),
    );

    Some(RecoveredExternalMetering {
        usage,
        cost_usd: derived.cost_usd,
        admitted_requests: counts.admitted_requests,
        metering_state: derived.metering_state,
        counts,
        artifact,
    })
}
