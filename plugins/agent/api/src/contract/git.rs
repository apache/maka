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

use super::WorkspacePath;
pub use maka_fs_tools::git::{
    GitArea, GitBranchEntry, GitChangeKind, GitCommitSummary, GitCompare, GitCompareEntry,
    GitCompareSpec, GitDiff, GitRemoteRepo, GitRevisions, GitStatus, GitStatusEntry,
    GitWorkspaceDiff, GitWorktreeEntry,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitSessionRead")]
pub struct GitSessionRead {
    pub session_id: String,
    #[serde(default)]
    pub worktree_path: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitDiffRead")]
pub struct GitDiffRead {
    pub session_id: String,
    pub area: GitArea,
    pub path: WorkspacePath,
    #[serde(default)]
    pub worktree_path: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitWorkspaceDiffRead")]
pub struct GitWorkspaceDiffRead {
    pub session_id: String,
    #[serde(default)]
    pub area: Option<GitArea>,
    #[serde(default)]
    pub worktree_path: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitCompareRead")]
pub struct GitCompareRead {
    pub session_id: String,
    pub spec: GitCompareSpec,
    #[serde(default)]
    pub include_patch: bool,
    #[serde(default)]
    pub worktree_path: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitCompareDiffRead")]
pub struct GitCompareDiffRead {
    pub session_id: String,
    pub spec: GitCompareSpec,
    pub path: WorkspacePath,
    #[serde(default)]
    pub worktree_path: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentProjectWorktreesRead")]
pub struct ProjectWorktreesRead {
    pub path: String,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentProjectWorktree")]
pub struct ProjectWorktree {
    pub id: String,
    pub name: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub branch: Option<String>,
    pub path: String,
}

#[derive(Serialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentProjectWorktrees")]
pub enum ProjectWorktrees {
    Git {
        root: String,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
        head_branch: Option<String>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
        default_base: Option<String>,
        branches: Vec<GitBranchEntry>,
        #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<u64>")]
        uncommitted_files: Option<u64>,
        worktrees: Vec<ProjectWorktree>,
    },
    NotGit,
    Unavailable,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentProjectWorktreeCreate")]
pub struct ProjectWorktreeCreate {
    pub path: String,
    pub name: String,
    pub branch: String,
    /// A fully qualified ref in refs/heads or refs/remotes, resolved locally.
    pub base_ref: String,
    /// Capture the selected checkout's files and index, requiring this ref to be its HEAD.
    #[serde(default)]
    pub include_changes: bool,
}

#[derive(Clone, Copy, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentProjectWorktreeFailure")]
pub enum ProjectWorktreeFailure {
    InvalidName,
    InvalidBranch,
    BaseUnavailable,
    BranchConflict,
    DirectoryConflict,
    SnapshotUnavailable,
    GitRequired,
    LocationNotAllowed,
    Unavailable,
    Unsupported,
    Unknown,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentProjectWorktreeCreated")]
pub enum ProjectWorktreeCreated {
    Created {
        worktree: ProjectWorktree,
    },
    Failed {
        reason: ProjectWorktreeFailure,
        message: String,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentProjectBranchCheckout")]
pub struct ProjectBranchCheckout {
    pub path: String,
    pub branch: String,
    #[serde(default)]
    pub create: bool,
}

#[derive(Clone, Copy, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentProjectBranchFailure")]
pub enum ProjectBranchFailure {
    InvalidBranch,
    BranchUnavailable,
    AlreadyExists,
    CheckedOutElsewhere,
    OverwritesChanges,
    GitRequired,
    Unsupported,
    Unavailable,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentProjectBranchCheckedOut")]
pub enum ProjectBranchCheckedOut {
    CheckedOut,
    Failed { reason: ProjectBranchFailure },
}
