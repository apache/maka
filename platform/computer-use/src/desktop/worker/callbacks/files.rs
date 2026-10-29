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

//! File service messages inherit the existing callback scope and joined checks.
use super::*;
#[cfg(any(feature = "native-desktop", test))]
use crate::FilesFuture;
use crate::{BrowserAssetDirectory, BrowserAssetFiles};
#[cfg(any(feature = "native-desktop", test))]
use maka_capabilities::call::ReadResource;

/// Framing follows immutable resource ingress; no whole asset enters a frame.
const CHUNK: usize = 64 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    Begin,
    WriteStart {
        directory: u64,
        name: String,
        bytes: usize,
        digest: String,
    },
    WriteChunk {
        upload: u64,
        offset: usize,
        bytes: Vec<u8>,
    },
    WriteFinish {
        upload: u64,
    },
    Commit {
        directory: u64,
    },
    Abort {
        directory: u64,
    },
}
impl Request {
    fn cleanup(&self) -> bool {
        matches!(self, Self::Abort { .. })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Reply {
    Directory { id: u64, path: String },
    Upload { id: u64 },
    Path { path: String },
    Done,
}
struct Upload {
    directory: u64,
    name: String,
    expected: usize,
    digest: String,
    bytes: Vec<u8>,
}
#[derive(Default)]
pub(super) struct Custody {
    next: u64,
    directories: HashMap<u64, Box<dyn BrowserAssetDirectory>>,
    uploads: HashMap<u64, Upload>,
}
impl Custody {
    fn id(&mut self) -> Result<u64, ToolError> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| failed("File callback identity exhausted"))?;
        Ok(self.next)
    }
    async fn execute(
        &mut self,
        files: Option<Arc<dyn BrowserAssetFiles>>,
        request: Request,
        cancellation: CancellationToken,
    ) -> Result<Reply, ToolError> {
        match request {
            Request::Begin => {
                let directory = files
                    .as_ref()
                    .ok_or_else(|| failed("Current Host file publisher is unavailable"))?
                    .begin(cancellation)
                    .await?;
                let path = directory.path().to_owned();
                let id = self.id()?;
                self.directories.insert(id, directory);
                Ok(Reply::Directory { id, path })
            }
            Request::WriteStart {
                directory,
                name,
                bytes,
                digest,
            } => {
                if !self.directories.contains_key(&directory) {
                    return Err(failed("File directory does not belong to this operation"));
                }
                let id = self.id()?;
                self.uploads.insert(
                    id,
                    Upload {
                        directory,
                        name,
                        expected: bytes,
                        digest,
                        bytes: Vec::new(),
                    },
                );
                Ok(Reply::Upload { id })
            }
            Request::WriteChunk {
                upload,
                offset,
                bytes,
            } => {
                let upload = self
                    .uploads
                    .get_mut(&upload)
                    .ok_or_else(|| failed("File upload does not belong to this operation"))?;
                if bytes.len() > CHUNK
                    || offset != upload.bytes.len()
                    || offset
                        .checked_add(bytes.len())
                        .is_none_or(|end| end > upload.expected)
                {
                    return Err(failed("File resource chunk range changed"));
                }
                if cancellation.is_cancelled() {
                    return Err(failed("File resource publication cancelled"));
                }
                upload.bytes.extend_from_slice(&bytes);
                Ok(Reply::Done)
            }
            Request::WriteFinish { upload } => {
                let upload = self
                    .uploads
                    .remove(&upload)
                    .ok_or_else(|| failed("File upload does not belong to this operation"))?;
                if upload.bytes.len() != upload.expected {
                    return Err(failed("File resource snapshot changed"));
                }
                let resource = files
                    .as_ref()
                    .ok_or_else(|| failed("Current Host file publisher is unavailable"))?
                    .snapshot(upload.name.clone(), upload.bytes)?;
                if resource.metadata()["digest"].as_str() != Some(upload.digest.as_str()) {
                    return Err(failed("File resource snapshot digest changed"));
                }
                let directory = self
                    .directories
                    .get_mut(&upload.directory)
                    .ok_or_else(|| failed("File directory does not belong to this operation"))?;
                directory
                    .write(upload.name, resource, cancellation)
                    .await
                    .map(|path| Reply::Path { path })
            }
            Request::Commit { directory } => {
                if self
                    .uploads
                    .values()
                    .any(|upload| upload.directory == directory)
                {
                    return Err(failed("File directory still has an incomplete resource"));
                }
                let directory = self
                    .directories
                    .get_mut(&directory)
                    .ok_or_else(|| failed("File directory does not belong to this operation"))?;
                directory.commit(cancellation).await?;
                Ok(Reply::Done)
            }
            Request::Abort { directory } => {
                self.uploads
                    .retain(|_, upload| upload.directory != directory);
                if let Some(directory) = self.directories.get_mut(&directory) {
                    directory.abort().await?
                }
                self.directories.remove(&directory);
                Ok(Reply::Done)
            }
        }
    }
}

impl ParentCallbacks {
    pub(super) fn file_request(
        &self,
        token: ScopeToken,
        id: u64,
        request: Request,
    ) -> Result<(), ToolError> {
        let prepared = {
            let mut state = self.0.state.lock().unwrap();
            let scope = checked_scope(&state, &token, request.cleanup())?;
            let result = if scope.sealed && !request.cleanup() {
                Err(failed("File service scope is sealed"))
            } else {
                Ok((
                    scope.capabilities.files.clone(),
                    scope.files.clone(),
                    scope.capabilities.authorization.clone(),
                    scope.invocation_id,
                ))
            };
            result.map(|(files, custody, authorization, invocation_id)| {
                let cancellation = CancellationToken::new();
                state.checks.insert((token.id, id), cancellation.clone());
                (files, custody, authorization, invocation_id, cancellation)
            })
        };
        let (files, custody, authorization, invocation_id, cancellation) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                return (self.0.send)(ParentMessage::FileResult {
                    token,
                    id,
                    result: Err(error.into()),
                });
            }
        };
        let parent = self.clone();
        tokio::spawn(async move {
            let result = AssertUnwindSafe(async {
                if !request.cleanup() {
                    authorization
                        .clone()
                        .ok_or_else(|| {
                            failed("File publication lost its original Host authorization")
                        })?
                        .check(token.key.access.clone(), cancellation.clone())
                        .await?;
                }
                // Keep the same native file future until physical settlement.
                custody
                    .lock()
                    .await
                    .execute(files, request, cancellation)
                    .await
            })
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(uncertain(
                    "Host file callback panicked before physical settlement",
                ))
            });

            let cleanup = super::super::authorization_cleanup(result.clone().map(|_| ()));
            {
                let mut state = parent.0.state.lock().unwrap();
                if let Some(error) = &cleanup {
                    state.authority_cleanup.get_or_insert(error.clone());
                }
                let _ = (parent.0.send)(ParentMessage::FileResult {
                    token: token.clone(),
                    id,
                    result: result.map_err(Failure::from),
                });
                state.checks.remove(&(token.id, id));
            }
            if let Some(error) = cleanup {
                parent.disconnect("File publication physical cleanup is unconfirmed");
                let _ = parent.0.fault.send(CallbackFault {
                    invocation_id: Some(invocation_id),
                    error,
                });
            }
            parent.prune(token.id);
        });
        Ok(())
    }
}

#[cfg(any(feature = "native-desktop", test))]
impl RemoteScope {
    async fn file_call(
        self: Arc<Self>,
        request: Request,
        cancellation: CancellationToken,
    ) -> Result<Reply, ToolError> {
        let response = {
            let _emission = self.worker.0.emission.lock().unwrap();
            let mut state = self.worker.0.state.lock().unwrap();
            if state.closed.is_some()
                || (self.sealed.load(Ordering::SeqCst) && !request.cleanup())
                || cancellation.is_cancelled() && !request.cleanup()
            {
                return Err(failed("File service scope is closed"));
            }
            let id = allocate(&self.worker.0.next)?;
            let (reply, response) = oneshot::channel();
            state.files.insert((self.token.id, id), reply);
            if let Err(error) = (self.worker.0.send)(WorkerMessage::FileRequest {
                token: self.token.clone(),
                id,
                request,
            }) {
                state.files.remove(&(self.token.id, id));
                return Err(error);
            }
            response
        };
        // Cancellation is intent. An admitted file write must still settle;
        // never race this reply against cancellation and detach physical I/O.
        response
            .await
            .map_err(|_| uncertain("File callback completion disappeared"))?
    }
}
#[cfg(any(feature = "native-desktop", test))]
struct RemoteDirectory {
    scope: Arc<RemoteScope>,
    id: u64,
    path: String,
}
#[cfg(any(feature = "native-desktop", test))]
impl BrowserAssetDirectory for RemoteDirectory {
    fn path(&self) -> &str {
        &self.path
    }
    fn write(
        &mut self,
        name: String,
        resource: Arc<dyn ReadResource>,
        cancellation: CancellationToken,
    ) -> FilesFuture<String> {
        let scope = self.scope.clone();
        let directory = self.id;
        Box::pin(async move {
            let metadata = resource.metadata();
            let digest = metadata["digest"]
                .as_str()
                .ok_or_else(|| failed("File resource has no immutable digest"))?
                .to_owned();
            let upload = match scope
                .clone()
                .file_call(
                    Request::WriteStart {
                        directory,
                        name,
                        bytes: resource.bytes(),
                        digest,
                    },
                    cancellation.clone(),
                )
                .await?
            {
                Reply::Upload { id } => id,
                _ => return Err(uncertain("File upload response changed kind")),
            };
            let mut offset = 0;
            while offset < resource.bytes() {
                let end = offset.saturating_add(CHUNK).min(resource.bytes());
                let bytes = resource.read(offset..end).map_err(failed)?;
                if bytes.len() != end - offset {
                    return Err(failed("Immutable file resource changed"));
                }
                scope
                    .clone()
                    .file_call(
                        Request::WriteChunk {
                            upload,
                            offset,
                            bytes,
                        },
                        cancellation.clone(),
                    )
                    .await?;
                offset = end;
            }
            match scope
                .file_call(Request::WriteFinish { upload }, cancellation)
                .await?
            {
                Reply::Path { path } => Ok(path),
                _ => Err(uncertain("File write response changed kind")),
            }
        })
    }
    fn commit(&mut self, cancellation: CancellationToken) -> FilesFuture<()> {
        let scope = self.scope.clone();
        let directory = self.id;
        Box::pin(async move {
            match scope
                .file_call(Request::Commit { directory }, cancellation)
                .await?
            {
                Reply::Done => Ok(()),
                _ => Err(uncertain("File commit response changed kind")),
            }
        })
    }
    fn abort(&mut self) -> FilesFuture<()> {
        let scope = self.scope.clone();
        let directory = self.id;
        Box::pin(async move {
            match scope
                .file_call(Request::Abort { directory }, CancellationToken::new())
                .await?
            {
                Reply::Done => Ok(()),
                _ => Err(uncertain("File abort response changed kind")),
            }
        })
    }
}
/// Keep RemoteScope alive through the last real directory handle.
#[cfg(any(feature = "native-desktop", test))]
pub(super) struct RemoteFiles {
    pub scope: Arc<RemoteScope>,
}
#[cfg(any(feature = "native-desktop", test))]
impl BrowserAssetFiles for RemoteFiles {
    fn snapshot(&self, name: String, bytes: Vec<u8>) -> Result<Arc<dyn ReadResource>, ToolError> {
        Ok(maka_capabilities::call::immutable_bytes(name, bytes))
    }
    fn begin(
        &self,
        cancellation: CancellationToken,
    ) -> FilesFuture<Box<dyn BrowserAssetDirectory>> {
        let scope = self.scope.clone();
        Box::pin(async move {
            let reply = scope
                .clone()
                .file_call(Request::Begin, cancellation.clone())
                .await?;
            let Reply::Directory { id, path } = reply else {
                return Err(uncertain("File begin response changed kind"));
            };
            let mut directory =
                Box::new(RemoteDirectory { scope, id, path }) as Box<dyn BrowserAssetDirectory>;
            if cancellation.is_cancelled() {
                directory.abort().await?;
                return Err(failed("File directory creation cancelled"));
            }
            Ok(directory)
        })
    }
}
