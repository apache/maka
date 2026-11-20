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

use super::{ModelRequestContext, PreparedContextBreakdown, SummaryDefect, TextSummary};
use crate::model::{ModelFinishReason, ModelPart, NativeCompaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelFailureProtocol {
    pub failure: crate::model::error::ModelError,
    pub transport: Option<crate::model::retry_transport::ModelTransportEvidence>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelClosureProtocol {
    pub finish_reason: ModelFinishReason,
    pub provider_options: Option<Value>,
    /// Older adapters sometimes filled a missing cache counter with zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_reported: Option<bool>,
    pub response_id: Option<String>,
    pub model: Option<String>,
    pub timestamp: Option<String>,
    pub compaction: Option<NativeCompaction>,
    pub summary: Option<SummaryResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SummaryResult {
    Text { summary: TextSummary },
    RejectedToolContent,
    Incomplete,
    ProviderEffectsUnknown { calls: BTreeSet<String> },
}

impl SummaryResult {
    pub fn from_parts<'a>(
        finish_reason: ModelFinishReason,
        parts: impl IntoIterator<Item = &'a ModelPart>,
    ) -> Self {
        let parts: Vec<&ModelPart> = parts.into_iter().collect();
        let results: BTreeSet<&str> = parts
            .iter()
            .copied()
            .filter_map(|part| match part {
                ModelPart::ToolResult { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        let calls: BTreeSet<String> = parts
            .iter()
            .copied()
            .filter_map(|part| match part {
                ModelPart::ToolCall { call }
                    if call.provider_executed && !results.contains(call.id.as_str()) =>
                {
                    Some(call.id.clone())
                }
                _ => None,
            })
            .collect();
        if !calls.is_empty() {
            return Self::ProviderEffectsUnknown { calls };
        }
        match TextSummary::from_parts(finish_reason, parts) {
            Ok(summary) => Self::Text { summary },
            Err(SummaryDefect::ToolContent) => Self::RejectedToolContent,
            Err(SummaryDefect::InvalidFinish) => Self::Incomplete,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionOptions {
    pub prompt: Option<String>,
    pub resume_model: Option<crate::configuration::ModelSelection>,
}

impl CompactionOptions {
    pub fn from_input(input: &crate::model::ToolInput) -> Result<Self, serde_json::Error> {
        let value = input
            .as_json()
            .ok_or_else(|| serde::de::Error::custom("invalid CompactContext arguments"))?;
        Self::deserialize(value)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestContextEvidence {
    pub resume_model: Option<crate::configuration::ModelSelection>,
    pub compaction_request: Option<crate::durable::ToolKey>,
    pub codex_preflight: Option<super::CodexPreflight>,
    pub estimated_input_tokens: u64,
    pub breakdown: PreparedContextBreakdown,
    pub model_context: Option<ModelRequestContext>,
    pub previous_checkpoint_id: Option<String>,
}

impl RequestContextEvidence {
    pub fn same_compaction_input(&self, other: &Self) -> bool {
        self.previous_checkpoint_id == other.previous_checkpoint_id
            && self.compaction_request == other.compaction_request
    }

    pub fn accepts_background_summary(&self, summary: &Self, options: &CompactionOptions) -> bool {
        if self.same_compaction_input(summary) {
            return true;
        }
        let native = summary
            .model_context
            .as_ref()
            .is_some_and(|context| context.operation == super::ModelOperation::CodexCompaction);
        self.previous_checkpoint_id == summary.previous_checkpoint_id
            && summary.compaction_request.is_none()
            && options.prompt.is_none()
            && (options.resume_model.is_none() || !native)
    }

    pub fn needs_compaction(&self) -> bool {
        self.compaction_request.is_some()
            || self
                .model_context
                .as_ref()
                .and_then(|context| context.declared_window)
                .is_some_and(|limit| self.estimated_input_tokens >= limit)
    }
}
