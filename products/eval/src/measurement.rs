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

//! Exact 6-counter token usage preservation and standardized model pricing.

use crate::contract::{ContractError, exact_object, nonnegative_u64};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub const COST_USD_TOLERANCE: f64 = 1e-9;

/// Exact 6-counter normalized token usage.
///
/// Each counter is preserved as reported by the provider or receipt; `total_tokens`
/// is never synthesized or overwritten by summing the other five counters.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
}

impl<'de> Deserialize<'de> for NormalizedUsage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        decode_usage(&value, "usage").map_err(serde::de::Error::custom)
    }
}

pub(crate) fn decode_usage(
    value: &Value,
    where_label: &str,
) -> Result<NormalizedUsage, ContractError> {
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
    Ok(NormalizedUsage {
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

impl NormalizedUsage {
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PricingRates {
    pub input_per_million: f64,
    pub output_per_million: f64,
    pub cache_read_per_million: f64,
    pub cache_write_per_million: f64,
}

impl PricingRates {
    pub fn cost_usd(&self, usage: &NormalizedUsage) -> f64 {
        let cached = usage
            .cache_read_tokens
            .saturating_add(usage.cache_write_tokens);
        let uncached = usage.input_tokens.saturating_sub(cached);
        ((uncached as f64) * self.input_per_million
            + (usage.cache_read_tokens as f64) * self.cache_read_per_million
            + (usage.cache_write_tokens as f64) * self.cache_write_per_million
            + (usage.output_tokens as f64) * self.output_per_million)
            / 1_000_000.0
    }
}

/// Published DeepSeek V4 Flash prices in USD per million tokens (off-peak band).
pub const DEEPSEEK_V4_FLASH_COST: PricingRates = PricingRates {
    input_per_million: 0.22,
    output_per_million: 0.66,
    cache_read_per_million: 0.007,
    cache_write_per_million: 0.22,
};

pub fn costs_match_within_tolerance(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(a), Some(b)) => (a - b).abs() <= COST_USD_TOLERANCE,
        _ => false,
    }
}
