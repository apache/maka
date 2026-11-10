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

//! Session history plus a caller-attested or explicitly unverified workspace copy.
use super::*;

fn consistency(value: CheckpointWorkspaceConsistency) -> storage::WorkspaceConsistency {
    match value {
        CheckpointWorkspaceConsistency::CallerConfirmedQuiescent => {
            storage::WorkspaceConsistency::CallerConfirmedQuiescent
        }
        CheckpointWorkspaceConsistency::Unverified => storage::WorkspaceConsistency::Unverified,
    }
}
fn response(
    value: storage::Publication,
    mode: Option<CheckpointWorkspaceConsistency>,
) -> CheckpointPublication {
    let mut result = publication(value);
    result.workspace = mode.map(|consistency| CheckpointWorkspaceNotice {
        consistency,
        warning: CheckpointWorkspaceWarning::ExternalWritersNotFenced,
    });
    result
}
fn requested(input: CheckpointPublish) -> (Capture, Option<CheckpointWorkspaceConsistency>) {
    let mode = input.workspace_consistency;
    let mut capture = capture(input);
    capture.workspace = mode.map(|mode| storage::WorkspaceCapture {
        root: Default::default(),
        identity: String::new(),
        consistency: consistency(mode),
    });
    (capture, mode)
}

impl Owner {
    pub async fn publish_checkpoint(
        self: &Arc<Self>,
        input: CheckpointPublish,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<CheckpointPublication, String> {
        management(scope)?;
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let publisher = owner.history_checkpoints();
                let (mut capture, mode) = requested(input);
                publisher
                    .validate_request(&capture, &operation)
                    .map_err(failure)?;
                let state = owner.checkpoint_state()?;
                let history = state.session_history(owner.run_owner(), capture.session_id.clone());
                let id = snapshot_id(&operation)?;
                let original = history
                    .captured_snapshot(id, scope.cancellation.child_token())
                    .await
                    .map_err(failure)?;
                let recovering = original.is_some();
                let mut admission = None;
                let snapshot = match original {
                    Some((_, snapshot)) => snapshot,
                    None => {
                        let inventory = owner.checkpoint_inventory(&capture.session_id).await?;
                        if inventory.subtree_digest != capture.confirmed_subtree_digest {
                            return Err("agent_history_checkpoint_changed".into());
                        }
                        let (guard, session) = owner
                            .checkpoint_admission(&capture.session_id, mode.is_some())
                            .await?;
                        if let Some(workspace_mode) = mode {
                            capture.workspace = Some(storage::WorkspaceCapture {
                                root: session.configuration.workspace.path.into(),
                                identity: session.configuration.workspace.identity.into(),
                                consistency: consistency(workspace_mode),
                            });
                        }
                        let writer = owner.store.data_writer().map_err(failure)?;
                        let metadata = owner
                            .store
                            .session(&capture.session_id)
                            .await
                            .map_err(failure)?
                            .revision_guard(&writer, session.revision)
                            .map_err(failure)?;
                        let request = maka_agent_state::session_history::snapshot::CaptureRequest {
                            id,
                            cut: history.capture().await.map_err(failure)?,
                        };
                        admission = Some(guard);
                        history
                            .capture_snapshot_guarded(
                                request,
                                metadata,
                                scope.cancellation.child_token(),
                            )
                            .await
                            .map_err(failure)?
                    }
                };
                let file = owner.checkpoint_file(&capture.session_id).await?;
                let material = snapshot.export(file).await.map_err(failure)?;
                if recovering {
                    return publisher
                        .receipt(capture, &operation, &material.history)
                        .await
                        .map_err(failure)?
                        .map(|value| response(value, mode))
                        .ok_or_else(|| "agent_history_checkpoint_publication_not_recorded".into());
                }
                let result = publisher
                    .publish(
                        capture,
                        &operation,
                        material,
                        admission
                            .as_ref()
                            .and_then(|guard| guard.physical.as_deref()),
                    )
                    .await
                    .map(|value| response(value, mode))
                    .map_err(failure);
                drop(admission);
                result
            })
        })
        .await
    }

    pub async fn checkpoint_receipt(
        self: &Arc<Self>,
        input: CheckpointReceiptRead,
        context: Context,
    ) -> Result<CheckpointReceipt, String> {
        management(context.scope())?;
        let scope = context.scope().clone();
        self.resource_work(&scope, move |owner, scope| {
            Box::pin(async move {
                let publisher = owner.history_checkpoints();
                let (capture, mode) = requested(input.input);
                publisher
                    .validate_request(&capture, &input.reference)
                    .map_err(failure)?;
                let operation = context.recover(input.reference.clone())?.await?;
                let publication = if operation.is_some() {
                    let state = owner.checkpoint_state()?;
                    let history =
                        state.session_history(owner.run_owner(), capture.session_id.clone());
                    match history
                        .captured_snapshot(
                            snapshot_id(&input.reference)?,
                            scope.cancellation.child_token(),
                        )
                        .await
                        .map_err(failure)?
                    {
                        Some((_, snapshot)) => {
                            let file = owner.checkpoint_file(&capture.session_id).await?;
                            let material = snapshot.export(file).await.map_err(failure)?;
                            publisher
                                .receipt(capture, &input.reference, &material.history)
                                .await
                                .map_err(failure)?
                                .map(|value| response(value, mode))
                        }
                        None => None,
                    }
                } else {
                    None
                };
                Ok(CheckpointReceipt {
                    operation,
                    publication,
                })
            })
        })
        .await
    }
}
