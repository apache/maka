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

use maka_plugins::composition::Scope;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageProjection {
    pub extension_id: String,
    pub content_digest: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub dependencies: Vec<String>,
    pub structural_dependencies: Vec<String>,
    pub required_by: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryProjection {
    pub id: String,
    pub root_id: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_id: Option<String>,
    pub config: Value,
    pub disabled: bool,
    pub status: EntryPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    pub waiting_for: Vec<String>,
    pub effects: Vec<String>,
    pub children: Vec<EntryProjection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryPhase {
    Disabled,
    Pending,
    Loading,
    Active,
    Failed,
    Unloading,
    Disposed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Failure {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_id: Option<String>,
    pub diagnostic: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionIdentity {
    pub entry_id: String,
    pub scope_id: Scope,
    pub extension_id: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolProjection {
    #[serde(flatten)]
    pub identity: ContributionIdentity,
    pub tool_name: String,
    pub active_calls: usize,
    pub retired: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandProjection {
    #[serde(flatten)]
    pub identity: ContributionIdentity,
    pub name: String,
    pub description: String,
    pub aliases: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutorProjection {
    #[serde(flatten)]
    pub identity: ContributionIdentity,
    pub id: String,
    pub display_name: String,
    pub capabilities: ExecutorCapabilities,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutorCapabilities {
    pub thinking: bool,
    pub tool_activity: bool,
    pub history_copy: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalViewProjection {
    pub package_id: String,
    pub scope_id: Scope,
    pub method: String,
    pub target: maka_plugins::remote::Target,
    pub descriptor: maka_plugins::terminal_ui::Descriptor,
}
