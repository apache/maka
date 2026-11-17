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
mod scan;
#[cfg(test)]
mod tests;

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
        for entry in status.entries {
            interrupted(&repo.cancel)?;
            if area.is_some_and(|wanted| wanted != entry.area) {
                continue;
            }
            let bytes = entry
                .path
                .bytes()
                .map_err(|_| failure("git_invalid_path"))?;
            match diff::read(&repo, entry.area, &bytes)? {
                GitDiff::Text { patch, .. } => {
                    if combined.len() + patch.len() > MAX_PATCH_BYTES {
                        truncated = true;
                        skipped_files += 1;
                    } else {
                        combined.push_str(&patch);
                    }
                }
                GitDiff::Binary | GitDiff::Unsupported => {
                    skipped_files += 1;
                }
                GitDiff::Unchanged => {}
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
