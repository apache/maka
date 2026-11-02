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
use maka_agent_facts::execution::ThinkingLevel;
pub use maka_goal::goal::{Control as GoalControl, Status as GoalStatus};

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGoalRead")]
pub struct GoalRead {
    pub session_id: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGoalView")]
pub struct GoalView {
    pub enabled: bool,
    pub current: Option<GoalDetail>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGoalDetail")]
pub struct GoalDetail {
    pub id: uuid::Uuid,
    pub revision: u64,
    pub objective: String,
    pub status: GoalStatus,
    pub iterations: u64,
    pub token_budget: Option<u64>,
    pub consumed: maka_goal::goal::Meter,
    pub remaining_tokens: Option<u64>,
    pub elapsed_seconds: u64,
    pub retry_at: Option<u64>,
    pub created_at: u64,
    pub pending: bool,
    pub report: Option<maka_goal::goal::Report>,
    pub note: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentGoalChange")]
pub enum GoalChange {
    Create {
        session_id: String,
        objective: String,
        token_budget: Option<u64>,
        start: bool,
        approval: GoalApproval,
    },
    Control {
        session_id: String,
        goal_id: uuid::Uuid,
        revision: u64,
        action: GoalControl,
        #[serde(default)]
        budget: Option<GoalBudget>,
        /// Explicit renewed model and session authority, only for Resume without a pending iteration.
        #[serde(default)]
        approval: Option<GoalApproval>,
    },
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentGoalResult")]
pub enum GoalResult {
    Committed { goal_id: uuid::Uuid, revision: u64 },
    Conflict { actual: Option<u64> },
    Rejected { reason: String },
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGoalApproval")]
pub struct GoalApproval {
    pub target: ScheduledTarget,
    pub model: ModelSelection,
    pub thinking_level: Option<ThinkingLevel>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGoalReceiptRead")]
pub struct GoalReceiptRead {
    pub reference: maka_plugin_core::operation::RecoveryRef,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGoalBudget")]
pub struct GoalBudget {
    pub token_budget: Option<u64>,
}
