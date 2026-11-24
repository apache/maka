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

//! User-created linked checkouts, independent of temporary agent worktrees.

mod local_git;
mod snapshot;

use super::{interrupted, ownership, valid_id};
use crate::{directory, git::revisions, workspace::git};
use gix::refs::{
    FullName,
    transaction::{LogChange, PreviousValue, RefEdit},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use snapshot::Snapshot;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

#[derive(Debug)]
pub enum Error {
    InvalidName,
    InvalidBranch,
    BaseUnavailable,
    BranchConflict,
    DirectoryConflict,
    SnapshotUnavailable,
    SnapshotCommand(io::Error),
    GitRequired,
    Unavailable,
    Unsupported,
    Io(io::Error),
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

type Result<T> = std::result::Result<T, Error>;
const OPERATIONS_DIR: &str = "project-worktree-operations";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Repository {
    pub root: PathBuf,
    pub common_dir: PathBuf,
    identity: directory::Observation,
}

pub struct Branches {
    pub head: Option<String>,
    pub default_base: Option<String>,
    pub entries: Vec<crate::git::GitBranchEntry>,
}

/// The operation's validated destination and pinned base, persisted before Git writes.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Allocation {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub base_ref: String,
    pub directory: PathBuf,
    repository: Repository,
    base_commit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snapshot: Option<Snapshot>,
}

pub enum Base<'a> {
    Commit(String),
    LocalFiles {
        reference: String,
        source: &'a Path,
        identity: &'a directory::Observation,
        private_root: &'a Path,
        cancel: &'a AtomicBool,
    },
}

pub use local_git::BranchError;

impl Repository {
    pub fn discover(source: &Path) -> Result<Option<Self>> {
        if !git::has_repository(source)? {
            return Ok(None);
        }
        let repo = git::discover(source)?;
        if repo
            .workdir()
            .map(dunce::canonicalize)
            .transpose()?
            .as_deref()
            != Some(source)
        {
            return Ok(None);
        }
        let (common_dir, identity) = directory::capture(repo.common_dir())?;
        let common_dir = dunce::simplified(&common_dir).to_owned();
        let main = repo.main_repo().map_err(io::Error::other)?;
        let root = main
            .workdir()
            .map(dunce::canonicalize)
            .transpose()?
            .ok_or(Error::Unsupported)?;
        let root = dunce::simplified(&root).to_owned();
        let result = Self {
            root,
            common_dir,
            identity,
        };
        result.open()?;
        Ok(Some(result))
    }

    fn open(&self) -> Result<gix::Repository> {
        directory::open(&self.common_dir, &self.identity)?;
        let repo = gix::open::Options::isolated()
            .strict_config(true)
            .config_overrides([
                "committer.name=Maka",
                "committer.email=host@maka.invalid",
                "core.logAllRefUpdates=true",
                "core.filesRefLockTimeout=100",
                "core.packedRefsTimeout=100",
            ])
            .open(&self.root)
            .map_err(io::Error::other)?
            .to_thread_local();
        if dunce::canonicalize(repo.common_dir())? != self.common_dir
            || dunce::canonicalize(repo.git_dir())? != self.common_dir
            || repo
                .workdir()
                .map(dunce::canonicalize)
                .transpose()?
                .as_ref()
                != Some(&self.root)
        {
            return Err(Error::Unavailable);
        }
        Ok(repo)
    }

    pub fn branches(&self, source: &Path, cancel: &AtomicBool) -> Result<Branches> {
        let repo = git::discover(source)?;
        if dunce::canonicalize(repo.common_dir())? != self.common_dir {
            return Err(Error::Unavailable);
        }
        let head = revisions::head_branch(&repo)?;
        let entries = revisions::read_branches(&repo, cancel)?;
        let default_base = repo
            .try_find_reference("refs/remotes/origin/HEAD")
            .map_err(io::Error::other)?
            .and_then(|reference| {
                reference.target().try_name().and_then(|target| {
                    let full = std::str::from_utf8(target.as_bstr()).ok()?;
                    let short = full.strip_prefix("refs/remotes/")?;
                    entries
                        .iter()
                        .any(|entry| entry.remote && entry.name == short)
                        .then(|| full.to_owned())
                })
            });
        Ok(Branches {
            head,
            default_base,
            entries,
        })
    }

    pub fn destination_parent(&self) -> Result<&Path> {
        self.root.parent().ok_or(Error::Unavailable)
    }

    fn destination(&self, name: &str) -> Result<PathBuf> {
        let stem = self
            .root
            .file_name()
            .and_then(|part| part.to_str())
            .ok_or(Error::Unavailable)?;
        Ok(self
            .destination_parent()?
            .join(format!("{stem}-worktrees"))
            .join(name))
    }

    pub fn plan(
        &self,
        id: String,
        name: String,
        branch: String,
        base: Base<'_>,
    ) -> Result<Allocation> {
        valid_id(&id)?;
        valid_name(&name)?;
        let branch_ref = branch_ref(&branch)?;
        let base_ref = match &base {
            Base::Commit(reference) | Base::LocalFiles { reference, .. } => reference,
        };
        if !(base_ref.starts_with("refs/heads/") || base_ref.starts_with("refs/remotes/"))
            || FullName::try_from(base_ref.as_str()).is_err()
        {
            return Err(Error::BaseUnavailable);
        }
        let repo = self.open()?;
        supported_configuration(&repo)?;
        let mut reference = repo
            .try_find_reference(base_ref.as_str())
            .map_err(io::Error::other)?
            .ok_or(Error::BaseUnavailable)?;
        let commit = reference
            .peel_to_commit()
            .map_err(|_| Error::BaseUnavailable)?;
        let tree = commit.tree_id().map_err(io::Error::other)?;
        let index = repo.index_from_tree(&tree).map_err(io::Error::other)?;
        if index
            .entries()
            .iter()
            .any(|entry| entry.mode == gix::index::entry::Mode::COMMIT)
        {
            return Err(Error::Unsupported);
        }
        let directory = self.destination(&name)?;
        if destination_occupied(&directory)? {
            return Err(Error::DirectoryConflict);
        }
        if branch_occupied(&repo, &branch_ref)? {
            return Err(Error::BranchConflict);
        }
        let snapshot = match &base {
            Base::Commit(_) => None,
            Base::LocalFiles {
                source,
                identity,
                private_root,
                cancel,
                ..
            } => {
                let source_repo = self.open_source(source, identity)?;
                Some(Snapshot::capture(
                    &source_repo,
                    source,
                    identity,
                    private_root,
                    cancel,
                    Some((base_ref.as_bytes(), commit.id)),
                )?)
            }
        };
        Ok(Allocation {
            id,
            name,
            branch,
            base_ref: base_ref.clone(),
            directory,
            repository: self.clone(),
            base_commit: commit.id.to_string(),
            snapshot,
        })
    }

    fn open_source(
        &self,
        source: &Path,
        identity: &directory::Observation,
    ) -> Result<gix::Repository> {
        directory::open(source, identity)?;
        directory::open(&self.common_dir, &self.identity)?;
        let repo = git::discover(source)?;
        if dunce::canonicalize(repo.common_dir())? != self.common_dir
            || repo
                .workdir()
                .map(dunce::canonicalize)
                .transpose()?
                .as_deref()
                != Some(source)
            || (source != self.root
                && !dunce::canonicalize(repo.git_dir())?
                    .starts_with(self.common_dir.join("worktrees")))
        {
            return Err(Error::Unavailable);
        }
        supported_configuration(&repo)?;
        Ok(repo)
    }
}

impl Allocation {
    pub fn matches(
        &self,
        repo: &Repository,
        name: &str,
        branch: &str,
        base_ref: &str,
        snapshot_source: Option<&Path>,
    ) -> bool {
        &self.repository == repo
            && self.name == name
            && self.branch == branch
            && self.base_ref == base_ref
            && self.snapshot.as_ref().map(Snapshot::source) == snapshot_source
    }

    /// Publish only a completed checkout with reciprocal Git registration and the
    /// original directory identity. For a published result, always read live HEAD.
    pub fn inspect(&self, private_root: &Path) -> Result<Option<Option<String>>> {
        let local = private_root.join(OPERATIONS_DIR).join(&self.id);
        if !exists(&local.join("ready"))? {
            return Ok(None);
        }
        let directory = load::<directory::Observation>(&local.join("directory.json"))?
            .ok_or(Error::Unavailable)?;
        let admin = load::<PathBuf>(&local.join("git.json"))?.ok_or(Error::Unavailable)?;
        let (repo, _) = self.open_registration(&directory, Some(&admin))?;
        Ok(Some(revisions::head_branch(&repo)?))
    }

    pub fn ensure(
        &self,
        private_root: &Path,
        parent: &directory::Observation,
        cancel: Arc<AtomicBool>,
    ) -> Result<Option<String>> {
        valid_id(&self.id)?;
        interrupted(&cancel)?;
        directory::open(self.repository.destination_parent()?, parent)?;
        let local = private_root.join(OPERATIONS_DIR).join(&self.id);
        fs::create_dir_all(&local)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(local.join("lock"))?;
        lock.try_lock().map_err(io::Error::from)?;

        if let Some(branch) = self.inspect(private_root)? {
            return Ok(branch);
        }

        let repo = self.repository.open()?;
        supported_configuration(&repo)?;
        let branch_ref = branch_ref(&self.branch)?;
        let commit =
            gix::hash::ObjectId::from_hex(self.base_commit.as_bytes()).map_err(io::Error::other)?;

        let reserved = local.join("directory.json");
        let directory = if let Some(observation) = load::<directory::Observation>(&reserved)? {
            directory::open(&self.directory, &observation).map_err(|_| Error::DirectoryConflict)?;
            observation
        } else {
            // Check both collisions before reserving a directory. The create-new
            // filesystem and reference operations below also guard the races.
            if destination_occupied(&self.directory)? {
                return Err(Error::DirectoryConflict);
            }
            if branch_occupied(&repo, &branch_ref)?
                && !self.owns_branch(&repo, &branch_ref, commit)?
            {
                return Err(Error::BranchConflict);
            }
            self.reserve_destination(parent)?;
            let (_, observation) = directory::capture(&self.directory)?;
            save(&reserved, &observation)?;
            observation
        };

        let pending = local.join("git.json");
        let mut recorded = load::<PathBuf>(&pending)?;
        let claim = self.reflog_message();
        if !exists(&self.directory.join(".git"))? {
            if let Some(admin) = recorded.take() {
                if exists(&admin)? {
                    return Err(Error::Unavailable);
                }
                fs::remove_file(&pending)?;
            }
            if fs::read_dir(&self.directory)?.next().transpose()?.is_some() {
                return Err(Error::DirectoryConflict);
            }
            match self
                .repository
                .common_dir
                .join("worktrees")
                .symlink_metadata()
            {
                Ok(entry) if !entry.file_type().is_dir() => {
                    return Err(Error::Unavailable);
                }
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.into()),
                _ => {}
            }
            let mut git = local_git::command(&repo)?;
            if let Err(error) = self.ensure_branch(&repo, branch_ref.clone(), commit) {
                if matches!(error, Error::BranchConflict) && fs::remove_dir(&self.directory).is_ok()
                {
                    fs::remove_file(&reserved)?;
                }
                return Err(error);
            }
            interrupted(&cancel)?;
            directory::open(&self.directory, &directory)?;
            let output = local_git::run(
                git.args([
                    "worktree",
                    "add",
                    "--no-checkout",
                    "--no-guess-remote",
                    "--lock",
                    "--reason",
                    &claim,
                    "--",
                ])
                .arg(&self.directory)
                .arg(&self.branch),
            )?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(
                    if stderr.contains("already checked out")
                        || stderr.contains("already used by worktree")
                    {
                        Error::BranchConflict
                    } else if stderr.contains("already exists")
                        || stderr.contains("already registered")
                    {
                        Error::DirectoryConflict
                    } else {
                        local_git::git_error(&output).into()
                    },
                );
            }
        }
        let (checkout, admin) = self.open_registration(&directory, recorded.as_deref())?;
        if revisions::head_branch(&checkout)?.as_deref() != Some(&self.branch)
            || checkout.head_id().map_err(io::Error::other)?.detach() != commit
        {
            return Err(Error::BranchConflict);
        }
        // The Git lock bridges a crash between registration and recording its admin path.
        let locked = match fs::read(admin.join("locked")) {
            Ok(contents) => contents.trim_ascii_end() == claim.as_bytes(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if recorded.is_none() {
            if !locked {
                return Err(Error::Unavailable);
            }
            save(&pending, &admin)?;
        }
        if checkout.index_path().is_file() {
            // An interrupted send may reuse a completed checkout. Leave any
            // unexpected edits or incomplete staging for the user to inspect.
            let unchanged = match &self.snapshot {
                Some(snapshot) => snapshot.matches(
                    &checkout,
                    &self.directory,
                    &directory,
                    private_root,
                    &cancel,
                )?,
                None => crate::git::status(
                    &self.directory,
                    &directory,
                    private_root,
                    None,
                    cancel.clone(),
                )?
                .is_some_and(|status| status.entries.is_empty()),
            };
            if !unchanged {
                return Err(Error::Unavailable);
            }
        } else {
            if !locked || !self.owns_branch(&repo, &branch_ref, commit)? {
                return Err(Error::Unavailable);
            }
            for entry in fs::read_dir(&self.directory)? {
                if entry?.file_name() != ".git" {
                    return Err(Error::Unavailable);
                }
            }
            interrupted(&cancel)?;
            directory::open(&self.directory, &directory)?;
            match &self.snapshot {
                Some(snapshot) => snapshot.checkout(&checkout)?,
                // Unlike a hard reset, read-tree never advances the attached branch.
                None => local_git::checked(local_git::command(&checkout)?.args([
                    "read-tree",
                    "-m",
                    "-u",
                    &self.base_commit,
                ]))?,
            }
        }
        interrupted(&cancel)?;
        let (observed, _) = self.open_registration(&directory, Some(&admin))?;
        let branch = revisions::head_branch(&observed)?;
        if branch.as_deref() != Some(&self.branch)
            || observed.head_id().map_err(io::Error::other)?.detach() != commit
        {
            return Err(Error::BranchConflict);
        }
        if locked {
            local_git::checked(
                local_git::command(&repo)?
                    .args(["worktree", "unlock", "--"])
                    .arg(&self.directory),
            )?;
        }
        save(&local.join("ready"), &())?;
        Ok(branch)
    }

    fn reserve_destination(&self, observed: &directory::Observation) -> Result<()> {
        let parent = self.repository.destination_parent()?;
        let bucket = self.directory.parent().ok_or(Error::Unavailable)?;
        let parent = directory::open(parent, observed)?;
        let bucket_name = bucket.file_name().ok_or(Error::InvalidName)?;
        match parent.create_dir(bucket_name) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        if !parent.symlink_metadata(bucket_name)?.is_dir() || dunce::canonicalize(bucket)? != bucket
        {
            return Err(Error::DirectoryConflict);
        }
        parent
            .open_dir(bucket_name)?
            .create_dir(&self.name)
            .map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    Error::DirectoryConflict
                } else {
                    error.into()
                }
            })?;
        if dunce::canonicalize(&self.directory)? != self.directory {
            return Err(Error::DirectoryConflict);
        }
        Ok(())
    }

    fn open_registration(
        &self,
        directory: &directory::Observation,
        expected_admin: Option<&Path>,
    ) -> Result<(gix::Repository, PathBuf)> {
        if !fs::symlink_metadata(&self.directory).is_ok_and(|entry| entry.file_type().is_dir())
            || !fs::symlink_metadata(self.directory.join(".git"))
                .is_ok_and(|entry| entry.file_type().is_file())
        {
            return Err(Error::Unavailable);
        }
        directory::open(&self.directory, directory)?;
        directory::open(&self.repository.common_dir, &self.repository.identity)?;
        let repo = git::discover(&self.directory)?;
        let admin = dunce::canonicalize(repo.git_dir())?;
        if expected_admin.is_some_and(|expected| expected != admin)
            || dunce::canonicalize(repo.common_dir())? != self.repository.common_dir
            || !admin.starts_with(self.repository.common_dir.join("worktrees"))
            || repo
                .workdir()
                .map(dunce::canonicalize)
                .transpose()?
                .as_ref()
                != Some(&self.directory)
        {
            return Err(Error::Unavailable);
        }
        let backlink = fs::read_to_string(admin.join("gitdir"))?;
        let backlink = backlink.trim_end_matches(['\r', '\n']);
        if dunce::canonicalize(admin.join(backlink))? != self.directory.join(".git") {
            return Err(Error::Unavailable);
        }
        Ok((repo, admin))
    }

    fn ensure_branch(
        &self,
        repo: &gix::Repository,
        name: FullName,
        commit: gix::hash::ObjectId,
    ) -> Result<()> {
        if branch_occupied(repo, &name)? {
            return if self.owns_branch(repo, &name, commit)? {
                Ok(())
            } else {
                Err(Error::BranchConflict)
            };
        }
        let edit = RefEdit::update_with_log(
            name.clone(),
            commit,
            PreviousValue::MustNotExist,
            LogChange {
                message: self.reflog_message().into(),
                force_create_reflog: true,
                ..Default::default()
            },
        );
        match repo.edit_reference(edit) {
            Ok(edits) if edits[0].change.previous_value().is_none() => Ok(()),
            Ok(_) => Err(Error::BranchConflict),
            Err(_) if self.owns_branch(repo, &name, commit)? => Ok(()),
            Err(_) if branch_occupied(repo, &name)? => Err(Error::BranchConflict),
            Err(error) => Err(io::Error::other(error).into()),
        }
    }

    fn reflog_message(&self) -> String {
        format!("Maka worktree {}", self.id)
    }

    fn owns_branch(
        &self,
        repo: &gix::Repository,
        name: &FullName,
        commit: gix::hash::ObjectId,
    ) -> Result<bool> {
        // An unrelated branch at the same commit has no creation entry
        // from this operation's reference transaction.
        let Some(branch) = repo
            .try_find_reference(name.as_ref())
            .map_err(io::Error::other)?
        else {
            return Ok(false);
        };
        if branch.try_id().is_none_or(|id| id.detach() != commit) {
            return Ok(false);
        }
        let mut log = branch.log_iter();
        let last = log
            .rev()?
            .and_then(|mut entries| entries.next())
            .transpose()
            .map_err(io::Error::other)?;
        Ok(last.is_some_and(|entry| entry.message.as_slice() == self.reflog_message().as_bytes()))
    }
}

fn supported_configuration(repo: &gix::Repository) -> Result<()> {
    let config = repo.config_snapshot();
    if config.boolean("core.sparseCheckout") == Some(true)
        || config.boolean("worktree.useRelativePaths") == Some(true)
        || config.plumbing().sections_by_name("filter").is_some()
    {
        return Err(Error::Unsupported);
    }
    Ok(())
}

fn branch_ref(branch: &str) -> Result<FullName> {
    if branch.is_empty()
        || branch.len() > 240
        || branch.starts_with('-')
        || matches!(branch, "HEAD" | "@")
    {
        return Err(Error::InvalidBranch);
    }
    format!("refs/heads/{branch}")
        .try_into()
        .map_err(|_| Error::InvalidBranch)
}

fn branch_occupied(repo: &gix::Repository, name: &FullName) -> Result<bool> {
    let full = name.as_bstr();
    let short = full.strip_prefix(b"refs/heads/").expect("local branch");
    for (offset, byte) in short.iter().enumerate() {
        if *byte == b'/'
            && repo
                .try_find_reference(&full[..b"refs/heads/".len() + offset])
                .map_err(io::Error::other)?
                .is_some()
        {
            return Ok(true);
        }
    }
    if repo
        .try_find_reference(name.as_ref())
        .map_err(io::Error::other)?
        .is_some()
    {
        return Ok(true);
    }
    let prefix = format!("{full}/");
    let refs = repo.references().map_err(io::Error::other)?;
    let mut nested = refs.prefixed(prefix.as_str()).map_err(io::Error::other)?;
    Ok(nested
        .next()
        .transpose()
        .map_err(io::Error::other)?
        .is_some())
}

fn valid_name(name: &str) -> Result<()> {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|digit| {
                matches!(
                    digit,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    if name.is_empty()
        || name.len() > 120
        || name.trim() != name
        || name.starts_with('.')
        || name.ends_with('.')
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || name.chars().any(char::is_control)
        || reserved
    {
        return Err(Error::InvalidName);
    }
    Ok(())
}

fn exists(path: &Path) -> io::Result<bool> {
    match path.symlink_metadata() {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn destination_occupied(path: &Path) -> io::Result<bool> {
    let bucket = path.parent().expect("worktree destination has a parent");
    match bucket.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_dir() => exists(path),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn load<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(io::Error::from),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn save(path: &Path, value: &impl Serialize) -> io::Result<()> {
    ownership::write_new(path, &serde_json::to_vec(value)?)?;
    ownership::sync(path.parent().expect("operation directory"))
}

#[cfg(test)]
mod tests;
