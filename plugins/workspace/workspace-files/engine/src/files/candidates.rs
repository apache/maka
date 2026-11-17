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

//! Composer path candidates through the original workspace directory capability.
use super::*;
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::{io::Read, sync::Arc};

impl Directory {
    /// Browses direct entries for an empty query, otherwise searches descendant file paths.
    /// Neither operation reads candidate contents or follows directory links.
    pub fn candidates(
        &self,
        query: &str,
        cancel: &AtomicBool,
        mut emit: impl FnMut(FileEntry) -> io::Result<()>,
    ) -> io::Result<()> {
        expose(self.candidate_files(query, cancel, &mut emit))
    }

    fn candidate_files(
        &self,
        query: &str,
        cancel: &AtomicBool,
        emit: &mut impl FnMut(FileEntry) -> io::Result<()>,
    ) -> io::Result<()> {
        enum Work {
            Enter(Arc<Dir>, PathBuf),
            Child(Arc<Dir>, PathBuf, Vec<u8>, FileKind),
            Leave,
        }
        interrupted(cancel)?;
        self.validate_inner()?;
        let target = self.anchors.last().expect("target anchor");
        let mut pending = vec![Work::Enter(
            Arc::new(target.directory.try_clone()?),
            self.relative.clone(),
        )];
        let mut rules = Vec::new();
        for anchor in &self.anchors[..self.anchors.len() - 1] {
            let relative = anchor
                .path
                .strip_prefix(&self.anchors[0].path)
                .map_err(|_| error("files_changed"))?;
            rules.push(directory_rules(&anchor.directory, relative, cancel)?);
        }
        let query = query.trim().to_lowercase();
        while let Some(work) = pending.pop() {
            interrupted(cancel)?;
            match work {
                Work::Leave => {
                    rules.pop();
                }
                Work::Enter(directory, relative) => {
                    let entries = match directory.entries() {
                        Ok(entries) => entries,
                        Err(error) if disappeared(&error) => continue,
                        Err(error) => return Err(error),
                    };
                    rules.push(directory_rules(&directory, &relative, cancel)?);
                    pending.push(Work::Leave);
                    let absolute = self.anchors[0].path.join(&relative);
                    let mut children = Vec::new();
                    for entry in entries {
                        interrupted(cancel)?;
                        let entry = match entry {
                            Ok(entry) => entry,
                            Err(error) if disappeared(&error) => continue,
                            Err(error) => return Err(error),
                        };
                        let name = entry.file_name();
                        if self.excluded_child(&absolute, &name) {
                            continue;
                        }
                        let kind = match entry.file_type() {
                            Ok(kind) => kind,
                            Err(error) if disappeared(&error) => continue,
                            Err(error) => return Err(error),
                        };
                        let kind = if kind.is_dir() {
                            FileKind::Directory
                        } else if kind.is_file() {
                            FileKind::File
                        } else if kind.is_symlink() {
                            FileKind::Symlink
                        } else {
                            continue;
                        };
                        let path = relative.join(&name);
                        if excluded(&rules, &path, kind == FileKind::Directory) {
                            continue;
                        }
                        let bytes = gix::path::to_unix_separators_on_windows(
                            gix::path::into_bstr(path.clone())
                                .map_err(|_| error("files_unavailable"))?,
                        )
                        .into_owned();
                        children.push((bytes.to_vec(), path, kind));
                    }
                    children.sort_by(|left, right| left.0.cmp(&right.0));
                    for (bytes, path, kind) in children.into_iter().rev() {
                        pending.push(Work::Child(directory.clone(), path, bytes, kind));
                    }
                }
                Work::Child(directory, relative, _, FileKind::Directory) if !query.is_empty() => {
                    let name = relative.file_name().expect("directory entry name");
                    let child = match directory.open_dir_nofollow(name) {
                        Ok(child) => child,
                        Err(error) if disappeared(&error) => continue,
                        Err(error) => return Err(error),
                    };
                    pending.push(Work::Enter(Arc::new(child), relative));
                }
                Work::Child(_, _, bytes, kind) => {
                    // Display matching never becomes the identity of a non-UTF-8 path.
                    if !bytes.to_str_lossy().to_lowercase().contains(&query) {
                        continue;
                    }
                    let path = WorkspacePath::from_bytes(&bytes)
                        .map_err(|_| error("files_invalid_path"))?;
                    emit(FileEntry { path, kind })?;
                }
            }
        }
        interrupted(cancel)?;
        self.validate_inner()?;
        Ok(())
    }

    /// Visits regular UTF-8 files under the workspace while honoring ignore rules and capability boundaries.
    pub(crate) fn visit_text_files(
        &self,
        max_file_bytes: u64,
        max_files: usize,
        cancel: &AtomicBool,
        mut visit: impl FnMut(WorkspacePath, String, String) -> io::Result<bool>,
    ) -> io::Result<()> {
        enum Work {
            Enter(Arc<Dir>, PathBuf),
            Child(Arc<Dir>, PathBuf, Vec<u8>, FileKind),
            Leave,
        }
        interrupted(cancel)?;
        self.validate_inner()?;
        let target = self.anchors.last().expect("target anchor");
        let mut pending = vec![Work::Enter(
            Arc::new(target.directory.try_clone()?),
            self.relative.clone(),
        )];
        let mut rules = Vec::new();
        for anchor in &self.anchors[..self.anchors.len() - 1] {
            let relative = anchor
                .path
                .strip_prefix(&self.anchors[0].path)
                .map_err(|_| error("files_changed"))?;
            rules.push(directory_rules(&anchor.directory, relative, cancel)?);
        }
        let mut visited = 0_usize;
        while let Some(work) = pending.pop() {
            interrupted(cancel)?;
            if visited >= max_files {
                break;
            }
            match work {
                Work::Leave => {
                    rules.pop();
                }
                Work::Enter(directory, relative) => {
                    let entries = match directory.entries() {
                        Ok(entries) => entries,
                        Err(err) if disappeared(&err) => continue,
                        Err(err) => return Err(err),
                    };
                    rules.push(directory_rules(&directory, &relative, cancel)?);
                    pending.push(Work::Leave);
                    let absolute = self.anchors[0].path.join(&relative);
                    let mut children = Vec::new();
                    for entry in entries {
                        interrupted(cancel)?;
                        let entry = match entry {
                            Ok(entry) => entry,
                            Err(err) if disappeared(&err) => continue,
                            Err(err) => return Err(err),
                        };
                        let name = entry.file_name();
                        if self.excluded_child(&absolute, &name) {
                            continue;
                        }
                        let kind = match entry.file_type() {
                            Ok(kind) => kind,
                            Err(err) if disappeared(&err) => continue,
                            Err(err) => return Err(err),
                        };
                        let kind = if kind.is_dir() {
                            FileKind::Directory
                        } else if kind.is_file() {
                            FileKind::File
                        } else {
                            continue;
                        };
                        let path = relative.join(&name);
                        if excluded(&rules, &path, kind == FileKind::Directory) {
                            continue;
                        }
                        let bytes = gix::path::to_unix_separators_on_windows(
                            gix::path::into_bstr(path.clone())
                                .map_err(|_| error("files_unavailable"))?,
                        )
                        .into_owned();
                        children.push((bytes.to_vec(), path, kind));
                    }
                    children.sort_by(|left, right| left.0.cmp(&right.0));
                    for (bytes, path, kind) in children.into_iter().rev() {
                        pending.push(Work::Child(directory.clone(), path, bytes, kind));
                    }
                }
                Work::Child(directory, relative, _, FileKind::Directory) => {
                    let name = relative.file_name().expect("directory entry name");
                    let child = match directory.open_dir_nofollow(name) {
                        Ok(child) => child,
                        Err(err) if disappeared(&err) => continue,
                        Err(err) => return Err(err),
                    };
                    pending.push(Work::Enter(Arc::new(child), relative));
                }
                Work::Child(directory, relative, bytes, FileKind::File) => {
                    let Ok(display) = String::from_utf8(bytes.clone()) else {
                        continue;
                    };
                    if skip_extension(&display) {
                        continue;
                    }
                    let Some(name) = relative.file_name() else {
                        continue;
                    };
                    let mut options = crate::workspace::options();
                    options.read(true);
                    let mut file = match directory.open_with(name, &options) {
                        Ok(file) => file,
                        Err(err) if disappeared(&err) => continue,
                        Err(err) => return Err(err),
                    };
                    let metadata = match file.metadata() {
                        Ok(metadata) => metadata,
                        Err(err) if disappeared(&err) => continue,
                        Err(err) => return Err(err),
                    };
                    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_file_bytes
                    {
                        continue;
                    }
                    let mut raw = Vec::with_capacity(metadata.len() as usize);
                    if (&mut file)
                        .take(max_file_bytes + 1)
                        .read_to_end(&mut raw)
                        .is_err()
                        || raw.len() as u64 > max_file_bytes
                        || raw.contains(&0)
                    {
                        continue;
                    }
                    let Ok(content) = String::from_utf8(raw) else {
                        continue;
                    };
                    let Ok(ws_path) = WorkspacePath::from_bytes(&bytes) else {
                        continue;
                    };
                    visited += 1;
                    if !visit(ws_path, display, content)? {
                        break;
                    }
                }
                Work::Child(..) => {}
            }
        }
        interrupted(cancel)?;
        self.validate_inner()?;
        Ok(())
    }
}

fn skip_extension(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".min.js")
        || lower.ends_with(".min.css")
        || lower.ends_with(".map")
        || lower.ends_with(".lock")
        || lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".ico")
        || lower.ends_with(".pdf")
        || lower.ends_with(".woff")
        || lower.ends_with(".woff2")
        || lower.ends_with(".ttf")
        || lower.ends_with(".wasm")
        || lower.ends_with(".zst")
        || lower.ends_with(".bin")
}

fn directory_rules(
    directory: &Dir,
    relative: &Path,
    cancel: &AtomicBool,
) -> io::Result<[Gitignore; 4]> {
    Ok([
        read_rules(directory, relative, ".rgignore", cancel)?,
        read_rules(directory, relative, ".ignore", cancel)?,
        read_rules(directory, relative, ".gitignore", cancel)?,
        git_exclude(directory, relative, cancel)?,
    ])
}

fn disappeared(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

fn excluded(rules: &[[Gitignore; 4]], path: &Path, directory: bool) -> bool {
    // Let a nested negation override its parent rule.
    for priority in 0..4 {
        for layer in rules.iter().rev() {
            let matched = layer[priority].matched_path_or_any_parents(path, directory);
            if !matched.is_none() {
                return matched.is_ignore();
            }
        }
    }
    false
}

fn git_exclude(directory: &Dir, relative: &Path, cancel: &AtomicBool) -> io::Result<Gitignore> {
    interrupted(cancel)?;
    let git = match directory.symlink_metadata(".git") {
        Ok(metadata) if metadata.is_dir() => match directory.open_dir_nofollow(".git") {
            Ok(directory) => directory,
            Err(error) if disappeared(&error) => return Ok(Gitignore::empty()),
            Err(error) => return Err(error),
        },
        Ok(_) => return Ok(Gitignore::empty()),
        Err(error) if disappeared(&error) => return Ok(Gitignore::empty()),
        Err(error) => return Err(error),
    };
    let info = match git.symlink_metadata("info") {
        Ok(metadata) if metadata.is_dir() => match git.open_dir_nofollow("info") {
            Ok(directory) => directory,
            Err(error) if disappeared(&error) => return Ok(Gitignore::empty()),
            Err(error) => return Err(error),
        },
        Ok(_) => return Ok(Gitignore::empty()),
        Err(error) if disappeared(&error) => return Ok(Gitignore::empty()),
        Err(error) => return Err(error),
    };
    read_rules(&info, relative, "exclude", cancel)
}

fn read_rules(
    directory: &Dir,
    relative: &Path,
    name: &str,
    cancel: &AtomicBool,
) -> io::Result<Gitignore> {
    interrupted(cancel)?;
    match directory.symlink_metadata(name) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Ok(Gitignore::empty()),
        Err(error) if disappeared(&error) => return Ok(Gitignore::empty()),
        Err(error) => return Err(error),
    }
    let mut options = crate::workspace::options();
    options.read(true);
    let mut file = match directory.open_with(name, &options) {
        Ok(file) => file,
        Err(error) if disappeared(&error) => return Ok(Gitignore::empty()),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(error("files_unavailable"));
    }
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    let mut reader = (&mut file).take(metadata.len());
    while reader.limit() != 0 {
        interrupted(cancel)?;
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Err(error("files_changed"));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    let mut builder = GitignoreBuilder::new(relative);
    let source = relative.join(name);
    for line in String::from_utf8_lossy(&bytes).lines() {
        interrupted(cancel)?;
        builder
            .add_line(Some(source.clone()), line)
            .map_err(io::Error::other)?;
    }
    builder.build().map_err(io::Error::other)
}
