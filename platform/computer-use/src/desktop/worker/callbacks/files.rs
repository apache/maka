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
#[cfg(feature = "native-desktop")]
use crate::FilesFuture;
use crate::{BrowserAssetDirectory, BrowserAssetFiles};
#[cfg(feature = "native-desktop")]
use maka_capabilities::call::ReadResource;

/// Framing follows immutable resource ingress; no whole asset enters a frame.
const CHUNK: usize = 64 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    Begin,
    UploadPrepare {
        request: crate::BrowserUploadRequest,
    },
    UploadCheck {
        request: crate::BrowserUploadRequest,
    },
    UploadRead {
        input: u64,
        index: usize,
        offset: usize,
        end: usize,
    },
    UploadRelease {
        input: u64,
    },
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
        matches!(self, Self::Abort { .. } | Self::UploadRelease { .. })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Reply {
    Directory {
        id: u64,
        path: String,
    },
    Upload {
        id: u64,
    },
    Path {
        path: String,
    },
    Done,
    Inputs {
        id: u64,
        files: Vec<InputDescriptor>,
    },
    Bytes {
        bytes: Vec<u8>,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputDescriptor {
    name: String,
    bytes: usize,
    digest: String,
    #[serde(default)]
    modified: Option<serde_json::Value>,
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
    inputs: HashMap<u64, Vec<crate::BrowserUploadFile>>,
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
        authorization: Option<Arc<dyn BrowserAuthorization>>,
        cancellation: CancellationToken,
    ) -> Result<Reply, ToolError> {
        match request {
            Request::UploadPrepare { request } => {
                let captured = authorization
                    .ok_or_else(|| failed("Upload snapshot lost its original Host authorization"))?
                    .prepare_upload(request, cancellation)
                    .await?;
                let descriptors = captured
                    .iter()
                    .map(|file| {
                        let metadata = file.resource.metadata();
                        let digest = metadata["digest"]
                            .as_str()
                            .ok_or_else(|| failed("Upload resource has no immutable digest"))?
                            .to_owned();
                        Ok(InputDescriptor {
                            name: file.name.clone(),
                            bytes: file.resource.bytes(),
                            digest,
                            modified: metadata.get("modified").cloned(),
                        })
                    })
                    .collect::<Result<Vec<_>, ToolError>>()?;
                let id = self.id()?;
                self.inputs.insert(id, captured);
                Ok(Reply::Inputs {
                    id,
                    files: descriptors,
                })
            }
            Request::UploadCheck { request } => {
                authorization
                    .ok_or_else(|| failed("Upload check lost its original Host authorization"))?
                    .check_upload(request, cancellation)
                    .await?;
                Ok(Reply::Done)
            }
            Request::UploadRead {
                input,
                index,
                offset,
                end,
            } => {
                if end.checked_sub(offset).is_none_or(|count| count > CHUNK) {
                    return Err(failed("Invalid upload resource range"));
                }
                let file = self
                    .inputs
                    .get(&input)
                    .and_then(|files| files.get(index))
                    .ok_or_else(|| failed("Upload resource does not belong to this operation"))?;
                let bytes = file.resource.read(offset..end).map_err(failed)?;
                if bytes.len() != end - offset {
                    return Err(failed("Upload resource snapshot changed"));
                }
                Ok(Reply::Bytes { bytes })
            }
            Request::UploadRelease { input } => {
                self.inputs.remove(&input);
                Ok(Reply::Done)
            }
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
        if let Request::UploadPrepare { request } | Request::UploadCheck { request } = &request {
            if request.document != *token.key.access.document() {
                return Err(failed("Upload snapshot changed its bound document"));
            }
        }
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
                    .execute(files, request, authorization, cancellation)
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

#[cfg(feature = "native-desktop")]
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
#[cfg(feature = "native-desktop")]
struct RemoteDirectory {
    scope: Arc<RemoteScope>,
    id: u64,
    path: String,
}
#[cfg(feature = "native-desktop")]
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
#[cfg(feature = "native-desktop")]
pub(super) struct RemoteFiles {
    pub scope: Arc<RemoteScope>,
}
#[cfg(feature = "native-desktop")]
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

/// Preserve only the approved file metadata on the locally verified byte snapshot.
#[cfg(feature = "native-desktop")]
struct InputResource {
    resource: Arc<dyn ReadResource>,
    modified: Option<serde_json::Value>,
}
#[cfg(feature = "native-desktop")]
impl ReadResource for InputResource {
    fn encoding(&self) -> maka_capabilities::call::ResourceEncoding {
        self.resource.encoding()
    }
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        self.resource.resource_type()
    }
    fn bytes(&self) -> usize {
        self.resource.bytes()
    }
    fn metadata(&self) -> serde_json::Value {
        let mut metadata = self.resource.metadata();
        if let Some(modified) = &self.modified {
            metadata["modified"] = modified.clone();
        }
        metadata
    }
    fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>, String> {
        self.resource.read(range)
    }
}

#[cfg(feature = "native-desktop")]
impl WorkerCallbacks {
    pub(super) fn prepare_upload(
        &self,
        identity: ScopeIdentity,
        invocation_id: u64,
        request: crate::BrowserUploadRequest,
        cancellation: CancellationToken,
    ) -> crate::BrowserUploadFuture {
        let worker = self.clone();
        Box::pin(async move {
            let key = ScopeKey {
                identity,
                access: BrowserAccess::Metadata {
                    document: request.document.clone(),
                },
            };
            let PreparedServices { scope, .. } = worker
                .prepare_binding(invocation_id, key, cancellation.clone())
                .await?;
            let Reply::Inputs { id, files } = scope
                .clone()
                .file_call(Request::UploadPrepare { request }, cancellation.clone())
                .await?
            else {
                return Err(uncertain("Upload snapshot response changed kind"));
            };
            let result = async {
                let mut snapshots = Vec::new();
                for (index, descriptor) in files.into_iter().enumerate() {
                    let mut bytes = Vec::new();
                    let mut offset = 0;
                    while offset < descriptor.bytes {
                        let end = offset.saturating_add(CHUNK).min(descriptor.bytes);
                        let Reply::Bytes { bytes: chunk } = scope
                            .clone()
                            .file_call(
                                Request::UploadRead {
                                    input: id,
                                    index,
                                    offset,
                                    end,
                                },
                                cancellation.clone(),
                            )
                            .await?
                        else {
                            return Err(uncertain("Upload resource response changed kind"));
                        };
                        if chunk.len() != end - offset {
                            return Err(failed("Upload resource range changed"));
                        }
                        bytes.extend_from_slice(&chunk);
                        offset = end;
                    }
                    let resource =
                        maka_capabilities::call::immutable_bytes(descriptor.name.clone(), bytes);
                    if resource.bytes() != descriptor.bytes
                        || resource.metadata()["digest"].as_str()
                            != Some(descriptor.digest.as_str())
                    {
                        return Err(failed("Upload snapshot digest changed"));
                    }
                    snapshots.push(crate::BrowserUploadFile {
                        name: descriptor.name,
                        resource: Arc::new(InputResource {
                            resource,
                            modified: descriptor.modified,
                        }),
                    });
                }
                Ok(snapshots)
            }
            .await;
            // Release is metadata-only cleanup and remains valid after sealing.
            let release = scope
                .file_call(
                    Request::UploadRelease { input: id },
                    CancellationToken::new(),
                )
                .await;
            match (result, release) {
                (Ok(files), Ok(Reply::Done)) => Ok(files),
                (Err(error), Ok(Reply::Done)) => Err(error),
                (_, Err(error)) => Err(error),
                _ => Err(uncertain("Upload release response changed kind")),
            }
        })
    }
    pub(super) fn check_upload(
        &self,
        identity: ScopeIdentity,
        invocation_id: u64,
        request: crate::BrowserUploadRequest,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let worker = self.clone();
        Box::pin(async move {
            let key = ScopeKey {
                identity,
                access: BrowserAccess::Metadata {
                    document: request.document.clone(),
                },
            };
            let PreparedServices { scope, .. } = worker
                .prepare_binding(invocation_id, key, cancellation.clone())
                .await?;
            match scope
                .file_call(Request::UploadCheck { request }, cancellation)
                .await?
            {
                Reply::Done => Ok(()),
                _ => Err(uncertain("Upload check response changed kind")),
            }
        })
    }
}

#[cfg(all(test, feature = "native-desktop"))]
mod modified_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct Authority {
        resource: Arc<dyn ReadResource>,
        checks: Arc<AtomicUsize>,
    }
    impl BrowserAuthorization for Authority {
        fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            panic!("metadata transport cannot request a new grant");
        }
        fn check(&self, _: BrowserAccess, cancellation: CancellationToken) -> AuthorizationFuture {
            self.checks.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if cancellation.is_cancelled() {
                    Err(failed("fixture scope cancelled"))
                } else {
                    Ok(())
                }
            })
        }
        fn prepare_upload(
            &self,
            _: crate::BrowserUploadRequest,
            _: CancellationToken,
        ) -> crate::BrowserUploadFuture {
            let resource = self.resource.clone();
            Box::pin(async move {
                Ok(vec![crate::BrowserUploadFile {
                    name: "source.bin".into(),
                    resource,
                }])
            })
        }
    }

    #[tokio::test]
    async fn upload_callback_roundtrip_preserves_actual_modified_metadata() {
        for modified in [
            Some(serde_json::json!({"seconds":-1_i64,"nanos":500_000_000_u32})),
            Some(serde_json::json!({"seconds":1_700_000_000_i64,"nanos":123_456_789_u32})),
            None,
        ] {
            let bytes: Vec<u8> = (0u8..=255).cycle().take(CHUNK + 17).collect();
            let original =
                maka_capabilities::call::immutable_bytes("source.bin".into(), bytes.clone());
            let expected_digest = original.metadata()["digest"].clone();
            let checks = Arc::new(AtomicUsize::new(0));
            let authority = Arc::new(Authority {
                resource: Arc::new(InputResource {
                    resource: original,
                    modified: modified.clone(),
                }),
                checks: checks.clone(),
            });
            let (parent_send, mut parent_messages) = mpsc::unbounded_channel();
            let (worker_send, mut worker_messages) = mpsc::unbounded_channel();
            let (fault, mut faults) = mpsc::unbounded_channel();
            let parent = ParentCallbacks::new(
                Arc::new(move |message| {
                    parent_send
                        .send(message)
                        .map_err(|_| failed("fixture parent closed"))
                }),
                fault,
            );
            let worker = WorkerCallbacks::new(Arc::new(move |message| {
                worker_send
                    .send(message)
                    .map_err(|_| failed("fixture worker closed"))
            }));
            let identity = ScopeIdentity {
                owner: "modified-owner".into(),
                epoch: "modified-epoch".into(),
                session: "modified-session".into(),
                turn: "modified-turn".into(),
                operation_id: "modified-operation".into(),
            };
            let request = crate::BrowserUploadRequest {
                document: crate::BrowserDocument {
                    browser_id: "fixture-browser".into(),
                    generation: "fixture-generation".into(),
                    tab_id: "fixture-tab".into(),
                    url: "https://fixture.test/".into(),
                },
                source_origin: BrowserAttachmentOrigin::Site("https://fixture.test".into()),
                files: vec!["source.bin".into()],
            };
            let mut transferring =
                worker.prepare_upload(identity.clone(), 17, request, CancellationToken::new());
            let mut reads = 0;
            let mut releases = 0;
            let files = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    tokio::select! {
                        result = &mut transferring => break result.unwrap(),
                        message = worker_messages.recv() => {
                            let message: WorkerMessage = serde_json::from_slice(
                                &serde_json::to_vec(&message.unwrap()).unwrap()
                            ).unwrap();
                            match message {
                                WorkerMessage::Prepare { invocation_id, request_id, key } => {
                                    assert_eq!(key.identity, identity);
                                    assert_eq!(invocation_id, 17);
                                    parent.prepare(
                                        invocation_id, request_id, key, &identity,
                                        ParentCapabilities { authorization: Some(authority.clone()), ..Default::default() },
                                        CancellationToken::new(),
                                    ).await.unwrap();
                                }
                                message => {
                                    if let WorkerMessage::FileRequest { request, .. } = &message {
                                        reads += usize::from(matches!(request, Request::UploadRead { .. }));
                                        releases += usize::from(matches!(request, Request::UploadRelease { .. }));
                                    }
                                    parent.handle(message).unwrap();
                                }
                            }
                        }
                        message = parent_messages.recv() => {
                            let message: ParentMessage = serde_json::from_slice(
                                &serde_json::to_vec(&message.unwrap()).unwrap()
                            ).unwrap();
                            worker.handle(message).unwrap();
                        }
                    }
                }
            }).await.unwrap();
            assert_eq!(files.len(), 1);
            assert_eq!(files[0].name, "source.bin");
            assert_eq!(files[0].resource.bytes(), bytes.len());
            let mut copied = files[0].resource.read(0..CHUNK).unwrap();
            copied.extend(files[0].resource.read(CHUNK..bytes.len()).unwrap());
            assert_eq!(copied, bytes);
            assert_eq!(files[0].resource.metadata()["digest"], expected_digest);
            assert_eq!(
                files[0].resource.metadata().get("modified"),
                modified.as_ref()
            );
            assert_eq!(reads, 2);
            assert_eq!(releases, 1);
            assert!(checks.load(Ordering::SeqCst) >= 2);
            assert!(faults.try_recv().is_err());
            assert!(
                parent
                    .0
                    .state
                    .lock()
                    .unwrap()
                    .scopes
                    .values()
                    .all(|scope| { scope.files.try_lock().unwrap().inputs.is_empty() })
            );
        }
    }
}
