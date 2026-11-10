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
use maka_agent_facts::durable::{BlockerId, BlockerKind, RunId, WaitReason};
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
    Run {
        run_id: RunId,
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
    pub run_id: RunId,
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
    pub run_id: RunId,
}
/// Metadata readiness only. Retirement also requires the actual Root work fence
/// held continuously through the caller's original pending-retirement commit.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentWorkReadiness")]
pub enum WorkReadiness {
    Ready,
    Pending,
    Unavailable,
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
/// Stable logical Run receipt, independent of activations and the current Session tip.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentExecution")]
pub struct Execution {
    pub session_id: String,
    pub turn_id: String,
    pub run_id: RunId,
    /// Run-local event count, not the root-global transcript cursor.
    pub high_water: u64,
    pub state: ExecutionState,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentExecutionState")]
pub enum ExecutionState {
    Admitted,
    Running,
    Waiting { waits: Vec<WaitReason> },
    Blocked { blockers: Vec<RunBlocker> },
    Completed,
    Failed,
    Cancelled,
}
/// A durable blocker is an observation, never permission to replay an operation.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentRunBlocker")]
pub struct RunBlocker {
    pub id: BlockerId,
    pub reason: BlockerKind,
    pub offered_actions: Vec<maka_agent_facts::durable::OfferedRiskAction>,
}

/// Manual continuation of a terminal Run always admits a new Run. Recovery of an
/// unfinished Run is internal reconciliation, not this user command.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentContinueRun")]
pub struct ContinueRun {
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub source_run_id: RunId,
    /// Exact immutable source fence returned by execution.
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub source_high_water: u64,
    pub model: ModelSelection,
    pub thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentContinuationResult")]
pub enum ContinuationResult {
    Started { execution: Execution },
    Rejected { reason: ContinuationRejection },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentContinuationAvailability")]
pub enum ContinuationAvailability {
    Ready { source: Execution },
    Rejected { reason: ContinuationRejection },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentContinuationRejection")]
pub enum ContinuationRejection {
    Closed,
    Archived,
    Busy,
    SourceMissing,
    SourceChanged,
    SourceNotTerminal,
    AlreadyContinued,
    WorkspaceChanged,
    SafetyCheckFailed,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentAdjudicateRisk")]
pub struct AdjudicateRisk {
    pub session_id: String,
    pub run_id: RunId,
    /// Compare against the Run-local observation used for this decision.
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub expected_high_water: u64,
    pub blocker_id: BlockerId,
    pub decision: RiskDecisionInput,
}

/// User-supplied evidence bytes. Native stores and pins the immutable content in
/// the same control transaction; callers cannot select a canonical ContentRef.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentRiskEvidenceInput")]
pub enum RiskEvidenceInput {
    Text {
        #[schemars(length(min = 1))]
        text: String,
    },
    Json {
        value: serde_json::Value,
    },
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentRiskDecisionInput")]
pub enum RiskDecisionInput {
    RecordExternalObservation { evidence: RiskEvidenceInput },
    AuthorizeReplan { evidence: RiskEvidenceInput },
    CancelBlockedRun { diagnostic: String },
}
