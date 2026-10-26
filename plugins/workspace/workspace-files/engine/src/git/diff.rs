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
use super::{image::Image, repository::Repository};
use cap_fs_ext::DirExt;
use gix::index::entry::Mode;
use std::io::Read;

pub(super) fn read(repo: &Repository, area: GitArea, name: &[u8]) -> io::Result<GitDiff> {
    let Some((before, after)) = images(repo, area, name)? else {
        return Ok(GitDiff::Unsupported);
    };
    if before.as_ref().map(|i| (i.mode, &i.bytes)) == after.as_ref().map(|i| (i.mode, &i.bytes)) {
        return Ok(GitDiff::Unchanged);
    }
    if before
        .iter()
        .chain(after.iter())
        .any(|image| image.bytes.contains(&0) || std::str::from_utf8(&image.bytes).is_err())
    {
        return Ok(GitDiff::Binary);
    }
    interrupted(&repo.cancel)?;
    let mut patch = Vec::new();
    image::append(
        &mut patch,
        name,
        before.as_ref(),
        after.as_ref(),
        repo.repo.object_hash(),
    )?;
    interrupted(&repo.cancel)?;
    Ok(GitDiff::Text {
        patch: String::from_utf8(patch).map_err(|_| failure("git_unsupported"))?,
    })
}
fn images(
    repo: &Repository,
    area: GitArea,
    name: &[u8],
) -> io::Result<Option<(Option<Image>, Option<Image>)>> {
    if repo
        .index
        .entries()
        .iter()
        .any(|e| e.path(&repo.index) == name.as_bstr() && e.stage_raw() != 0)
    {
        return Ok(None);
    }
    let indexed = repo.index.entry_by_path(name.as_bstr());
    let index_image = || {
        indexed
            .filter(|e| !e.flags.contains(gix::index::entry::Flags::INTENT_TO_ADD))
            .map(|entry| object(repo, entry.id, entry.mode.bits()))
            .transpose()
    };
    match area {
        GitArea::Staged => {
            let before = if repo.head.is_some() {
                let tree = repo.repo.find_tree(repo.tree).map_err(io::Error::other)?;
                tree.lookup_entry(name.split(|b| *b == b'/').map(|p| p.to_vec()))
                    .map_err(io::Error::other)?
                    .map(|entry| object(repo, entry.object_id(), u32::from(entry.mode().value())))
                    .transpose()?
            } else {
                None
            };
            Ok(Some((before, index_image()?)))
        }
        GitArea::Worktree => {
            if indexed.is_none() {
                return Ok(Some((None, None)));
            }
            Ok(Some((
                index_image()?,
                working(repo, name, indexed.map(|e| e.mode))?,
            )))
        }
        GitArea::Untracked => {
            if indexed.is_some() || !untracked(repo, name)? {
                return Ok(Some((None, None)));
            }
            Ok(Some((None, working(repo, name, None)?)))
        }
    }
}
fn untracked(repo: &Repository, name: &[u8]) -> io::Result<bool> {
    let pattern = [b":(literal)".as_slice(), name].concat();
    let changes = repo
        .repo
        .status(gix::progress::Discard)
        .map_err(io::Error::other)?
        .index(gix::worktree::IndexPersistedOrInMemory::Persisted(
            repo.index.clone(),
        ))
        .head_tree(repo.tree)
        .untracked_files(gix::status::UntrackedFiles::Files)
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Disabled)
        .index_worktree_rewrites(None)
        .index_worktree_submodules(None)
        .should_interrupt_owned(repo.cancel.clone())
        .into_iter([pattern.into()])
        .map_err(io::Error::other)?;
    for item in changes {
        interrupted(&repo.cancel)?;
        if let gix::status::Item::IndexWorktree(
            gix::status::index_worktree::Item::DirectoryContents { entry, .. },
        ) = item.map_err(io::Error::other)?
            && entry.status == gix::dir::entry::Status::Untracked
            && entry.rela_path.as_slice() == name
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn object(repo: &Repository, id: gix::hash::ObjectId, mode: u32) -> io::Result<Image> {
    interrupted(&repo.cancel)?;
    let object = repo.repo.find_blob(id).map_err(io::Error::other)?;
    Ok(Image {
        mode,
        bytes: object.data.to_vec(),
    })
}
fn working(repo: &Repository, name: &[u8], indexed: Option<Mode>) -> io::Result<Option<Image>> {
    interrupted(&repo.cancel)?;
    let relative = gix::path::from_bstr(name.as_bstr()).map_err(io::Error::other)?;
    let mut parent = repo.directory.try_clone()?;
    let components: Vec<_> = relative.components().collect();
    for part in &components[..components.len() - 1] {
        let meta = match parent.symlink_metadata(part.as_os_str()) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Ok(None);
        }
        parent = parent.open_dir_nofollow(part.as_os_str())?;
    }
    let leaf = components
        .last()
        .ok_or_else(|| failure("git_invalid_path"))?
        .as_os_str();
    let meta = match parent.symlink_metadata(leaf) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() {
        let bytes = gix::path::into_bstr(parent.read_link_contents(leaf)?)
            .map_err(io::Error::other)?
            .to_vec();
        return Ok(Some(Image {
            mode: Mode::SYMLINK.bits(),
            bytes,
        }));
    }
    if meta.is_dir() {
        return Ok(None);
    }
    if !meta.is_file() {
        return Err(failure("git_unsupported"));
    }
    repo.check(&repo.root.join(relative.as_ref()))?;
    let mut file = parent.open_with(leaf, crate::workspace::options().read(true))?;
    let mut bytes = Vec::new();
    let symlink_file = indexed == Some(Mode::SYMLINK)
        && repo.repo.config_snapshot().boolean("core.symlinks") == Some(false);
    if symlink_file {
        file.read_to_end(&mut bytes)?;
    } else {
        let (mut pipeline, _) = repo.repo.filter_pipeline(None).map_err(io::Error::other)?;
        pipeline
            .convert_to_git(file, &relative, &repo.index)
            .map_err(io::Error::other)?
            .read_to_end(&mut bytes)?;
    }
    let mut mode = if symlink_file {
        Mode::SYMLINK
    } else {
        Mode::FILE
    };
    if !symlink_file {
        let executable;
        #[cfg(unix)]
        {
            use cap_fs_ext::OsMetadataExt;
            executable = if repo.repo.config_snapshot().boolean("core.filemode") == Some(false) {
                indexed == Some(Mode::FILE_EXECUTABLE)
            } else {
                meta.mode() & 0o111 != 0
            };
        }
        #[cfg(not(unix))]
        {
            executable = indexed == Some(Mode::FILE_EXECUTABLE);
        }
        if executable {
            mode = Mode::FILE_EXECUTABLE;
        }
    }
    Ok(Some(Image {
        mode: mode.bits(),
        bytes,
    }))
}
