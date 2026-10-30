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

use maka_plugin_core::contract::{Contract, Interface, Method, MethodMode, Transport};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

mod management;
pub use management::*;
mod model;
pub use model::*;
mod preparation;
pub use preparation::*;

/// Installation-selected skill collections. No ambient home or workspace scan.
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryConfiguration")]
pub struct Configuration {
    /// Explicit user root; only its standard .maka/skills and .agents/skills collections are scanned.
    #[schemars(length(min = 1))]
    pub home: Option<String>,
    /// Explicit ceilings for a request's selected project. An observation grants no access.
    #[serde(default)]
    pub project_roots: Vec<maka_host_runtime::DirectoryRootSpec>,
    /// Include the immutable skill instructions and resources shipped with this build.
    #[serde(default)]
    pub bundled: bool,
    /// Allow management of the configured standard user and project skill directories.
    #[serde(default)]
    pub manage: bool,
    /// Allow edits to enabled/pinned preferences, independently of file management.
    #[serde(default)]
    pub preferences: bool,
    pub sources: Vec<Source>,
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibrarySource")]
pub struct Source {
    #[schemars(regex(pattern = "^[a-z0-9][a-z0-9_-]*$"))]
    pub id: String,
    #[schemars(length(min = 1))]
    pub label: String,
    /// Absolute directory containing skill directories. Captured at activation.
    #[schemars(length(min = 1))]
    pub path: String,
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryCursor")]
pub struct Cursor {
    #[schemars(length(min = 1))]
    pub revision: String,
    pub query: String,
    pub offset: usize,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryList")]
pub struct List {
    pub workspace: Option<maka_agent_api::contract::Workspace>,
    pub query: String,
    pub cursor: Option<Cursor>,
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryEntry")]
pub struct Entry {
    pub bundled: bool,
    pub location: Option<maka_skills::LocationId>,
    pub path: String,
    pub installation: Option<Installation>,
    pub preference: maka_skills::Preference,
    pub reference: String,
    pub source: String,
    pub name: String,
    pub description: String,
    pub valid: bool,
    pub shadowed_by: Option<String>,
    pub issues: Vec<String>,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "SkillLibraryPage")]
pub enum Page {
    Page {
        writable: bool,
        targets: Vec<Target>,
        preferences_writable: bool,
        preference_revision: u64,
        revision: String,
        entries: Vec<Entry>,
        after: Option<Cursor>,
        diagnostics: Vec<String>,
    },
    Changed,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryRead")]
pub struct Read {
    pub workspace: Option<maka_agent_api::contract::Workspace>,
    #[schemars(length(min = 1))]
    pub reference: String,
    /// Complete catalog revision from the list/read response.
    #[schemars(length(min = 1))]
    pub revision: String,
    pub offset: usize,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "SkillLibraryDocument")]
pub enum Document {
    Page {
        writable: bool,
        preferences_writable: bool,
        preference_revision: u64,
        entry: Box<Entry>,
        revision: String,
        text: String,
        offset: usize,
        before: Option<usize>,
        after: Option<usize>,
        total_bytes: usize,
    },
    Changed,
    Unavailable,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryChangeResult")]
pub enum ChangeResult {
    Applied { reference: String },
    Rejected { reason: String },
}
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SkillLibrarySetPreference")]
pub struct SetPreference {
    #[schemars(length(min = 1))]
    pub reference: String,
    #[schemars(range(max = 9007199254740991_u64))]
    pub revision: u64,
    pub preference: maka_skills::Preference,
}
#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SkillLibraryPreferenceResult")]
pub enum PreferenceResult {
    Applied { revision: u64 },
    Changed,
    Rejected { reason: String },
}
pub fn configuration_schema() -> Value {
    schemars::schema_for!(Configuration).into()
}
pub fn contract() -> Contract {
    Contract {
        name: "maka.skills.Library".into(),
        version: 1,
        transport: Transport::Remote,
        interface: Interface::Service {
            methods: BTreeMap::from([
                (
                    "prepare".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: schemars::schema_for!(SkillToolRequest<Prepare>).into(),
                        output: schemars::schema_for!(Preparation).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "search".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: schemars::schema_for!(SkillToolRequest<ModelSearch>).into(),
                        output: schemars::schema_for!(ModelSearchResult<'static>).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "load".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: schemars::schema_for!(SkillToolRequest<ModelLoad>).into(),
                        output: schemars::schema_for!(ModelLoadResult<'static>).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "setPreference".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(SetPreference).into(),
                        output: schemars::schema_for!(PreferenceResult).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "discoverSource".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: schemars::schema_for!(DiscoverSource).into(),
                        output: schemars::schema_for!(DiscoveredSource).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "install".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(Install).into(),
                        output: schemars::schema_for!(InstallResult).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "update".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(ManageSkill).into(),
                        output: schemars::schema_for!(ChangeResult).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "delete".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: schemars::schema_for!(ManageSkill).into(),
                        output: schemars::schema_for!(ChangeResult).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "list".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: schemars::schema_for!(List).into(),
                        output: schemars::schema_for!(Page).into(),
                        resources: BTreeMap::new(),
                    },
                ),
                (
                    "read".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Query,
                        input: schemars::schema_for!(Read).into(),
                        output: schemars::schema_for!(Document).into(),
                        resources: BTreeMap::new(),
                    },
                ),
            ]),
        },
    }
}
