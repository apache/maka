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
use contract::{PreparationStage, PreparationState};
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;
use maka_host_runtime::application::NativeRequest;

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Target {
    Existing {
        session_id: String,
    },
    New {
        #[serde(default)]
        isolated_workspace: bool,
        #[serde(default)]
        #[schemars(extend("uniqueItems" = true))]
        tools: Option<Vec<String>>,
        title: String,
        workspace: crate::contract::DirectorySelection,
    },
}
impl Target {
    pub(super) fn validate(&self) -> Result<(), String> {
        match self {
            Self::Existing { session_id } if session_id.is_empty() => {
                Err("workhub_target_invalid".into())
            }
            Self::New { title, .. } if title.trim().is_empty() => {
                Err("workhub_title_invalid".into())
            }
            _ => Ok(()),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Transfer {
    pub source: AttachmentRef,
    pub digest: String,
}
/// Resolved immutable input, saved before send when create/upload receipts supply
/// new identities. This records a dispatch decision, never execution or outcome.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Delivery {
    pub session_id: String,
    pub attachments: Vec<String>,
}
impl Delivery {
    fn validate(&self, assignment: &Assignment) -> Result<(), String> {
        if self.session_id.is_empty()
            || self.attachments.len() != assignment.attachments.len()
            || self
                .attachments
                .iter()
                .any(|id| maka_agent_facts::interaction::entity_id(id).is_err())
            || self
                .attachments
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.attachments.len()
            || matches!(&assignment.target, Target::Existing { session_id } if session_id != &self.session_id)
        {
            return Err("workhub_delivery_invalid".into());
        }
        Ok(())
    }
}
impl Hub {
    pub(super) async fn transfers(
        &self,
        context: &ToolCallContext,
        attachments: &[AttachmentRef],
    ) -> Result<Vec<Transfer>, String> {
        let source = &context.invocation;
        let store = self.agent.0.tool_store(context)?;
        let mut transfers = Vec::with_capacity(attachments.len());
        let mut seen = std::collections::BTreeSet::new();
        for attachment in attachments {
            let StorageRef::SessionFile {
                session_id,
                relative_path,
            } = &attachment.storage_ref
            else {
                return Err("workhub_attachment_invalid".into());
            };
            if session_id != &source.session_id || !seen.insert(relative_path) {
                return Err("workhub_attachment_invalid".into());
            }
            let record = store
                .get_artifact(session_id, relative_path)
                .await
                .map_err(|_| "workhub_attachment_unavailable")?
                .record
                .ok_or("workhub_attachment_unavailable")?;
            record
                .validate_attachment(attachment)
                .map_err(|_| "workhub_attachment_invalid")?;
            if record.source != ArtifactSource::UserUpload {
                return Err("workhub_attachment_invalid".into());
            }
            let digest = record.summary.ok_or("workhub_attachment_invalid")?;
            if !digest.strip_prefix("sha256:").is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }) {
                return Err("workhub_attachment_invalid".into());
            }
            transfers.push(Transfer {
                source: attachment.clone(),
                digest,
            });
        }
        Ok(transfers)
    }
    pub(super) async fn transfer_resource(
        &self,
        request: &NativeRequest,
        transfer: &Transfer,
    ) -> Result<maka_host_runtime::application::CallResources, String> {
        use maka_capabilities::call::ResourceEncoding;
        use maka_host_runtime::application::{RESOURCE_CHUNK_LIMIT, ResourceDescriptor};
        let StorageRef::SessionFile {
            session_id,
            relative_path,
        } = &transfer.source.storage_ref
        else {
            return Err("workhub_attachment_invalid".into());
        };
        if !self.agent.0.owns(session_id) {
            return Err("workhub_attachment_invalid".into());
        }
        let source = transfer.source.clone();
        let digest = transfer.digest.clone();
        let (session, id) = (session_id.clone(), relative_path.clone());
        let scope = request.scope().clone();
        let store = match (scope.identity.agent(), scope.execution()) {
            (Some(invocation), Some(execution)) if invocation.session_id == session => self
                .agent
                .0
                .store
                .session_for_execution(execution.as_ref(), invocation)
                .map_err(|error| error.to_string())?,
            _ => self
                .agent
                .0
                .store
                .session(&session)
                .await
                .map_err(|error| error.to_string())?,
        };
        let mut capture = request.capture_resources(BTreeMap::from([("file".into(),ResourceDescriptor {
            encoding:ResourceEncoding::Bytes,resource:maka_plugin_core::contract::binary_resource_type(),length:source.bytes,
            metadata:serde_json::json!({"name":source.name,"bytes":source.bytes,"digest":digest}),
        })]))?;
        // Own the actual asynchronous reader independently of its JoinHandle.
        // The original capture retains the buffer budget and its own parent Ticket.
        let mut ticket = scope
            .resources
            .reserve()
            .map_err(|error| error.to_string())?;
        ticket.start();
        tokio::spawn(async move {
            let result = async {
                capture = store
                    .with_artifact(
                        maka_event_log::artifacts::ArtifactReadScope::Session(&session),
                        &id,
                        move |record, reader| -> Result<_, String> {
                            record
                                .validate_attachment(&source)
                                .map_err(|_| "workhub_attachment_invalid")?;
                            if record.source != ArtifactSource::UserUpload
                                || record.summary.as_deref() != Some(digest.as_str())
                            {
                                return Err("workhub_attachment_invalid".into());
                            }
                            let mut hash = Sha256::new();
                            let mut buffer = [0u8; RESOURCE_CHUNK_LIMIT];
                            for offset in (0..source.bytes).step_by(RESOURCE_CHUNK_LIMIT) {
                                if scope.cancellation.is_cancelled() {
                                    return Err("workhub_cancelled".into());
                                }
                                let length = (source.bytes - offset)
                                    .min(RESOURCE_CHUNK_LIMIT as u64)
                                    as usize;
                                let chunk = &mut buffer[..length];
                                reader
                                    .read_exact(chunk)
                                    .map_err(|_| "workhub_attachment_unavailable")?;
                                hash.update(&*chunk);
                                capture.write("file", offset, chunk)?;
                            }
                            if format!("sha256:{}", hex::encode(hash.finalize())) != digest {
                                return Err("workhub_attachment_invalid".into());
                            }
                            Ok(capture)
                        },
                    )
                    .await
                    .map_err(|_| "workhub_attachment_unavailable")?
                    .ok_or("workhub_attachment_unavailable")??;
                capture.finish()
            }
            .await;
            ticket.complete(Ok(()));
            result
        })
        .await
        .map_err(|_| "workhub_attachment_worker_failed")?
    }
    fn delivery_key(&self, id: &str) -> Result<String, String> {
        self.task_key(id)?;
        Ok(format!("{}deliveries/{id}", self.agent.0.prefix))
    }
    pub(super) async fn delivery(
        &self,
        id: &str,
        assignment: &Assignment,
    ) -> Result<Option<Delivery>, String> {
        // Already concrete input needs no second record.
        if let Target::Existing { session_id } = &assignment.target
            && assignment.attachments.is_empty()
        {
            return Ok(Some(Delivery {
                session_id: session_id.clone(),
                attachments: vec![],
            }));
        }
        let Some(record) = self
            .agent
            .0
            .store
            .plugin_data(&namespace(), &self.delivery_key(id)?)
            .await
            .map_err(|_| "workhub_store_unavailable")?
        else {
            return Ok(None);
        };
        let Data::Present(value) = record.data else {
            return Err("workhub_delivery_removed".into());
        };
        let delivery: Delivery =
            serde_json::from_value(value).map_err(|_| "workhub_delivery_invalid")?;
        delivery.validate(assignment)?;
        Ok(Some(delivery))
    }
    pub(super) async fn prepare_delivery(
        &self,
        id: &str,
        assignment: &Assignment,
        request: &NativeRequest,
        advance: bool,
    ) -> Result<Result<Delivery, TaskStatus>, String> {
        if let Some(delivery) = self.delivery(id, assignment).await? {
            return Ok(Ok(delivery));
        }
        let session = match &assignment.target {
            Target::Existing { session_id } => session_id.clone(),
            Target::New {
                title,
                workspace,
                tools,
                isolated_workspace,
            } => {
                let operation = child_id(&format!("{id}:create"));
                let kind = if *isolated_workspace {
                    "isolated_git"
                } else {
                    "directory"
                };
                let input = serde_json::json!({"title":title,"labels":[],"tools":tools,"workspace":{"kind":kind,"selection":workspace}});
                let reply = self
                    .dispatch(
                        request,
                        Call {
                            worker: &assignment.worker,
                            binding: &assignment.binding,
                            operation,
                            method: "create",
                            input: &input,
                            attachment: None,
                        },
                        advance,
                    )
                    .await?;
                let value = match step(reply, false) {
                    Ok(value) => value,
                    Err(state) => {
                        return Ok(Err(TaskStatus::Preparing {
                            stage: PreparationStage::Create,
                            operation,
                            session_id: None,
                            state,
                        }));
                    }
                };
                if value["kind"] != "created" {
                    return Err("workhub_creation_invalid".into());
                }
                let selected: crate::contract::Workspace =
                    serde_json::from_value(value["session"]["workspace"].clone())
                        .map_err(|_| "workhub_creation_invalid")?;
                let matches = if *isolated_workspace {
                    selected.worktree.as_ref().is_some_and(|binding| {
                        binding.source_identity() == &workspace.directory_identity
                            && binding.directory() == std::path::Path::new(&selected.path)
                    })
                } else {
                    selected.worktree.is_none()
                        && selected.directory_identity == workspace.directory_identity
                };
                if !matches {
                    return Err("workhub_creation_invalid".into());
                }
                value["session"]["id"]
                    .as_str()
                    .ok_or("workhub_creation_invalid")?
                    .to_owned()
            }
        };
        let mut attachments = Vec::with_capacity(assignment.attachments.len());
        for (index, transfer) in assignment.attachments.iter().enumerate() {
            let operation = child_id(&format!("{id}:attachment:{index}"));
            let input = serde_json::json!({"sessionId":session,"name":transfer.source.name,"bytes":transfer.source.bytes,"digest":transfer.digest});
            let reply = self
                .dispatch(
                    request,
                    Call {
                        worker: &assignment.worker,
                        binding: &assignment.binding,
                        operation,
                        method: "uploadAttachment",
                        input: &input,
                        attachment: Some(transfer),
                    },
                    advance,
                )
                .await?;
            let value = match step(reply, true) {
                Ok(value) => value,
                Err(state) => {
                    return Ok(Err(TaskStatus::Preparing {
                        stage: PreparationStage::Attachment {
                            index,
                            total: assignment.attachments.len(),
                        },
                        operation,
                        session_id: Some(session.clone()),
                        state,
                    }));
                }
            };
            let attachment = &value["attachment"];
            if value["kind"] != "uploaded"
                || attachment["sessionId"] != session
                || attachment["name"] != transfer.source.name
                || attachment["mimeType"] != transfer.source.mime_type
                || attachment["bytes"] != transfer.source.bytes
            {
                return Err("workhub_attachment_result_invalid".into());
            }
            attachments.push(
                attachment["id"]
                    .as_str()
                    .ok_or("workhub_attachment_result_invalid")?
                    .to_owned(),
            );
        }
        let delivery = Delivery {
            session_id: session,
            attachments,
        };
        delivery.validate(assignment)?;
        if !advance {
            return Ok(Err(TaskStatus::Preparing {
                stage: PreparationStage::Delivery,
                operation: assignment.operation,
                session_id: Some(delivery.session_id),
                state: PreparationState::Pending,
            }));
        }
        if request.scope().cancellation.is_cancelled() {
            return Err("workhub_cancelled".into());
        }
        match self
            .agent
            .0
            .store
            .plugin_data_batch(
                &namespace(),
                vec![Mutation {
                    key: self.delivery_key(id)?,
                    expected_revision: None,
                    data: Data::Present(
                        serde_json::to_value(delivery).map_err(|_| "workhub_encoding_failed")?,
                    ),
                }],
            )
            .await
        {
            Ok(_) | Err(maka_event_log::StoreError::RevisionConflict { .. }) => {}
            Err(_) => return Err("workhub_delivery_commit_unknown".into()),
        }
        Ok(Ok(self
            .delivery(id, assignment)
            .await?
            .ok_or("workhub_delivery_missing")?))
    }
}
fn step(observed: DispatchObservation, resource: bool) -> Result<Value, PreparationState> {
    let state = match observed {
        DispatchObservation::Pending => PreparationState::Pending,
        DispatchObservation::Unavailable => PreparationState::Unavailable,
        DispatchObservation::Reply(reply) => match reply.receipt {
            Receipt::NotRecorded if resource => PreparationState::OriginalCaptureRequired,
            Receipt::NotRecorded => PreparationState::Pending,
            Receipt::Recorded {
                outcome: OperationOutcome::Returned { value },
                cleanup: OperationCleanup::Confirmed,
            } => {
                if value["kind"] == "rejected" {
                    PreparationState::Rejected {
                        reason: value["reason"]
                            .as_str()
                            .unwrap_or("worker_rejected_preparation")
                            .into(),
                    }
                } else {
                    return Ok(value);
                }
            }
            _ => PreparationState::Uncertain,
        },
    };
    Err(state)
}

fn directory(directory: &Value) -> Result<Value, String> {
    Ok(serde_json::json!({
        "nameExcerpt":excerpt(directory["name"].as_str().ok_or("workhub_directory_invalid")?,32),
        "pathExcerpt":excerpt(directory["path"].as_str().ok_or("workhub_directory_invalid")?,48),
        "selection":directory["selection"],
    }))
}
pub(super) fn directory_page(page: Value) -> Result<Value, String> {
    if page["kind"] == "roots" {
        let roots = page["roots"]
            .as_array()
            .ok_or("workhub_directory_invalid")?
            .iter()
            .map(directory)
            .collect::<Result<Vec<_>, _>>()?;
        let value = serde_json::json!({"kind":"roots","roots":roots});
        return Ok(value);
    }
    if page["kind"] != "children" {
        return Err("workhub_directory_invalid".into());
    }
    let rows = page["children"]
        .as_array()
        .ok_or("workhub_directory_invalid")?;
    let count = rows.len().min(4);
    let children = rows[..count]
        .iter()
        .map(directory)
        .collect::<Result<Vec<_>, _>>()?;
    let after = if count < rows.len() || !page["after"].is_null() {
        rows.get(count.saturating_sub(1))
            .map(|row| row["name"].clone())
    } else {
        None
    };
    let value = serde_json::json!({"kind":"children","children":children,"after":after});
    Ok(value)
}
