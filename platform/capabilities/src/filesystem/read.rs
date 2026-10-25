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

//! Read-only input capabilities; never execution authority.
mod file;
#[cfg(test)]
mod scoped;
use super::directory::Directory;
use crate::Error;
use crate::filesystem::entries::DirectoryPage;
use crate::filesystem::entries::Entry;
use crate::filesystem::entries::FilePage;
use crate::filesystem::entries::Kind;
use crate::filesystem::entries::ListFiles;
use crate::filesystem::entries::ReadFile;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::OpenOptions;
pub use file::{FileInfo, OpenFile, PinnedFile, PinnedReader, ReadRange};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Read, Seek, SeekFrom},
    path::{Component, Path},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

/// Whether to resolve the final component's symlink inside the admitted root.
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Symlinks {
    #[default]
    Follow,
    Reject,
}
impl Symlinks {
    fn follow(self) -> bool {
        matches!(self, Self::Follow)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadInput {
    #[serde(flatten)]
    pub file: ReadFile,
    #[serde(default)]
    pub symlinks: Symlinks,
}
impl From<ReadFile> for ReadInput {
    fn from(file: ReadFile) -> Self {
        Self {
            file,
            symlinks: Symlinks::Follow,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    #[serde(flatten)]
    pub files: ListFiles,
    #[serde(default)]
    pub symlinks: Symlinks,
}
impl From<ListFiles> for ListInput {
    fn from(files: ListFiles) -> Self {
        Self {
            files,
            symlinks: Symlinks::Follow,
        }
    }
}
/// I/O classifications survive the native API; missing optional inputs are not failures.
#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("read capability is retired")]
    Retired,
    #[error("invalid read operation: {0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}
impl From<ReadError> for Error {
    fn from(error: ReadError) -> Self {
        match error {
            ReadError::Retired => Self::Retired,
            error => Self::Invalid(error.to_string()),
        }
    }
}

/// Revalidate an authenticated read scope before each batch. Lifecycle alone
/// is not authorization; this contract is implemented by the embedding.
pub trait ReadAuthorization: Send + Sync {
    fn check(&self) -> futures_util::future::BoxFuture<'_, Result<crate::call::Ticket, ReadError>>;
}

/// Embedding-owned root. Only the embedding decides which directory to expose.
#[derive(Clone)]
pub struct ReadRoot {
    directory: Directory,
    files: Option<Arc<BTreeSet<String>>>,
    open_files: Arc<tokio::sync::Semaphore>,
}
impl ReadRoot {
    /// Compare captured read targets and restrictions without granting or
    /// restoring access. A replaced pathname cannot change the held identity.
    pub fn execution_basis(&self) -> io::Result<serde_json::Value> {
        serde_json::to_value((self.directory.execution_basis()?, &self.files))
            .map_err(io::Error::other)
    }

    /// Capture on the embedding's blocking worker, before publishing a view.
    pub fn capture(path: impl AsRef<Path>) -> io::Result<Self> {
        Directory::capture(path.as_ref()).map(|directory| Self {
            directory,
            files: None,
            open_files: Arc::new(tokio::sync::Semaphore::new(32)),
        })
    }

    pub fn restrict(
        mut self,
        policy: Arc<maka_sandbox::filesystem::Compiled>,
    ) -> Result<Self, Error> {
        self.directory = self.directory.restrict(policy)?;
        Ok(self)
    }
    pub fn bind_authorized(
        &self,
        scope: &crate::call::Scope,
        authorization: Arc<dyn ReadAuthorization>,
    ) -> ReadDirectory {
        let mut view = self.bind_scope(scope);
        view.authorization = Some(authorization);
        view
    }
    /// Capture an embedding-owned handle. The path is display metadata; reads
    /// continue through the handle even if that pathname is replaced.
    pub fn from_handle(directory: cap_std::fs::Dir, path: std::path::PathBuf) -> Self {
        Self {
            directory: Directory::from_handle(directory, path),
            files: None,
            open_files: Arc::new(tokio::sync::Semaphore::new(32)),
        }
    }
    pub async fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref().to_owned();
        tokio::task::spawn_blocking(move || Self::capture(path))
            .await
            .map_err(io::Error::other)?
    }
    /// Restrict a mount to relative files or subtrees (names ending in '/').
    pub fn select(mut self, files: BTreeSet<String>) -> Result<Self, Error> {
        for path in &files {
            relative(path.trim_end_matches('/'))?;
        }
        self.files = Some(Arc::new(files));
        Ok(self)
    }
    /// Bind an already authorized root to the original application call. The
    /// scope supplies cancellation and worker custody, never filesystem access.
    pub fn bind_scope(&self, scope: &crate::call::Scope) -> ReadDirectory {
        ReadDirectory {
            root: self.directory.clone(),
            files: self.files.clone(),
            owner: ReadOwner(scope.clone()),
            cancellation: scope.cancellation.clone(),
            authorization: None,
            open_files: self.open_files.clone(),
        }
    }
}

/// Relative paths, bounded reads and directory pages; no raw handles or writes.
/// Borrowed callback views expire when the callback ends.
#[derive(Clone)]
pub struct ReadDirectory {
    root: Directory,
    files: Option<Arc<BTreeSet<String>>>,
    owner: ReadOwner,
    cancellation: CancellationToken,
    authorization: Option<Arc<dyn ReadAuthorization>>,
    open_files: Arc<tokio::sync::Semaphore>,
}
#[derive(Clone)]
struct ReadOwner(crate::call::Scope);
impl ReadOwner {
    fn admit(&self) -> Result<crate::call::Ticket, ReadError> {
        self.0.resources.reserve().map_err(|_| ReadError::Retired)
    }
    fn spawn_resource<F>(
        &self,
        task: impl FnOnce(CancellationToken) -> F,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<(), String>>, ReadError>
    where
        F: Future<Output = Result<(), String>> + Send + 'static,
    {
        use futures_util::FutureExt;
        let mut ticket = self.admit()?;
        let future = task(self.0.cancellation.clone());
        let (send, receive) = tokio::sync::oneshot::channel();
        ticket.start();
        tokio::spawn(async move {
            let result = std::panic::AssertUnwindSafe(future)
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err("read resource worker panicked".into()));
            ticket.complete(result.clone());
            let _ = send.send(result);
        });
        Ok(receive)
    }
}
impl ReadDirectory {
    /// Display location only. It never grants authority to reopen the pathname.
    pub fn location(&self) -> std::path::PathBuf {
        self.root.path().to_owned()
    }
    /// Batch native reads on one blocking worker. The borrowed adapter cannot
    /// escape, exposes the same bounded operations as JS, and checks cancellation
    /// on each operation. The resource lease remains with the worker if its caller drops.
    pub async fn with_reader<T: Send + 'static>(
        &self,
        work: impl FnOnce(Reader<'_>) -> T + Send + 'static,
    ) -> Result<T, ReadError> {
        if self.cancellation.is_cancelled() {
            return Err(ReadError::Retired);
        }
        let mut lease = self.owner.admit()?;
        let mut ticket = if let Some(authorization) = &self.authorization {
            tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => return Err(ReadError::Retired),
                result = authorization.check() => Some(result?),
            }
        } else {
            None
        };
        let view = self.clone();
        tokio::task::spawn_blocking(move || {
            let reader = Reader { view: &view };
            reader.check()?;
            lease.start();
            if let Some(ticket) = &mut ticket {
                ticket.start();
            }
            let result = work(reader);
            if let Some(ticket) = ticket {
                ticket.complete(Ok(()));
            }
            lease.complete(Ok(()));
            Ok(result)
        })
        .await
        .map_err(|error| ReadError::Io(io::Error::other(error)))?
    }

    pub async fn read(&self, input: impl Into<ReadInput>) -> Result<FilePage, ReadError> {
        let input = input.into();
        self.with_reader(move |reader| reader.read(input)).await?
    }
    pub async fn list(&self, input: impl Into<ListInput>) -> Result<DirectoryPage, ReadError> {
        let input = input.into();
        self.with_reader(move |reader| reader.list(input)).await?
    }

    /// Observe a regular file without retaining an open-file resource.
    pub async fn file_info(&self, input: OpenFile) -> Result<FileInfo, ReadError> {
        self.with_reader(move |reader| reader.file_info(input))
            .await?
    }

    /// Pin a regular file and its current length, not immutable contents. The
    /// consumer detects in-place changes when its format needs a stable snapshot.
    /// At most 32 files may be held across views of the same admitted root.
    pub async fn open_file(&self, input: OpenFile) -> Result<PinnedFile, ReadError> {
        let slot = self
            .open_files
            .clone()
            .try_acquire_owned()
            .map_err(|_| invalid("open-file capacity exceeded; close unused files"))?;
        let (file, info, slot) = self
            .with_reader(move |reader| {
                let (file, metadata) = reader.open(&input.path, input.symlinks)?;
                let info = FileInfo::capture(&metadata)?;
                Ok::<_, ReadError>((file, info, slot))
            })
            .await??;
        PinnedFile::new(self.clone(), file, info, slot)
    }
}

/// A synchronous, borrowed read capability for native batch algorithms.
/// No mutable file, directory handle or ambient pathname is exposed.
pub struct Reader<'a> {
    view: &'a ReadDirectory,
}
impl Reader<'_> {
    pub fn file_info(&self, input: OpenFile) -> Result<FileInfo, ReadError> {
        let (_, metadata) = self.open(&input.path, input.symlinks)?;
        FileInfo::capture(&metadata)
    }
    fn check(&self) -> Result<(), ReadError> {
        if self.view.cancellation.is_cancelled() {
            Err(ReadError::Retired)
        } else {
            Ok(())
        }
    }
    pub fn read(&self, input: impl Into<ReadInput>) -> Result<FilePage, ReadError> {
        self.check()?;
        let ReadInput {
            file: input,
            symlinks,
        } = input.into();
        if input.limit == 0 || input.offset > (1_u64 << 53) - 1 {
            return Err(invalid("invalid read range"));
        }
        let (mut file, metadata) = self.open(&input.path, symlinks)?;
        file.seek(SeekFrom::Start(input.offset))?;
        let remaining = metadata.len().saturating_sub(input.offset);
        let extent = remaining.min(u64::try_from(input.limit).unwrap_or(u64::MAX));
        let mut reader = file.take(extent);
        let mut bytes = Vec::new();
        let mut chunk = [0; 8192];
        while reader.limit() != 0 {
            self.check()?;
            let count = reader.read(&mut chunk)?;
            if count == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "file changed within its captured read extent",
                )
                .into());
            }
            bytes.try_reserve(count).map_err(std::io::Error::other)?;
            bytes.extend_from_slice(&chunk[..count]);
        }
        self.check()?;
        let next_offset = if remaining > extent {
            Some(
                input
                    .offset
                    .checked_add(extent)
                    .filter(|offset| *offset < (1_u64 << 53))
                    .ok_or_else(|| invalid("read offset cannot be represented"))?,
            )
        } else {
            None
        };
        Ok(FilePage { bytes, next_offset })
    }

    fn open(
        &self,
        path: &str,
        symlinks: Symlinks,
    ) -> Result<(cap_std::fs::File, cap_std::fs::Metadata), ReadError> {
        self.check()?;
        relative(path)?;
        if self
            .view
            .files
            .as_ref()
            .is_some_and(|files| !selected(files, Path::new(path)))
        {
            return Err(invalid("file is outside the mounted input selection"));
        }
        let (parent, name) = self.view.root.resolve(Path::new(path), symlinks.follow())?;
        if self.view.files.as_ref().is_some_and(|files| {
            let path = parent.relative(Path::new(&name));
            !selected(files, &path)
        }) {
            return Err(invalid(
                "link target is outside the mounted input selection",
            ));
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = parent.dir().open_with(name, &options)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(invalid("expected a regular file"));
        }
        Ok((file, metadata))
    }

    pub fn list(&self, input: impl Into<ListInput>) -> Result<DirectoryPage, ReadError> {
        self.check()?;
        let ListInput {
            files: input,
            symlinks,
        } = input.into();
        if input.limit == 0 || input.limit > 1024 {
            return Err(invalid("invalid directory page"));
        }
        let mut entries = BTreeMap::new();
        self.visit_directory(&input.path, symlinks, |entry| {
            if input.after.as_ref().is_none_or(|after| &entry.name > after) {
                entries.insert(entry.name.clone(), entry);
                if entries.len() > input.limit + 1 {
                    entries.pop_last();
                }
            }
            Ok::<_, ReadError>(())
        })?;
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

    /// Visit authorized entries once in filesystem order, checking cancellation
    /// between entries. Pagination bounds retained output, not source size.
    pub fn visit_directory<E: From<ReadError>>(
        &self,
        path: &str,
        symlinks: Symlinks,
        mut visit: impl FnMut(Entry) -> Result<(), E>,
    ) -> Result<(), E> {
        self.check()?;
        if !path.is_empty() {
            relative(path)?;
        }
        let directory = self
            .view
            .root
            .open(Path::new(path), symlinks.follow())
            .map_err(ReadError::from)?;
        if self
            .view
            .files
            .as_ref()
            .is_some_and(|files| !visible(files, &directory.relative(Path::new(""))))
        {
            return Err(invalid("directory is outside the mounted input selection").into());
        }
        for entry in directory.dir().entries().map_err(ReadError::from)? {
            self.check()?;
            let entry = entry.map_err(ReadError::from)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| invalid("filename is not UTF-8"))?;
            let entry_path = if path.is_empty() {
                name.clone()
            } else {
                format!("{path}/{name}")
            };
            if self.view.files.as_ref().is_some_and(|files| {
                !visible(files, Path::new(&entry_path))
                    || !visible(files, &directory.relative(Path::new(&name)))
            }) {
                continue;
            }
            if !directory.readable(Path::new(&name)) {
                continue;
            }
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(ReadError::from(error).into()),
            };
            let kind = if kind.is_file() {
                Kind::File
            } else if kind.is_dir() {
                Kind::Directory
            } else {
                Kind::Other
            };
            visit(Entry { name, kind })?;
        }
        Ok(())
    }
}
fn relative(path: &str) -> Result<(), ReadError> {
    if path.is_empty()
        || path.chars().any(char::is_control)
        || path.contains(['\\', ':'])
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(invalid("expected a relative read-view path"));
    }
    Ok(())
}
fn selected(files: &BTreeSet<String>, path: &Path) -> bool {
    files.iter().any(|file| {
        if file.ends_with('/') {
            path.starts_with(file.trim_end_matches('/'))
        } else {
            Path::new(file) == path
        }
    })
}
fn visible(files: &BTreeSet<String>, path: &Path) -> bool {
    selected(files, path)
        || files
            .iter()
            .any(|file| Path::new(file.trim_end_matches('/')).starts_with(path))
}
fn invalid(error: impl ToString) -> ReadError {
    ReadError::Invalid(error.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn scope() -> crate::call::Scope {
        crate::call::Issuer::default()
            .issue(
                crate::call::Identity::Remote {
                    request_id: uuid::Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .unwrap()
    }

    #[test]
    fn execution_basis_tracks_held_directories_aliases_and_read_restrictions() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source");
        std::fs::create_dir(&path).unwrap();
        let root = ReadRoot::capture(&path).unwrap();
        let basis = root.execution_basis().unwrap();
        assert_eq!(
            ReadRoot::capture(&path).unwrap().execution_basis().unwrap(),
            basis
        );
        std::fs::write(path.join("new-file"), b"mutable data").unwrap();
        assert_eq!(root.execution_basis().unwrap(), basis);
        assert_ne!(
            root.clone()
                .select(["new-file".into()].into())
                .unwrap()
                .execution_basis()
                .unwrap(),
            basis
        );
        let policy = Arc::new(
            maka_sandbox::filesystem::Policy {
                default: maka_sandbox::filesystem::Access::Deny,
                rules: vec![],
                deny_globs: vec![],
            }
            .compile()
            .unwrap(),
        );
        assert_ne!(
            root.clone()
                .restrict(policy)
                .unwrap()
                .execution_basis()
                .unwrap(),
            basis
        );
        let same_handle_other_alias = ReadRoot::from_handle(
            cap_std::fs::Dir::open_ambient_dir(&path, cap_std::ambient_authority()).unwrap(),
            temporary.path().join("alias"),
        );
        assert_ne!(same_handle_other_alias.execution_basis().unwrap(), basis);
        std::fs::rename(&path, temporary.path().join("original")).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert_eq!(root.execution_basis().unwrap(), basis);
        assert_ne!(
            ReadRoot::capture(&path).unwrap().execution_basis().unwrap(),
            basis
        );
    }

    #[tokio::test]
    async fn reads_keep_mount_boundaries_and_end_with_the_callback_or_owner() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("allowed"), b"abcdef").unwrap();
        std::fs::write(directory.path().join("private"), b"secret").unwrap();
        let owner = scope();
        let root = ReadRoot::open(directory.path()).await.unwrap();
        let restricted = root.clone().select(["allowed".into()].into()).unwrap();
        let cancellation = owner.cancellation.clone();
        let view = restricted.bind_scope(&owner);
        let read = |path: &str| ReadFile {
            path: path.into(),
            offset: 0,
            limit: 3,
        };
        let protected = root
            .clone()
            .restrict(Arc::new(
                maka_sandbox::filesystem::Policy {
                    default: maka_sandbox::filesystem::Access::Read,
                    rules: vec![maka_sandbox::filesystem::Rule::exact(
                        dunce::canonicalize(directory.path())
                            .unwrap()
                            .join("private"),
                        maka_sandbox::filesystem::Access::Deny,
                    )],
                    deny_globs: vec![],
                }
                .compile()
                .unwrap(),
            ))
            .unwrap()
            .bind_scope(&owner);
        assert!(protected.read(read("private")).await.is_err());
        assert_eq!(protected.read(read("allowed")).await.unwrap().bytes, b"abc");
        assert!(matches!(
            protected.read(read("missing")).await,
            Err(ReadError::Io(error)) if error.kind() == io::ErrorKind::NotFound
        ));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("private", directory.path().join("private-alias")).unwrap();
            assert!(protected.read(read("private-alias")).await.is_err());
        }
        let page = view.read(read("allowed")).await.unwrap();
        assert_eq!(page.bytes, b"abc");
        assert_eq!(page.next_offset, Some(3));
        assert!(view.read(read("private")).await.is_err());
        let page = view
            .list(ListFiles {
                path: String::new(),
                after: None,
                limit: 10,
            })
            .await
            .unwrap();
        assert_eq!(
            page.entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["allowed"]
        );
        let workspace = root.bind_scope(&owner);
        assert!(workspace.read(read("../private")).await.is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("secret"), b"outside").unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("secret"),
                directory.path().join("escape"),
            )
            .unwrap();
            assert!(workspace.read(read("escape")).await.is_err());
            std::os::unix::fs::symlink("allowed", directory.path().join("alias")).unwrap();
            assert_eq!(workspace.read(read("alias")).await.unwrap().bytes, b"abc");
            let reject: ReadInput = serde_json::from_value(serde_json::json!({
                "path": "alias", "limit": 3, "symlinks": "reject"
            }))
            .unwrap();
            assert!(workspace.read(reject).await.is_err());
            std::os::unix::fs::symlink(
                directory.path().join("allowed"),
                directory.path().join("absolute"),
            )
            .unwrap();
            assert_eq!(
                workspace.read(read("absolute")).await.unwrap().bytes,
                b"abc"
            );
            assert_eq!(
                protected.read(read("absolute")).await.unwrap().bytes,
                b"abc"
            );
            let selected_alias = root
                .clone()
                .select(["alias".into()].into())
                .unwrap()
                .bind_scope(&owner);
            assert!(
                selected_alias.read(read("alias")).await.is_err(),
                "selection must constrain link targets too"
            );

            let moved = directory.path().with_extension("retained");
            std::fs::rename(directory.path(), &moved).unwrap();
            std::fs::create_dir(directory.path()).unwrap();
            std::fs::write(directory.path().join("allowed"), "wrong").unwrap();
            assert_eq!(
                workspace.read(read("absolute")).await.unwrap().bytes,
                b"abc"
            );
            // Return the fixture to its temporary owner for automatic cleanup.
            std::fs::remove_file(directory.path().join("allowed")).unwrap();
            std::fs::remove_dir(directory.path()).unwrap();
            std::fs::rename(moved, directory.path()).unwrap();
        }
        cancellation.cancel();
        assert!(matches!(
            view.read(read("allowed")).await,
            Err(ReadError::Retired)
        ));
        owner.finish().await.unwrap();
        let independent_owner = scope();
        let independent = restricted.bind_scope(&independent_owner);
        assert_eq!(
            independent.read(read("allowed")).await.unwrap().bytes,
            b"abc"
        );
        independent_owner.finish().await.unwrap();
        assert!(matches!(
            independent.read(read("allowed")).await,
            Err(ReadError::Retired)
        ));
    }
}
