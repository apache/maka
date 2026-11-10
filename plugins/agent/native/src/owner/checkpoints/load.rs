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
        self.resource_work(scope, move |owner, scope| {
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
                if let storage::LoadState::Ready {
                    history: expected, ..
                } = &value.state
                {
                    let history = owner
                        .checkpoint_state()?
                        .session_history(owner.run_owner(), input.session_id.clone());
                    if history
                        .imported_snapshot(
                            operation.operation,
                            expected,
                            scope.cancellation.child_token(),
                        )
                        .await
                        .map_err(failure)?
                        .is_none()
                    {
                        let checkout = publisher
                            .repository(&input.session_id)
                            .await
                            .map_err(failure)?
                            .loaded_snapshot(operation.operation)
                            .await
                            .map_err(failure)?;
                        history
                            .import_snapshot(
                                operation.operation,
                                expected.clone(),
                                checkout.snapshot,
                                scope.cancellation.child_token(),
                            )
                            .await
                            .map_err(failure)?;
                    }
                }
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
        self.resource_work(&scope, move |owner, scope| {
            Box::pin(async move {
                let publisher = owner.history_checkpoints();
                let request = publisher
                    .load_request(&input.input, &input.reference)
                    .map_err(failure)?;
                let operation = context.recover(input.reference.clone())?.await?;
                let load = if operation.is_some() {
                    let value = publisher
                        .repository(&input.input.session_id)
                        .await
                        .map_err(failure)?
                        .load_receipt(request)
                        .await
                        .map_err(failure)?;
                    match value {
                        Some(mut value) => {
                            if let storage::LoadState::Ready {
                                history: expected, ..
                            } = &value.state
                            {
                                let history = owner.checkpoint_state()?.session_history(
                                    owner.run_owner(),
                                    input.input.session_id.clone(),
                                );
                                if history
                                    .imported_snapshot(
                                        input.reference.operation,
                                        expected,
                                        scope.cancellation.child_token(),
                                    )
                                    .await
                                    .map_err(failure)?
                                    .is_none()
                                {
                                    let observed = owner
                                        .store
                                        .operation(&input.reference)
                                        .map_err(failure)?
                                        .operation_observation()
                                        .await
                                        .map_err(failure)?;
                                    use maka_plugin_core::operation::{
                                        OperationOutcome, OperationResult,
                                    };
                                    value.state = match observed.map(|value| value.outcome) {
                                        Some(OperationOutcome::Returned {
                                            result: OperationResult::Failure { diagnostic },
                                        }) if diagnostic
                                            == "agent_history_checkpoint_outcome_unknown" =>
                                        {
                                            storage::LoadState::Preparing
                                        }
                                        Some(OperationOutcome::Returned {
                                            result: OperationResult::Failure { .. },
                                        }) => storage::LoadState::Unavailable,
                                        Some(OperationOutcome::Returned {
                                            result: OperationResult::Success { .. },
                                        }) => {
                                            return Err(
                                                "agent_checkpoint_inspection_receipt_missing"
                                                    .into(),
                                            );
                                        }
                                        _ => storage::LoadState::Preparing,
                                    };
                                }
                            }
                            Some(loaded(
                                value,
                                CheckpointInspection {
                                    source_session_id: input.input.session_id,
                                    operation_id: input.reference.operation,
                                },
                            ))
                        }
                        None => None,
                    }
                } else {
                    None
                };
                Ok(CheckpointLoadReceipt { operation, load })
            })
        })
        .await
    }
    async fn inspection_snapshot(
        &self,
        inspection: &CheckpointInspection,
    ) -> Result<maka_agent_state::session_history::snapshot::Snapshot, String> {
        let repository = self
            .history_checkpoints()
            .repository(&inspection.source_session_id)
            .await
            .map_err(failure)?;
        let loaded = repository
            .loaded_checkpoint(inspection.operation_id)
            .await
            .map_err(failure)?;
        let storage::LoadState::Ready {
            history: expected, ..
        } = loaded.state
        else {
            return Err("agent_checkpoint_inspection_not_ready".into());
        };
        let history = self
            .checkpoint_state()?
            .session_history(self.run_owner(), inspection.source_session_id.clone());
        history
            .imported_snapshot_receipt(inspection.operation_id, &expected)
            .await
            .map_err(failure)?
            .ok_or_else(|| "agent_checkpoint_inspection_not_ready".into())
    }

    pub async fn loaded_checkpoint_history(
        self: &Arc<Self>,
        input: CheckpointHistoryRead,
        scope: &Scope,
    ) -> Result<HistoryPage, String> {
        management(scope)?;
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                if input.session_id != input.inspection.source_session_id {
                    return Err("agent_checkpoint_source_session_mismatch".into());
                }
                let snapshot = owner.inspection_snapshot(&input.inspection).await?;
                crate::service::history::snapshot_page(
                    &snapshot,
                    input.position,
                    input.include_thinking,
                    input.view,
                    &scope.cancellation,
                )
                .await
                .map(HistoryPage::from)
            })
        })
        .await
    }

    pub async fn loaded_checkpoint_source(
        self: &Arc<Self>,
        input: CheckpointSourceRead,
        scope: &Scope,
    ) -> Result<maka_agent_ports::session::history::HistorySource, String> {
        management(scope)?;
        input
            .address
            .validate()
            .map_err(|error| error.to_string())?;
        use maka_agent_ports::session::history::SourcePosition;
        if matches!(input.position,SourcePosition::Before { offset }|SourcePosition::After { offset } if offset>9_007_199_254_740_991)
        {
            return Err("agent_checkpoint_source_position_invalid".into());
        }
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let snapshot = owner.inspection_snapshot(&input.inspection).await?;
                crate::service::history::snapshot_source(
                    &snapshot,
                    input.address,
                    input.field,
                    input.path,
                    input.position,
                    &scope.cancellation,
                )
                .await
            })
        })
        .await
    }

    pub async fn loaded_checkpoint_tool_image(
        self: &Arc<Self>,
        input: CheckpointToolImageRead,
        scope: &Scope,
    ) -> Result<HistoryImagePage, String> {
        management(scope)?;
        input
            .position
            .validate()
            .map_err(|error| error.to_string())?;
        if input.offset > 9_007_199_254_740_991 {
            return Err("agent_checkpoint_image_offset_invalid".into());
        }
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let snapshot = owner.inspection_snapshot(&input.inspection).await?;
                crate::service::history::snapshot_tool_image(
                    &snapshot,
                    input.position,
                    input.image,
                    input.offset,
                    &scope.cancellation,
                )
                .await
            })
        })
        .await
    }
    pub async fn loaded_checkpoint_attachment_image(
        self: &Arc<Self>,
        input: CheckpointAttachmentImageRead,
        scope: &Scope,
    ) -> Result<HistoryImagePage, String> {
        management(scope)?;
        input
            .position
            .validate()
            .map_err(|error| error.to_string())?;
        if input.offset > 9_007_199_254_740_991 {
            return Err("agent_checkpoint_image_offset_invalid".into());
        }
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let snapshot = owner.inspection_snapshot(&input.inspection).await?;
                crate::service::history::snapshot_attachment_image(
                    &snapshot,
                    input.position,
                    input.attachment_index,
                    input.offset,
                    &scope.cancellation,
                )
                .await
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
        self.resource_work(scope, move |owner, _scope| {
            Box::pin(async move {
                let mut snapshot = owner.inspection_snapshot(&input.inspection).await?;
                for run in input.path {
                    snapshot = snapshot.nested(run).await.map_err(failure)?;
                }
                let after = input.offset.checked_sub(1);
                let (entries, next) = snapshot
                    .artifact_records(input.session_id, after, 32)
                    .await
                    .map_err(failure)?;
                let artifacts = entries
                    .into_iter()
                    .map(|(_, entry)| match entry {
                        maka_agent_facts::history_snapshot::Entry::Artifact { record, .. } => {
                            Ok(artifact(record.artifact))
                        }
                        _ => Err("agent_checkpoint_artifact_index_invalid".to_owned()),
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(CheckpointArtifacts {
                    artifacts,
                    next_offset: next
                        .map(|ordinal| {
                            ordinal
                                .checked_add(1)
                                .ok_or("agent_checkpoint_cursor_exhausted")
                        })
                        .transpose()?,
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
        self.resource_work(&scope, move |owner, scope| {
            Box::pin(async move {
                let mut snapshot = owner.inspection_snapshot(&input.inspection).await?;
                for run in input.path {
                    snapshot = snapshot.nested(run).await.map_err(failure)?;
                }
                let record = snapshot
                    .artifact_record(input.session_id, input.artifact_id)
                    .await
                    .map_err(failure)?
                    .ok_or("agent_checkpoint_artifact_unavailable")?;
                if input.offset > record.payload.bytes {
                    return Err("agent_checkpoint_artifact_offset_invalid".into());
                }
                let mut offset = input.offset;
                while offset < record.payload.bytes {
                    if scope.cancellation.is_cancelled() || owner.stop.is_cancelled() {
                        return Err("agent_history_checkpoint_cancelled".into());
                    }
                    let chunk = snapshot
                        .chunk(&record.payload, offset, 32 * 1024)
                        .await
                        .map_err(failure)?;
                    if chunk.is_empty() {
                        return Err("agent_history_checkpoint_integrity_failed".into());
                    }
                    let length = chunk.len() as u64;
                    context
                        .emit(
                            serde_json::to_value(CheckpointArtifactChunk {
                                artifact: artifact(record.artifact.clone()),
                                offset,
                                data: STANDARD.encode(chunk),
                            })
                            .map_err(|error| error.to_string())?,
                        )
                        .await?;
                    offset = offset
                        .checked_add(length)
                        .ok_or("agent_checkpoint_artifact_offset_invalid")?;
                }
                Ok(Value::Null)
            })
        })
        .await
    }
}
fn loaded(value: storage::LoadedCheckpoint, inspection: CheckpointInspection) -> CheckpointLoad {
    CheckpointLoad {
        head: head(value.head),
        inspection: inspection.clone(),
        state: match value.state {
            storage::LoadState::Preparing => CheckpointLoadState::Preparing,
            storage::LoadState::Ready { workspace, .. } => CheckpointLoadState::Ready {
                session_ids: vec![inspection.source_session_id.clone()],
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
