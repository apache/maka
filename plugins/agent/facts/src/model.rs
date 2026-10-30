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
pub mod assembly;
pub mod body;
pub mod budget;
pub mod error;
pub mod prompt;
pub mod prompt_source;
pub mod recorded;
pub mod request;
pub mod retry_transport;
mod tool_input;
use serde_json::Value;
pub use tool_input::ToolInput;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaintextResponses {
    pub reasoning_replay: PlaintextReasoningReplay,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility: Option<OpenResponsesCompatibility>,
}

impl PlaintextResponses {
    pub fn profile(self) -> &'static str {
        match (self.reasoning_replay, self.compatibility) {
            (PlaintextReasoningReplay::PlaintextContent, None) => "plaintext-content:standard",
            (PlaintextReasoningReplay::PlaintextSummary, None) => "plaintext-summary:standard",
            (
                PlaintextReasoningReplay::PlaintextContent,
                Some(OpenResponsesCompatibility::AlibabaTokenPlan),
            ) => "plaintext-content:alibaba-token-plan",
            (
                PlaintextReasoningReplay::PlaintextSummary,
                Some(OpenResponsesCompatibility::AlibabaTokenPlan),
            ) => "plaintext-summary:alibaba-token-plan",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaintextReasoningReplay {
    PlaintextContent,
    PlaintextSummary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenResponsesCompatibility {
    AlibabaTokenPlan,
}

/// Provider metadata is an open adapter-owned object, merged without losing
/// nested reasoning/signature evidence as subsequent observations arrive.
pub fn merge_provider_options(target: &mut Option<Value>, next: Option<Value>) {
    fn overlay(target: &mut Value, next: Value) {
        if let (Some(a), Some(b)) = (target.as_object_mut(), next.as_object()) {
            for (key, value) in b {
                overlay(a.entry(key.clone()).or_insert(Value::Null), value.clone());
            }
        } else {
            *target = next;
        }
    }
    if let Some(next) = next {
        overlay(target.get_or_insert(Value::Null), next);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ModelUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

/// Auxiliary Host generation, not an assistant step in the parent conversation.
/// Usage is provider-reported; absent counters are unknown, not zero.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelGeneration {
    pub text: String,
    pub model_id: String,
    pub finish_reason: ModelFinishReason,
    pub usage: ModelUsage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelFinishReason {
    Stop,
    ToolCalls,
    Length,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextKind {
    Text,
    Thinking,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelToolCall {
    pub id: String,
    pub name: String,
    pub input: ToolInput,
    pub provider_options: Option<Value>,
    pub provider_executed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelPart {
    Source {
        source: ModelSource,
    },
    Text {
        text_kind: TextKind,
        text: body::TextBody,
        provider_options: Option<std::sync::Arc<Value>>,
    },
    ToolCall {
        call: ModelToolCall,
    },
    ToolResult {
        id: String,
        name: String,
        output: Value,
        is_error: bool,
        provider_options: Option<Value>,
    },
}

/// Runtime-owned stream vocabulary; provider chunk names never enter storage.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ModelEvent {
    Source(ModelSource),
    PartStarted {
        id: String,
        text_kind: TextKind,
        provider_options: Option<Value>,
    },
    PartDelta {
        id: String,
        text: String,
        provider_options: Option<Value>,
    },
    PartFinished {
        id: String,
        provider_options: Option<Value>,
    },
    /// Display-only source observations. Only the complete ToolCall below can
    /// accept a model item or authorize execution.
    ToolInputStarted {
        id: String,
        name: String,
        provider_executed: bool,
    },
    ToolInputDelta {
        id: String,
        text: String,
    },
    ToolInputFinished {
        id: String,
    },
    ToolCall(ModelToolCall),
    ProviderToolResult {
        id: String,
        name: String,
        output: Value,
        is_error: bool,
        provider_options: Option<Value>,
    },
    ResponseMetadata {
        id: Option<String>,
        model: Option<String>,
        timestamp: Option<String>,
    },
    Finished {
        reason: ModelFinishReason,
        usage: ModelUsage,
        provider_options: Option<Value>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelStep {
    pub parts: Vec<ModelPart>,
    pub finish_reason: ModelFinishReason,
    pub usage: ModelUsage,
    pub provider_options: Option<Value>,
    pub response_id: Option<String>,
    pub model: Option<String>,
    pub timestamp: Option<String>,
}

/// Citation evidence, distinct from model prose and replayable tool results.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelSource {
    Url {
        id: String,
        url: String,
        title: Option<String>,
        provider_options: Option<Value>,
    },
    Document {
        id: String,
        media_type: String,
        title: String,
        filename: Option<String>,
        provider_options: Option<Value>,
    },
}

impl ModelStep {
    pub fn tool_calls(&self) -> impl Iterator<Item = &ModelToolCall> {
        self.parts.iter().filter_map(|part| match part {
            ModelPart::ToolCall { call } => Some(call),
            _ => None,
        })
    }
}
