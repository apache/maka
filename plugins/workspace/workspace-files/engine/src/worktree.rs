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

//! Host-owned linked worktrees. Call synchronous operations on a blocking worker.
//! A binding must be durably recorded for its owning Session before materialization.
mod checkout;
mod ownership;
mod patch;
mod removal;

use crate::workspace::{git, invalid};
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

/// Immutable allocation intent, not the current child branch or HEAD.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    id: String,
    common_dir: PathBuf,
    source: PathBuf,
    #[schemars(with = "String", regex(pattern = "^sha256:[a-f0-9]{64}$"))]
    source_identity: maka_sandbox::workspace::DirectoryIdentity,
    base_commit: String,
    directory: PathBuf,
}

impl Binding {
    pub fn directory(&self) -> &Path {
        &self.directory
    }
    pub fn source(&self) -> &Path {
        &self.source
    }
    pub fn source_identity(&self) -> &maka_sandbox::workspace::DirectoryIdentity {
        &self.source_identity
    }
    pub fn base_commit(&self) -> &str {
        &self.base_commit
    }
    fn branch(&self) -> String {
        format!("refs/heads/maka/{}", self.id)
    }
    fn base_ref(&self) -> String {
        format!("refs/maka/worktrees/{}", self.id)
    }
    pub(crate) fn common_directory(&self) -> &Path {
        &self.common_dir
    }
    pub(crate) fn admin(&self) -> PathBuf {
        self.common_dir
            .join("worktrees")
            .join(format!("maka-{}", self.id))
    }
}

/// Root must be Host-private. Allocation IDs include Host and Session identity.
pub struct Worktrees {
    root: PathBuf,
}

impl Worktrees {
    pub fn open(root: &Path) -> io::Result<Self> {
        std::fs::create_dir_all(root)?;
        Ok(Self {
            root: dunce::canonicalize(root)?,
        })
    }

    /// No Git or workspace writes. Uncommitted source edits are never silently omitted.
    pub fn plan(&self, source: &Path, id: &str, cancel: Arc<AtomicBool>) -> io::Result<Binding> {
        valid_id(id)?;
        interrupted(&cancel)?;
        let (source, source_identity) = crate::directory::capture(source)?;
        let repo = git::discover(&source)?;
        if repo
            .workdir()
            .map(dunce::canonicalize)
            .transpose()?
            .as_ref()
            != Some(&source)
        {
            return Err(invalid(
                "isolated execution requires the repository worktree root",
            ));
        }
        checkout::supported(&repo)?;
        let base = repo.head_id().map_err(io::Error::other)?.detach();
        let base_commit = base.to_string();
        let status = repo
            .status(gix::progress::Discard)
            .map_err(io::Error::other)?
            .untracked_files(gix::status::UntrackedFiles::Files)
            .should_interrupt_owned(cancel.clone())
            .into_iter(std::iter::empty())
            .map_err(io::Error::other)?;
        for change in status {
            let change = change.map_err(io::Error::other)?;
            // The native directory owner creates this identity before task
            // routing. It is metadata, not uncommitted source to omit.
            if let gix::status::Item::IndexWorktree(
                gix::status::index_worktree::Item::DirectoryContents { entry, .. },
            ) = &change
                && entry.status == gix::dir::entry::Status::Untracked
                && entry.rela_path.as_slice() == crate::workspace::MARKER_FILE.as_bytes()
                && crate::workspace::read_identity(&source).is_ok()
            {
                continue;
            }
            return Err(invalid(
                "isolated execution requires a clean source worktree",
            ));
        }
        interrupted(&cancel)?;
        if repo.head_id().map_err(io::Error::other)? != base {
            return Err(invalid("source HEAD changed during worktree planning"));
        }
        Ok(Binding {
            id: id.into(),
            source,
            source_identity,
            base_commit,
            common_dir: dunce::canonicalize(repo.common_dir())?,
            directory: self.root.join(id).join("worktree"),
        })
    }

    /// Reopening a published worktree never resets its branch, index or files.
    pub fn ensure(&self, binding: &Binding, cancel: &AtomicBool) -> io::Result<()> {
        self.validate(binding)?;
        interrupted(cancel)?;
        let _owner = ownership::lock(&self.root, binding)?;
        removal::require_live(binding)?;
        if binding.directory.try_exists()? {
            return self.inspect(binding);
        }
        checkout::materialize(binding, cancel)?;
        self.inspect(binding)
    }

    pub fn inspect(&self, binding: &Binding) -> io::Result<()> {
        self.validate(binding)?;
        ownership::verify(&self.root.join(&binding.id), binding)?;
        removal::require_live(binding)?;
        ownership::verify(&binding.admin(), binding)?;
        let repo = git::discover(&binding.directory)?;
        if repo
            .workdir()
            .map(dunce::canonicalize)
            .transpose()?
            .as_ref()
            != Some(&binding.directory)
            || dunce::canonicalize(repo.git_dir())? != binding.admin()
            || dunce::canonicalize(repo.common_dir())? != binding.common_dir
        {
            return Err(invalid("owned worktree location changed"));
        }
        let base = repo
            .find_reference(&binding.base_ref())
            .map_err(io::Error::other)?
            .peel_to_id()
            .map_err(io::Error::other)?
            .to_string();
        if base != binding.base_commit {
            return Err(invalid("owned worktree base reference changed"));
        }
        Ok(())
    }

    /// Caller must settle all workspace writers first. Never modifies the real index.
    pub fn capture_patch(&self, binding: &Binding, cancel: Arc<AtomicBool>) -> io::Result<Vec<u8>> {
        self.inspect(binding)?;
        let _owner = ownership::lock(&self.root, binding)?;
        let patch = patch::capture(binding, cancel)?;
        self.inspect(binding)?;
        Ok(patch)
    }

    fn validate(&self, binding: &Binding) -> io::Result<()> {
        valid_id(&binding.id)?;
        if binding.directory != self.root.join(&binding.id).join("worktree")
            || dunce::canonicalize(&binding.common_dir)? != binding.common_dir
            || gix::hash::ObjectId::from_hex(binding.base_commit.as_bytes()).is_err()
        {
            return Err(invalid("invalid owned worktree binding"));
        }
        Ok(())
    }
}

fn valid_id(id: &str) -> io::Result<()> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid(
            "worktree identity must be a 64-character lowercase hex digest",
        ));
    }
    Ok(())
}
fn interrupted(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "worktree operation cancelled",
        ))
    } else {
        Ok(())
    }
}
