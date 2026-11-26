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

use super::Workspace;
use maka_skills::LocationId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMcpConfigurations")]
pub struct McpConfigurations {
    pub workspace: Option<Workspace>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentProjectMcpTrustDecision")]
pub enum ProjectMcpTrustDecision {
    Undecided,
    Trusted,
    Declined,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentProjectMcpTrustStatus")]
pub struct ProjectMcpTrustStatus {
    pub path: String,
    pub revision: String,
    pub decision: ProjectMcpTrustDecision,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentProjectMcpDecisionInput")]
pub enum ProjectMcpDecisionInput {
    Trusted,
    Declined,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMcpProjectTrustChange")]
pub struct McpProjectTrustChange {
    pub workspace: Workspace,
    pub revision: String,
    pub decision: ProjectMcpDecisionInput,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentMcpProjectTrustChangeResult")]
pub enum McpProjectTrustChangeResult {
    Saved,
    Changed,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMcpConfigurationList")]
pub struct McpConfigurationList {
    pub locations: Vec<McpConfigurationLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_trust: Option<ProjectMcpTrustStatus>,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMcpConfigurationLocation")]
pub struct McpConfigurationLocation {
    pub location: LocationId,
    pub path: String,
    pub revision: String,
    pub servers: Vec<McpConfigurationEntry>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMcpConfigurationEntry")]
pub struct McpConfigurationEntry {
    pub name: String,
    pub configuration: Value,
    pub shadowed_by: Option<LocationId>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentMcpConfigurationChange")]
pub struct McpConfigurationChange {
    pub workspace: Option<Workspace>,
    pub location: LocationId,
    pub name: String,
    pub revision: String,
    pub change: McpServerChange,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentMcpServerChange")]
pub enum McpServerChange {
    Save { configuration: Value },
    Delete,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentMcpConfigurationResult")]
pub enum McpConfigurationResult {
    Saved,
    Changed,
    Rejected { reason: String },
}
