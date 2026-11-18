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

//! Composer path candidates and bounded text-file traversal through the original workspace directory capability.
use super::*;
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use gix::bstr::io::BufReadExt;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::{
    io::{BufReader, Read},
    sync::Arc,
};

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
        let query = query.trim().to_lowercase();
        let descend = !query.is_empty();
        self.walk_entries(descend, true, cancel, |_dir, _rel, bytes, kind| {
            // Display matching never becomes the identity of a non-UTF-8 path.
            if bytes.to_str_lossy().to_lowercase().contains(&query) {
                let path =
                    WorkspacePath::from_bytes(bytes).map_err(|_| error("files_invalid_path"))?;
                emit(FileEntry { path, kind })?;
            }
            Ok(true)
        })
    }

    /// Visits regular UTF-8 files under the workspace while honoring ignore rules and capability boundaries.
    pub(crate) fn visit_text_files(
        &self,
        max_file_bytes: u64,
        max_files: usize,
        cancel: &AtomicBool,
        mut visit: impl FnMut(WorkspacePath, String, String) -> io::Result<bool>,
    ) -> io::Result<()> {
        let mut visited = 0_usize;
        self.walk_entries(true, false, cancel, |directory, relative, bytes, kind| {
            if kind != FileKind::File {
                return Ok(true);
            }
            if visited >= max_files {
                return Ok(false);
            }
            let Ok(display) = std::str::from_utf8(bytes).map(str::to_owned) else {
                return Ok(true);
            };
            if skip_extension(&display) {
                return Ok(true);
            }
            let Some(name) = relative.file_name() else {
                return Ok(true);
            };
            let mut options = crate::workspace::options();
            options.read(true);
            let mut file = match directory.open_with(name, &options) {
                Ok(file) => file,
                Err(err) if disappeared(&err) => return Ok(true),
                Err(err) => return Err(err),
            };
            let metadata = match file.metadata() {
                Ok(metadata) => metadata,
                Err(err) if disappeared(&err) => return Ok(true),
                Err(err) => return Err(err),
            };
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_file_bytes {
                return Ok(true);
            }
            let mut raw = Vec::with_capacity(metadata.len() as usize);
            if (&mut file)
                .take(max_file_bytes + 1)
                .read_to_end(&mut raw)
                .is_err()
                || raw.len() as u64 > max_file_bytes
                || raw.contains(&0)
            {
                return Ok(true);
            }
            let Ok(content) = String::from_utf8(raw) else {
                return Ok(true);
            };
            let Ok(ws_path) = WorkspacePath::from_bytes(bytes) else {
                return Ok(true);
            };
            visited += 1;
            visit(ws_path, display, content)
        })
    }

    fn walk_entries(
        &self,
        descend_directories: bool,
        include_symlinks: bool,
        cancel: &AtomicBool,
        mut on_entry: impl FnMut(&Dir, &Path, &[u8], FileKind) -> io::Result<bool>,
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
        while let Some(work) = pending.pop() {
            interrupted(cancel)?;
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
                        } else if include_symlinks && kind.is_symlink() {
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
                Work::Child(directory, relative, _, FileKind::Directory) if descend_directories => {
                    let name = relative.file_name().expect("directory entry name");
                    let child = match directory.open_dir_nofollow(name) {
                        Ok(child) => child,
                        Err(err) if disappeared(&err) => continue,
                        Err(err) => return Err(err),
                    };
                    pending.push(Work::Enter(Arc::new(child), relative));
                }
                Work::Child(directory, relative, bytes, kind) => {
                    if !on_entry(&directory, &relative, &bytes, kind)? {
                        break;
                    }
                }
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
        || lower.ends_with(".sqlite")
        || lower.ends_with(".db")
}

fn directory_rules(
    directory: &Dir,
    relative: &Path,
    cancel: &AtomicBool,
) -> io::Result<Option<Gitignore>> {
    let mut builder = GitignoreBuilder::new("");
    let mut any = false;
    for name in [".rgignore", ".ignore", ".gitignore"] {
        any |= add_rules(&mut builder, directory, relative, Path::new(name), cancel)?;
    }
    if relative.as_os_str().is_empty() {
        any |= add_rules(
            &mut builder,
            directory,
            relative,
            Path::new(".git/info/exclude"),
            cancel,
        )?;
    }
    if !any {
        return Ok(None);
    }
    Ok(builder.build().ok())
}

fn add_rules(
    builder: &mut GitignoreBuilder,
    directory: &Dir,
    root: &Path,
    name: &Path,
    cancel: &AtomicBool,
) -> io::Result<bool> {
    interrupted(cancel)?;
    let current;
    let parent = match name.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            current = match directory.open_dir_nofollow(parent) {
                Ok(directory) => directory,
                Err(_) => return Ok(false),
            };
            &current
        }
        _ => directory,
    };
    let Some(file_name) = name.file_name() else {
        return Ok(false);
    };
    let mut options = crate::workspace::options();
    options.read(true);
    let file = match parent.open_with(file_name, &options) {
        Ok(file) => file,
        Err(_) => return Ok(false),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok(false);
    }
    BufReader::new(file.take(metadata.len())).for_byte_line(|line| {
        interrupted(cancel)?;
        if let Ok(text) = std::str::from_utf8(line) {
            let _ = builder.add_line(Some(root.to_path_buf()), text);
        }
        Ok(true)
    })?;
    Ok(true)
}

fn disappeared(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

fn excluded(rules: &[Option<Gitignore>], path: &Path, is_dir: bool) -> bool {
    let mut ignored = false;
    for rule in rules.iter().flatten() {
        match rule.matched(path, is_dir) {
            ignore::Match::None => {}
            ignore::Match::Ignore(_) => ignored = true,
            ignore::Match::Whitelist(_) => ignored = false,
        }
    }
    ignored
}
