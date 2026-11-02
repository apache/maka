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

use super::ModelSelection;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentWorkRead")]
pub struct WorkRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub target: WorkTarget,
    pub cursor: Option<AnswerCursor>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentWorkTarget")]
pub enum WorkTarget {
    Invocation {
        #[schemars(length(min = 1))]
        invocation_id: String,
    },
    Message {
        #[schemars(length(min = 1))]
        message_id: String,
    },
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentAnswerCursor")]
pub struct AnswerCursor {
    #[schemars(length(min = 1))]
    pub invocation_id: String,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub offset: u64,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentAnswerPage")]
pub struct AnswerPage {
    pub text: String,
    pub next: Option<AnswerCursor>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentWork")]
pub enum Work {
    Missing,
    Pending,
    Cancelled,
    Changed,
    Delivered {
        shared: bool,
        execution: Execution,
        answer: Option<AnswerPage>,
        /// Count for this exact Run; original Session interactions retain all authority.
        pending_interactions: u32,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentExecutionRead")]
pub struct ExecutionRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub invocation_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "AgentPatchRead")]
pub struct PatchRead {
    pub execution: ExecutionRead,
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub offset: u64,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentWorkspacePatch")]
pub struct WorkspacePatch {
    pub artifact_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub base_commit: String,
    pub bytes: u64,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentPatchResult")]
pub enum PatchResult {
    Unavailable,
    Busy,
    Changed,
    Ready { patch: WorkspacePatch },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentPatchPage")]
pub enum PatchPage {
    Unavailable,
    Ready {
        patch: WorkspacePatch,
        offset: u64,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
        next: Option<u64>,
        #[schemars(length(max = 8192))]
        text: String,
    },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentExecutionResult")]
pub enum ExecutionResult {
    Missing,
    Found { execution: Execution },
}
/// Canonical physical execution receipt, independent of the current Session tip.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentExecution")]
pub struct Execution {
    pub session_id: String,
    pub turn_id: String,
    pub run_id: String,
    pub invocation_id: String,
    /// Run-local event count, not the root-global transcript cursor.
    pub high_water: u64,
    pub state: ExecutionState,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentExecutionState")]
pub enum ExecutionState {
    Admitted,
    Running,
    Waiting,
    Paused,
    Completed,
    Failed,
    Cancelled,
}
/// Observe the latest run using the model selected for a possible continuation.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentResumableRead")]
pub struct ResumableRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub model: ModelSelection,
    pub thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentResumable")]
pub enum Resumable {
    Ready { source: Execution },
    Unavailable { reason: ResumeParkReason },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentResume")]
pub struct Resume {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub source_invocation_id: String,
    /// Exact Run-local count returned by execution.
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub source_high_water: u64,
    /// Explicit model selection for this new continuation; original input is replayed.
    pub model: ModelSelection,
    pub thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentResumeResult")]
pub enum ResumeResult {
    Started { execution: Execution },
    Parked { reason: ResumeParkReason },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentResumeParkReason")]
pub enum ResumeParkReason {
    Closed,
    Archived,
    Busy,
    SourceMissing,
    SourceChanged,
    SourceNotResumable,
    AlreadyContinued,
    WorkspaceChanged,
    SafetyCheckFailed,
}
