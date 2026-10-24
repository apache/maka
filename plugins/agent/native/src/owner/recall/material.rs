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
use maka_agent_facts::artifact::ArtifactKind;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::attachment::AttachmentKind;
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;
use maka_agent_facts::read::ReadInput;

impl Recall {
    pub(super) async fn material(
        self: &Arc<Self>,
        call: Scope,
        input: search::Material,
    ) -> Result<ToolSuccess, ToolError> {
        self.check(&call).await?;
        let target = call
            .identity
            .agent()
            .ok_or_else(|| failed("RecallMaterial requires an Agent call"))?
            .session_id
            .clone();
        if !super::super::owns_session(&self.prefix, &input.session_id) {
            return Err(failed("Recall Session unavailable"));
        }
        let mut ticket = call.resources.reserve()?;
        ticket.start();
        let recall = self.clone();
        self.workers
            .spawn(async move {
                // The actual worker retains its call ticket until SQLite settles.
                let result = async {
                    recall.check(&call).await?;
                    let selected_target = recall
                        .store
                        .session_for_execution(
                            call.execution()
                                .ok_or_else(|| failed("Recall execution custody unavailable"))?
                                .as_ref(),
                            call.identity.agent().expect("validated Agent call"),
                        )
                        .map_err(failed)?;
                    let record = recall
                        .store
                        .execution_attachment(
                            &selected_target,
                            &input.session_id,
                            &input.artifact_id,
                        )
                        .await
                        .map_err(failed)?
                        .record
                        .filter(|record| record.source == ArtifactSource::UserUpload)
                        .ok_or_else(|| failed("Historical user attachment unavailable"))?;
                    let mime_type = record
                        .mime_type
                        .clone()
                        .ok_or_else(|| failed("Attachment media type unavailable"))?;
                    let attachment = AttachmentRef {
                        kind: AttachmentKind::from_metadata(&mime_type, &record.name),
                        name: record.name.clone(),
                        mime_type,
                        bytes: record.size_bytes,
                        storage_ref: StorageRef::SessionFile {
                            session_id: input.session_id.clone(),
                            relative_path: input.artifact_id.clone(),
                        },
                    };
                    let namespace = maka_capabilities::storage::Namespace::new(
                        crate::IMPLEMENTATION,
                        maka_plugin_core::scope::Scope::Profile,
                    )
                    .map_err(failed)?;
                    let copied = recall
                        .store
                        .copy_plugin_attachment_to_execution(
                            &selected_target,
                            &namespace,
                            maka_agent_ports::execution::CopyAttachment {
                                attachment,
                                target_session_id: target.clone(),
                            },
                        )
                        .await
                        .map_err(|error| match error {
                            maka_event_log::StoreError::CommitUnknown(_) => {
                                ToolError::OutcomeUnknown(
                                    "Recall attachment copy outcome is unknown".into(),
                                )
                            }
                            error => failed(error),
                        })?;
                    recall.check(&call).await?;
                    let StorageRef::SessionFile {
                        relative_path: id, ..
                    } = &copied.storage_ref
                    else {
                        unreachable!()
                    };
                    let request = ReadInput {
                        path: copied
                            .storage_ref
                            .resource_ref()
                            .ok_or_else(|| failed("Attachment address unavailable"))?,
                        offset: input.offset,
                        limit: input.limit,
                    }
                    .resolve()
                    .map_err(failed)?;
                    let output = maka_files_native::attachments::read(
                        &recall.scoped_store(&call, &target).await?,
                        &target,
                        &id,
                        &request,
                        record.kind == ArtifactKind::Image,
                        &call.cancellation,
                    )
                    .await?;
                    recall.check(&call).await?;
                    match output {
                        maka_files_native::Output::Json(value) => Ok(value.into()),
                        maka_files_native::Output::Image { bytes, mime_type } => {
                            ToolSuccess::image(bytes, mime_type).map_err(failed)
                        }
                    }
                }
                .await;
                ticket.complete(Ok(()));
                result
            })
            .await
            .map_err(|_| {
                ToolError::CleanupUnconfirmed("Recall attachment worker disappeared".into())
            })?
    }
}
