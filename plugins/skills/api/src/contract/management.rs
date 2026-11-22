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

use maka_agent_api::contract::Workspace;
use maka_skills::LocationId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The exact source snapshot selected during discovery, or last installed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "SkillLibrarySourceSnapshot")]
pub enum SourceSnapshot {
    Git {
        url: String,
        reference: Option<String>,
        revision: String,
    },
    Directory {
        path: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryInstallation")]
pub struct Installation {
    pub source: SourceSnapshot,
    pub directory: String,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryDiscoverSource")]
pub struct DiscoverSource {
    pub workspace: Option<Workspace>,
    pub source: String,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibrarySourceSkill")]
pub struct SourceSkill {
    pub directory: String,
    pub name: String,
    pub description: String,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryDiscoveredSource")]
pub struct DiscoveredSource {
    pub source: SourceSnapshot,
    pub skills: Vec<SourceSkill>,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryInstall")]
pub struct Install {
    pub workspace: Option<Workspace>,
    pub location: LocationId,
    pub source: SourceSnapshot,
    pub skills: Vec<String>,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryManageSkill")]
pub struct ManageSkill {
    pub workspace: Option<Workspace>,
    pub reference: String,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryInstallOutcome")]
pub enum InstallOutcome {
    Installed { reference: String },
    Rejected { directory: String, reason: String },
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SkillLibraryInstallResult")]
pub struct InstallResult {
    pub results: Vec<InstallOutcome>,
}

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SkillLibraryTarget")]
pub struct Target {
    pub location: LocationId,
    pub path: String,
}
