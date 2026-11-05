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

use crate::input::InvocationInput;
use crate::model::{ModelFinishReason, ModelPart, TextKind};
use serde::{Deserialize, Serialize};

mod breakdown;
pub mod measure;
pub use breakdown::{ContextBucket, ContextCounts, PreparedContextBreakdown};
mod checkpoint_mode;
mod summary;
pub use checkpoint_mode::CheckpointMode;
pub use summary::{default_compaction_prompt, summary_format_template};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelPurpose {
    Main,
    Summary,
}

pub fn effective_input_limit(context_window: Option<u64>, input_limit: Option<u64>) -> Option<u64> {
    match (context_window, input_limit) {
        (Some(context), Some(input)) => Some(context.min(input)),
        (context, input) => context.or(input),
    }
}

pub fn default_compaction_threshold(
    context_window: Option<u64>,
    input_limit: Option<u64>,
) -> Option<u64> {
    effective_input_limit(context_window, input_limit)
        .map(|limit| ((u128::from(limit) * 85 / 100) as u64).max(1))
}

pub fn effective_output_limit(configured: Option<u64>) -> u64 {
    configured.unwrap_or(8000)
}

/// Frozen facts about this request's selected model, not prompt contents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRequestContext {
    #[serde(default, skip_serializing_if = "ModelOperation::is_inference")]
    pub operation: ModelOperation,
    pub provider_id: String,
    /// Captured at request preparation; never reconstructed from a later catalog.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex: Option<CodexRequestProvenance>,
    /// Effective input ceiling: the smaller known contextWindow/inputLimit value.
    /// Unlike ModelInfo::context_window, this may be input-only. No output budget
    /// is subtracted here; this value is not the proactive compaction threshold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Full selected-model capacity, independent of the input-only ceiling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_context_window: Option<u64>,
    /// Resolved proactive threshold: explicit compactionThreshold, otherwise 85% of
    /// the smaller of total capacity and any independent input ceiling.
    /// None means no usable threshold; overflow recovery remains available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_window: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelOperation {
    #[default]
    Inference,
    CodexCompaction,
}

impl ModelOperation {
    pub fn is_inference(&self) -> bool {
        *self == Self::Inference
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointContent {
    Text(String),
    CodexNative {
        item_digest: String,
        estimated_tokens: u64,
    },
}
impl CheckpointContent {
    pub fn text_value(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }
    pub fn text(summary: TextSummary) -> Self {
        Self::Text(summary.text)
    }
    pub fn native(item: &crate::model::NativeCompaction, estimated_tokens: u64) -> Self {
        Self::CodexNative {
            item_digest: item.digest(),
            estimated_tokens,
        }
    }
}

/// ChatGPT subscription facts. Account/connection identify provenance, not replay permission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexRequestProvenance {
    pub connection_id: String,
    pub account_id: Option<String>,
    pub compatibility: Option<CodexCompatibility>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexCompatibility {
    pub comp_hash: String,
    /// Unix seconds, matching the canonical account inventory timestamp.
    pub fetched_at: u64,
}

impl ModelRequestContext {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.operation == ModelOperation::CodexCompaction && self.codex.is_none() {
            return Err("native compaction requires ChatGPT provenance");
        }
        if let Some(codex) = &self.codex {
            if codex.connection_id.is_empty()
                || codex
                    .account_id
                    .as_ref()
                    .is_some_and(|id| id.is_empty() || id.chars().any(char::is_control))
            {
                return Err("invalid Codex request provenance");
            }
            if let Some(proof) = &codex.compatibility
                && (proof.comp_hash.is_empty()
                    || proof.comp_hash.trim() != proof.comp_hash
                    || proof.comp_hash.chars().any(char::is_control)
                    || proof.fetched_at > 9_007_199_254_740_991)
            {
                return Err("invalid Codex compatibility observation");
            }
        }
        if self.provider_id.is_empty() || self.provider_id.encode_utf16().count() > 512 {
            return Err("invalid model request provider identity");
        }
        if [
            self.context_window,
            self.model_context_window,
            self.declared_window,
        ]
        .into_iter()
        .flatten()
        .any(|value| value == 0 || value > 9_007_199_254_740_991)
        {
            return Err("invalid model request context window");
        }
        Ok(())
    }
}

/// The caller must first associate the request with its canonical opening.
/// The explicit purpose must agree with the opening's execution kind.
pub fn resolve_model_purpose(
    opening: &crate::input::InvocationInput,
    purpose: ModelPurpose,
) -> Result<ModelPurpose, &'static str> {
    match (opening, purpose) {
        (
            InvocationInput::Message { .. }
            | InvocationInput::Continuation { .. }
            | InvocationInput::Handoff { .. },
            purpose,
        ) => Ok(purpose),
        (InvocationInput::ContextCompact { .. }, ModelPurpose::Summary) => {
            Ok(ModelPurpose::Summary)
        }
        (InvocationInput::ContextCompact { .. }, ModelPurpose::Main) => {
            Err("model purpose contradicts compact opening")
        }
        (InvocationInput::Code { .. }, _) => {
            Err("model request has no supported canonical opening")
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CompactOutcome {
    Compacted { checkpoint_id: String },
    Unchanged { reason: String },
    Failed { reason: String },
}

/// Identity and Session belong to the containing checkpoint event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextCheckpoint {
    pub mode: CheckpointMode,
    pub covered_through: u64,
    pub source_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_checkpoint_id: Option<String>,
    pub summary: CheckpointContent,
    pub summary_step_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextSummary {
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SummaryDefect {
    #[error("summary_contains_tool_content")]
    ToolContent,
    #[error("summary_has_invalid_finish_reason")]
    InvalidFinish,
}

impl TextSummary {
    /// Ordinary text parts concatenate in original order; thinking is not a
    /// portable summary. The prompt controls the summary's content and format.
    pub fn from_parts<'a>(
        finish_reason: ModelFinishReason,
        parts: impl IntoIterator<Item = &'a ModelPart>,
    ) -> Result<Self, SummaryDefect> {
        let mut text = String::new();
        for part in parts {
            match part {
                ModelPart::Text {
                    text_kind: TextKind::Text,
                    text: part,
                    ..
                } => {
                    for chunk in part.chunks() {
                        text.push_str(chunk);
                    }
                }
                ModelPart::Text {
                    text_kind: TextKind::Thinking,
                    ..
                } => {}
                ModelPart::ToolCall { .. }
                | ModelPart::ToolResult { .. }
                | ModelPart::Source { .. } => {
                    return Err(SummaryDefect::ToolContent);
                }
            }
        }
        if finish_reason != ModelFinishReason::Stop {
            return Err(SummaryDefect::InvalidFinish);
        }
        Ok(Self { text })
    }
}

impl ContextCheckpoint {
    /// Storage additionally verifies same-Session coverage, predecessor and the
    /// exact completed summary attempt; these are not inferred from the shape.
    pub fn validate(&self) -> Result<(), &'static str> {
        if let CheckpointContent::CodexNative {
            item_digest,
            estimated_tokens,
            ..
        } = &self.summary
            && (item_digest.len() != 71
                || !item_digest.starts_with("sha256:")
                || !item_digest.as_bytes()[7..]
                    .iter()
                    .all(u8::is_ascii_hexdigit)
                || *estimated_tokens > 9_007_199_254_740_991)
        {
            return Err("invalid native Codex checkpoint");
        }
        if let CheckpointMode::MidTurn { anchor_event_id } = &self.mode {
            crate::interaction::entity_id(anchor_event_id)?;
        }
        if self.covered_through == 0
            || self.source_digest.len() != 71
            || !self.source_digest.starts_with("sha256:")
            || !self.source_digest[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid checkpoint coverage");
        }
        crate::interaction::entity_id(&self.summary_step_id)?;
        if let Some(id) = &self.previous_checkpoint_id {
            crate::interaction::entity_id(id)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_context_keeps_unknown_windows_and_checks_utf16_and_safe_integers() {
        let mut context = ModelRequestContext {
            operation: ModelOperation::Inference,
            codex: None,
            provider_id: "😀".repeat(256),
            context_window: None,
            model_context_window: None,
            declared_window: None,
        };
        assert!(context.validate().is_ok());
        assert!(
            serde_json::to_value(&context)
                .unwrap()
                .get("context_window")
                .is_none()
        );
        context.provider_id.push('x');
        assert!(context.validate().is_err());
        context.provider_id.clear();
        assert!(context.validate().is_err());
        context.provider_id = "openai".into();
        context.context_window = Some(1);
        context.declared_window = Some(9_007_199_254_740_991);
        assert!(context.validate().is_ok());
        for invalid in [0, 9_007_199_254_740_992] {
            context.declared_window = Some(invalid);
            assert!(context.validate().is_err());
        }
        context.declared_window = None;
        context.model_context_window = Some(0);
        assert!(context.validate().is_err());
        context.model_context_window = Some(128000);
        assert!(context.validate().is_ok());
        let encoded = serde_json::to_value(&context).unwrap();
        assert_eq!(
            serde_json::from_value::<ModelRequestContext>(encoded).unwrap(),
            context
        );
    }

    #[test]
    fn ordinary_context_and_text_checkpoint_keep_their_canonical_wire_shapes() {
        let original = serde_json::json!({"provider_id":"chatgpt","codex":{"connection_id":"connection","account_id":null,"compatibility":null}});
        let context: ModelRequestContext = serde_json::from_value(original.clone()).unwrap();
        assert_eq!(context.operation, ModelOperation::Inference);
        assert_eq!(serde_json::to_value(context).unwrap(), original);
        let text = serde_json::json!({"text":"checkpoint"});
        let summary: CheckpointContent = serde_json::from_value(text.clone()).unwrap();
        assert_eq!(serde_json::to_value(summary).unwrap(), text);
    }

    #[test]
    fn checkpoint_mode_is_explicit_and_rejects_contradictory_fields() {
        let value = serde_json::json!({"mode":{"kind":"standalone"},"covered_through":1,"source_digest":"digest","summary_step_id":"step",
            "summary":{"text":"summary"}});
        let mut checkpoint: ContextCheckpoint = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(checkpoint.mode, CheckpointMode::Standalone);
        assert_eq!(serde_json::to_value(&checkpoint).unwrap(), value);
        checkpoint.mode = CheckpointMode::MidTurn {
            anchor_event_id: "anchor".into(),
        };
        assert_eq!(
            serde_json::to_value(&checkpoint).unwrap()["mode"],
            serde_json::json!({"kind":"mid_turn","anchor_event_id":"anchor"})
        );
        assert!(
            serde_json::from_value::<CheckpointMode>(
                serde_json::json!({"kind":"pre_turn","anchor_event_id":"forbidden"})
            )
            .is_err()
        );
    }
}
