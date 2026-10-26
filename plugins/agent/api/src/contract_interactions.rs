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

use maka_agent_facts::interaction::InteractionAnswer;
use maka_agent_facts::interaction::InteractionRecord;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, JsonSchema, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentPendingInteractions")]
pub struct PendingInteractions {
    pub revision: u64,
    pub entries: Vec<InteractionSummary>,
}
#[derive(Clone, Serialize, JsonSchema, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentInteractionSummary")]
pub struct InteractionSummary {
    pub request_id: String,
    pub kind: InteractionKind,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub tool_use_id: Option<String>,
}
#[derive(Clone, Serialize, JsonSchema, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentInteractionKind")]
pub enum InteractionKind {
    ServiceApproval,
    Question,
    Permissions,
    Form,
    ClientCapability,
    ComputerApp,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentInteractionRead")]
pub struct InteractionRead {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub request_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentInteractionRespond")]
pub struct InteractionRespond {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub request_id: String,
    pub answer: InteractionAnswer,
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentInteractionResult")]
pub enum InteractionResult {
    /// Includes a concurrent winner. Consumers inspect the canonical outcome.
    Recorded {
        record: Box<InteractionRecord>,
    },
    Rejected {
        reason: InteractionRejection,
    },
}
#[derive(Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentInteractionRejection")]
pub enum InteractionRejection {
    Closed,
    Unavailable,
    InvalidAnswer,
    Unsupported,
}
