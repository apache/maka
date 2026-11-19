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

use crate::durable::{ExecutionIdentity, ExternalTaskId, RunOwner};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "UsageToolStatus")]
pub enum ToolStatus {
    Success,
    Error,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolUsage {
    pub request_id: String,
    pub source: ToolUsageSource,
    pub name: String,
    pub binding: Option<crate::execution::ModelBinding>,
    pub completed_at: f64,
    pub result: ToolUsageResult,
    pub cleanup: Option<maka_plugin_core::operation::OperationCleanup>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ToolUsageResult {
    Rejected {
        reason: Option<crate::tool_call::RejectionKind>,
    },
    Settled {
        started_at: f64,
        outcome: ToolStatus,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolUsageSource {
    Agent {
        execution: ExecutionIdentity,
        call: crate::tool_call::ToolCallIdentity,
    },
    Cell {
        cell: crate::cells::CellId,
        owner: crate::cells::CellOwner,
        operation: uuid::Uuid,
    },
    External {
        task: ExternalTaskId,
        owner: RunOwner,
        operation: uuid::Uuid,
    },
}
