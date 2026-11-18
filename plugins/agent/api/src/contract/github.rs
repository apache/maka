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

use super::GitWorkspaceDiff;
use maka_plugin_core::wire_schema::RequiredNullable;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubRepoRef")]
pub struct GitHubRepoRef {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentGitHubPullStateFilter")]
pub enum GitHubPullStateFilter {
    #[default]
    Open,
    Closed,
    All,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentGitHubTokenSource")]
pub enum GitHubTokenSource {
    Manual,
    Env,
    HostsFile,
    Netrc,
    GhCli,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubAuthStatus")]
pub struct GitHubAuthStatus {
    pub host: String,
    pub authenticated: bool,
    #[schemars(with = "RequiredNullable<GitHubTokenSource>")]
    pub token_source: Option<GitHubTokenSource>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubPullRequestsRead")]
pub struct GitHubPullRequestsRead {
    pub session_id: String,
    #[serde(default)]
    pub repo: Option<GitHubRepoRef>,
    #[serde(default)]
    pub state: GitHubPullStateFilter,
    #[serde(default)]
    pub head_branch: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubPullSummary")]
pub struct GitHubPullSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: String,
    pub base_sha: String,
    pub updated_at: String,
    pub html_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentGitHubPullRequestsResult")]
pub enum GitHubPullRequestsResult {
    Ready {
        repo: GitHubRepoRef,
        remotes: Vec<GitHubRepoRef>,
        auth: GitHubAuthStatus,
        #[schemars(with = "RequiredNullable<u64>")]
        current_branch_pr: Option<u64>,
        pulls: Vec<GitHubPullSummary>,
    },
    NoRemote {
        remotes: Vec<GitHubRepoRef>,
    },
    Unauthorized {
        repo: GitHubRepoRef,
        remotes: Vec<GitHubRepoRef>,
        auth: GitHubAuthStatus,
        message: String,
    },
    Error {
        #[schemars(with = "RequiredNullable<GitHubRepoRef>")]
        repo: Option<GitHubRepoRef>,
        remotes: Vec<GitHubRepoRef>,
        auth: GitHubAuthStatus,
        message: String,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubPullDetailRead")]
pub struct GitHubPullDetailRead {
    pub session_id: String,
    #[serde(default)]
    pub repo: Option<GitHubRepoRef>,
    pub number: u64,
    #[serde(default)]
    pub include_patch: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentGitHubPullFileStatus")]
pub enum GitHubPullFileStatus {
    Added,
    Modified,
    Removed,
    Renamed,
    Copied,
    Changed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubPullFile")]
pub struct GitHubPullFile {
    pub path: String,
    #[schemars(with = "RequiredNullable<String>")]
    pub previous_path: Option<String>,
    pub status: GitHubPullFileStatus,
    pub additions: u64,
    pub deletions: u64,
    pub digest: String,
    pub has_patch: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
#[schemars(rename = "AgentGitHubDiffSide")]
pub enum GitHubDiffSide {
    Left,
    Right,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubReviewComment")]
pub struct GitHubReviewComment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub html_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubReviewThread")]
pub struct GitHubReviewThread {
    pub id: u64,
    pub path: String,
    pub side: GitHubDiffSide,
    #[schemars(with = "RequiredNullable<u32>")]
    pub line: Option<u32>,
    #[schemars(with = "RequiredNullable<u32>")]
    pub start_line: Option<u32>,
    pub outdated: bool,
    pub diff_hunk: String,
    pub comments: Vec<GitHubReviewComment>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubReviewSummary")]
pub struct GitHubReviewSummary {
    pub id: u64,
    pub author: String,
    pub state: String,
    pub body: String,
    pub submitted_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubPullDetail")]
pub struct GitHubPullDetail {
    pub repo: GitHubRepoRef,
    pub auth: GitHubAuthStatus,
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub draft: bool,
    pub merged: bool,
    pub author: String,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: String,
    pub base_sha: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub html_url: String,
    pub files: Vec<GitHubPullFile>,
    pub threads: Vec<GitHubReviewThread>,
    pub reviews: Vec<GitHubReviewSummary>,
    pub issue_comments: Vec<GitHubReviewComment>,
    #[schemars(with = "RequiredNullable<GitWorkspaceDiff>")]
    pub patch: Option<GitWorkspaceDiff>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentGitHubPullDetailResult")]
pub enum GitHubPullDetailResult {
    Ready {
        detail: GitHubPullDetail,
    },
    Unauthorized {
        repo: GitHubRepoRef,
        auth: GitHubAuthStatus,
        message: String,
    },
    NotFound {
        repo: GitHubRepoRef,
        auth: GitHubAuthStatus,
        number: u64,
    },
    Error {
        #[schemars(with = "RequiredNullable<GitHubRepoRef>")]
        repo: Option<GitHubRepoRef>,
        auth: GitHubAuthStatus,
        message: String,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubPullFileDiffRead")]
pub struct GitHubPullFileDiffRead {
    pub session_id: String,
    #[serde(default)]
    pub repo: Option<GitHubRepoRef>,
    pub number: u64,
    pub path: String,
    #[serde(default)]
    pub base_sha: Option<String>,
    #[serde(default)]
    pub head_sha: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentGitHubPullFileDiff")]
pub enum GitHubPullFileDiff {
    Full {
        patch: String,
        before: String,
        after: String,
        digest: String,
    },
    PatchOnly {
        patch: String,
        digest: String,
    },
    Binary,
    Large,
    NotFound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentGitHubReviewEvent")]
pub enum GitHubReviewEvent {
    Comment,
    Approve,
    RequestChanges,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubDraftReviewComment")]
pub struct GitHubDraftReviewComment {
    pub path: String,
    pub side: GitHubDiffSide,
    pub line: u32,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub start_side: Option<GitHubDiffSide>,
    pub body: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubSubmitReviewInput")]
pub struct GitHubSubmitReviewInput {
    pub session_id: String,
    #[serde(default)]
    pub repo: Option<GitHubRepoRef>,
    pub number: u64,
    pub expected_head_sha: String,
    pub event: GitHubReviewEvent,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub comments: Vec<GitHubDraftReviewComment>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentGitHubSubmitReviewResult")]
pub enum GitHubSubmitReviewResult {
    Submitted {
        review_id: u64,
        state: String,
        html_url: String,
    },
    StaleHead {
        actual_head_sha: String,
    },
    Unauthorized {
        message: String,
    },
    Rejected {
        message: String,
    },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubReplyCommentInput")]
pub struct GitHubReplyCommentInput {
    pub session_id: String,
    #[serde(default)]
    pub repo: Option<GitHubRepoRef>,
    pub number: u64,
    pub comment_id: u64,
    pub body: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubIssueCommentInput")]
pub struct GitHubIssueCommentInput {
    pub session_id: String,
    #[serde(default)]
    pub repo: Option<GitHubRepoRef>,
    pub number: u64,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentGitHubReplyCommentResult")]
pub enum GitHubReplyCommentResult {
    Replied { comment: GitHubReviewComment },
    Unauthorized { message: String },
    Rejected { message: String },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitHubTokenKey")]
pub struct GitHubTokenKey {
    pub host: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentGitHubTokenResult")]
pub enum GitHubTokenResult {
    Updated { auth: GitHubAuthStatus },
    InvalidToken,
}
