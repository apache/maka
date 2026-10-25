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

use super::{Binding, checkout, interrupted};
use crate::workspace::{git, invalid};
use gix::{bstr::ByteSlice, index::entry::Mode};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read},
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

use crate::git::image::{self as format, Image};

pub(super) fn capture(binding: &Binding, cancel: Arc<AtomicBool>) -> io::Result<Vec<u8>> {
    let repo = git::discover(&binding.directory)?;
    checkout::supported(&repo)?;
    let base =
        gix::hash::ObjectId::from_hex(binding.base_commit.as_bytes()).map_err(io::Error::other)?;
    let tree = repo
        .find_object(base)
        .map_err(io::Error::other)?
        .peel_to_tree()
        .map_err(io::Error::other)?
        .id;
    let base_index = repo.index_from_tree(&tree).map_err(io::Error::other)?;
    let (mut filters, current) = repo.filter_pipeline(None).map_err(io::Error::other)?;
    let index_before = fs::read(repo.index_path())?;
    let head_before = repo.head_id().map_err(io::Error::other)?.detach();
    let mut old = BTreeMap::new();
    let mut present = BTreeSet::new();
    for entry in base_index.entries() {
        old.insert(entry.path(&base_index).to_vec(), entry);
    }
    for entry in current.entries() {
        if entry.stage_raw() != 0
            || entry.mode == Mode::COMMIT
            || entry
                .flags
                .contains(gix::index::entry::Flags::SKIP_WORKTREE)
        {
            return Err(invalid(
                "cannot capture conflicted, sparse or submodule index",
            ));
        }
        present.insert(entry.path(&current).to_vec());
    }
    let changes = repo
        .status(gix::progress::Discard)
        .map_err(io::Error::other)?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .should_interrupt_owned(cancel.clone())
        .into_iter(std::iter::empty())
        .map_err(io::Error::other)?;
    for item in changes {
        interrupted(&cancel)?;
        if let gix::status::Item::IndexWorktree(
            gix::status::index_worktree::Item::DirectoryContents { entry, .. },
        ) = item.map_err(io::Error::other)?
            && entry.status == gix::dir::entry::Status::Untracked
        {
            present.insert(entry.rela_path.to_vec());
        }
    }
    let paths: BTreeSet<_> = old.keys().chain(present.iter()).cloned().collect();
    let mut patch = Vec::new();
    for name in paths {
        interrupted(&cancel)?;
        let before = old
            .get(&name)
            .map(|entry| -> io::Result<_> {
                let object = repo.find_object(entry.id).map_err(io::Error::other)?;
                Ok(Image {
                    mode: entry.mode.bits(),
                    bytes: object.data.to_vec(),
                })
            })
            .transpose()?;
        let relative = gix::path::from_bstr(name.as_bstr()).map_err(io::Error::other)?;
        let after = if present.contains(&name) {
            let indexed = current.entry_by_path(name.as_bstr()).map(|e| e.mode);
            read_image(
                &repo,
                &binding.directory,
                &relative,
                indexed,
                &mut filters,
                &current,
            )?
        } else {
            None
        };
        format::append(
            &mut patch,
            &name,
            before.as_ref(),
            after.as_ref(),
            repo.object_hash(),
        )?;
    }
    interrupted(&cancel)?;
    if repo.head_id().map_err(io::Error::other)? != head_before
        || fs::read(repo.index_path())? != index_before
    {
        return Err(invalid(
            "worktree HEAD or index changed while capturing results",
        ));
    }
    Ok(patch)
}

fn read_image(
    repo: &gix::Repository,
    root: &Path,
    relative: &Path,
    indexed: Option<Mode>,
    filters: &mut gix::filter::Pipeline<'_>,
    index: &gix::index::State,
) -> io::Result<Option<Image>> {
    // Never follow an ancestor symlink, even if it points back inside the root.
    let mut parent = root.to_owned();
    for part in relative.parent().into_iter().flat_map(Path::components) {
        parent.push(part);
        match fs::symlink_metadata(&parent) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => return Ok(None), // tracked directory replaced by another entry
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        }
    }
    let path = root.join(relative);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() {
        return Ok(Some(Image {
            mode: Mode::SYMLINK.bits(),
            bytes: gix::path::into_bstr(fs::read_link(&path)?)
                .map_err(io::Error::other)?
                .to_vec(),
        }));
    }
    if meta.is_dir() {
        if indexed.is_some() {
            return Ok(None);
        }
        return Err(invalid(
            "nested repositories cannot be exported as a complete patch",
        ));
    }
    if !meta.is_file() {
        return Err(invalid("worktree contains a special file"));
    }
    let directory = cap_std::fs::Dir::open_ambient_dir(root, cap_std::ambient_authority())?;
    let mut file = directory.open_with(relative, crate::workspace::options().read(true))?;
    let mut bytes = Vec::new();
    let symlink_file = indexed == Some(Mode::SYMLINK)
        && repo.config_snapshot().boolean("core.symlinks") == Some(false);
    if symlink_file {
        file.read_to_end(&mut bytes)?;
    } else {
        filters
            .convert_to_git(file, relative, index)
            .map_err(io::Error::other)?
            .read_to_end(&mut bytes)?;
    }
    let mut mode = indexed.unwrap_or(Mode::FILE);
    if !symlink_file {
        mode = Mode::FILE;
    }
    #[cfg(unix)]
    if !symlink_file {
        use std::os::unix::fs::PermissionsExt;
        let executable = if repo.config_snapshot().boolean("core.filemode") == Some(false) {
            indexed == Some(Mode::FILE_EXECUTABLE)
        } else {
            meta.permissions().mode() & 0o111 != 0
        };
        if executable {
            mode = Mode::FILE_EXECUTABLE;
        }
    }
    #[cfg(windows)]
    if !symlink_file && indexed == Some(Mode::FILE_EXECUTABLE) {
        mode = Mode::FILE_EXECUTABLE;
    }
    Ok(Some(Image {
        mode: mode.bits(),
        bytes,
    }))
}
