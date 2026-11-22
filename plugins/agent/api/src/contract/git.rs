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
use serde::Deserialize;

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
