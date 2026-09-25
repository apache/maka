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

use crate::model::{ModelFinishReason, ModelPart, ModelStep, TextKind};
use serde::{Deserialize, Serialize};

mod checkpoint_mode;
mod summary;
pub use checkpoint_mode::CheckpointMode;
pub use summary::{SUMMARY_FORMAT_TEMPLATE, validate_summary};
pub const MAX_SUMMARY_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelPurpose {
    Main,
    Summary,
}

/// Complete bounded material read by an ordinary model or summary step.
pub const MAX_HISTORY_EVENTS: usize = 10_000;
pub const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;

/// Frozen facts about this request's selected model, not prompt contents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRequestContext {
    pub provider_id: String,
    /// Effective input ceiling: the smaller known contextWindow/inputLimit value.
    /// Unlike ModelInfo::context_window, this may be input-only. No output budget
    /// is subtracted here; this value is not the proactive compaction threshold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Full selected-model capacity. Unknown legacy values must not be inferred
    /// from context_window, which may be an independent input-only limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_context_window: Option<u64>,
    /// Resolved proactive threshold: explicit compactionThreshold, otherwise 85% of
    /// the smaller of total capacity and any independent input ceiling.
    /// None means no usable threshold; overflow recovery remains available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_window: Option<u64>,
}

impl ModelRequestContext {
    pub fn validate(&self) -> Result<(), &'static str> {
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
    use crate::input::InvocationInput;
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
    pub summary: TextSummary,
    pub summary_step_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SummaryFormat {
    SectionsV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextSummary {
    pub format: SummaryFormat,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SummaryDefect {
    #[error("empty_summary")]
    Empty,
    #[error("summary_too_large")]
    TooLarge,
    #[error("malformed_summary_missing_section")]
    MissingSection,
    #[error("malformed_summary_truncated")]
    Truncated,
    #[error("malformed_summary_too_small_for_fold")]
    TooSmallForFold,
    #[error("summary_contains_tool_content")]
    ToolContent,
    #[error("summary_has_invalid_finish_reason")]
    InvalidFinish,
}

impl TextSummary {
    pub fn validate(&self) -> Result<(), SummaryDefect> {
        match self.format {
            SummaryFormat::SectionsV1 => validate_summary(&self.text, None),
        }
    }

    /// Ordinary text parts concatenate in original order; thinking is not a
    /// portable summary. Missing usage stays unknown; roll-forward inputs do
    /// not measure the entire folded span and therefore never receive its floor.
    pub fn from_model_step(step: &ModelStep, initial_fold: bool) -> Result<Self, SummaryDefect> {
        if step.finish_reason != ModelFinishReason::Stop {
            return Err(SummaryDefect::InvalidFinish);
        }
        let mut text = String::new();
        for part in &step.parts {
            match part {
                ModelPart::Text {
                    text_kind: TextKind::Text,
                    text: part,
                    ..
                } => {
                    if part.len() > MAX_SUMMARY_BYTES.saturating_sub(text.len()) {
                        return Err(SummaryDefect::TooLarge);
                    }
                    text.push_str(part);
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
        let text = text.trim_matches(summary::js_space);
        validate_summary(text, initial_fold.then_some(&step.usage))?;
        Ok(Self {
            format: SummaryFormat::SectionsV1,
            text: text.into(),
        })
    }
}

impl ContextCheckpoint {
    /// Storage additionally verifies same-Session coverage, predecessor and the
    /// exact completed summary attempt; these are not inferred from the shape.
    pub fn validate(&self) -> Result<(), &'static str> {
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
        self.summary
            .validate()
            .map_err(|_| "invalid checkpoint summary")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::InvocationInput;

    #[test]
    fn model_purpose_must_match_the_canonical_opening() {
        let message = InvocationInput::Message {
            source_messages: Vec::new(),
            content: "task".into(),
            request_fingerprint: None,
        };
        let compact = InvocationInput::ContextCompact {
            request_fingerprint: "request".into(),
        };
        let code = InvocationInput::Code { source: "1".into() };
        for purpose in [ModelPurpose::Main, ModelPurpose::Summary] {
            assert_eq!(resolve_model_purpose(&message, purpose), Ok(purpose));
            assert!(resolve_model_purpose(&code, purpose).is_err());
        }
        assert!(resolve_model_purpose(&compact, ModelPurpose::Main).is_err());
        assert_eq!(
            resolve_model_purpose(&compact, ModelPurpose::Summary),
            Ok(ModelPurpose::Summary)
        );
    }

    #[test]
    fn request_context_keeps_unknown_windows_and_checks_utf16_and_safe_integers() {
        let legacy: ModelRequestContext = serde_json::from_value(serde_json::json!({
            "provider_id":"openai", "context_window":4000
        }))
        .unwrap();
        assert_eq!(
            legacy.model_context_window, None,
            "an old input budget is not a model window"
        );
        let mut context = ModelRequestContext {
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
    fn checkpoint_mode_is_explicit_and_rejects_contradictory_fields() {
        let value = serde_json::json!({"mode":{"kind":"standalone"},"covered_through":1,"source_digest":"digest","summary_step_id":"step",
            "summary":{"format":"sections_v1","text":"summary"}});
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
