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

use super::*;
use cap_std::{ambient_authority, fs::Dir};
use gix::index::entry::Mode;
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub(super) struct Repository {
    pub root: PathBuf,
    pub directory: Dir,
    pub repo: gix::Repository,
    pub index: gix::worktree::Index,
    pub head: Option<String>,
    pub tree: gix::hash::ObjectId,
    pub cancel: Arc<AtomicBool>,
    identity: DirectoryIdentity,
    private_root: PathBuf,
    index_before: Option<Vec<u8>>,
}
impl Repository {
    pub fn open(
        workspace: &Path,
        identity: &DirectoryIdentity,
        private_root: &Path,
        binding: Option<&Binding>,
        cancel: Arc<AtomicBool>,
    ) -> io::Result<Option<Self>> {
        interrupted(&cancel)?;
        let directory = crate::directory::open(workspace, identity)?;
        let root = dunce::canonicalize(workspace)?;
        let private_root = dunce::canonicalize(private_root)?;
        if binding.is_some_and(|b| b.directory() != root) {
            return Err(failure("git_unsupported"));
        }
        if private_root.starts_with(&root) {
            return Err(failure("git_private"));
        }
        if root.starts_with(&private_root) && binding.is_none() {
            return Err(failure("git_private"));
        }
        let entry = root.join(".git");
        let metadata = match fs::symlink_metadata(&entry) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                for ancestor in root.ancestors().skip(1) {
                    if ancestor.join(".git").symlink_metadata().is_ok() {
                        return Err(failure("git_unsupported"));
                    }
                }
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        if metadata.file_type().is_symlink() {
            return Err(failure("git_unsupported"));
        }
        let git_dir = if metadata.is_dir() {
            entry.clone()
        } else if metadata.is_file() {
            let bytes = read_file(&entry)?;
            let path = bytes
                .strip_prefix(b"gitdir: ")
                .ok_or_else(|| failure("git_unsupported"))?;
            let path = path.strip_suffix(b"\n").unwrap_or(path);
            let path = path.strip_suffix(b"\r").unwrap_or(path);
            root.join(
                gix::path::from_bstr(path.as_bstr())
                    .map_err(|_| failure("git_unsupported"))?
                    .as_ref(),
            )
        } else {
            return Err(failure("git_unsupported"));
        };
        let git_dir = dunce::canonicalize(git_dir)?;
        let private_admin = binding
            .map(Binding::admin)
            .map(dunce::canonicalize)
            .transpose()?;
        guard_metadata(&git_dir, &private_root, private_admin.as_deref())?;
        let common_dir = match optional(&git_dir.join("commondir"))? {
            Some(bytes) => {
                let path = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
                let path = path.strip_suffix(b"\r").unwrap_or(path);
                dunce::canonicalize(
                    git_dir.join(
                        gix::path::from_bstr(path.as_bstr())
                            .map_err(|_| failure("git_unsupported"))?
                            .as_ref(),
                    ),
                )?
            }
            None => git_dir.clone(),
        };
        guard_metadata(&common_dir, &private_root, private_admin.as_deref())?;
        if let Some(binding) = binding
            && (Some(&git_dir) != private_admin.as_ref()
                || dunce::canonicalize(binding.common_directory())? != common_dir)
        {
            return Err(failure("git_unsupported"));
        }
        scan::metadata(
            &git_dir,
            &common_dir,
            &private_root,
            private_admin.as_deref(),
            &cancel,
        )?;
        let repo = gix::open::Options::isolated()
            .strict_config(true)
            .filter_config_section(|_| false)
            .open(&root)
            .map_err(io::Error::other)?
            .to_thread_local();
        if repo
            .workdir()
            .map(dunce::canonicalize)
            .transpose()?
            .as_ref()
            != Some(&root)
            || dunce::canonicalize(repo.git_dir())? != git_dir
            || dunce::canonicalize(repo.common_dir())? != common_dir
        {
            return Err(failure("git_unsupported"));
        }
        let config = repo.config_snapshot();
        if config.plumbing().sections_by_name("filter").is_some()
            || config.string("core.attributesFile").is_some()
            || config.string("core.excludesFile").is_some()
            || config.boolean("core.sparseCheckout") == Some(true)
        {
            return Err(failure("git_unsupported"));
        }
        let index_before = optional(&repo.index_path())?;
        let index = repo.index_or_empty().map_err(io::Error::other)?;
        for entry in index.entries() {
            interrupted(&cancel)?;
            if entry.mode == Mode::COMMIT
                || entry.mode == Mode::DIR
                || entry
                    .flags
                    .contains(gix::index::entry::Flags::SKIP_WORKTREE)
            {
                return Err(failure("git_unsupported"));
            }
            WorkspacePath::from_bytes(entry.path(&index))?;
        }
        let head = repo
            .head()
            .map_err(io::Error::other)?
            .id()
            .map(|id| id.detach().to_string());
        let tree = repo
            .head_tree_id_or_empty()
            .map_err(io::Error::other)?
            .detach();
        let baseline = repo.index_from_tree(&tree).map_err(io::Error::other)?;
        if baseline
            .entries()
            .iter()
            .any(|e| e.mode == Mode::COMMIT || e.mode == Mode::DIR)
        {
            return Err(failure("git_unsupported"));
        }
        let result = Self {
            root,
            directory,
            repo,
            index,
            head,
            tree,
            cancel,
            identity: identity.clone(),
            private_root,
            index_before,
        };
        scan::workspace(&result)?;
        result.finish()?;
        Ok(Some(result))
    }
    pub fn check(&self, path: &Path) -> io::Result<()> {
        let resolved = dunce::canonicalize(path)?;
        if resolved.starts_with(&self.private_root) && !resolved.starts_with(&self.root) {
            return Err(failure("git_private"));
        }
        if !resolved.starts_with(&self.root) {
            return Err(failure("git_unsupported"));
        }
        Ok(())
    }
    pub fn finish(&self) -> io::Result<()> {
        interrupted(&self.cancel)?;
        crate::directory::open(&self.root, &self.identity)?;
        let head = self
            .repo
            .head()
            .map_err(io::Error::other)?
            .id()
            .map(|id| id.detach().to_string());
        if self.head != head || self.index_before != optional(&self.repo.index_path())? {
            return Err(failure("git_changed"));
        }
        Ok(())
    }
    pub fn status(&self) -> io::Result<GitStatus> {
        let conflicts: BTreeSet<Vec<u8>> = self
            .index
            .entries()
            .iter()
            .filter(|e| e.stage_raw() != 0)
            .map(|e| e.path(&self.index).to_vec())
            .collect();
        let changes = self
            .repo
            .status(gix::progress::Discard)
            .map_err(io::Error::other)?
            .index(gix::worktree::IndexPersistedOrInMemory::Persisted(
                self.index.clone(),
            ))
            .head_tree(self.tree)
            .untracked_files(gix::status::UntrackedFiles::Files)
            .tree_index_track_renames(gix::status::tree_index::TrackRenames::Disabled)
            .index_worktree_rewrites(None)
            .index_worktree_submodules(None)
            .should_interrupt_owned(self.cancel.clone())
            .into_iter(std::iter::empty())
            .map_err(io::Error::other)?;
        let mut entries = Vec::new();
        for item in changes {
            interrupted(&self.cancel)?;
            use gix::status::{Item, index_worktree::Item as Worktree};
            let (area, name, kind) = match item.map_err(io::Error::other)? {
                Item::TreeIndex(change) => {
                    use gix::diff::index::ChangeRef;
                    let kind = match &change {
                        ChangeRef::Addition { .. } => GitChangeKind::Added,
                        ChangeRef::Deletion { .. } => GitChangeKind::Deleted,
                        ChangeRef::Modification {
                            previous_entry_mode,
                            entry_mode,
                            ..
                        } if previous_entry_mode.bits() & 0o170000
                            != entry_mode.bits() & 0o170000 =>
                        {
                            GitChangeKind::TypeChanged
                        }
                        _ => GitChangeKind::Modified,
                    };
                    (GitArea::Staged, change.location().to_vec(), kind)
                }
                Item::IndexWorktree(Worktree::Modification {
                    rela_path, status, ..
                }) => {
                    use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
                    let kind = match status {
                        EntryStatus::Conflict { .. } => GitChangeKind::Conflicted,
                        EntryStatus::Change(Change::Removed) => GitChangeKind::Deleted,
                        EntryStatus::Change(Change::Type { .. }) => GitChangeKind::TypeChanged,
                        EntryStatus::Change(_) => GitChangeKind::Modified,
                        EntryStatus::IntentToAdd => GitChangeKind::Added,
                        EntryStatus::NeedsUpdate(_) => continue,
                    };
                    (GitArea::Worktree, rela_path.to_vec(), kind)
                }
                Item::IndexWorktree(Worktree::DirectoryContents { entry, .. })
                    if entry.status == gix::dir::entry::Status::Untracked =>
                {
                    if entry.disk_kind == Some(gix::dir::entry::Kind::Repository) {
                        return Err(failure("git_unsupported"));
                    }
                    (
                        GitArea::Untracked,
                        entry.rela_path.to_vec(),
                        GitChangeKind::Added,
                    )
                }
                _ => continue,
            };
            let kind = if conflicts.contains(&name) {
                GitChangeKind::Conflicted
            } else {
                kind
            };
            entries.push((area, name, kind));
        }
        entries.sort();
        entries.dedup();
        Ok(GitStatus {
            head: self.head.clone(),
            entries: entries
                .into_iter()
                .map(|(area, name, kind)| {
                    Ok(GitStatusEntry {
                        area,
                        path: WorkspacePath::from_bytes(&name)?,
                        kind,
                    })
                })
                .collect::<io::Result<_>>()?,
        })
    }
}

pub(super) fn guard_metadata(
    path: &Path,
    private_root: &Path,
    admin: Option<&Path>,
) -> io::Result<()> {
    let path = dunce::canonicalize(path)?;
    if path.starts_with(private_root) && !admin.is_some_and(|a| path.starts_with(a)) {
        return Err(failure("git_private"));
    }
    Ok(())
}
pub(super) fn optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => read_file(path).map(Some),
        Ok(_) => Err(failure("git_unsupported")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
pub(super) fn read_file(path: &Path) -> io::Result<Vec<u8>> {
    let parent = Dir::open_ambient_dir(
        path.parent().ok_or_else(|| failure("git_unsupported"))?,
        ambient_authority(),
    )?;
    let mut bytes = Vec::new();
    let mut file = parent.open_with(
        path.file_name().ok_or_else(|| failure("git_unsupported"))?,
        crate::workspace::options().read(true),
    )?;
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}
