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

/// Actual Agent registrations are supplied outside model-controlled arguments.
/// These names describe compatibility and confer no execution authority.
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkillToolRequest<T> {
    pub workspace: Option<maka_agent_api::contract::Workspace>,
    pub tools: Vec<String>,
    pub input: T,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SkillModelSearch")]
pub struct ModelSearch {
    pub query: String,
    /// Omission returns the complete matching catalog.
    #[schemars(range(min = 1))]
    pub limit: Option<usize>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "SkillModelLoad")]
pub struct ModelLoad {
    /// Exact ref from search, or a skill id/name resolved before eligibility checks.
    #[schemars(length(min = 1))]
    pub name: String,
    /// Catalog revision from search or a previous load/resource response.
    #[schemars(length(min = 1))]
    pub revision: String,
    /// UTF-8 resource path relative to this skill, or its exact continuation.
    pub resource: Option<maka_agent_facts::read::ReadInput>,
    /// UTF-8 byte offset from a returned instruction continuation; omit initially.
    pub instruction_offset: Option<usize>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "SkillModelSearchResult")]
pub struct ModelSearchResult<'a> {
    pub revision: String,
    #[serde(flatten)]
    pub result: maka_skills::SearchResult<'a>,
}
#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[schemars(rename = "SkillModelLoadResult")]
pub enum ModelLoadResult<'a> {
    /// User-provided, lower-priority instructions. Declared tools are hints, not grants.
    Loaded {
        revision: String,
        metadata: maka_skills::SkillMetadata<'a>,
        instructions: String,
        instruction_offset: usize,
        next: Option<ModelLoad>,
        relative_path: String,
        declared_tools: Vec<String>,
        declared_tools_truncated: bool,
        truncated: bool,
        receipt: maka_skills::SkillInvocationReceipt,
    },
    Resource {
        revision: String,
        reference: String,
        path: String,
        content: String,
        offset: usize,
        returned_lines: usize,
        total_lines: usize,
        partial_line: bool,
        next: Option<ModelLoad>,
        receipt: maka_skills::SkillInvocationReceipt,
    },
    Changed,
    Unavailable {
        reason: maka_skills::SkillFailureReason,
        receipt: maka_skills::SkillInvocationReceipt,
    },
    ResourceUnavailable {
        reason: String,
    },
}
