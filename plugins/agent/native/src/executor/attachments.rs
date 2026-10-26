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

//! Copies only the original invocation's immutable uploads into its request budget.
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;
use maka_capabilities::call::ResourceEncoding;
use maka_event_log::{SessionStore, artifacts::ArtifactReadScope};
use maka_host_runtime::application::{
    CallResources, NativeRequest, RESOURCE_CHUNK_LIMIT, ResourceDescriptor,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use maka_agent_api::executor::AttachmentMetadata as Metadata;
pub(super) async fn capture(
    store: Arc<SessionStore>,
    request: &NativeRequest,
    session: &str,
    attachments: Vec<AttachmentRef>,
) -> Result<CallResources, String> {
    if attachments.is_empty() {
        return Ok(maka_capabilities::call::Attachments::default().into());
    }
    let mut manifest = Vec::with_capacity(attachments.len());
    let mut total = 0u64;
    let mut sources = Vec::new();
    let mut seen = BTreeSet::new();
    for attachment in attachments {
        let StorageRef::SessionFile {
            session_id,
            relative_path,
        } = &attachment.storage_ref
        else {
            return Err("executor_attachment_invalid".into());
        };
        if session_id != session || !seen.insert(relative_path.clone()) {
            return Err("executor_attachment_invalid".into());
        }
        let record = store
            .get_artifact(session, relative_path)
            .await
            .map_err(|_| "executor_attachment_unavailable")?
            .record
            .ok_or("executor_attachment_unavailable")?;
        record
            .validate_attachment(&attachment)
            .map_err(|_| "executor_attachment_invalid")?;
        if record.source != ArtifactSource::UserUpload {
            return Err("executor_attachment_invalid".into());
        }
        let metadata = Metadata {
            name: attachment.name.clone(),
            mime_type: attachment.mime_type.clone(),
            bytes: attachment.bytes,
            digest: record.summary.ok_or("executor_attachment_invalid")?,
        };
        let start = total;
        total = total
            .checked_add(metadata.bytes)
            .ok_or("executor_attachment_invalid")?;
        usize::try_from(total).map_err(|_| "executor_attachment_invalid")?;
        sources.push((
            start,
            relative_path.clone(),
            attachment,
            metadata.digest.clone(),
        ));
        manifest.push(metadata);
    }
    let descriptors = BTreeMap::from([(
        "attachments".into(),
        ResourceDescriptor {
            encoding: ResourceEncoding::Bytes,
            resource: maka_plugin_core::contract::binary_resource_type(),
            length: total,
            metadata: serde_json::to_value(manifest).map_err(|e| e.to_string())?,
        },
    )]);
    // Reserve before allocating payloads. The original request retains capacity
    // and observes physical completion even if this future is cancelled.
    let mut capture = request.capture_resources(descriptors)?;
    let scope = request.scope().clone();
    let session = session.to_owned();
    let mut ticket = scope.resources.reserve().map_err(|e| e.to_string())?;
    ticket.start();
    tokio::spawn(async move {
        let result = async {
            for (start, id, attachment, digest) in sources {
                if scope.cancellation.is_cancelled() {
                    return Err("executor_attachment_cancelled".into());
                }
                let cancellation = scope.cancellation.clone();
                capture = store
                    .with_artifact(
                        ArtifactReadScope::Session(&session),
                        &id,
                        move |record, reader| -> Result<_, String> {
                            if cancellation.is_cancelled() {
                                return Err("executor_attachment_cancelled".into());
                            }
                            record
                                .validate_attachment(&attachment)
                                .map_err(|_| "executor_attachment_invalid")?;
                            if record.source != ArtifactSource::UserUpload
                                || record.summary.as_deref() != Some(digest.as_str())
                            {
                                return Err("executor_attachment_invalid".into());
                            }
                            let mut hash = Sha256::new();
                            let mut buffer = [0u8; RESOURCE_CHUNK_LIMIT];
                            for offset in (0..attachment.bytes).step_by(RESOURCE_CHUNK_LIMIT) {
                                if cancellation.is_cancelled() {
                                    return Err("executor_attachment_cancelled".into());
                                }
                                let length = (attachment.bytes - offset)
                                    .min(RESOURCE_CHUNK_LIMIT as u64)
                                    as usize;
                                let chunk = &mut buffer[..length];
                                reader
                                    .read_exact(chunk)
                                    .map_err(|_| "executor_attachment_unavailable")?;
                                hash.update(&*chunk);
                                capture.write(
                                    "attachments",
                                    start
                                        .checked_add(offset)
                                        .ok_or("executor_attachment_invalid")?,
                                    chunk,
                                )?;
                            }
                            if format!("sha256:{}", hex::encode(hash.finalize())) != digest {
                                return Err("executor_attachment_invalid".into());
                            }
                            Ok(capture)
                        },
                    )
                    .await
                    .map_err(|_| "executor_attachment_unavailable")?
                    .ok_or("executor_attachment_unavailable")??;
            }
            capture.finish()
        }
        .await;
        ticket.complete(Ok(()));
        result
    })
    .await
    .map_err(|_| "executor_attachment_worker_failed")?
}
