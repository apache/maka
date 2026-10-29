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

//! Upload consent and file reading remain on the original embedding Host.

use super::{Access, access, api, failed};
use maka_agent_api::{contract::WorkspaceAccess, session::ResolvedConfiguration};
use maka_agent_facts::{
    interaction::{Decision, GrantCapability, GrantScope, GrantTarget},
    tools::ToolError,
};
use maka_capabilities::call::{ReadResource, ResourceEncoding};
use maka_computer_use::{
    AuthorizationFuture, BrowserAccess, BrowserAttachmentOrigin, BrowserUploadFile,
    BrowserUploadFuture, BrowserUploadRequest,
};
use maka_fs_tools::{BinaryFileMetadata, ReadExecutor, ReadScope};
use maka_host_runtime::application::{ResourceCapture, ResourceDescriptor};
use maka_sandbox::Sandbox;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io, ops::Range, path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

struct Snapshot {
    capture: ResourceCapture,
    slot: String,
    offset: u64,
    digest: Sha256,
    modified: serde_json::Value,
}
impl io::Write for Snapshot {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        self.capture
            .write(&self.slot, self.offset, bytes)
            .map_err(io::Error::other)?;
        self.digest.update(bytes);
        self.offset += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The payload owns the original Host packing reservations. This wrapper only
/// publishes the digest computed while copying that same opened source file.
struct UploadBytes {
    name: String,
    digest: String,
    modified: serde_json::Value,
    payload: Arc<dyn ReadResource>,
}
impl ReadResource for UploadBytes {
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        self.payload.resource_type()
    }
    fn bytes(&self) -> usize {
        self.payload.bytes()
    }
    fn metadata(&self) -> serde_json::Value {
        serde_json::json!({"name":self.name,"bytes":self.payload.bytes(),"digest":self.digest,"modified":self.modified})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        if range
            .end
            .checked_sub(range.start)
            .is_none_or(|count| count > 64 * 1024)
        {
            return Err("invalid upload snapshot range or exceeds 64 KiB".into());
        }
        self.payload.read(range)
    }
}

/// Normalize only the actual observed file timestamp, with no floating point
/// or clock fallback. Negative epochs use floor seconds plus positive nanos.
fn modified_metadata(time: std::time::SystemTime) -> Result<serde_json::Value, ToolError> {
    use std::time::UNIX_EPOCH;
    let (seconds, nanos) = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => (i128::from(duration.as_secs()), duration.subsec_nanos()),
        Err(error) => {
            let duration = error.duration();
            let nanos = duration.subsec_nanos();
            if nanos == 0 {
                (-i128::from(duration.as_secs()), 0)
            } else {
                (-i128::from(duration.as_secs()) - 1, 1_000_000_000 - nanos)
            }
        }
    };
    let seconds = i64::try_from(seconds)
        .map_err(|_| failed("Upload modification time exceeds the signed seconds range"))?;
    Ok(serde_json::json!({"seconds":seconds,"nanos":nanos}))
}

impl Access {
    async fn upload_targets(
        &self,
        request: &BrowserUploadRequest,
        cancellation: &CancellationToken,
    ) -> Result<(ResolvedConfiguration, [GrantTarget; 2]), ToolError> {
        if request.files.is_empty() {
            return Err(failed("fileChooser.setFiles requires at least one file"));
        }
        if !matches!(request.source_origin, BrowserAttachmentOrigin::Site(_)) {
            return Err(failed(
                "Browser file upload requires a verified HTTP(S) origin",
            ));
        }
        let (configuration, site) = self
            .current(
                &BrowserAccess::ReadDocument {
                    document: request.document.clone(),
                    origin: request.source_origin.clone(),
                },
                cancellation,
            )
            .await?;
        let site = site.ok_or_else(|| failed("Browser file upload origin is unavailable"))?;
        let GrantScope::BrowserOrigin { origin } = &site.scope else {
            unreachable!("verified document access returns an origin target");
        };
        let upload = GrantTarget {
            capability: GrantCapability::BrowserUpload,
            scope: GrantScope::BrowserOrigin {
                origin: origin.clone(),
            },
            ..api::target()
        };
        Ok((configuration, [site, upload]))
    }

    async fn current_upload(
        &self,
        request: &BrowserUploadRequest,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedConfiguration, ToolError> {
        let (configuration, targets) = self.upload_targets(request, cancellation).await?;
        for target in targets {
            if access::browser_decision(&self.owner, &self.call, self.basis, &target).await?
                != Some(Decision::Allow)
            {
                return Err(failed(
                    if target.capability == GrantCapability::BrowserUpload {
                        "Browser file upload access has not been granted"
                    } else {
                        "Browser site access has not been granted"
                    },
                ));
            }
        }
        if cancellation.is_cancelled() || self.producer.is_cancelled() {
            return Err(failed("Browser file upload cancelled"));
        }
        Ok(configuration)
    }

    async fn approve_upload(
        &self,
        request: &BrowserUploadRequest,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedConfiguration, ToolError> {
        let (configuration, [site, upload]) = self.upload_targets(request, cancellation).await?;
        // The bound browser operation already obtained current document consent.
        // Upload consent is separate; it cannot manufacture that earlier grant.
        self.check_target(&site).await?;
        access::approve_target(
            &self.owner,
            &self.call,
            &configuration,
            cancellation,
            upload,
            Some(&self.cell),
        )
        .await?;
        self.current_upload(request, cancellation).await
    }

    async fn prepare_upload_inner(
        &self,
        request: BrowserUploadRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<BrowserUploadFile>, ToolError> {
        let capturer = self.preparation.input_resources.clone().ok_or_else(|| {
            failed("Browser file upload requires original Host resource capture custody")
        })?;
        let configuration = self.approve_upload(&request, &cancellation).await?;
        let reader = capture_reader(&self.owner.store, &configuration).await?;
        let current = self.current_upload(&request, &cancellation).await?;
        if current.workspace != configuration.workspace {
            return Err(failed(
                "Workspace changed before browser upload file admission",
            ));
        }
        // Sizing is only a budget proposal. Every actual copy re-opens through
        // the same Files policy, rechecks this name/length before its first
        // write, and verifies stability of that actual opened file through EOF.
        let mut metadata = Vec::with_capacity(request.files.len());
        for path in &request.files {
            metadata.push(
                reader
                    .binary_metadata(path.clone(), cancellation.clone())
                    .await?,
            );
        }
        self.current_upload(&request, &cancellation).await?;
        let descriptors = metadata.iter().enumerate().map(|(index, file)| {
            (format!("file-{index}"), ResourceDescriptor {
                encoding:ResourceEncoding::Bytes,
                resource:maka_plugin_core::contract::binary_resource_type(),
                length:file.bytes,
                // Reserve exactly the final descriptor's extent, without
                // presenting this placeholder as a data digest to any consumer.
                metadata:serde_json::json!({"name":file.name,"bytes":file.bytes,"digest":format!("sha256:{}","0".repeat(64)),"modified":{"seconds":i64::MIN,"nanos":999_999_999u32}}),
            })
        }).collect::<BTreeMap<_,_>>();
        // One aggregate reservation preserves the original Host packing-window
        // rule for a single request with multiple (possibly very large) files.
        let mut capture = tokio::task::spawn_blocking(move || capturer.capture(descriptors))
            .await
            .map_err(failed)?
            .map_err(failed)?;
        let mut digests = Vec::with_capacity(metadata.len());
        for (index, (path, expected)) in request.files.iter().zip(&metadata).enumerate() {
            let expected_name = expected.name.clone();
            let expected_bytes = expected.bytes;
            let slot = format!("file-{index}");
            let material = reader
                .copy_binary(
                    path.clone(),
                    move |actual: BinaryFileMetadata| {
                        if actual.name != expected_name || actual.bytes != expected_bytes {
                            return Err(failed(
                                "Browser upload file changed after resource budget sizing",
                            ));
                        }
                        Ok(Snapshot {
                            capture,
                            slot,
                            offset: 0,
                            digest: Sha256::new(),
                            modified: modified_metadata(actual.modified.ok_or_else(|| {
                                failed("Upload source file modification time is unavailable")
                            })?)?,
                        })
                    },
                    cancellation.clone(),
                )
                .await?;
            let Snapshot {
                capture: original,
                digest,
                modified,
                ..
            } = material;
            capture = original;
            digests.push((
                format!("sha256:{}", hex::encode(digest.finalize())),
                modified,
            ));
            let current = self.current_upload(&request, &cancellation).await?;
            if current.workspace != configuration.workspace {
                return Err(failed("Workspace changed during browser upload file read"));
            }
        }
        let mut payloads = capture.finish_resources().map_err(failed)?;
        let files = metadata
            .into_iter()
            .zip(digests)
            .enumerate()
            .map(|(index, (file, (digest, modified)))| {
                let payload = payloads
                    .remove(&format!("file-{index}"))
                    .ok_or_else(|| failed("Original Host upload snapshot is missing"))?;
                let name = file.name;
                Ok(BrowserUploadFile {
                    name: name.clone(),
                    resource: Arc::new(UploadBytes {
                        name,
                        digest,
                        modified,
                        payload,
                    }) as Arc<dyn ReadResource>,
                })
            })
            .collect::<Result<Vec<_>, ToolError>>()?;
        self.current_upload(&request, &cancellation).await?;
        Ok(files)
    }

    pub(super) fn prepare_upload_request(
        &self,
        request: BrowserUploadRequest,
        cancellation: CancellationToken,
    ) -> BrowserUploadFuture {
        let access = self.clone();
        Box::pin(async move {
            let child = cancellation.child_token();
            let prepare = access.prepare_upload_inner(request, child.clone());
            tokio::pin!(prepare);
            tokio::select! {
                result = &mut prepare => result,
                () = access.producer.cancelled() => {
                    child.cancel();
                    // The original approval/read/hash job must finish or fail
                    // under its original custody before this callback returns.
                    prepare.await
                },
            }
        })
    }

    pub(super) fn check_upload_request(
        &self,
        request: BrowserUploadRequest,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let access = self.clone();
        Box::pin(async move {
            access
                .current_upload(&request, &cancellation)
                .await
                .map(|_| ())
        })
    }
}

async fn capture_reader(
    store: &maka_event_log::RootStore,
    configuration: &ResolvedConfiguration,
) -> Result<ReadExecutor, ToolError> {
    let root = store.owned_root().map_err(failed)?;
    let state = PathBuf::from(
        maka_fs_tools::workspace::project::host_path(root.canonical_path()).map_err(failed)?,
    );
    let workspace = configuration.workspace.clone();
    let access = configuration.permissions.access;
    tokio::task::spawn_blocking(move || {
        let path = PathBuf::from(&workspace.path);
        let directory =
            maka_fs_tools::directory::open(&path, &workspace.directory_identity).map_err(failed)?;
        if maka_fs_tools::workspace::read_directory_identity(
            path.clone(),
            directory.try_clone().map_err(failed)?,
        )
        .map_err(failed)?
            != workspace.identity
        {
            return Err(failed("Browser upload workspace marker identity changed"));
        }
        let sandbox = if access == WorkspaceAccess::DangerFullAccess {
            Sandbox::Disabled
        } else {
            maka_workspace_support::sandbox(&workspace, access, &state)
                .map_err(failed)?
                .0
        };
        // Same directory identity, private state rules and compiled filesystem
        // policy as the existing workspace Files service; no ambient fs::read.
        maka_fs_tools::directory::open(&path, &workspace.directory_identity).map_err(failed)?;
        let policy = match sandbox {
            Sandbox::Managed { filesystem, .. } => {
                Some(Arc::new(filesystem.compile().map_err(failed)?))
            }
            Sandbox::Disabled => None,
            _ => {
                return Err(failed(
                    "Workspace filesystem policy unavailable for browser upload",
                ));
            }
        };
        match policy {
            Some(policy) => ReadExecutor::from_directory(path, directory, Some(policy)),
            None => ReadExecutor::new(path, ReadScope::Unrestricted),
        }
    })
    .await
    .map_err(failed)?
}
