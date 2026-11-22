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

use super::{ReadDirectory, ReadError, Symlinks, invalid};
use crate::filesystem::entries::FilePage;
use cap_std::fs::File;
use futures_util::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Seek, SeekFrom},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use tokio::sync::OwnedSemaphorePermit;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenFile {
    pub path: String,
    #[serde(default)]
    pub symlinks: Symlinks,
}
impl From<String> for OpenFile {
    fn from(path: String) -> Self {
        Self {
            path,
            symlinks: Symlinks::Follow,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRange {
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "page_size")]
    pub limit: usize,
}
fn page_size() -> usize {
    64 * 1024
}
impl Default for ReadRange {
    fn default() -> Self {
        Self {
            offset: 0,
            limit: page_size(),
        }
    }
}

/// Metadata observed at open time, not a content digest or execution authority.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub length: u64,
    pub modified_at: Option<u64>,
}
impl FileInfo {
    pub(super) fn capture(metadata: &cap_std::fs::Metadata) -> Result<Self, ReadError> {
        if metadata.len() > (1_u64 << 53) - 1 {
            return Err(invalid("file length exceeds the wire range"));
        }
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.into_std().duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok())
            .filter(|time| *time < (1_u64 << 53));
        Ok(Self {
            length: metadata.len(),
            modified_at,
        })
    }
}

struct State {
    file: Arc<Mutex<Option<File>>>,
    info: FileInfo,
    closed: CancellationToken,
    completion: Shared<BoxFuture<'static, Result<(), String>>>,
}
impl Drop for State {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}

/// A fixed file object and readable prefix. Appends are excluded; in-place
/// changes remain observable. Use format-level digests when multiple passes must
/// agree. Neither Rust nor JS receives a raw handle or permission to reopen a path.
#[derive(Clone)]
pub struct PinnedFile {
    view: ReadDirectory,
    inner: Arc<State>,
}
impl PinnedFile {
    pub(super) fn new(
        view: ReadDirectory,
        file: File,
        info: FileInfo,
        slot: OwnedSemaphorePermit,
    ) -> Result<Self, ReadError> {
        let file = Arc::new(Mutex::new(Some(file)));
        let closed = CancellationToken::new();
        let resource = file.clone();
        let closing = closed.clone();
        let source = view.cancellation.clone();
        let completion = view
            .owner
            .spawn_resource(move |stop| async move {
                tokio::select! {
                    _ = source.cancelled() => {},
                    _ = closing.cancelled() => {},
                    _ = stop.cancelled() => {},
                }
                closing.cancel();
                // Wait for accepted bounded reads off the async worker. The permit
                // is returned only when the OS handle is actually released.
                tokio::task::spawn_blocking(move || {
                    resource.lock().unwrap().take();
                    drop(slot);
                })
                .await
                .map_err(|error| error.to_string())?;
                Ok(())
            })
            .map_err(|_| ReadError::Retired)?;
        Ok(Self {
            view,
            inner: Arc::new(State {
                file,
                info,
                closed,
                completion: async move { completion.await.map_err(|error| error.to_string())? }
                    .boxed()
                    .shared(),
            }),
        })
    }

    pub fn info(&self) -> &FileInfo {
        &self.inner.info
    }

    pub fn is_released(&self) -> bool {
        self.inner
            .completion
            .clone()
            .now_or_never()
            .is_some_and(|result| result.is_ok())
    }

    /// Every batch rechecks current authorization and holds a resource lease
    /// through its blocking worker, including when its waiting caller disappears.
    pub async fn with_reader<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut PinnedReader<'_>) -> Result<T, ReadError> + Send + 'static,
    ) -> Result<T, ReadError> {
        let inner = self.inner.clone();
        self.view
            .with_reader(move |scope| {
                scope.check()?;
                let mut file = inner.file.lock().unwrap();
                let mut reader = PinnedReader {
                    file: file.as_mut().ok_or(ReadError::Retired)?,
                    length: inner.info.length,
                    closed: &inner.closed,
                    source: &scope.view.cancellation,
                };
                reader.check()?;
                work(&mut reader)
            })
            .await?
    }

    pub async fn read(&self, range: ReadRange) -> Result<FilePage, ReadError> {
        self.with_reader(move |reader| reader.read(range)).await
    }

    /// Idempotent, and acknowledges release instead of only requesting cleanup.
    pub async fn close(&self) -> Result<(), ReadError> {
        self.inner.closed.cancel();
        self.inner
            .completion
            .clone()
            .await
            .map_err(|error| ReadError::Io(io::Error::other(error)))
    }
}

/// Borrowed native batches use exactly the same byte and cancellation limits as JS.
pub struct PinnedReader<'a> {
    file: &'a mut File,
    length: u64,
    closed: &'a CancellationToken,
    source: &'a CancellationToken,
}
impl PinnedReader<'_> {
    fn check(&self) -> Result<(), ReadError> {
        if self.closed.is_cancelled() || self.source.is_cancelled() {
            Err(ReadError::Retired)
        } else {
            Ok(())
        }
    }

    pub fn read(&mut self, range: ReadRange) -> Result<FilePage, ReadError> {
        self.check()?;
        if range.limit == 0 || range.limit > 1024 * 1024 || range.offset > self.length {
            return Err(invalid("invalid pinned read range"));
        }
        let length = (self.length - range.offset).min(range.limit as u64) as usize;
        self.file.seek(SeekFrom::Start(range.offset))?;
        let mut bytes = vec![0; length];
        let mut read = 0;
        while read < length {
            self.check()?;
            let end = (read + 8192).min(length);
            let count = self.file.read(&mut bytes[read..end])?;
            if count == 0 {
                return Err(ReadError::Io(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "file was truncated within its pinned prefix",
                )));
            }
            read += count;
        }
        let end = range.offset + length as u64;
        Ok(FilePage {
            bytes,
            next_offset: (end < self.length).then_some(end),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filesystem::ReadRoot;
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

    use std::io::Write;

    #[tokio::test]
    async fn pinned_reads_keep_identity_bound_appends_detect_truncation_and_release_on_retirement()
    {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source");
        std::fs::write(&path, b"abcdef").unwrap();
        let owner = scope();
        let root = ReadRoot::open(directory.path()).await.unwrap();
        let cancellation = owner.cancellation.clone();
        let view = root.bind_scope(&owner);
        let open = || OpenFile::from("source".to_owned());
        let file = view.open_file(open()).await.unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"ignored")
            .unwrap();
        assert_eq!(file.info().length, 6);
        let page = file.read(ReadRange::default()).await.unwrap();
        assert_eq!(page.bytes, b"abcdef");
        assert_eq!(page.next_offset, None);
        let held = directory.path().join("held");
        std::fs::rename(&path, &held).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        let page = file
            .read(ReadRange {
                offset: 2,
                limit: 2,
            })
            .await
            .unwrap();
        assert_eq!(page.bytes, b"cd");
        assert_eq!(page.next_offset, Some(4));
        // Pinning does not pretend to freeze another process's in-place writes.
        std::fs::write(&held, b"UVWXYZ").unwrap();
        assert_eq!(
            file.read(ReadRange::default()).await.unwrap().bytes,
            b"UVWXYZ"
        );
        std::fs::OpenOptions::new()
            .write(true)
            .open(&held)
            .unwrap()
            .set_len(2)
            .unwrap();
        assert!(matches!(file.read(ReadRange::default()).await,
            Err(ReadError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof));
        file.close().await.unwrap();
        file.close().await.unwrap();
        assert!(matches!(
            file.read(ReadRange::default()).await,
            Err(ReadError::Retired)
        ));

        let mut files = Vec::new();
        // The root's handle budget is shared across independently admitted
        // calls; each call also has its own smaller worker budget.
        let mut owners = Vec::new();
        for _ in 0..8 {
            files.push(view.open_file(open()).await.unwrap());
        }
        for _ in 0..3 {
            let owner = scope();
            let view = root.bind_scope(&owner);
            for _ in 0..8 {
                files.push(view.open_file(open()).await.unwrap());
            }
            owners.push(owner);
        }
        let other_owner = scope();
        let other_view = root.bind_scope(&other_owner);
        assert!(other_view.open_file(open()).await.is_err());
        files.pop().unwrap().close().await.unwrap();
        let recovered = other_view.open_file(open()).await.unwrap();
        cancellation.cancel();
        assert!(matches!(
            files[0].read(ReadRange::default()).await,
            Err(ReadError::Retired)
        ));
        let (entered, entered_read) = tokio::sync::oneshot::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let busy = recovered.clone();
        let read = tokio::spawn(async move {
            busy.with_reader(move |reader| {
                entered.send(()).unwrap();
                resume.recv().unwrap();
                reader.read(ReadRange::default())
            })
            .await
        });
        entered_read.await.unwrap();
        let first = recovered.clone();
        let second = recovered.clone();
        let first_close = tokio::spawn(async move { first.close().await });
        let second_close = tokio::spawn(async move { second.close().await });
        recovered.inner.closed.cancelled().await;
        assert!(
            !recovered.is_released(),
            "cancellation is not a cleanup receipt"
        );
        assert!(!first_close.is_finished() && !second_close.is_finished());
        release.send(()).unwrap();
        assert!(matches!(read.await.unwrap(), Err(ReadError::Retired)));
        first_close.await.unwrap().unwrap();
        second_close.await.unwrap().unwrap();
        assert!(recovered.is_released());
        owner.finish().await.unwrap();
        other_owner.finish().await.unwrap();
        assert!(matches!(
            recovered.read(ReadRange::default()).await,
            Err(ReadError::Retired)
        ));
        for file in files {
            file.close().await.unwrap();
        }
        recovered.close().await.unwrap();
        for owner in owners {
            owner.finish().await.unwrap();
        }
    }
}
