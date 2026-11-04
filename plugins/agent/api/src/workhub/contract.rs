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

//! Persistent coordinator discovery; model and worker authority remain explicit.
use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WorkHubConfiguration")]
pub struct Configuration {
    pub agent: crate::Configuration,
    /// Exactly selected imports of Agent services. Native grants are independent.
    #[schemars(extend("uniqueItems" = true))]
    pub workers: Vec<String>,
}
pub fn configuration_schema() -> serde_json::Value {
    schemars::schema_for!(Configuration).into()
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WorkHubTasksRead")]
pub struct TasksRead {
    /// Opaque continuation for newest accepted tasks first, with stable identity ties.
    /// This is live keyset pagination, not a frozen snapshot; pass it unchanged.
    pub after: Option<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WorkHubTasks")]
pub struct Tasks {
    #[schemars(length(max = 16))]
    pub entries: Vec<TaskEntry>,
    /// Opaque live continuation in accepted-time descending order. Null ends the page sequence.
    pub after: Option<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "WorkHubTaskEntry")]
pub struct TaskEntry {
    pub task_id: String,
    pub worker: String,
    pub title: String,
    /// Frozen task acceptance time in Unix milliseconds.
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub accepted_at: u64,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "WorkHubTaskRead")]
pub struct TaskRead {
    #[schemars(regex(pattern = "^wt_[a-f0-9]{64}$"))]
    pub task_id: String,
    pub cursor: Option<crate::contract::AnswerCursor>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "WorkHubTask")]
pub struct Task {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
    pub task_id: String,
    pub worker: String,
    pub title: String,
    /// Frozen task acceptance time in Unix milliseconds.
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub accepted_at: u64,
    pub operation: uuid::Uuid,
    pub status: TaskStatus,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "WorkHubTaskStatus")]
pub enum TaskStatus {
    Blocked {
        dependencies: Vec<String>,
    },
    Cancelled,
    Preparing {
        stage: PreparationStage,
        operation: uuid::Uuid,
        session_id: Option<String>,
        state: PreparationState,
    },
    Pending,
    Uncertain,
    Unavailable,
    Rejected {
        reason: String,
    },
    Started {
        session_id: String,
        invocation_id: String,
        progress: Option<crate::contract::Work>,
    },
    Queued {
        session_id: String,
        message_id: String,
        progress: Option<crate::contract::Work>,
    },
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "WorkHubPreparationStage")]
pub enum PreparationStage {
    Create,
    Attachment { index: usize, total: usize },
    Delivery,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "WorkHubPreparationState")]
pub enum PreparationState {
    Pending,
    Unavailable,
    Uncertain,
    /// The original resource-bearing call can only be observed, never recaptured.
    OriginalCaptureRequired,
    Rejected {
        reason: String,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "WorkHubControlRead")]
pub struct ControlRead {
    #[schemars(regex(pattern = "^wc_[a-f0-9]{64}$"))]
    pub control_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WorkHubControlsRead")]
pub struct ControlsRead {
    pub after: Option<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WorkHubControls")]
pub struct Controls {
    #[schemars(length(max = 16))]
    pub entries: Vec<ControlEntry>,
    pub after: Option<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "WorkHubControlEntry")]
pub struct ControlEntry {
    pub task_id: String,
    pub control_id: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "WorkHubControl")]
pub struct Control {
    pub task_id: String,
    pub control_id: String,
    pub operation: uuid::Uuid,
    pub status: ControlStatus,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "WorkHubControlStatus")]
pub enum ControlStatus {
    Pending,
    Unavailable,
    Uncertain,
    Returned { outcome: ControlOutcome },
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "WorkHubControlOutcome")]
pub enum ControlOutcome {
    Patch {
        result: crate::contract::PatchResult,
    },
    Stop {
        result: crate::contract::Stopped,
    },
    Resume {
        result: crate::contract::ResumeResult,
    },
    Retract {
        result: crate::contract::QueueMutationResult,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "WorkHubResolve")]
pub struct Resolve {
    /// The coordinator's directory, used only when freezing the first
    /// creation intent.
    #[schemars(length(min = 1))]
    pub workspace: String,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "WorkHubCoordinator")]
pub enum Coordinator {
    Missing,
    Pending {
        workspace: String,
    },
    Ready {
        session: Box<crate::contract::Session>,
    },
    Rejected {
        reason: crate::contract::Rejection,
    },
}
pub fn contract() -> Contract {
    Contract {
        name: "maka.workhub.Coordinator".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "presets".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: serde_json::json!({"type":"object","properties":{},"additionalProperties":false}).into(),
                        output: schemars::schema_for!(super::presets::Presets).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "savePresets".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(super::presets::Presets).into(),
                        output: schemars::schema_for!(super::presets::Result).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "watchTasks".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Subscription,
                        input: schemars::schema_for!(TasksRead).into(),
                        output: schemars::schema_for!(Tasks).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "watchTask".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Subscription,
                        input: schemars::schema_for!(TaskRead).into(),
                        output: schemars::schema_for!(Task).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "control".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: schemars::schema_for!(ControlRead).into(),
                        output: schemars::schema_for!(Control).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "controls".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: schemars::schema_for!(ControlsRead).into(),
                        output: schemars::schema_for!(Controls).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "tasks".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: schemars::schema_for!(TasksRead).into(),
                        output: schemars::schema_for!(Tasks).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "task".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: schemars::schema_for!(TaskRead).into(),
                        output: schemars::schema_for!(Task).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "coordinator".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: serde_json::json!({"type":"object","properties":{},"additionalProperties":false}).into(),
                        output: schemars::schema_for!(Coordinator).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "resolve".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(Resolve).into(),
                        output: schemars::schema_for!(Coordinator).into(),
                        resources: BTreeMap::new(),
                    },
                ),
            ]).into_iter().chain(super::graph::methods()).collect(),
        },
    }
}
