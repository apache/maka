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

//! Non-secret model rates and auditable estimates. This is not a billing ledger.

use crate::model::ModelUsage;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

mod quote;
pub use quote::Quote;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "PricingQuery")]
pub enum Query {
    Start,
    Continue { revision: u64, offset: u64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "source",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "PricingEntry")]
pub enum Entry {
    Builtin {
        pricing: Pricing,
    },
    Custom {
        pricing: Pricing,
        reset_effect: ResetEffect,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "PricingResetEffect")]
pub enum ResetEffect {
    RestoreBuiltin,
    BecomeUnpriced,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "PricingPage")]
pub enum Page {
    Page {
        revision: u64,
        offset: u64,
        entries: Vec<Entry>,
        next_offset: Option<u64>,
    },
    RevisionChanged {
        expected_revision: u64,
        actual_revision: u64,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "PricingMutation")]
pub enum Mutation {
    Upsert { pricing: Pricing },
    Delete { model_key: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "PricingUpdate")]
pub struct Update {
    pub expected_revision: u64,
    pub mutation: Mutation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "PricingUpdated")]
pub enum Updated {
    Committed {
        revision: u64,
    },
    Unchanged {
        revision: u64,
    },
    RevisionConflict {
        expected_revision: u64,
        actual_revision: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pricing {
    pub model_key: String,
    #[serde(rename = "inputUsdPer1M", deserialize_with = "rate")]
    pub input_usd_per_million: f64,
    #[serde(rename = "outputUsdPer1M", deserialize_with = "rate")]
    pub output_usd_per_million: f64,
    #[serde(
        rename = "cacheReadUsdPer1M",
        default,
        deserialize_with = "present_rate",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "f64")]
    pub cache_read_usd_per_million: Option<f64>,
    #[serde(
        rename = "cacheWriteUsdPer1M",
        default,
        deserialize_with = "present_rate",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "f64")]
    pub cache_write_usd_per_million: Option<f64>,
}

impl Pricing {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_key(&self.model_key)?;
        for rate in [
            Some(self.input_usd_per_million),
            Some(self.output_usd_per_million),
            self.cache_read_usd_per_million,
            self.cache_write_usd_per_million,
        ]
        .into_iter()
        .flatten()
        {
            if !rate.is_finite() || rate < 0.0 {
                return Err("invalid model price");
            }
        }
        Ok(())
    }

    /// Input and output totals include their cache and reasoning subsets.
    /// Optional cache rates inherit the input rate, never a made-up discount.
    /// Missing total usage or an unrepresentable estimate is not zero cost.
    pub fn estimate(&self, usage: &ModelUsage) -> Result<Option<f64>, &'static str> {
        self.validate()?;
        let (Some(input), Some(output)) = (usage.input_tokens, usage.output_tokens) else {
            return Ok(None);
        };
        if input != 0
            && ((usage.cache_read_tokens.is_none()
                && self
                    .cache_read_usd_per_million
                    .is_some_and(|rate| rate != self.input_usd_per_million))
                || (usage.cache_write_tokens.is_none()
                    && self
                        .cache_write_usd_per_million
                        .is_some_and(|rate| rate != self.input_usd_per_million)))
        {
            return Ok(None);
        }
        let read = usage.cache_read_tokens.unwrap_or(0).min(input);
        let write = usage.cache_write_tokens.unwrap_or(0).min(input - read);
        let uncached = input - read - write;
        // Scale the count before multiplication: a finite rate need not fit when
        // multiplied by a whole token count but may still produce a finite cost.
        let amount = uncached as f64 / 1_000_000.0 * self.input_usd_per_million
            + read as f64 / 1_000_000.0
                * self
                    .cache_read_usd_per_million
                    .unwrap_or(self.input_usd_per_million)
            + write as f64 / 1_000_000.0
                * self
                    .cache_write_usd_per_million
                    .unwrap_or(self.input_usd_per_million)
            + output as f64 / 1_000_000.0 * self.output_usd_per_million;
        Ok(amount.is_finite().then_some(amount))
    }
}

/// Model keys are exact identities, not normalized provider or model names.
pub fn validate_key(key: &str) -> Result<(), &'static str> {
    if key.is_empty() || key.trim() != key || key.chars().any(char::is_control) {
        return Err("invalid pricing model key");
    }
    Ok(())
}

fn present_rate<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<f64>, D::Error> {
    rate(deserializer).map(Some)
}

/// The maka binary enables serde_json's arbitrary_precision. A price buffered
/// inside a tagged enum then arrives as serde_json's number map, not an f64;
/// `Number` accepts both forms.
fn rate<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    serde_json::Number::deserialize(deserializer)?
        .as_f64()
        .ok_or_else(|| serde::de::Error::custom("invalid model price"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_preserves_unknowns_and_does_not_charge_token_subsets_twice() {
        let price = Pricing {
            model_key: "provider:model".into(),
            input_usd_per_million: 10.0,
            output_usd_per_million: 20.0,
            cache_read_usd_per_million: Some(1.0),
            cache_write_usd_per_million: Some(12.0),
        };
        let mut usage = ModelUsage {
            input_tokens: Some(1_000_000),
            output_tokens: Some(1_000_000),
            cache_read_tokens: Some(200_000),
            cache_write_tokens: Some(100_000),
            reasoning_tokens: Some(500_000),
        };
        assert_eq!(price.estimate(&usage).unwrap(), Some(28.4));
        usage.input_tokens = None;
        assert_eq!(price.estimate(&usage).unwrap(), None);
        usage.input_tokens = Some(0);
        usage.output_tokens = Some(0);
        assert_eq!(price.estimate(&usage).unwrap(), Some(0.0));
        // An impossible cache report cannot produce a negative uncached charge.
        usage.input_tokens = Some(100_000);
        assert_eq!(price.estimate(&usage).unwrap(), Some(0.1));
        usage.cache_read_tokens = None;
        assert_eq!(
            price.estimate(&usage).unwrap(),
            None,
            "unknown cache split changes the price"
        );
        let huge = Pricing {
            input_usd_per_million: f64::MAX,
            cache_read_usd_per_million: None,
            cache_write_usd_per_million: None,
            ..price
        };
        usage.cache_read_tokens = None;
        usage.cache_write_tokens = None;
        usage.input_tokens = Some(1);
        assert!(huge.estimate(&usage).unwrap().unwrap().is_finite());
        usage.input_tokens = Some(u64::MAX);
        assert_eq!(huge.estimate(&usage).unwrap(), None);
    }

    #[test]
    fn decimal_prices_survive_tagged_enum_buffering() {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case")]
        enum Tagged {
            Prepared { pricing: Pricing },
        }
        let raw = r#"{"kind":"prepared","pricing":{"modelKey":"deepseek:deepseek-flash","inputUsdPer1M":0.15,"outputUsdPer1M":0.6,"cacheReadUsdPer1M":0.003}}"#;
        let Tagged::Prepared { pricing } = serde_json::from_str(raw).unwrap();
        assert_eq!(pricing.input_usd_per_million, 0.15);
        assert_eq!(pricing.output_usd_per_million, 0.6);
        assert_eq!(pricing.cache_read_usd_per_million, Some(0.003));
        assert_eq!(pricing.cache_write_usd_per_million, None);
    }
}
