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

use super::*;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::execution::ThinkingLevel;
use maka_assistant::plan::{Artifact, Progress, Proposal};

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPlanRead")]
pub struct PlanRead {
    pub session_id: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPlanView")]
pub struct PlanView {
    pub enabled: bool,
    pub current: PlanSnapshot,
}

/// Public business data only; frozen execution authority remains with the owner.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPlanSnapshot")]
pub struct PlanSnapshot {
    pub revision: u64,
    pub proposal: Option<Proposal>,
    pub execution: Option<PlanExecution>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPlanExecution")]
pub struct PlanExecution {
    pub id: String,
    pub proposal_id: String,
    pub artifact: Artifact,
    pub steps: Vec<Progress>,
    pub phase: PlanPhase,
    pub invocation: Option<Invocation>,
    pub reason: Option<String>,
    pub cancellation: Option<String>,
    pub updated_at: u64,
}
#[derive(Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentPlanPhase")]
pub enum PlanPhase {
    AwaitingAdmission,
    Active,
    Interrupted,
    Completed,
    Cancelled,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPlanHistoryRead")]
pub struct PlanHistoryRead {
    pub session_id: String,
    pub through_revision: Option<u64>,
    #[serde(default)]
    pub after: u64,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPlanHistory")]
pub struct PlanHistory {
    pub through_revision: u64,
    pub snapshots: Vec<PlanSnapshot>,
    pub next_after: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPlanChange")]
pub struct PlanChange {
    pub session_id: String,
    pub revision: u64,
    pub action: PlanAction,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentPlanAction")]
pub enum PlanAction {
    Approve {
        proposal_id: String,
        proposal_revision: u64,
        approval: PlanApproval,
    },
    Revise {
        proposal_id: String,
    },
    Abandon {
        proposal_id: String,
    },
    Resume {
        execution_id: String,
        approval: PlanApproval,
    },
    Cancel {
        execution_id: String,
        reason: String,
    },
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPlanApproval")]
pub struct PlanApproval {
    pub target: ScheduledTarget,
    pub model: ModelSelection,
    pub thinking_level: Option<ThinkingLevel>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentPlanResult")]
pub enum PlanResult {
    Committed { revision: u64 },
    Conflict { actual: u64 },
    Rejected { reason: String },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPlanReceiptRead")]
pub struct PlanReceiptRead {
    pub reference: maka_plugin_core::operation::RecoveryRef,
}
