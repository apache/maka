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

use super::{Execution, ModelSelection};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCompactionPrompt")]
pub struct CompactionPrompt {
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub revision: u64,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub prompt: Option<String>,
    pub compaction_prompt: String,
    pub default_compaction_prompt: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSetCompactionPrompt")]
pub struct SetCompactionPrompt {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub expected_revision: u64,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub prompt: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentCompact")]
pub struct Compact {
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub model: ModelSelection,
    pub thinking_level: Option<maka_agent_facts::execution::ThinkingLevel>,
    /// One invocation only; omission uses the Session's effective preference.
    pub prompt: Option<String>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentCompactResult")]
pub enum CompactResult {
    Started { execution: Execution },
    Rejected { reason: CompactRejection },
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentCompactRejection")]
pub enum CompactRejection {
    Busy,
    Closed,
    Archived,
    BackendUnavailable,
    WorkspaceChanged,
}
