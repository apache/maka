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

//! Read-only Git comparisons within the Session's original workspace.
use crate::directory::Observation;
pub use crate::path::WorkspacePath;
use crate::worktree::Binding;
use gix::bstr::ByteSlice;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

mod diff;
pub(crate) mod image;
mod repository;
mod revisions;
mod scan;
#[cfg(test)]
mod tests;

pub use revisions::parse_remote_repo;

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum GitArea {
    Staged,
    Worktree,
    Untracked,
}
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeKind {
    Added,
    Modified,
    Deleted,
    TypeChanged,
    Conflicted,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitStatusEntry {
    pub area: GitArea,
    pub path: WorkspacePath,
    pub kind: GitChangeKind,
    pub digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitStatus {
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub head: Option<String>,
    pub entries: Vec<GitStatusEntry>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GitDiff {
    Text {
        patch: String,
        before: String,
        after: String,
        digest: String,
    },
    Binary,
    Unchanged,
    Unsupported,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitWorkspaceDiff {
    pub patch: String,
    pub truncated: bool,
    pub skipped_files: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitBranchEntry")]
pub struct GitBranchEntry {
    pub name: String,
    pub oid: String,
    pub remote: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitCommitSummary")]
pub struct GitCommitSummary {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author: String,
    pub timestamp: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitRemoteRepo")]
pub struct GitRemoteRepo {
    pub remote: String,
    pub host: String,
    pub owner: String,
    pub repo: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitWorktreeEntry")]
pub struct GitWorktreeEntry {
    pub path: String,
    pub name: String,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub branch: Option<String>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub head_oid: Option<String>,
    pub is_current: bool,
    pub is_main: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitRevisions")]
pub struct GitRevisions {
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub head_branch: Option<String>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub head_oid: Option<String>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub default_base: Option<String>,
    pub branches: Vec<GitBranchEntry>,
    pub commits: Vec<GitCommitSummary>,
    pub remotes: Vec<GitRemoteRepo>,
    pub worktrees: Vec<GitWorktreeEntry>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentGitCompareSpec")]
pub enum GitCompareSpec {
    Branch { base: String },
    Commit { oid: String },
    Range { base: String, head: String },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitCompareEntry")]
pub struct GitCompareEntry {
    pub path: WorkspacePath,
    pub kind: GitChangeKind,
    pub digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentGitCompare")]
pub struct GitCompare {
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub base_oid: Option<String>,
    pub head_oid: String,
    pub entries: Vec<GitCompareEntry>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<GitWorkspaceDiff>")]
    pub patch: Option<GitWorkspaceDiff>,
}

/// Blocking work: the caller retains its resource ticket and joins on cancellation.
pub fn status(
    workspace: &Path,
    identity: &Observation,
    private_root: &Path,
    binding: Option<&Binding>,
    cancel: Arc<AtomicBool>,
) -> io::Result<Option<GitStatus>> {
    expose((|| {
        let Some(repo) =
            repository::Repository::open(workspace, identity, private_root, binding, cancel)?
        else {
            return Ok(None);
        };
        let result = repo.status()?;
        repo.finish()?;
        Ok(Some(result))
    })())
}
pub fn diff(
    workspace: &Path,
    identity: &Observation,
    private_root: &Path,
    binding: Option<&Binding>,
    area: GitArea,
    path: &WorkspacePath,
    cancel: Arc<AtomicBool>,
) -> io::Result<Option<GitDiff>> {
    expose((|| {
        let bytes = path.bytes().map_err(|_| failure("git_invalid_path"))?;
        let Some(repo) =
            repository::Repository::open(workspace, identity, private_root, binding, cancel)?
        else {
            return Ok(None);
        };
        let result = diff::read(&repo, area, &bytes)?;
        repo.finish()?;
        Ok(Some(result))
    })())
}
pub fn workspace_diff(
    workspace: &Path,
    identity: &Observation,
    private_root: &Path,
    binding: Option<&Binding>,
    area: Option<GitArea>,
    cancel: Arc<AtomicBool>,
) -> io::Result<Option<GitWorkspaceDiff>> {
    const MAX_PATCH_BYTES: usize = 2 * 1024 * 1024;
    expose((|| {
        let Some(repo) =
            repository::Repository::open(workspace, identity, private_root, binding, cancel)?
        else {
            return Ok(None);
        };
        let status = repo.status()?;
        let mut combined = String::new();
        let mut truncated = false;
        let mut skipped_files = 0_u64;
        let mut multi_area = std::collections::HashSet::new();
        let mut seen = std::collections::HashSet::new();
        if area.is_none() {
            let mut first_seen = std::collections::HashSet::new();
            for entry in &status.entries {
                if !first_seen.insert(entry.path.bytes_base64.as_str()) {
                    multi_area.insert(entry.path.bytes_base64.clone());
                }
            }
        }
        for entry in status.entries {
            interrupted(&repo.cancel)?;
            if area.is_some_and(|wanted| wanted != entry.area) {
                continue;
            }
            let combine_head_to_worktree =
                area.is_none() && multi_area.contains(&entry.path.bytes_base64);
            if area.is_none() && !seen.insert(entry.path.bytes_base64.clone()) {
                continue;
            }
            if truncated {
                skipped_files += 1;
                continue;
            }
            let bytes = entry
                .path
                .bytes()
                .map_err(|_| failure("git_invalid_path"))?;
            match diff::read_patch_from_status(&repo, entry.area, &bytes, combine_head_to_worktree)?
            {
                diff::PatchDiff::Text(patch) => {
                    if combined.len() + patch.len() > MAX_PATCH_BYTES {
                        truncated = true;
                        skipped_files += 1;
                    } else {
                        combined.push_str(&patch);
                    }
                }
                diff::PatchDiff::Binary | diff::PatchDiff::Unsupported => {
                    skipped_files += 1;
                }
                diff::PatchDiff::Unchanged => {}
            }
        }
        repo.finish()?;
        Ok(Some(GitWorkspaceDiff {
            patch: combined,
            truncated,
            skipped_files,
        }))
    })())
}
pub fn revisions(
    workspace: &Path,
    identity: &Observation,
    private_root: &Path,
    binding: Option<&Binding>,
    cancel: Arc<AtomicBool>,
) -> io::Result<Option<GitRevisions>> {
    expose((|| {
        let Some(repo) =
            repository::Repository::open(workspace, identity, private_root, binding, cancel)?
        else {
            return Ok(None);
        };
        let result = revisions::read_revisions(&repo)?;
        repo.finish()?;
        Ok(Some(result))
    })())
}
pub fn compare(
    workspace: &Path,
    identity: &Observation,
    private_root: &Path,
    binding: Option<&Binding>,
    spec: &GitCompareSpec,
    include_patch: bool,
    cancel: Arc<AtomicBool>,
) -> io::Result<Option<GitCompare>> {
    expose((|| {
        let Some(repo) =
            repository::Repository::open(workspace, identity, private_root, binding, cancel)?
        else {
            return Ok(None);
        };
        let result = revisions::compare(&repo, spec, include_patch)?;
        repo.finish()?;
        Ok(Some(result))
    })())
}
pub fn compare_diff(
    workspace: &Path,
    identity: &Observation,
    private_root: &Path,
    binding: Option<&Binding>,
    spec: &GitCompareSpec,
    path: &WorkspacePath,
    cancel: Arc<AtomicBool>,
) -> io::Result<Option<GitDiff>> {
    expose((|| {
        let bytes = path.bytes().map_err(|_| failure("git_invalid_path"))?;
        let Some(repo) =
            repository::Repository::open(workspace, identity, private_root, binding, cancel)?
        else {
            return Ok(None);
        };
        let result = revisions::compare_diff(&repo, spec, &bytes)?;
        repo.finish()?;
        Ok(Some(result))
    })())
}
#[allow(clippy::too_many_arguments)]
pub fn merge_base_file_diff(
    workspace: &Path,
    identity: &Observation,
    private_root: &Path,
    binding: Option<&Binding>,
    base_oid: &str,
    head_oid: &str,
    path: &WorkspacePath,
    previous_path: Option<&WorkspacePath>,
    cancel: Arc<AtomicBool>,
) -> io::Result<Option<GitDiff>> {
    expose((|| {
        let bytes = path.bytes().map_err(|_| failure("git_invalid_path"))?;
        let prev_bytes = previous_path
            .map(|p| p.bytes().map_err(|_| failure("git_invalid_path")))
            .transpose()?;
        let Some(repo) =
            repository::Repository::open(workspace, identity, private_root, binding, cancel)?
        else {
            return Ok(None);
        };
        let result = revisions::merge_base_file_diff(
            &repo,
            base_oid,
            head_oid,
            &bytes,
            prev_bytes.as_deref(),
        )?;
        repo.finish()?;
        Ok(Some(result))
    })())
}

pub fn same_repository(first: &Path, second: &Path) -> bool {
    revisions::same_common_git_dir(first, second)
}

#[derive(Debug)]
struct Failure(&'static str);
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Failure {}
fn failure(code: &'static str) -> io::Error {
    io::Error::other(Failure(code))
}
fn expose<T>(result: io::Result<T>) -> io::Result<T> {
    result.map_err(|e| {
        if e.get_ref().is_some_and(|v| v.is::<Failure>()) {
            e
        } else {
            failure("git_unavailable")
        }
    })
}
fn interrupted(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(failure("git_cancelled"))
    } else {
        Ok(())
    }
}
