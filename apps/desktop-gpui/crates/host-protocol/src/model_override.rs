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

//! A model's parameters on one connection: the declarations a person makes
//! on the Models page (a display name, whether images are sent, ApplyPatch,
//! the context window and the other limits, thinking levels, the Fast
//! tier), which the catalog carries on each `catalog_entry` item
//! (`modelOverride`) and `connection.catalog.update` writes back as one
//! table (`modelOverrides`).
//!
//! Source: `ModelOverride` in packages/core/src/model-thinking.ts, decoded
//! by `decodeModelOverridesTable` in
//! packages/core/src/runtime-policy/connection-catalog-codec.ts. The rules
//! a settings page shows beside the fields (which models ApplyPatch is on
//! for by default, which custom models take the Fast tier, whether the
//! limits agree) are copied from the same file: they go stale with it and
//! are regenerated whenever [`crate::RUNTIME_HOST_COMPATIBILITY_EPOCH`]
//! changes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{ModelApiProtocol, ThinkingLevel};

/// `ModelOverride`. Every field is optional; an empty one keeps a model a
/// person added by hand. The facts this client does not edit
/// (`knowledgeCutoff`, `capabilities`, `modalities`) ride in
/// [`Self::other`], so a table read and written back keeps them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelOverride {
    /// Custom connections only: the levels the conversation offers, in
    /// [`DECLARABLE_THINKING_LEVELS`] order; never empty on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_levels: Option<Vec<ThinkingLevel>>,
    /// The level a new task on this model starts at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_thinking_level: Option<ThinkingLevel>,
    /// Whether images are sent; absent follows the model's information.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    /// ApplyPatch file editing; absent follows [`apply_patch_by_default`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apply_patch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_threshold: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_limit: Option<u64>,
    /// The output budget of one reply, thinking included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    /// A label for the model; requests keep the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Custom connections: the wire of this model, where it differs from the
    /// connection's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_protocol: Option<ModelApiProtocol>,
    /// Custom connections: `fast`, OpenAI's low-latency tier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    /// The fields this client keeps as the Host sent them.
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

/// `ModelOverrides`: a connection's table, by model id.
pub type ModelOverrides = BTreeMap<String, ModelOverride>;

/// The service tier a Fast declaration names.
pub const FAST_SERVICE_TIER: &str = "fast";

/// `DECLARABLE_RELAY_THINKING_LEVELS`: every level but `off`, which is a
/// disable wire rather than an intensity, in display order.
pub const DECLARABLE_THINKING_LEVELS: [ThinkingLevel; 6] = [
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::Xhigh,
    ThinkingLevel::Max,
];

impl ModelOverride {
    /// The declaration as the Host stores it (`normalizeModelOverride`):
    /// thinking levels declarable, unique, and in order (none when that
    /// leaves none), a blank display name dropped, zero limits dropped.
    pub fn normalized(&self) -> Self {
        let mut normalized = self.clone();
        normalized.thinking_levels = self.thinking_levels.as_ref().and_then(|levels| {
            let kept: Vec<ThinkingLevel> = DECLARABLE_THINKING_LEVELS
                .iter()
                .filter(|level| levels.contains(level))
                .cloned()
                .collect();
            (!kept.is_empty()).then_some(kept)
        });
        if self.display_name.as_deref().is_some_and(|name| name.trim().is_empty()) {
            normalized.display_name = None;
        }
        for limit in [
            &mut normalized.context_window,
            &mut normalized.compaction_threshold,
            &mut normalized.input_limit,
            &mut normalized.max_output_tokens,
        ] {
            if *limit == Some(0) {
                *limit = None;
            }
        }
        if normalized.service_tier.as_deref().is_some_and(|tier| tier != FAST_SERVICE_TIER) {
            normalized.service_tier = None;
        }
        normalized
    }

    /// Whether the input limit exceeds the context window
    /// (`modelLimitsConflict`), given the model's own values for what the
    /// declaration leaves out.
    pub fn limits_conflict(
        &self,
        default_context_window: Option<u64>,
        default_input_limit: Option<u64>,
    ) -> bool {
        match (
            self.context_window.or(default_context_window),
            self.input_limit.or(default_input_limit),
        ) {
            (Some(context), Some(input)) => input > context,
            _ => false,
        }
    }
}

/// The models ApplyPatch is on for when nothing is declared
/// (`APPLY_PATCH_MODELS` in packages/core/src/model-thinking.ts).
const APPLY_PATCH_MODELS: &[&str] = &[
    "gpt-5-codex",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.4-pro",
    "gpt-5.5",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "deepseek-flash",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "deepseek-v4-pro",
];

/// Whether ApplyPatch edits files for `model_id` when nothing is declared
/// (`modelApplyPatchEnabled` without an override): the id, trimmed,
/// lowercased, and without a trailing `-YYYY-MM-DD`, is a known
/// patch-capable model.
pub fn apply_patch_by_default(model_id: &str) -> bool {
    let id = model_id.trim().to_lowercase();
    let id = strip_date_suffix(&id);
    APPLY_PATCH_MODELS.contains(&id)
}

/// `id` without a trailing `-YYYY-MM-DD`.
fn strip_date_suffix(id: &str) -> &str {
    let bytes = id.as_bytes();
    if bytes.len() < 11 {
        return id;
    }
    let tail = &bytes[bytes.len() - 11..];
    let dated = tail[0] == b'-'
        && tail[5] == b'-'
        && tail[8] == b'-'
        && [1, 2, 3, 4, 6, 7, 9, 10].iter().all(|ix| tail[*ix].is_ascii_digit());
    if dated { &id[..id.len() - 11] } else { id }
}

/// Whether a custom model takes the Fast tier (`supportsCustomFastServiceTier`,
/// after `@ai-sdk/openai`'s priority-processing check): the model speaks
/// OpenAI Responses and is a GPT-4 model, a GPT-5 or later model that is
/// not a nano or chat variant, or an o-series model from o3 on.
pub fn supports_fast_service_tier(
    provider_type: &str,
    protocol: Option<&ModelApiProtocol>,
    model_id: &str,
) -> bool {
    if provider_type != crate::CUSTOM_PROVIDER_TYPE
        || protocol != Some(&ModelApiProtocol::OpenaiResponses)
    {
        return false;
    }
    if model_id.starts_with("gpt-4") {
        return true;
    }
    if let Some(rest) = model_id.strip_prefix('o') {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let after = &rest[digits.len()..];
        if !digits.is_empty() && (after.is_empty() || after.starts_with('-')) {
            return digits.parse::<u64>().is_ok_and(|version| version >= 3);
        }
    }
    let Some(rest) = model_id.strip_prefix("gpt-") else {
        return false;
    };
    // `gpt-(\d+)(?:\.(\d+))?(?:-(.+))?`, anchored at both ends.
    let major: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if major.is_empty() {
        return false;
    }
    let mut after = &rest[major.len()..];
    if let Some(minor) = after.strip_prefix('.') {
        let digits: String = minor.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            return false;
        }
        after = &minor[digits.len()..];
    }
    let variant = match after {
        "" => None,
        _ => match after.strip_prefix('-') {
            Some(variant) if !variant.is_empty() => Some(variant),
            _ => return false,
        },
    };
    let nano_or_chat =
        variant.is_some_and(|variant| variant.starts_with("nano") || variant.starts_with("chat"));
    major.parse::<u64>().is_ok_and(|major| major >= 5) && !nano_or_chat
}

/// `parseContextWindowInput`
/// (apps/desktop/src/renderer/features/connection-settings/context-window-input.ts):
/// a positive whole token count, optionally with a decimal and a `K` or `M`
/// suffix (decimal thousands and millions), that comes out whole.
pub fn parse_token_count(input: &str) -> Option<u64> {
    let input = input.trim();
    let (number, places) = match input.chars().last()? {
        'k' | 'K' => (&input[..input.len() - 1], 3),
        'm' | 'M' => (&input[..input.len() - 1], 6),
        _ => (input, 0),
    };
    let (whole, fraction) = number.split_once('.').unwrap_or((number, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || (number.contains('.') && fraction.is_empty())
    {
        return None;
    }
    // Digits past the suffix's places would be a fraction of a token.
    if fraction.len() > places && fraction[places..].bytes().any(|b| b != b'0') {
        return None;
    }
    let mut digits = String::from(whole);
    for ix in 0..places {
        digits.push(fraction.as_bytes().get(ix).map_or('0', |b| *b as char));
    }
    let value: u64 = digits.parse().ok()?;
    (value > 0 && value <= 9_007_199_254_740_991).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_declaration_round_trips_with_the_facts_it_does_not_edit() {
        let wire = json!({"displayName": "Mine", "vision": true, "contextWindow": 128000,
                          "thinkingLevels": ["low", "high"], "apiProtocol": "openai-responses",
                          "serviceTier": "fast", "knowledgeCutoff": "2025-01",
                          "capabilities": {"toolCall": true}});
        let declared: ModelOverride = serde_json::from_value(wire.clone()).expect("decode");
        assert_eq!(declared.display_name.as_deref(), Some("Mine"));
        assert_eq!(declared.thinking_levels, Some(vec![ThinkingLevel::Low, ThinkingLevel::High]));
        assert_eq!(declared.api_protocol, Some(ModelApiProtocol::OpenaiResponses));
        assert_eq!(declared.other.len(), 2, "knowledgeCutoff and capabilities ride along");
        assert_eq!(serde_json::to_value(&declared).expect("encode"), wire);
        assert_eq!(
            serde_json::to_value(ModelOverride::default()).expect("encode"),
            json!({}),
            "an empty declaration keeps a model added by hand"
        );
    }

    #[test]
    fn normalizing_orders_levels_and_drops_empty_fields() {
        let mut declared = ModelOverride {
            thinking_levels: Some(vec![ThinkingLevel::Max, ThinkingLevel::Off, ThinkingLevel::Low]),
            display_name: Some("  ".into()),
            context_window: Some(0),
            ..ModelOverride::default()
        };
        let normalized = declared.normalized();
        assert_eq!(normalized.thinking_levels, Some(vec![ThinkingLevel::Low, ThinkingLevel::Max]));
        assert_eq!((normalized.display_name, normalized.context_window), (None, None));
        declared.thinking_levels = Some(vec![ThinkingLevel::Off]);
        assert_eq!(declared.normalized().thinking_levels, None);
    }

    #[test]
    fn limits_conflict_when_the_input_exceeds_the_window() {
        let mut declared = ModelOverride { input_limit: Some(200_000), ..ModelOverride::default() };
        assert!(declared.limits_conflict(Some(128_000), None));
        assert!(!declared.limits_conflict(None, None));
        declared.context_window = Some(400_000);
        assert!(!declared.limits_conflict(Some(128_000), None));
    }

    #[test]
    fn apply_patch_defaults_follow_the_known_models() {
        assert!(apply_patch_by_default("gpt-5.5"));
        assert!(apply_patch_by_default(" GPT-5.4-2026-03-05 "));
        assert!(apply_patch_by_default("deepseek-v4-pro"));
        assert!(!apply_patch_by_default("qwen2.5:7b"));
        assert!(!apply_patch_by_default("gpt-5.4-2026-03"));
    }

    #[test]
    fn the_fast_tier_is_offered_where_the_openai_sdk_sends_it() {
        let responses = Some(&ModelApiProtocol::OpenaiResponses);
        for model in ["gpt-4o", "gpt-5", "gpt-5.1-codex", "o3", "o4-mini"] {
            assert!(supports_fast_service_tier("custom", responses, model), "{model}");
        }
        for model in ["gpt-5-nano", "gpt-5.1-chat-latest", "o1", "claude", "gpt-", "gpt-5."] {
            assert!(!supports_fast_service_tier("custom", responses, model), "{model}");
        }
        assert!(!supports_fast_service_tier("openai", responses, "gpt-5"));
        let chat = Some(&ModelApiProtocol::OpenaiChat);
        assert!(!supports_fast_service_tier("custom", chat, "gpt-5"));
    }

    #[test]
    fn token_counts_take_k_and_m_and_stay_whole() {
        for (input, value) in [
            ("128000", 128_000),
            ("128K", 128_000),
            ("1.5M", 1_500_000),
            (" 32k ", 32_000),
            ("1.001k", 1001),
            ("2.50k", 2500),
        ] {
            assert_eq!(parse_token_count(input), Some(value), "{input}");
        }
        for input in ["", "0", "1.5", "1.0001k", "k", "-5", "1e6", "1.k", "12 000"] {
            assert_eq!(parse_token_count(input), None, "{input}");
        }
    }
}
