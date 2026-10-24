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

use super::*;
use maka_agent_facts::artifact::Artifact;
use maka_agent_facts::artifact::ArtifactKind;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::artifact::content_digest;
use maka_agent_facts::artifact::normalize_name;
use maka_agent_facts::artifact::upload_artifact_id;
use maka_agent_facts::attachment::AttachmentKind;
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;
use maka_agent_facts::attachment::sniff_binary_mime;
use maka_capabilities::call::ReadResource;
use maka_capabilities::call::ResourceEncoding;
use maka_host_runtime::application::Context;

impl Owner {
    pub async fn upload_attachment(
        self: &Arc<Self>,
        input: UploadAttachment,
        context: Context,
    ) -> Result<AttachmentUploadResult, String> {
        let operation = context.operation().ok_or("agent_mutation_required")?;
        let identity = self.operation_id(operation);
        let resource = context
            .attachments()
            .get("file")
            .ok_or("agent_attachment_required")?
            .clone();
        let mut ticket = context
            .scope()
            .resources
            .reserve()
            .map_err(|e| e.to_string())?;
        ticket.start();
        let owner = self.clone();
        // This original Scope owns the entire worker through the SQL commit. Losing
        // the caller never reports physical cleanup before that worker finishes.
        tokio::spawn(async move {
            let result = async {
                let runs = owner.runs.lock().await;
                if runs.closing || context.scope().cancellation.is_cancelled() {
                    return Ok(AttachmentUploadResult::Rejected {
                        reason: AttachmentRejection::Closed,
                    });
                }
                if owner.session(&input.session_id).await?.archived {
                    return Ok(AttachmentUploadResult::Rejected {
                        reason: AttachmentRejection::Archived,
                    });
                }
                let cancellation = context.scope().cancellation.clone();
                let material = tokio::task::spawn_blocking(move || {
                    let bytes = read(&*resource, &input, &cancellation)?;
                    let mime = mime(&input.name, &bytes);
                    let record = Artifact {
                        id: upload_artifact_id(&input.session_id, &identity),
                        session_id: input.session_id,
                        turn_id: format!("upload_{identity}"),
                        created_at: now(),
                        name: normalize_name(&input.name),
                        kind: if mime.starts_with("image/") {
                            ArtifactKind::Image
                        } else if mime == "application/pdf" {
                            ArtifactKind::Pdf
                        } else {
                            ArtifactKind::File
                        },
                        size_bytes: bytes.len() as u64,
                        mime_type: Some(mime.into()),
                        source: ArtifactSource::UserUpload,
                        summary: Some(input.digest),
                    };
                    Ok::<_, String>((record, bytes))
                })
                .await
                .map_err(|_| "agent_attachment_worker_failed")?;
                let Ok((record, payload)) = material else {
                    return Ok(AttachmentUploadResult::Rejected {
                        reason: AttachmentRejection::InvalidFile,
                    });
                };
                if context.scope().cancellation.is_cancelled() {
                    return Ok(AttachmentUploadResult::Rejected {
                        reason: AttachmentRejection::Closed,
                    });
                }
                let record = owner
                    .store
                    .session(&record.session_id)
                    .await
                    .map_err(|error| error.to_string())?
                    .commit_artifact(record, payload)
                    .await
                    .map_err(|_| "agent_attachment_commit_failed")?;
                Ok(AttachmentUploadResult::Uploaded {
                    attachment: Attachment {
                        session_id: record.session_id,
                        id: record.id,
                        name: record.name,
                        mime_type: record.mime_type.expect("upload MIME"),
                        bytes: record.size_bytes,
                    },
                })
            }
            .await;
            drop(context);
            ticket.complete(Ok(()));
            result
        })
        .await
        .map_err(|_| "agent_attachment_worker_failed")?
    }

    pub(super) async fn attachment_refs(
        &self,
        session: &str,
        ids: Vec<String>,
    ) -> Result<Option<Vec<AttachmentRef>>, String> {
        if ids.is_empty() {
            return Ok(None);
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut attachments = Vec::with_capacity(ids.len());
        for id in ids {
            if maka_agent_facts::interaction::entity_id(&id).is_err() || !seen.insert(id.clone()) {
                return Err("agent_attachments_invalid".into());
            }
            let record = self
                .store
                .session(session)
                .await
                .map_err(|error| error.to_string())?
                .get_artifact(session, &id)
                .await
                .map_err(|_| "agent_attachment_unavailable")?
                .record
                .filter(|record| {
                    record.source == ArtifactSource::UserUpload && record.session_id == session
                })
                .ok_or("agent_attachment_unavailable")?;
            let mime_type = record
                .mime_type
                .clone()
                .ok_or("agent_attachment_unavailable")?;
            let attachment = AttachmentRef {
                kind: AttachmentKind::from_metadata(&mime_type, &record.name),
                name: record.name.clone(),
                mime_type,
                bytes: record.size_bytes,
                storage_ref: StorageRef::SessionFile {
                    session_id: session.into(),
                    relative_path: id,
                },
            };
            record
                .validate_attachment(&attachment)
                .map_err(|_| "agent_attachment_invalid")?;
            attachments.push(attachment);
        }
        Ok(Some(attachments))
    }
}
fn read(
    resource: &dyn ReadResource,
    input: &UploadAttachment,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, String> {
    if resource.resource_type() != maka_plugin_core::contract::binary_resource_type()
        || resource.encoding() != ResourceEncoding::Bytes
        || resource.bytes() != input.bytes
        || input.name.is_empty()
        || input.name.chars().any(char::is_control)
    {
        return Err("agent_attachment_invalid".into());
    }
    let mut bytes = Vec::with_capacity(input.bytes);
    for offset in (0..input.bytes).step_by(64 * 1024) {
        if cancellation.is_cancelled() {
            return Err("agent_attachment_cancelled".into());
        }
        let end = (offset + 64 * 1024).min(input.bytes);
        let chunk = resource.read(offset..end)?;
        if chunk.len() != end - offset {
            return Err("agent_attachment_invalid".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if content_digest(&bytes) != input.digest {
        return Err("agent_attachment_digest_mismatch".into());
    }
    Ok(bytes)
}
fn mime(name: &str, bytes: &[u8]) -> &'static str {
    if let Some(mime) = sniff_binary_mime(bytes) {
        return mime;
    }
    let text = std::str::from_utf8(bytes).is_ok() && !bytes.contains(&0);
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "json" if text => "application/json",
        "csv" if text => "text/csv",
        "md" if text => "text/markdown",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ if text => "text/plain",
        _ => "application/octet-stream",
    }
}
