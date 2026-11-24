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

use super::{Error, Result, interrupted, local_git};
use crate::directory;
use gix::{hash::ObjectId, index::entry::Mode};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Snapshot {
    source: PathBuf,
    staged: String,
    working: String,
}

impl Snapshot {
    pub(super) fn source(&self) -> &Path {
        &self.source
    }

    pub(super) fn capture(
        repo: &gix::Repository,
        source: &Path,
        identity: &directory::Observation,
        private_root: &Path,
        cancel: &AtomicBool,
        required_base: Option<(&[u8], ObjectId)>,
    ) -> Result<Self> {
        interrupted(cancel)?;
        let head = (
            repo.head_name().map_err(io::Error::other)?,
            repo.head_id().map_err(io::Error::other)?.detach(),
        );
        if let Some((reference, commit)) = required_base
            && (head
                .0
                .as_ref()
                .is_none_or(|name| name.as_bstr() != reference)
                || head.1 != commit)
        {
            return Err(Error::SnapshotUnavailable);
        }
        let real_index = repo.index_path();
        let original = fs::read(&real_index)?;
        let scratch = tempfile::tempdir_in(private_root)?;
        let index = scratch.path().join("index");
        fs::write(&index, &original)?;
        let git_index = dunce::simplified(&index);
        let mut git = local_git::command(repo)?;
        git.env("GIT_INDEX_FILE", git_index).arg("write-tree");
        let staged = tree_id(&mut git)?;
        interrupted(cancel)?;
        let output = local_git::run(
            local_git::command(repo)?
                .env("GIT_INDEX_FILE", git_index)
                .args(["add", "--all", "--", "."]),
        )?;
        if !output.status.success() {
            return Err(Error::SnapshotCommand(local_git::git_error(&output)));
        }
        let working = tree_id(&mut git)?;
        interrupted(cancel)?;
        directory::open(source, identity)?;
        if head
            != (
                repo.head_name().map_err(io::Error::other)?,
                repo.head_id().map_err(io::Error::other)?.detach(),
            )
            || original != fs::read(real_index)?
        {
            return Err(Error::SnapshotUnavailable);
        }
        for tree in [&staged, &working] {
            if repo
                .index_from_tree(tree)
                .map_err(io::Error::other)?
                .entries()
                .iter()
                .any(|entry| entry.mode == Mode::COMMIT)
            {
                return Err(Error::Unsupported);
            }
        }
        Ok(Self {
            source: source.to_owned(),
            staged: staged.to_string(),
            working: working.to_string(),
        })
    }

    pub(super) fn resume(
        &self,
        repo: &gix::Repository,
        path: &Path,
        identity: &directory::Observation,
        private_root: &Path,
        cancel: &AtomicBool,
        owns_registration: bool,
    ) -> Result<bool> {
        let current = Self::capture(repo, path, identity, private_root, cancel, None)?;
        if current.working != self.working {
            return Ok(false);
        }
        if current.staged == self.staged {
            return Ok(true);
        }
        // The first read-tree wrote the working snapshot as both the files and the index.
        if !owns_registration || current.staged != self.working {
            return Ok(false);
        }
        interrupted(cancel)?;
        directory::open(path, identity)?;
        self.restore_index(repo)?;
        Ok(true)
    }

    pub(super) fn checkout(&self, repo: &gix::Repository) -> Result<()> {
        local_git::checked(local_git::command(repo)?.args([
            "read-tree",
            "-m",
            "-u",
            &self.working,
        ]))?;
        self.restore_index(repo)
    }

    fn restore_index(&self, repo: &gix::Repository) -> Result<()> {
        // Restore staging without changing the files just checked out.
        local_git::checked(local_git::command(repo)?.args(["read-tree", &self.staged]))
    }
}

fn tree_id(command: &mut std::process::Command) -> Result<ObjectId> {
    let output = local_git::run(command)?;
    if !output.status.success() {
        return Err(Error::SnapshotCommand(local_git::git_error(&output)));
    }
    ObjectId::from_hex(output.stdout.trim_ascii()).map_err(|_| Error::SnapshotUnavailable)
}
