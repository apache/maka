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

pub use maka_fs_tools::files::{
    FileChange, FileContent, FileCursor, FileEntry, FileKind, FilePage, FileUnavailable,
};
pub use maka_fs_tools::path::WorkspacePath;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentFileListRead")]
pub struct FileListRead {
    pub session_id: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<WorkspacePath>")]
    pub path: Option<WorkspacePath>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<FileCursor>")]
    pub after: Option<FileCursor>,
}

/// Workspace-relative file suggestions from this Session's admitted directory.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentFileCandidatesRead")]
pub struct FileCandidatesRead {
    pub session_id: String,
    /// Omission or null selects the workspace root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<WorkspacePath>,
    /// Empty or whitespace browses the selected directory's direct files and directories.
    /// Otherwise, searches file paths within that directory's descendants.
    pub query: String,
}

/// An emitted batch of path observations; null final completion ends the subscription.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentFileCandidates")]
pub struct FileCandidates {
    pub entries: Vec<FileEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentFileWatch")]
pub struct FileWatch {
    pub session_id: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<WorkspacePath>")]
    pub path: Option<WorkspacePath>,
}

/// One bounded current-file capture. A version is a precondition, never read authority.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentFileRead")]
pub struct FileRead {
    pub session_id: String,
    pub path: WorkspacePath,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 71, max = 71), regex(pattern = "^sha256:[a-f0-9]{64}$"))]
    pub expected_version: Option<String>,
}

/// All parts are subscription items; only End admits a complete preview.
/// Offsets and byte counts refer to original bytes, not Base64 or UTF-16 lengths.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentFileReadPart")]
pub enum FileReadPart {
    Begin {
        version: String,
        digest: String,
        bytes: u64,
        content: FileContent,
    },
    Chunk {
        offset: u64,
        #[schemars(length(max = 43_692))]
        data: String,
    },
    End {
        version: String,
        digest: String,
        bytes: u64,
    },
    Absent,
    Changed,
    Binary {
        bytes: u64,
    },
    Unsupported {
        file_kind: FileKind,
    },
}
