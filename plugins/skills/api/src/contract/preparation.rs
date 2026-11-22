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

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillPrepare")]
pub struct Prepare {
    pub language: maka_agent_facts::language::Language,
    pub message: String,
    /// Actual selected tools bound to this Library; these names grant no access.
    #[schemars(length(min = 1))]
    pub load_tool: Option<String>,
    #[schemars(length(min = 1))]
    pub search_tool: Option<String>,
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillPreparationRecord")]
pub struct PreparationRecord {
    pub revision: String,
    pub metadata_prompt: String,
    pub invocation: maka_skills::SkillInvocationResult,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "SkillPreparation")]
pub enum Preparation {
    Ready {
        /// None preserves the original message exactly.
        text: Option<String>,
        record: PreparationRecord,
        required_tools: std::collections::BTreeSet<String>,
    },
    Blocked {
        invocation: maka_skills::SkillInvocationResult,
    },
}
