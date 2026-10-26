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

use super::{MARKER_FILE, Workspace, identity, invalid, options};
use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use std::{
    io::{self, Read, Write},
    path::Path,
};

pub(crate) fn has_entry(path: &Path) -> io::Result<bool> {
    Ok(repository_directory(path)?.is_some())
}

/// Resolve metadata for ordinary repositories and linked worktrees without
/// executing Git or consulting global configuration. Call on a blocking worker.
pub fn metadata(path: &Path) -> io::Result<Vec<std::path::PathBuf>> {
    let Some(directory) = repository_directory(path)? else {
        return Ok(Vec::new());
    };
    let entry = directory.join(".git");
    // An empty metadata directory carries no Git indirection. It can be an
    // uninitialized repository or a live native sandbox's mount target. Protect
    // it as-is; do not reject unrelated operations or discover an enclosing repo.
    if entry.symlink_metadata()?.is_dir()
        && std::fs::read_dir(&entry)?.next().transpose()?.is_none()
    {
        return Ok(vec![dunce::canonicalize(entry)?]);
    }
    let repository = discover(directory)?;
    let mut paths = vec![
        dunce::canonicalize(directory.join(".git"))?,
        dunce::canonicalize(repository.git_dir())?,
        dunce::canonicalize(repository.common_dir())?,
    ];
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn repository_directory(path: &Path) -> io::Result<Option<&Path>> {
    for ancestor in path.ancestors() {
        match ancestor.join(".git").symlink_metadata() {
            Ok(_) => return Ok(Some(ancestor)),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

pub(super) fn exclude_marker(
    workspace: &Workspace,
    private: &Path,
    control: &Path,
    binding: Option<&crate::worktree::Binding>,
) -> io::Result<()> {
    let Some(directory) = repository_directory(&workspace.path)? else {
        return Ok(());
    };
    // Open the nearest entry itself: gix must not substitute another repository.
    let entry = directory.join(".git");
    let repository = match gix::open::Options::isolated()
        .strict_config(true)
        .open(&entry)
    {
        Ok(repository) => repository.to_thread_local(),
        Err(error) => {
            if let Some(source) = error.downcast_any_ref::<io::Error>() {
                if matches!(
                    source.kind(),
                    io::ErrorKind::NotFound
                        | io::ErrorKind::NotADirectory
                        | io::ErrorKind::InvalidData
                ) {
                    return Ok(());
                }
                return Err(match source.raw_os_error() {
                    Some(code) => io::Error::from_raw_os_error(code),
                    None => io::Error::new(source.kind(), source.to_string()),
                });
            }
            match error.dominant_class() {
                Some(
                    gix::error::Class::NotFound
                    | gix::error::Class::Corruption
                    | gix::error::Class::Validation,
                ) => return Ok(()),
                _ => return Err(io::Error::other(error)),
            }
        }
    };
    let git = dunce::canonicalize(repository.git_dir())?;
    let common = dunce::canonicalize(repository.common_dir())?;
    let admin = binding
        .map(crate::worktree::Binding::admin)
        .map(dunce::canonicalize)
        .transpose()?;
    for path in [&git, &common] {
        if path.starts_with(control)
            || (path.starts_with(private)
                && !admin.as_ref().is_some_and(|admin| path.starts_with(admin)))
        {
            return Err(invalid("Git marker exclusion targets private Host state"));
        }
    }
    if let Some(binding) = binding
        && (Some(&git) != admin.as_ref()
            || common != dunce::canonicalize(binding.common_directory())?)
    {
        return Err(invalid("workspace Git binding changed"));
    }
    let directory = Dir::open_ambient_dir(&common, ambient_authority())?;
    validate_anchor(&common, &directory)?;
    workspace.validate_directory()?;
    match directory.create_dir("info") {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let info = directory.open_dir_nofollow("info")?;
    let info_path = common.join("info");
    validate_anchor(&info_path, &info)?;
    workspace.validate_directory()?;
    let mut file = info.open_with("exclude", options().read(true).append(true).create(true))?;
    let (found, bytes, last) = scan_exclusion(&info, &mut file)?;
    validate_anchor(&common, &directory)?;
    validate_anchor(&info_path, &info)?;
    workspace.validate_directory()?;
    if !found {
        let addition = format!(
            "{}{MARKER_FILE}\n",
            if bytes != 0 && last != Some(b'\n') {
                "\n"
            } else {
                ""
            }
        );
        file.write_all(addition.as_bytes())?;
        file.sync_all()?;
    }
    validate_anchor(&common, &directory)?;
    validate_anchor(&info_path, &info)
}

fn validate_anchor(path: &Path, directory: &Dir) -> io::Result<()> {
    let visible = Dir::open_ambient_dir(path, ambient_authority())?;
    if dunce::canonicalize(path)? != path
        || identity(&visible.dir_metadata()?) != identity(&directory.dir_metadata()?)
    {
        return Err(invalid("Git metadata directory changed"));
    }
    Ok(())
}

fn scan_exclusion(
    directory: &Dir,
    file: &mut cap_std::fs::File,
) -> io::Result<(bool, u64, Option<u8>)> {
    let before = file.metadata()?;
    let named = directory.symlink_metadata("exclude")?;
    if !before.is_file() || !named.is_file() || identity(&before) != identity(&named) {
        return Err(invalid("Git exclude must be a regular file"));
    }
    let marker = MARKER_FILE.as_bytes();
    let mut buffer = [0; 8192];
    let (mut found, mut total, mut last, mut position, mut matches) =
        (false, 0_u64, None, 0_usize, true);
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        for &byte in &buffer[..read] {
            last = Some(byte);
            if byte == b'\n' {
                found |= matches && (position == marker.len() || position == marker.len() + 1);
                position = 0;
                matches = true;
            } else {
                matches &= if position < marker.len() {
                    byte == marker[position]
                } else {
                    position == marker.len() && byte == b'\r'
                };
                position = position.saturating_add(1).min(marker.len() + 2);
            }
        }
    }
    found |= matches && (position == marker.len() || position == marker.len() + 1);
    let after = file.metadata()?;
    let named = directory.symlink_metadata("exclude")?;
    if total != before.len()
        || after.len() != before.len()
        || before.modified()? != after.modified()?
        || !named.is_file()
        || identity(&before) != identity(&named)
    {
        return Err(invalid("Git exclude changed while reading"));
    }
    Ok((found, total, last))
}

/// Repository-local metadata only: no Git executable, ambient discovery overrides,
/// global configuration or config includes. Handles remain on the blocking worker.
pub(crate) fn discover(path: &Path) -> io::Result<gix::Repository> {
    // Open the nearest entry explicitly: invalid nested metadata must not make
    // discovery silently select a different enclosing repository.
    let directory =
        repository_directory(path)?.ok_or_else(|| invalid("workspace has no Git repository"))?;
    gix::open::Options::isolated()
        .strict_config(true)
        .open(directory)
        .map(|repository| repository.to_thread_local())
        .map_err(|error| invalid(&format!("workspace Git discovery failed: {error}")))
}
