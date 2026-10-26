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

use super::{DirectorySelection, Session};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentImportLocation")]
pub enum ImportLocation {
    Codex {
        directory: DirectorySelection,
    },
    ClaudeCode {
        directory: DirectorySelection,
    },
    OpenCode {
        directory: DirectorySelection,
        #[schemars(length(min = 1))]
        database: String,
    },
}
impl ImportLocation {
    pub fn directory(&self) -> &DirectorySelection {
        match self {
            Self::Codex { directory }
            | Self::ClaudeCode { directory }
            | Self::OpenCode { directory, .. } => directory,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentImportSource")]
pub struct ImportSource {
    pub id: Uuid,
    #[schemars(length(min = 1))]
    pub name: String,
    pub location: ImportLocation,
    #[schemars(length(min = 1))]
    pub path: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentImportSourceRef")]
pub struct ImportSourceRef {
    pub id: Uuid,
    #[schemars(range(min = 1, max = 9007199254740991_u64))]
    pub revision: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentImportEntryRef")]
pub struct ImportEntryRef {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(length(min = 1))]
    pub path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentImportSelection")]
pub struct ImportSelection {
    pub source: ImportSourceRef,
    pub entry: ImportEntryRef,
    #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
    pub digest: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentImportQuery")]
pub struct ImportQuery {
    pub text: String,
    pub include_archived: bool,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub cursor: Option<String>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentImportEntry")]
pub struct ImportEntry {
    pub id: String,
    pub path: String,
    pub title: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub cwd: Option<String>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub updated_at: Option<u64>,
    pub archived: bool,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentImportPreviewItem")]
pub struct ImportPreviewItem {
    pub index: u64,
    pub kind: ImportRecordKind,
    #[schemars(length(max = 4096))]
    pub text: String,
    pub truncated: bool,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentImportRecordKind")]
pub enum ImportRecordKind {
    User,
    Assistant,
    ToolCall,
    ToolResult,
    Note,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentImportPreview")]
pub struct ImportPreview {
    pub selection: ImportSelection,
    pub title: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub cwd: Option<String>,
    pub records: u64,
    pub bytes: u64,
    pub incomplete_tail: bool,
    #[schemars(length(max = 8))]
    pub items: Vec<ImportPreviewItem>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
    pub next: Option<u64>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentImportsRead")]
pub enum ImportsRead {
    Sources,
    Catalog {
        source: ImportSourceRef,
        query: ImportQuery,
    },
    Preview {
        source: ImportSourceRef,
        entry: ImportEntryRef,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
        digest: Option<String>,
        #[schemars(range(max = 9_007_199_254_740_991u64))]
        after: u64,
    },
    Copies {
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
        after: Option<String>,
    },
}
#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentImportsPage")]
pub enum ImportsPage {
    Sources {
        revision: u64,
        sources: Vec<ImportSource>,
    },
    Catalog {
        source: ImportSourceRef,
        #[schemars(length(max = 16))]
        entries: Vec<ImportEntry>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
        next: Option<String>,
    },
    Preview {
        preview: ImportPreview,
    },
    Copies {
        #[schemars(length(max = 16))]
        sessions: Vec<Session>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
        next: Option<String>,
    },
    Changed,
    Unavailable,
    Invalid,
}
#[derive(Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentImportChange")]
pub enum ImportChange {
    SaveSource {
        #[schemars(range(max = 9007199254740991_u64))]
        revision: u64,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<Uuid>")]
        id: Option<Uuid>,
        #[schemars(length(min = 1))]
        name: String,
        location: ImportLocation,
    },
    RemoveSource {
        #[schemars(range(max = 9007199254740991_u64))]
        revision: u64,
        id: Uuid,
    },
    Copy {
        selection: ImportSelection,
        directory: DirectorySelection,
        #[schemars(length(min = 1))]
        title: String,
    },
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentImportResult")]
pub enum ImportResult {
    Sources {
        revision: u64,
        sources: Vec<ImportSource>,
    },
    Imported {
        session: Box<Session>,
    },
    Changed,
    Unavailable,
    Invalid,
}
