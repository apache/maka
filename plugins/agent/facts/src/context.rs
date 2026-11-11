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

use crate::input::RunInput;
use crate::model::{ModelFinishReason, ModelPart, TextKind};
use serde::{Deserialize, Serialize};

mod breakdown;
mod closure;
pub use closure::{
    ModelClosureProtocol, ModelFailureProtocol, RequestContextEvidence, SummaryResult,
};
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

/// Call only with ChatGPT provenance on both sides. Recorded observations do not
/// expire with the catalog; a later catalog cannot certify a missing old hash.
/// Native re-compaction may ask the producing model to convert its own old state.
pub fn codex_replay_allowed(
    same_model: bool,
    hashes_match: Option<bool>,
    operation: ModelOperation,
) -> bool {
    (same_model && operation == ModelOperation::CodexCompaction)
        || hashes_match.unwrap_or(same_model)
}

impl ModelRequestContext {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.operation == ModelOperation::CodexCompaction && self.codex.is_none() {
            return Err("native compaction requires ChatGPT provenance");
        }
        if let Some(codex) = &self.codex {
            codex.validate()?;
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
    opening: &crate::input::RunInput,
    purpose: ModelPurpose,
) -> Result<ModelPurpose, &'static str> {
    match (opening, purpose) {
        (RunInput::Message { .. } | RunInput::Continuation { .. }, purpose) => Ok(purpose),
        (RunInput::ContextCompact { .. }, ModelPurpose::Summary) => Ok(ModelPurpose::Summary),
        (RunInput::ContextCompact { .. }, ModelPurpose::Main) => {
            Err("model purpose contradicts compact opening")
        }
        (RunInput::Code { .. } | RunInput::HistorySource { .. }, _) => {
            Err("model request has no supported canonical opening")
        }
    }
}

/// Semantic compaction budget; a new physical driver never resets it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionBudget {
    Available,
    Reshaped,
    Failed,
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
    pub summary_step_id: crate::durable::StepId,
}

/// Complete semantic compaction material. The capture reference addresses the
/// original immutable source descriptor, not today's mutable history projection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompactedContext {
    pub source_capture: crate::durable::ContentRef,
    pub checkpoint: ContextCheckpoint,
    pub native: Option<NativeCheckpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_origin: Option<SummaryOrigin>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SummaryOrigin {
    pub run: crate::durable::RunId,
    pub attempt: crate::durable::ModelAttemptId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCheckpoint {
    pub item: crate::model::NativeCompaction,
    pub producer: CodexRequestProvenance,
}
impl CompactedContext {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.source_capture.validate()?;
        self.checkpoint.validate()?;
        match (&self.checkpoint.summary, &self.native) {
            (CheckpointContent::Text(_), None) => Ok(()),
            (CheckpointContent::CodexNative { item_digest, .. }, Some(native)) => {
                native.producer.validate()?;
                if native.item.digest() != *item_digest {
                    return Err("native checkpoint item differs from its original digest");
                }
                Ok(())
            }
            _ => Err("checkpoint content does not match its complete native material"),
        }
    }
}
impl CodexRequestProvenance {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.connection_id.is_empty()
            || self
                .account_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.chars().any(char::is_control))
        {
            return Err("invalid Codex request provenance");
        }
        if let Some(proof) = &self.compatibility
            && (proof.comp_hash.is_empty()
                || proof.comp_hash.trim() != proof.comp_hash
                || proof.comp_hash.chars().any(char::is_control)
                || proof.fetched_at > 9_007_199_254_740_991)
        {
            return Err("invalid Codex compatibility observation");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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
        if let Some(id) = &self.previous_checkpoint_id {
            crate::interaction::entity_id(id)?;
        }
        Ok(())
    }
}
