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

use super::DirectorySelection;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentProjectRef")]
pub struct ProjectRef {
    pub id: uuid::Uuid,
    #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
    pub revision: String,
}

#[derive(Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentProject")]
pub struct Project {
    pub reference: ProjectRef,
    #[schemars(length(min = 1))]
    pub name: String,
    pub archived: bool,
    pub available: bool,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<DirectorySelection>")]
    pub selection: Option<DirectorySelection>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub path: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentProjectCursor")]
pub struct ProjectCursor {
    #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
    pub revision: String,
    pub after: uuid::Uuid,
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentProjectsRead")]
pub enum ProjectsRead {
    List {
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<ProjectCursor>")]
        cursor: Option<ProjectCursor>,
    },
    Directory {
        selection: DirectorySelection,
    },
}

#[derive(Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentProjectLocation")]
pub struct ProjectLocation {
    pub selection: DirectorySelection,
    #[schemars(length(min = 1))]
    pub path: String,
    #[schemars(length(min = 1))]
    pub name: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<Project>")]
    pub project: Option<Project>,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentProjectsPage")]
pub enum ProjectsPage {
    Projects {
        #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
        revision: String,
        #[schemars(length(max = 16))]
        projects: Vec<Project>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<ProjectCursor>")]
        next: Option<ProjectCursor>,
    },
    Directory {
        location: ProjectLocation,
    },
    Changed,
    Unavailable,
}

#[derive(Clone, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentProjectChange")]
pub enum ProjectChange {
    Register {
        selection: DirectorySelection,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<ProjectRef>")]
        expected: Option<ProjectRef>,
    },
    Rename {
        project: ProjectRef,
        #[schemars(length(min = 1))]
        name: String,
    },
    Archive {
        project: ProjectRef,
    },
    Restore {
        project: ProjectRef,
    },
    Relocate {
        project: ProjectRef,
        selection: DirectorySelection,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<ProjectRef>")]
        destination: Option<ProjectRef>,
    },
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentProjectResult")]
pub enum ProjectResult {
    Committed { project: Project },
    Changed,
    Unavailable,
    Busy,
    Invalid,
}
