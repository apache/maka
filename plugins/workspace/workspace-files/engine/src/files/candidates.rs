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
    cmp::Reverse,
    io::{BufReader, Read},
    sync::Arc,
};

impl Directory {
    /// Browses direct entries for an empty query, otherwise searches descendant names.
    /// Neither operation reads candidate contents or follows directory links.
    pub fn candidates(
        &self,
        query: &str,
        cancel: &AtomicBool,
        mut emit: impl FnMut(FileEntry) -> io::Result<()>,
    ) -> io::Result<()> {
        expose(self.candidate_files(query, true, cancel, &mut emit))
    }

    /// Like shell completion of a typed path: only direct entries match.
    pub fn child_candidates(
        &self,
        query: &str,
        cancel: &AtomicBool,
        mut emit: impl FnMut(FileEntry) -> io::Result<()>,
    ) -> io::Result<()> {
        expose(self.candidate_files(query, false, cancel, &mut emit))
    }

    fn candidate_files(
        &self,
        query: &str,
        descend: bool,
        cancel: &AtomicBool,
        emit: &mut impl FnMut(FileEntry) -> io::Result<()>,
    ) -> io::Result<()> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return self.walk_entries(false, true, cancel, |_dir, _rel, bytes, kind| {
                let path =
                    WorkspacePath::from_bytes(bytes).map_err(|_| error("files_invalid_path"))?;
                emit(FileEntry { path, kind })?;
                Ok(true)
            });
        }
        self.search_names(&query, descend, cancel, emit)
    }

    /// Ranks fuzzy matches of the relative path (the name alone for direct
    /// entries) and emits the best ones, highest first. The walk is
    /// breadth-first and bounded, so a large workspace such as a home
    /// directory still finishes. Hidden entries are searched only when the
    /// query itself starts with a dot.
    fn search_names(
        &self,
        query: &str,
        descend: bool,
        cancel: &AtomicBool,
        emit: &mut impl FnMut(FileEntry) -> io::Result<()>,
    ) -> io::Result<()> {
        const SHOWN: usize = 50;
        const VISITS: usize = 200_000;
        interrupted(cancel)?;
        self.validate_inner()?;
        let target = self.anchors.last().expect("target anchor");
        let mut rules = [const { Vec::new() }; 4];
        for anchor in &self.anchors[..self.anchors.len() - 1] {
            let relative = anchor
                .path
                .strip_prefix(&self.anchors[0].path)
                .map_err(|_| error("files_changed"))?;
            load_directory_rules(&mut rules, &anchor.directory, relative, cancel)?;
        }
        let hidden = query.starts_with('.');
        let fuzzy = super::fuzzy::Query::new(query);
        let mut visits = 0;
        // The lowest-ranked kept match sits on top: score, then shorter, then path order.
        let mut kept = std::collections::BinaryHeap::new();
        // Directories are opened when dequeued, so the queue holds no descriptors.
        let mut pending = std::collections::VecDeque::from([(PathBuf::new(), Arc::new(rules))]);
        'search: while let Some((inner, inherited)) = pending.pop_front() {
            interrupted(cancel)?;
            let directory = match open_descendant_dir(&target.directory, &inner) {
                Ok(directory) => directory,
                Err(err) if disappeared(&err) => continue,
                Err(err) if !inner.as_os_str().is_empty() && denied(&err) => continue,
                Err(err) => return Err(err),
            };
            let entries = match directory.entries() {
                Ok(entries) => entries,
                Err(err) if disappeared(&err) => continue,
                Err(err) if !inner.as_os_str().is_empty() && denied(&err) => continue,
                Err(err) => return Err(err),
            };
            let relative = self.relative.join(&inner);
            let mut own = [const { Vec::new() }; 4];
            load_directory_rules(&mut own, &directory, &relative, cancel)?;
            let rules = if own.iter().all(Vec::is_empty) {
                inherited
            } else {
                let mut merged = (*inherited).clone();
                for (source, added) in merged.iter_mut().zip(own) {
                    source.extend(added);
                }
                Arc::new(merged)
            };
            let absolute = self.anchors[0].path.join(&relative);
            let mut children = Vec::new();
            for entry in entries {
                interrupted(cancel)?;
                visits += 1;
                if visits > VISITS {
                    break 'search;
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(err) if disappeared(&err) || denied(&err) => continue,
                    Err(err) => return Err(err),
                };
                let name = entry.file_name();
                if !hidden && name.as_encoded_bytes().starts_with(b".")
                    || self.excluded_child(&absolute, &name)
                {
                    continue;
                }
                let kind = match entry.file_type() {
                    Ok(kind) if kind.is_dir() => FileKind::Directory,
                    Ok(kind) if kind.is_file() => FileKind::File,
                    Ok(kind) if kind.is_symlink() => FileKind::Symlink,
                    Ok(_) => continue,
                    Err(err) if disappeared(&err) || denied(&err) => continue,
                    Err(err) => return Err(err),
                };
                let path = relative.join(&name);
                if excluded(&rules, &path, kind == FileKind::Directory) {
                    continue;
                }
                children.push((name, path, kind));
            }
            for (name, path, kind) in &children {
                // Display matching never becomes the identity of a non-UTF-8 path.
                let shown = if descend {
                    path.as_os_str()
                } else {
                    name.as_os_str()
                };
                let Some(score) = fuzzy.score(&shown.to_string_lossy()) else {
                    continue;
                };
                let bytes = gix::path::to_unix_separators_on_windows(
                    gix::path::into_bstr(path.clone()).map_err(|_| error("files_unavailable"))?,
                )
                .into_owned()
                .to_vec();
                let rank = (Reverse(score), bytes.len(), bytes);
                if kept.len() < SHOWN {
                    kept.push(Ranked(rank, *kind));
                } else if kept.peek().is_some_and(|worst: &Ranked| rank < worst.0) {
                    kept.pop();
                    kept.push(Ranked(rank, *kind));
                }
            }
            for (name, _, kind) in &children {
                if descend && *kind == FileKind::Directory {
                    pending.push_back((inner.join(name), rules.clone()));
                }
            }
        }
        interrupted(cancel)?;
        self.validate_inner()?;
        for Ranked((_, _, bytes), kind) in kept.into_sorted_vec() {
            let path =
                WorkspacePath::from_bytes(&bytes).map_err(|_| error("files_invalid_path"))?;
            emit(FileEntry { path, kind })?;
        }
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
                Err(err) if disappeared(&err) || denied(&err) => return Ok(true),
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
            Leave([usize; 4]),
        }
        interrupted(cancel)?;
        self.validate_inner()?;
        let target = self.anchors.last().expect("target anchor");
        let mut pending = vec![Work::Enter(
            Arc::new(target.directory.try_clone()?),
            self.relative.clone(),
        )];
        let mut rules = [const { Vec::new() }; 4];
        for anchor in &self.anchors[..self.anchors.len() - 1] {
            let relative = anchor
                .path
                .strip_prefix(&self.anchors[0].path)
                .map_err(|_| error("files_changed"))?;
            load_directory_rules(&mut rules, &anchor.directory, relative, cancel)?;
        }
        while let Some(work) = pending.pop() {
            interrupted(cancel)?;
            match work {
                Work::Leave(lengths) => {
                    for (source, len) in rules.iter_mut().zip(lengths) {
                        source.truncate(len);
                    }
                }
                Work::Enter(directory, relative) => {
                    let entries = match directory.entries() {
                        Ok(entries) => entries,
                        Err(err) if disappeared(&err) => continue,
                        Err(err) if relative != self.relative && denied(&err) => continue,
                        Err(err) => return Err(err),
                    };
                    let lengths = rules.each_ref().map(Vec::len);
                    load_directory_rules(&mut rules, &directory, &relative, cancel)?;
                    pending.push(Work::Leave(lengths));
                    let absolute = self.anchors[0].path.join(&relative);
                    let mut children = Vec::new();
                    for entry in entries {
                        interrupted(cancel)?;
                        let entry = match entry {
                            Ok(entry) => entry,
                            Err(err) if disappeared(&err) || denied(&err) => continue,
                            Err(err) => return Err(err),
                        };
                        let name = entry.file_name();
                        if self.excluded_child(&absolute, &name) {
                            continue;
                        }
                        let kind = match entry.file_type() {
                            Ok(kind) => kind,
                            Err(err) if disappeared(&err) || denied(&err) => continue,
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
                        Err(err) if disappeared(&err) || denied(&err) => continue,
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

/// A kept candidate, ordered by its rank alone.
struct Ranked((Reverse<i32>, usize, Vec<u8>), FileKind);
impl PartialEq for Ranked {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl Eq for Ranked {}
impl PartialOrd for Ranked {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Ranked {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.cmp(&other.0)
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

fn load_directory_rules(
    rules: &mut [Vec<Gitignore>; 4],
    directory: &Dir,
    relative: &Path,
    cancel: &AtomicBool,
) -> io::Result<()> {
    let files = [
        Some(".rgignore"),
        Some(".ignore"),
        Some(".gitignore"),
        relative
            .as_os_str()
            .is_empty()
            .then_some(".git/info/exclude"),
    ];
    for (source, name) in rules.iter_mut().zip(files) {
        if let Some(name) = name
            && let Some(matcher) = read_rules(directory, relative, Path::new(name), cancel)?
        {
            source.push(matcher);
        }
    }
    Ok(())
}

fn read_rules(
    directory: &Dir,
    root: &Path,
    name: &Path,
    cancel: &AtomicBool,
) -> io::Result<Option<Gitignore>> {
    interrupted(cancel)?;
    let current;
    let parent = match name.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            current = match directory.open_dir_nofollow(parent) {
                Ok(directory) => directory,
                Err(_) => return Ok(None),
            };
            &current
        }
        _ => directory,
    };
    let Some(file_name) = name.file_name() else {
        return Ok(None);
    };
    let mut options = crate::workspace::options();
    options.read(true);
    let file = match parent.open_with(file_name, &options) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok(None);
    }
    let mut builder = GitignoreBuilder::new("");
    BufReader::new(file.take(metadata.len())).for_byte_line(|line| {
        interrupted(cancel)?;
        if let Ok(text) = std::str::from_utf8(line) {
            let _ = builder.add_line(Some(root.to_path_buf()), text);
        }
        Ok(true)
    })?;
    Ok(builder.build().ok())
}

// A search below the workspace root, such as a home directory, leaves out
// entries the user may not read (including macOS privacy-protected folders)
// instead of failing the whole search.
fn open_descendant_dir(root: &Dir, inner: &Path) -> io::Result<Dir> {
    let mut current = root.try_clone()?;
    for component in inner.components() {
        current = current.open_dir_nofollow(component.as_os_str())?;
    }
    Ok(current)
}

fn denied(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
}

fn disappeared(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

fn excluded(rules: &[Vec<Gitignore>; 4], path: &Path, is_dir: bool) -> bool {
    // Source precedence wins across directories. Within a source, the nearest file wins.
    for source in rules {
        for rule in source.iter().rev() {
            let matched = rule.matched(path, is_dir);
            if !matched.is_none() {
                return matched.is_ignore();
            }
        }
    }
    false
}
