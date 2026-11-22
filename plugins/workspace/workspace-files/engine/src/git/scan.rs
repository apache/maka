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

use super::repository::{Repository, guard_metadata, optional, read_file};
use super::*;
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use gix::ignore::{Search, glob::pattern::Case};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

/// Only the metadata actually consumed by status, never all sibling worktrees.
pub(super) fn metadata(
    git: &Path,
    common: &Path,
    private: &Path,
    admin: Option<&Path>,
    cancel: &AtomicBool,
) -> io::Result<()> {
    let mut roots = vec![git];
    if common != git {
        roots.push(common);
    }
    for root in roots {
        for name in [
            "HEAD",
            "index",
            "config",
            "config.worktree",
            "commondir",
            "packed-refs",
            "refs",
            "objects",
            "info",
        ] {
            metadata_entry(&root.join(name), private, admin, cancel, name == "objects")?;
        }
        // gix expands split-index links through these immutable sibling files.
        for entry in fs::read_dir(root)? {
            interrupted(cancel)?;
            let entry = entry?;
            if entry
                .file_name()
                .as_encoded_bytes()
                .get(..12)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"sharedindex."))
            {
                metadata_entry(&entry.path(), private, admin, cancel, false)?;
            }
        }
    }
    Ok(())
}
fn metadata_entry(
    path: &Path,
    private: &Path,
    admin: Option<&Path>,
    cancel: &AtomicBool,
    object_store: bool,
) -> io::Result<()> {
    interrupted(cancel)?;
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() || (!meta.is_dir() && !meta.is_file()) {
        return Err(failure("git_unsupported"));
    }
    guard_metadata(path, private, admin)?;
    if meta.is_dir() {
        for child in fs::read_dir(path)? {
            metadata_entry(&child?.path(), private, admin, cancel, object_store)?;
        }
    } else if object_store
        && path.file_name().is_some_and(|name| name == "alternates")
        && !read_file(path)?.is_empty()
    {
        return Err(failure("git_unsupported"));
    }
    Ok(())
}

pub(super) fn workspace(repo: &Repository) -> io::Result<()> {
    let mut ignores = Search::default();
    let exclude = repo.repo.common_dir().join("info/exclude");
    if let Some(bytes) = optional(&exclude)? {
        ignores
            .add_patterns_buffer(&bytes, &exclude, None, Default::default())
            .map_err(io::Error::other)?;
    }
    let fs = repo.repo.filesystem_options().map_err(io::Error::other)?;
    let pattern_root = if fs.precompose_unicode {
        gix::utils::str::precompose_path(repo.root.as_path().into()).into_owned()
    } else {
        repo.root.clone()
    };
    let mut walker = Walker {
        repo,
        ignores,
        lookup: repo.index.prepare_icase_backing(),
        precompose_unicode: fs.precompose_unicode,
        pattern_root,
        case: if fs.ignore_case {
            Case::Fold
        } else {
            Case::Sensitive
        },
    };
    walker.visit(&repo.directory, Path::new(""), false)
}
struct Walker<'a> {
    repo: &'a Repository,
    ignores: Search,
    lookup: gix::index::AccelerateLookup<'a>,
    precompose_unicode: bool,
    pattern_root: PathBuf,
    case: Case,
}
impl Walker<'_> {
    fn visit(
        &mut self,
        directory: &Dir,
        relative: &Path,
        inherited_ignored: bool,
    ) -> io::Result<()> {
        interrupted(&self.repo.cancel)?;
        self.repo.check(&self.repo.root.join(relative))?;
        let previous = self.ignores.patterns.len();
        if let Some(bytes) = self.control(directory, relative, ".gitignore")? {
            self.ignores
                .add_patterns_buffer(
                    &bytes,
                    self.pattern_root
                        .join(
                            gix::path::from_bstr(self.lookup_path(relative)?.as_bstr())
                                .map_err(io::Error::other)?
                                .as_ref(),
                        )
                        .join(".gitignore"),
                    Some(&self.pattern_root),
                    Default::default(),
                )
                .map_err(io::Error::other)?;
        }
        self.control(directory, relative, ".gitattributes")?;
        for child in directory.entries()? {
            interrupted(&self.repo.cancel)?;
            let child = child?;
            let name = child.file_name();
            if name.as_encoded_bytes().eq_ignore_ascii_case(b".git") {
                continue;
            }
            let relative_child = relative.join(&name);
            let kind = child.file_type()?;
            let name_bytes = self.lookup_path(&relative_child)?;
            let ignored = inherited_ignored
                || self
                    .ignores
                    .pattern_matching_relative_path(
                        name_bytes.as_bstr(),
                        Some(kind.is_dir()),
                        self.case,
                    )
                    .is_some_and(|m| !m.pattern.is_negative());
            if kind.is_dir() {
                if ignored
                    && self
                        .repo
                        .index
                        .entry_closest_to_directory_or_directory_icase(
                            name_bytes.as_bstr(),
                            self.case == Case::Fold,
                            &self.lookup,
                        )
                        .is_none()
                {
                    continue;
                }
                if directory
                    .symlink_metadata(Path::new(&name).join(".git"))
                    .is_ok()
                {
                    return Err(failure("git_unsupported"));
                }
                self.repo.check(&self.repo.root.join(&relative_child))?;
                self.visit(
                    &directory.open_dir_nofollow(&name)?,
                    &relative_child,
                    ignored,
                )?;
            } else if kind.is_file()
                && (!ignored
                    || self
                        .repo
                        .index
                        .entry_by_path_icase(
                            name_bytes.as_bstr(),
                            self.case == Case::Fold,
                            &self.lookup,
                        )
                        .is_some())
            {
                self.repo.check(&self.repo.root.join(&relative_child))?;
            }
        }
        self.ignores.patterns.truncate(previous);
        Ok(())
    }
    fn lookup_path(&self, path: &Path) -> io::Result<gix::bstr::BString> {
        let bytes = gix::path::to_unix_separators_on_windows(
            gix::path::into_bstr(path).map_err(|_| failure("git_unsupported"))?,
        );
        Ok(if self.precompose_unicode {
            gix::utils::str::precompose_bstr(bytes)
        } else {
            bytes
        }
        .into_owned())
    }
    fn control(&self, directory: &Dir, relative: &Path, name: &str) -> io::Result<Option<Vec<u8>>> {
        let bytes = match directory.symlink_metadata(name) {
            Ok(meta) => {
                if !meta.is_file() || meta.file_type().is_symlink() {
                    return Err(failure("git_unsupported"));
                }
                self.repo.check(&self.repo.root.join(relative).join(name))?;
                let mut bytes = Vec::new();
                directory
                    .open_with(name, crate::workspace::options().read(true))?
                    .read_to_end(&mut bytes)?;
                bytes
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let path = self.lookup_path(&relative.join(name))?;
                // Tracked comparisons prime attributes using their original index path.
                // Ignore rules apply to the actual dirwalk path; widening that lookup
                // could prune a directory that gix will still visit.
                let entry = if name == ".gitattributes" {
                    self.repo.index.entry_by_path_icase(
                        path.as_bstr(),
                        self.case == Case::Fold,
                        &self.lookup,
                    )
                } else {
                    self.repo.index.entry_by_path(path.as_bstr())
                };
                let Some(entry) = entry else {
                    return Ok(None);
                };
                if entry.mode != gix::index::entry::Mode::FILE
                    && entry.mode != gix::index::entry::Mode::FILE_EXECUTABLE
                {
                    return Err(failure("git_unsupported"));
                }
                self.repo
                    .repo
                    .find_object(entry.id)
                    .map_err(io::Error::other)?
                    .data
                    .to_vec()
            }
            Err(e) => return Err(e),
        };
        Ok(Some(bytes))
    }
}
