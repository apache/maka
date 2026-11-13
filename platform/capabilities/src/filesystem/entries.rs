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

//! Bounded filesystem primitives shared by private data and authorized workspace
//! operations. File formats, transactions and coordination belong to plugins.

use crate::storage::Directory;
use cap_fs_ext::MetadataExt;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use maka_plugin_core::storage::StoreError;
use maka_sandbox::filesystem::{Access, Compiled};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
};

use tokio_util::sync::CancellationToken;

const CHUNK: usize = 1024 * 1024;
const MAX_OFFSET: u64 = (1_u64 << 53) - 1;

/// Relative to an already authorized directory. These are primitives, not a
/// transaction: plugins own multi-operation intent and recovery.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    content = "input",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Operation {
    Read(ReadFile),
    Write(WriteFile),
    List(ListFiles),
    Stat { path: String },
    Sync { path: String },
    CreateDirectory { path: String },
    Remove { path: String },
    Rename { from: String, to: String },
}
impl Operation {
    pub fn is_read(&self) -> bool {
        matches!(self, Self::Read(_) | Self::List(_) | Self::Stat { .. })
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Read(_) => "files.read_bytes",
            Self::Write(_) => "files.write_bytes",
            Self::List(_) => "files.list",
            Self::Stat { .. } => "files.stat",
            Self::Sync { .. } => "files.sync",
            Self::CreateDirectory { .. } => "files.create_directory",
            Self::Remove { .. } => "files.remove",
            Self::Rename { .. } => "files.rename",
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Output {
    Read(FilePage),
    List(DirectoryPage),
    Stat(Metadata),
    Done,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Metadata {
    pub kind: Kind,
    pub size: u64,
    pub mode: u32,
}

/// Embedding primitive: the caller must admit and own work on this root. No
/// path supplied to an operation can create or widen that authority.
pub fn execute(
    root: &Dir,
    operation: Operation,
    cancellation: &CancellationToken,
    policy: Option<Policy<'_>>,
) -> Result<Output, Error> {
    check(cancellation)?;
    if let Some(policy) = policy {
        policy.authorize(root, &operation)?;
    }
    match operation {
        Operation::Read(input) => read(root, input, cancellation).map(Output::Read),
        Operation::Write(input) => write(root, input, policy.is_some()).map(|()| Output::Done),
        Operation::List(input) => list(root, input, cancellation, policy).map(Output::List),
        Operation::Stat { path } => stat(root, path).map(Output::Stat),
        Operation::Sync { path } => {
            if !path.is_empty() {
                self::path(&path)?;
            }
            sync(&directory(root, &path)?).map_err(Error::from)?;
            Ok(Output::Done)
        }
        Operation::CreateDirectory { path } => create_directory(root, path).map(|()| Output::Done),
        Operation::Remove { path } => remove(root, path).map(|()| Output::Done),
        Operation::Rename { from, to } => rename(root, from, to).map(|()| Output::Done),
    }
}

/// Optional workspace ceiling on an already captured directory capability.
/// Private plugin data has its own namespace authority and does not use it.
#[derive(Clone, Copy)]
pub struct Policy<'a> {
    pub root: &'a Path,
    pub filesystem: &'a Compiled,
}
impl Policy<'_> {
    fn check(&self, root: &Dir, name: &str, access: Access, subtree: bool) -> Result<(), Error> {
        if !name.is_empty() {
            path(name)?;
        }
        let lexical = self.root.join(name);
        let resolved = match root.canonicalize(if name.is_empty() { "." } else { name }) {
            Ok(path) => self.root.join(path),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let (parent, file) = name.rsplit_once('/').unwrap_or(("", name));
                self.root
                    .join(root.canonicalize(if parent.is_empty() { "." } else { parent })?)
                    .join(file)
            }
            Err(error) => return Err(error.into()),
        };
        for path in [&lexical, &resolved] {
            let path: std::path::PathBuf = path.components().collect();
            if self.filesystem.access(&path).intersect(access) != access
                || (subtree && !self.filesystem.permits_subtree(&path, access))
            {
                return Err(Error::Invalid(format!(
                    "filesystem policy denies {access:?} access to {}",
                    path.display()
                )));
            }
        }
        Ok(())
    }

    fn authorize(&self, root: &Dir, operation: &Operation) -> Result<(), Error> {
        match operation {
            Operation::Read(input) => self.check(root, &input.path, Access::Read, false),
            Operation::List(input) => self.check(root, &input.path, Access::Read, false),
            Operation::Stat { path } => self.check(root, path, Access::Read, false),
            Operation::Write(input) => {
                self.check(root, &input.path, Access::Write, false)?;
                // Opening without truncation is harmless; check the held file
                // again in write() before content or permissions can change.
                Ok(())
            }
            Operation::CreateDirectory { path } | Operation::Sync { path } => {
                self.check(root, path, Access::Write, false)
            }
            Operation::Remove { path } => {
                let directory = root.symlink_metadata(path)?.is_dir();
                self.check(root, path, Access::Write, directory)
            }
            Operation::Rename { from, to } => {
                let directory = root.symlink_metadata(from)?.is_dir();
                self.check(root, from, Access::Write, directory)?;
                self.check(root, to, Access::Write, directory)
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadFile {
    pub path: String,
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "read_limit")]
    pub limit: usize,
}
fn read_limit() -> usize {
    64 * 1024
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePage {
    pub bytes: Vec<u8>,
    pub next_offset: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteFile {
    pub path: String,
    #[serde(default)]
    pub offset: u64,
    pub bytes: Vec<u8>,
    /// Explicitly truncate before writing; only valid at offset zero.
    #[serde(default)]
    pub truncate: bool,
    /// Refuse to open an existing name, including a symlink.
    #[serde(default)]
    pub create_new: bool,
    /// Ordinary permission bits; never setuid, setgid or sticky.
    pub mode: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListFiles {
    /// Empty selects the namespace root; mutations never accept the root.
    #[serde(default)]
    pub path: String,
    pub after: Option<String>,
    #[serde(default = "list_limit")]
    pub limit: usize,
}
fn list_limit() -> usize {
    256
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPage {
    pub entries: Vec<Entry>,
    pub next_after: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    pub kind: Kind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    File,
    Directory,
    Other,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid file operation: {0}")]
    Invalid(String),
    #[error("file does not exist")]
    NotFound,
    #[error("file already exists")]
    AlreadyExists,
    #[error("file operation cancelled")]
    Cancelled,
    #[error("file capability is retired")]
    Retired,
    #[error("file I/O failed: {0}")]
    Io(String),
    #[error("file mutation outcome is unknown: {0}")]
    OutcomeUnknown(String),
}
impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::NotFound,
            io::ErrorKind::AlreadyExists => Self::AlreadyExists,
            _ => Self::Io(error.to_string()),
        }
    }
}
impl From<StoreError> for Error {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Retired => Self::Retired,
            StoreError::OutcomeUnknown(message) => Self::OutcomeUnknown(message),
            error => Self::Io(error.to_string()),
        }
    }
}

impl Directory {
    pub async fn stat(&self, name: String) -> Result<Metadata, Error> {
        self.run(move |root, _| stat(root, name)).await?
    }
    pub async fn read(&self, input: ReadFile) -> Result<FilePage, Error> {
        self.run(move |root, cancellation| read(root, input, cancellation))
            .await?
    }
    pub async fn write(&self, input: WriteFile) -> Result<(), Error> {
        self.run(move |root, _| write(root, input, false)).await?
    }
    pub async fn list(&self, input: ListFiles) -> Result<DirectoryPage, Error> {
        self.run(move |root, cancellation| list(root, input, cancellation, None))
            .await?
    }
    pub async fn create_directory(&self, name: String) -> Result<(), Error> {
        self.run(move |root, _| create_directory(root, name))
            .await?
    }
    pub async fn remove(&self, name: String) -> Result<(), Error> {
        self.run(move |root, _| remove(root, name)).await?
    }
    pub async fn rename(&self, from: String, to: String) -> Result<(), Error> {
        self.run(move |root, _| rename(root, from, to)).await?
    }
}

fn read(root: &Dir, input: ReadFile, cancellation: &CancellationToken) -> Result<FilePage, Error> {
    path(&input.path)?;
    if input.limit == 0 || input.offset > MAX_OFFSET {
        return Err(Error::Invalid("invalid read range".into()));
    }

    let (parent, name) = parent(root, &input.path)?;
    let mut file = parent.open_with(name, options().read(true))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(Error::Invalid("expected a regular file".into()));
    }
    file.seek(SeekFrom::Start(input.offset))?;
    let remaining = metadata.len().saturating_sub(input.offset);
    let extent = remaining.min(u64::try_from(input.limit).unwrap_or(u64::MAX));
    let mut reader = file.take(extent);
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    while reader.limit() != 0 {
        check(cancellation)?;
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "file changed within its captured read extent",
            )
            .into());
        }
        bytes.try_reserve(count).map_err(std::io::Error::other)?;
        bytes.extend_from_slice(&buffer[..count]);
    }
    check(cancellation)?;
    let next_offset = if remaining > extent {
        Some(
            input
                .offset
                .checked_add(extent)
                .filter(|offset| *offset <= MAX_OFFSET)
                .ok_or_else(|| Error::Invalid("read offset cannot be represented".into()))?,
        )
    } else {
        None
    };
    Ok(FilePage { bytes, next_offset })
}

fn write(root: &Dir, input: WriteFile, managed: bool) -> Result<(), Error> {
    path(&input.path)?;
    if input.bytes.len() > CHUNK
        || input.offset > MAX_OFFSET - input.bytes.len() as u64
        || (input.truncate && input.offset != 0)
        || input.mode.is_some_and(|mode| mode > 0o777)
    {
        return Err(Error::Invalid("invalid write range".into()));
    }

    let (parent, name) = parent(root, &input.path)?;
    let mut file = parent.open_with(
        name,
        options()
            .write(true)
            .create(true)
            .create_new(input.create_new),
    )?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(Error::Invalid("expected a regular file".into()));
    }
    if managed && metadata.nlink() != 1 {
        return Err(Error::Invalid(
            "managed writes cannot modify a multiply-linked file".into(),
        ));
    }
    let mut write = || -> io::Result<()> {
        if input.truncate {
            file.set_len(0)?;
        }
        file.seek(SeekFrom::Start(input.offset))?;
        file.write_all(&input.bytes)?;
        if let Some(mode) = input.mode {
            #[cfg(unix)]
            {
                use cap_std::fs::PermissionsExt;
                file.set_permissions(cap_std::fs::Permissions::from_mode(mode))?;
            }
            #[cfg(windows)]
            {
                let mut permissions = file.metadata()?.permissions();
                permissions.set_readonly(mode & 0o222 == 0);
                file.set_permissions(permissions)?;
            }
        }
        file.sync_all()?;
        sync(&parent)
    };
    write().map_err(|error| Error::OutcomeUnknown(error.to_string()))
}

fn list(
    root: &Dir,
    input: ListFiles,
    cancellation: &CancellationToken,
    policy: Option<Policy<'_>>,
) -> Result<DirectoryPage, Error> {
    if !input.path.is_empty() {
        path(&input.path)?;
    }
    if input.limit == 0 || input.limit > 1024 {
        return Err(Error::Invalid("invalid directory page limit".into()));
    }

    let directory = directory(root, &input.path)?;
    let mut entries = BTreeMap::new();
    for entry in directory.entries()? {
        check(cancellation)?;
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| Error::Invalid("filename is not UTF-8".into()))?;
        if input.after.as_ref().is_some_and(|after| &name <= after) {
            continue;
        }
        if let Some(policy) = policy {
            let path = Path::new(&input.path).join(&name);
            if !policy.filesystem.access(&policy.root.join(path)).can_read() {
                continue;
            }
        }
        let kind = entry.file_type()?;
        let kind = if kind.is_file() {
            Kind::File
        } else if kind.is_dir() {
            Kind::Directory
        } else {
            Kind::Other
        };
        entries.insert(name.clone(), Entry { name, kind });
        if entries.len() > input.limit + 1 {
            entries.pop_last();
        }
    }
    let next_after = if entries.len() > input.limit {
        entries.pop_last();
        entries.last_key_value().map(|(name, _)| name.clone())
    } else {
        None
    };
    Ok(DirectoryPage {
        entries: entries.into_values().collect(),
        next_after,
    })
}

fn create_directory(root: &Dir, name: String) -> Result<(), Error> {
    path(&name)?;

    let (parent, name) = parent(root, &name)?;
    parent.create_dir(name)?;
    sync(&parent).map_err(|error| Error::OutcomeUnknown(error.to_string()))
}

fn remove(root: &Dir, name: String) -> Result<(), Error> {
    path(&name)?;

    let (parent, name) = parent(root, &name)?;
    if parent.symlink_metadata(name)?.is_dir() {
        parent.remove_dir(name)?;
    } else {
        parent.remove_file(name)?;
    }
    sync(&parent).map_err(|error| Error::OutcomeUnknown(error.to_string()))
}

fn rename(root: &Dir, from: String, to: String) -> Result<(), Error> {
    path(&from)?;
    path(&to)?;

    let (source, name) = parent(root, &from)?;
    let (target, destination) = parent(root, &to)?;
    rename_noreplace(&source, name, &target, destination)?;
    sync(&target)
        .and_then(|()| sync(&source))
        .map_err(|error| Error::OutcomeUnknown(error.to_string()))
}

#[cfg(unix)]
fn rename_noreplace(source: &Dir, from: &str, target: &Dir, to: &str) -> std::io::Result<()> {
    rustix::fs::renameat_with(source, from, target, to, rustix::fs::RenameFlags::NOREPLACE)?;
    Ok(())
}
#[cfg(windows)]
fn rename_noreplace(source: &Dir, from: &str, target: &Dir, to: &str) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
    let source = directory_path(source)?.join(from);
    let target = directory_path(target)?.join(to);
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // cap-std directory handles exclude FILE_SHARE_DELETE: parents stay pinned.
    // Omitting REPLACE_EXISTING preserves a concurrently created destination.
    // SAFETY: both terminated paths remain live for this synchronous call.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(windows)]
fn directory_path(directory: &Dir) -> std::io::Result<std::path::PathBuf> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 512];
    loop {
        // SAFETY: a live directory handle and a writable buffer of the supplied size.
        let size = unsafe {
            GetFinalPathNameByHandleW(
                directory.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if size == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if (size as usize) < buffer.len() {
            return Ok(std::ffi::OsString::from_wide(&buffer[..size as usize]).into());
        }
        if size > 32768 {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        buffer.resize(size as usize + 1, 0);
    }
}

fn stat(root: &Dir, name: String) -> Result<Metadata, Error> {
    path(&name)?;
    let (parent, name) = parent(root, &name)?;
    let metadata = parent.symlink_metadata(name)?;
    let kind = if metadata.is_file() {
        Kind::File
    } else if metadata.is_dir() {
        Kind::Directory
    } else {
        Kind::Other
    };
    if metadata.len() > MAX_OFFSET {
        return Err(Error::Invalid("file exceeds supported offset range".into()));
    }
    #[cfg(unix)]
    let mode = {
        use cap_std::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    };
    #[cfg(windows)]
    let mode = if metadata.permissions().readonly() {
        0o400
    } else {
        0o600
    };
    Ok(Metadata {
        kind,
        size: metadata.len(),
        mode,
    })
}

/// The same portable relative names accepted by the scoped file operations.
pub fn validate_path(value: &str) -> Result<(), Error> {
    path(value)
}

fn path(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || value.chars().any(char::is_control)
        || value.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
        || value
            .split('/')
            .any(|part| part.is_empty() || part.ends_with(['.', ' ']) || reserved(part))
    {
        return Err(Error::Invalid("expected a relative file path".into()));
    }
    Ok(())
}
fn reserved(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or_default();
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}
fn directory(root: &Dir, path: &str) -> Result<Dir, Error> {
    let mut directory = root.try_clone()?;
    if !path.is_empty() {
        for part in path.split('/') {
            directory = directory.open_dir_nofollow(part)?;
        }
    }
    Ok(directory)
}
fn parent<'a>(root: &Dir, path: &'a str) -> Result<(Dir, &'a str), Error> {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    Ok((directory(root, parent)?, name))
}
fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    options
}
fn sync(directory: &Dir) -> io::Result<()> {
    #[cfg(unix)]
    {
        directory.open(".")?.sync_all()
    }
    #[cfg(windows)]
    {
        // File contents are flushed. There is no portable directory fsync;
        // namespace mutations do not promise persistence across power loss.
        let _ = directory;
        Ok(())
    }
}

fn check(cancellation: &CancellationToken) -> Result<(), Error> {
    if cancellation.is_cancelled() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}
