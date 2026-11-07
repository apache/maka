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

//! Host-admitted isolated inspection; no method here creates a runnable Session.
use super::*;

impl Owner {
    pub async fn load_history_checkpoint(
        self: &Arc<Self>,
        input: HistoryCheckpointRead,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<CheckpointLoad, String> {
        management(scope)?;
        let operation = operation.clone();
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let publisher = owner.history_checkpoints();
                let request = publisher
                    .load_request(&input, &operation)
                    .map_err(failure)?;
                let value = publisher
                    .repository(&input.session_id)
                    .await
                    .map_err(failure)?
                    .load_exact(request)
                    .await
                    .map_err(failure)?;
                Ok(loaded(
                    value,
                    CheckpointInspection {
                        source_session_id: input.session_id,
                        operation_id: operation.operation,
                    },
                ))
            })
        })
        .await
    }
    pub async fn history_checkpoint_load_receipt(
        self: &Arc<Self>,
        input: CheckpointLoadReceiptRead,
        context: Context,
    ) -> Result<CheckpointLoadReceipt, String> {
        management(context.scope())?;
        let scope = context.scope().clone();
        self.resource_work(&scope, move |owner, _| {
            Box::pin(async move {
                let publisher = owner.history_checkpoints();
                let request = publisher
                    .load_request(&input.input, &input.reference)
                    .map_err(failure)?;
                let operation = context.recover(input.reference.clone())?.await?;
                let load = if operation.is_some() {
                    publisher
                        .repository(&input.input.session_id)
                        .await
                        .map_err(failure)?
                        .load_receipt(request)
                        .await
                        .map_err(failure)?
                        .map(|value| {
                            loaded(
                                value,
                                CheckpointInspection {
                                    source_session_id: input.input.session_id,
                                    operation_id: input.reference.operation,
                                },
                            )
                        })
                } else {
                    None
                };
                Ok(CheckpointLoadReceipt { operation, load })
            })
        })
        .await
    }
    pub async fn loaded_checkpoint_history(
        self: &Arc<Self>,
        input: CheckpointHistoryRead,
        scope: &Scope,
    ) -> Result<HistoryPage, String> {
        management(scope)?;
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let page = owner
                    .history_checkpoints()
                    .repository(&input.inspection.source_session_id)
                    .await
                    .map_err(failure)?
                    .loaded_history(
                        input.inspection.operation_id,
                        input.session_id,
                        input.position,
                        input.include_thinking,
                    )
                    .await
                    .map_err(failure)?;
                Ok(HistoryPage::from(page))
            })
        })
        .await
    }
    pub async fn loaded_checkpoint_artifacts(
        self: &Arc<Self>,
        input: CheckpointArtifactsRead,
        scope: &Scope,
    ) -> Result<CheckpointArtifacts, String> {
        management(scope)?;
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let page = owner
                    .history_checkpoints()
                    .repository(&input.inspection.source_session_id)
                    .await
                    .map_err(failure)?
                    .loaded_artifacts(
                        input.inspection.operation_id,
                        input.session_id,
                        input.offset,
                    )
                    .await
                    .map_err(failure)?;
                let next = input.offset + page.records.len() as u64;
                Ok(CheckpointArtifacts {
                    next_offset: (next < page.total).then_some(next),
                    artifacts: page.records.into_iter().map(artifact).collect(),
                })
            })
        })
        .await
    }
    pub async fn loaded_checkpoint_artifact(
        self: &Arc<Self>,
        input: CheckpointArtifactRead,
        context: Context,
    ) -> Result<Value, String> {
        management(context.scope())?;
        let scope = context.scope().clone();
        let context = Arc::new(context);
        self.resource_work(&scope.clone(), move |owner, _| {
            Box::pin(async move {
                owner
                    .history_checkpoints()
                    .repository(&input.inspection.source_session_id)
                    .await
                    .map_err(failure)?
                    .stream_loaded_artifact(
                        input.inspection.operation_id,
                        input.session_id,
                        input.artifact_id,
                        input.offset,
                        move |record| {
                            let context = context.clone();
                            let scope = scope.clone();
                            let owner = owner.clone();
                            async move {
                                if scope.cancellation.is_cancelled() || owner.stop.is_cancelled() {
                                    return Err(maka_event_log::StoreError::InvalidTransition(
                                        "checkpoint artifact cancelled".into(),
                                    ));
                                }
                                let chunk =
                                    record.map(|(record, offset, chunk)| CheckpointArtifactChunk {
                                        artifact: artifact(record),
                                        offset,
                                        data: STANDARD.encode(chunk.bytes),
                                    });
                                context
                                    .emit(serde_json::to_value(chunk)?)
                                    .await
                                    .map_err(maka_event_log::StoreError::InvalidTransition)
                            }
                        },
                    )
                    .await
                    .map_err(failure)?;
                Ok(Value::Null)
            })
        })
        .await
    }
}
fn loaded(value: storage::LoadedCheckpoint, inspection: CheckpointInspection) -> CheckpointLoad {
    CheckpointLoad {
        head: head(value.head),
        inspection,
        state: match value.state {
            storage::LoadState::Preparing => CheckpointLoadState::Preparing,
            storage::LoadState::Ready {
                session_ids,
                workspace,
                ..
            } => CheckpointLoadState::Ready {
                session_ids,
                workspace: workspace.map(|w| CheckpointWorkspaceSnapshot {
                    identity: w.identity,
                    inventory: object(w.inventory),
                    consistency: match w.consistency {
                        storage::WorkspaceConsistency::CallerConfirmedQuiescent => {
                            CheckpointWorkspaceConsistency::CallerConfirmedQuiescent
                        }
                        storage::WorkspaceConsistency::Unverified => {
                            CheckpointWorkspaceConsistency::Unverified
                        }
                    },
                    warning: CheckpointWorkspaceWarning::ExternalWritersNotFenced,
                }),
            },
            storage::LoadState::Unavailable => CheckpointLoadState::Unavailable,
        },
    }
}
fn artifact(record: maka_agent_facts::artifact::Artifact) -> CheckpointArtifact {
    CheckpointArtifact {
        id: record.id,
        name: record.name,
        bytes: record.size_bytes,
        mime_type: record.mime_type,
    }
}
