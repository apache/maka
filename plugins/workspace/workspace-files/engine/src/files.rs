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

//! Bounded single-directory snapshots and native invalidation within a Session workspace.
use crate::{path::WorkspacePath, worktree::Binding};
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use gix::bstr::ByteSlice;
use maka_agent_facts::execution::DirectoryIdentity;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

mod watch;
pub use watch::Watch;
mod candidates;
mod preview;
pub use preview::{FileCapture, FileContent, FileSnapshot};
#[cfg(test)]
mod tests;

const PAGE_SIZE: usize = 128;
const MAX_PAGE_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentFileCursor")]
pub struct FileCursor {
    #[schemars(with = "String")]
    pub directory_identity: DirectoryIdentity,
    pub after: WorkspacePath,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentFilePage")]
pub struct FilePage {
    #[schemars(with = "String")]
    pub directory_identity: DirectoryIdentity,
    pub entries: Vec<FileEntry>,
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<FileCursor>")]
    pub next: Option<FileCursor>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentFileEntry")]
pub struct FileEntry {
    pub path: WorkspacePath,
    pub kind: FileKind,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentFileKind")]
pub enum FileKind {
    File,
    Directory,
    Symlink,
    Other,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "AgentFileChange")]
pub enum FileChange {
    Ready {
        #[schemars(with = "String")]
        directory_identity: DirectoryIdentity,
    },
    Changed,
    Unavailable {
        reason: FileUnavailable,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(rename = "AgentFileUnavailable")]
pub enum FileUnavailable {
    DirectoryChanged,
}

/// Actual admitted shallow state; no file content or descendant traversal.
#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
pub struct Snapshot(BTreeMap<Vec<u8>, EntryMetadata>);

#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
struct EntryMetadata {
    dev: u64,
    ino: u64,
    mode: u32,
    nlink: u64,
    size: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}

struct Anchor {
    path: PathBuf,
    directory: Dir,
    identity: DirectoryIdentity,
}
pub struct Directory {
    anchors: Vec<Anchor>,
    relative: PathBuf,
    private_root: PathBuf,
    control: PathBuf,
    managed: bool,
}
impl Directory {
    /// All paths and the Binding are trusted Owner authority; path alone is caller data.
    pub fn open(
        workspace: &Path,
        identity: &DirectoryIdentity,
        private_root: &Path,
        control: &Path,
        binding: Option<&Binding>,
        path: Option<&WorkspacePath>,
        cancel: &AtomicBool,
    ) -> io::Result<Self> {
        expose((|| {
            interrupted(cancel)?;
            let relative = match path {
                Some(path) => {
                    gix::path::from_bstring(path.bytes().map_err(|_| error("files_invalid_path"))?)
                        .map_err(|_| error("files_invalid_path"))?
                }
                None => PathBuf::new(),
            };
            let directory = crate::directory::open(workspace, identity)?;
            let root = dunce::canonicalize(workspace)?;
            let private_root = dunce::canonicalize(private_root)?;
            let control = dunce::canonicalize(control)?;
            let managed = binding.is_some_and(|b| b.directory() == root);
            if binding.is_some() && !managed {
                return Err(error("files_private"));
            }
            let mut result = Self {
                anchors: vec![Anchor {
                    path: root,
                    directory,
                    identity: identity.clone(),
                }],
                relative: relative.clone(),
                private_root,
                control,
                managed,
            };
            if result.excluded(&result.anchors[0].path) {
                return Err(error("files_private"));
            }
            result.descend(&relative, cancel)?;
            result.validate_inner()?;
            Ok(result)
        })())
    }
    fn descend(&mut self, relative: &Path, cancel: &AtomicBool) -> io::Result<()> {
        for component in relative.components() {
            interrupted(cancel)?;
            let parent = self.anchors.last().expect("workspace anchor");
            let path = parent.path.join(component.as_os_str());
            if self.excluded_child(&parent.path, component.as_os_str()) {
                return Err(error("files_private"));
            }
            let directory = parent.directory.open_dir_nofollow(component.as_os_str())?;
            let identity = crate::directory::identity(&directory)?;
            self.anchors.push(Anchor {
                path,
                directory,
                identity,
            });
        }
        Ok(())
    }
    pub fn directory_identity(&self) -> &DirectoryIdentity {
        &self.anchors.last().expect("target anchor").identity
    }
    pub fn validate(&self) -> io::Result<()> {
        expose(self.validate_inner())
    }
    fn validate_inner(&self) -> io::Result<()> {
        if dunce::canonicalize(&self.private_root).map_err(|_| error("files_changed"))?
            != self.private_root
            || dunce::canonicalize(&self.control).map_err(|_| error("files_changed"))?
                != self.control
        {
            return Err(error("files_changed"));
        }
        for anchor in &self.anchors {
            let meta = fs::symlink_metadata(&anchor.path).map_err(|_| error("files_changed"))?;
            if !meta.is_dir()
                || meta.file_type().is_symlink()
                || dunce::canonicalize(&anchor.path).map_err(|_| error("files_changed"))?
                    != anchor.path
                || crate::directory::open(&anchor.path, &anchor.identity).is_err()
                || crate::directory::identity(&anchor.directory)? != anchor.identity
                || self.excluded(&anchor.path)
            {
                return Err(error("files_changed"));
            }
        }
        Ok(())
    }
    fn excluded(&self, path: &Path) -> bool {
        path.starts_with(&self.control)
            || (path.starts_with(&self.private_root)
                && !(self.managed && path.starts_with(&self.anchors[0].path)))
    }
    fn excluded_child(&self, directory: &Path, name: &std::ffi::OsStr) -> bool {
        name.as_encoded_bytes().eq_ignore_ascii_case(b".git")
            || name == std::ffi::OsStr::new(crate::workspace::MARKER_FILE)
            || self.excluded(&directory.join(name))
    }
    /// Reconcile only direct, admitted entries through the held target descriptor.
    #[cfg(target_os = "macos")]
    pub fn snapshot(&self, cancel: &AtomicBool) -> io::Result<Snapshot> {
        use cap_std::fs::MetadataExt;
        expose((|| {
            interrupted(cancel)?;
            self.validate_inner()?;
            interrupted(cancel)?;
            let target = self.anchors.last().expect("target anchor");
            let mut entries = BTreeMap::new();
            for entry in target.directory.entries()? {
                interrupted(cancel)?;
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                };
                let name = entry.file_name();
                if self.excluded_child(&target.path, &name) {
                    continue;
                }
                let metadata = match target.directory.symlink_metadata(&name) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                };
                interrupted(cancel)?;
                entries.insert(
                    name.as_encoded_bytes().to_vec(),
                    EntryMetadata {
                        dev: metadata.dev(),
                        ino: metadata.ino(),
                        mode: metadata.mode(),
                        nlink: metadata.nlink(),
                        size: metadata.size(),
                        mtime: metadata.mtime(),
                        mtime_nsec: metadata.mtime_nsec(),
                        ctime: metadata.ctime(),
                        ctime_nsec: metadata.ctime_nsec(),
                    },
                );
            }
            interrupted(cancel)?;
            self.validate_inner()?;
            interrupted(cancel)?;
            Ok(Snapshot(entries))
        })())
    }
    pub fn list(&self, after: Option<&FileCursor>, cancel: &AtomicBool) -> io::Result<FilePage> {
        expose(self.list_inner(after, cancel))
    }
    fn list_inner(&self, after: Option<&FileCursor>, cancel: &AtomicBool) -> io::Result<FilePage> {
        interrupted(cancel)?;
        self.validate_inner()?;
        let after_bytes = after
            .map(|cursor| {
                if &cursor.directory_identity != self.directory_identity() {
                    return Err(error("files_invalid_cursor"));
                }
                let bytes = cursor
                    .after
                    .bytes()
                    .map_err(|_| error("files_invalid_cursor"))?;
                let path = gix::path::from_bstr(bytes.as_bstr())
                    .map_err(|_| error("files_invalid_cursor"))?;
                if path.parent().unwrap_or(Path::new("")) != self.relative {
                    return Err(error("files_invalid_cursor"));
                }
                Ok(bytes)
            })
            .transpose()?;
        let target = self.anchors.last().expect("target anchor");
        let mut entries = BTreeMap::new();
        for entry in target.directory.entries()? {
            interrupted(cancel)?;
            let entry = entry?;
            let name = entry.file_name();
            if self.excluded_child(&target.path, &name) {
                continue;
            }
            let relative = gix::path::to_unix_separators_on_windows(
                gix::path::into_bstr(self.relative.join(&name))
                    .map_err(|_| error("files_unavailable"))?,
            )
            .into_owned();
            let path =
                WorkspacePath::from_bytes(&relative).map_err(|_| error("files_invalid_path"))?;
            if after_bytes
                .as_ref()
                .is_some_and(|after| relative.as_slice() <= after.as_slice())
            {
                continue;
            }
            let kind = entry.file_type()?;
            let kind = if kind.is_symlink() {
                FileKind::Symlink
            } else if kind.is_dir() {
                FileKind::Directory
            } else if kind.is_file() {
                FileKind::File
            } else {
                FileKind::Other
            };
            entries.insert(relative.to_vec(), FileEntry { path, kind });
            if entries.len() > PAGE_SIZE + 1 {
                entries.pop_last();
            }
        }
        let has_more = entries.len() > PAGE_SIZE;
        if has_more {
            entries.pop_last();
        }
        let mut page = FilePage {
            directory_identity: self.directory_identity().clone(),
            entries: entries.into_values().collect(),
            next: None,
        };
        let mut more = has_more;
        loop {
            page.next = if more {
                page.entries.last().map(|entry| FileCursor {
                    directory_identity: self.directory_identity().clone(),
                    after: entry.path.clone(),
                })
            } else {
                None
            };
            if page.entries.len() <= 1
                || serde_json::to_vec(&page).map_err(io::Error::other)?.len() <= MAX_PAGE_BYTES
            {
                break;
            }
            page.entries.pop();
            more = true;
        }
        interrupted(cancel)?;
        self.validate_inner()?;
        Ok(page)
    }
    /// Install the nonrecursive anchor chain before emitting Ready or reading a list.
    pub fn watch(&self) -> io::Result<Watch> {
        expose(watch::open(self))
    }
}

#[derive(Debug)]
struct Failure(&'static str);
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Failure {}
fn error(code: &'static str) -> io::Error {
    io::Error::other(Failure(code))
}
fn expose<T>(value: io::Result<T>) -> io::Result<T> {
    value.map_err(|e| {
        if e.get_ref().is_some_and(|v| v.is::<Failure>()) {
            e
        } else {
            error("files_unavailable")
        }
    })
}
fn interrupted(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(error("files_cancelled"))
    } else {
        Ok(())
    }
}
