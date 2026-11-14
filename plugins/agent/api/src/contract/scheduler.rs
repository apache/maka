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
pub use maka_scheduler::{plan::Misfire as TaskMisfire, schedule::Schedule as TaskSchedule};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentScheduledEffect")]
pub enum ScheduledEffect {
    Session {
        #[serde(default)]
        delivery: AutomationDelivery,
        target: ScheduledTarget,
        model: ModelSelection,
        thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    },
    ExecutorSession {
        target: ScheduledTarget,
        selection: maka_agent_facts::executor::Selection,
    },
    AgentRun {
        target: ScheduledTarget,
        model: ModelSelection,
        thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    },
    /// Read-only investigation in a fresh worker. The target is the current Bot.
    Discovery {
        target: ScheduledTarget,
        model: ModelSelection,
        thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    },
}
impl ScheduledEffect {
    pub fn target(&self) -> &ScheduledTarget {
        match self {
            Self::Session { target, .. }
            | Self::ExecutorSession { target, .. }
            | Self::AgentRun { target, .. }
            | Self::Discovery { target, .. } => target,
        }
    }
}

impl maka_scheduler::task::TaskEffect for ScheduledEffect {
    fn validate(&self) -> Result<(), maka_scheduler::Error> {
        let target = self.target();
        if target.session_id.is_empty()
            || target.boundary_revision > maka_agent_facts::interaction::MAX_SAFE_INTEGER
            || target.binding.validate().is_err()
        {
            return Err(maka_scheduler::Error::Invalid(
                "invalid scheduled execution target".into(),
            ));
        }
        if let Self::ExecutorSession { selection, .. } = self {
            selection
                .settings
                .validate()
                .map_err(|error| maka_scheduler::Error::Invalid(error.into()))?;
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationDelivery {
    #[default]
    Steering,
    Followup,
}

/// Exact observed source boundary. This data is checked against the original
/// Session; passing it never grants execution by itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentScheduledTarget")]
pub struct ScheduledTarget {
    pub session_id: String,
    pub workspace: Workspace,
    pub permissions: WorkspacePermissions,
    pub boundary_revision: u64,
    pub binding: maka_sandbox::workspace::BindingStamp,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentScheduledInput")]
pub struct ScheduledInput {
    pub task: maka_scheduler::task::Create<ScheduledEffect>,
    pub timezone: String,
    pub misfire: TaskMisfire,
}
#[derive(Clone, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentScheduleRead")]
pub enum ScheduleRead {
    List {
        cursor: Option<String>,
        expected_revision: Option<u64>,
    },
    Get {
        task_id: String,
    },
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentScheduledSummary")]
pub struct ScheduledSummary {
    pub id: String,
    pub revision: u64,
    pub title: String,
    pub session_id: String,
    pub script: bool,
    pub approved: bool,
    pub status: maka_scheduler::task::Status,
    pub next_fire_at: Option<i64>,
    pub pending_fire: Option<String>,
    pub last_error: Option<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentScheduledDetail")]
pub struct ScheduledDetail {
    pub revision: u64,
    pub task: maka_scheduler::task::Task<ScheduledEffect>,
    pub timezone: String,
    pub misfire: TaskMisfire,
    pub approved: bool,
    pub pending_fire: Option<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentSchedules")]
pub enum Schedules {
    Page {
        revision: u64,
        tasks: Vec<ScheduledSummary>,
        next_cursor: Option<String>,
    },
    Task {
        detail: Option<Box<ScheduledDetail>>,
    },
    Changed {
        revision: u64,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentScheduleChange")]
pub enum ScheduleChange {
    Create {
        input: ScheduledInput,
    },
    Update {
        task_id: String,
        revision: u64,
        input: ScheduledInput,
    },
    Approve {
        task_id: String,
        revision: u64,
    },
    Pause {
        task_id: String,
        revision: u64,
    },
    Resume {
        task_id: String,
        revision: u64,
    },
    TriggerNow {
        task_id: String,
        revision: u64,
    },
    ClearHistory {
        task_id: String,
        revision: u64,
    },
    Delete {
        task_id: String,
        revision: u64,
    },
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentScheduleResult")]
pub enum ScheduleResult {
    Committed { task_id: String, revision: u64 },
    Conflict { actual: Option<u64> },
    Rejected { reason: String },
}
