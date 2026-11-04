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
    mode: CheckpointWorkspaceConsistency,
) -> SessionCheckpointPublication {
    SessionCheckpointPublication {
        publication: publication(value),
        workspace_consistency: mode,
        warning: CheckpointWorkspaceWarning::ExternalWritersNotFenced,
    }
}
fn requested(input: SessionCheckpointPublish) -> (Capture, CheckpointWorkspaceConsistency) {
    let mut capture = capture(input.history);
    capture.workspace = Some(storage::WorkspaceCapture {
        root: Default::default(),
        identity: String::new(),
        consistency: consistency(input.workspace_consistency),
    });
    (capture, input.workspace_consistency)
}

impl Owner {
    pub async fn publish_session_checkpoint(
        self: &Arc<Self>,
        input: SessionCheckpointPublish,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<SessionCheckpointPublication, String> {
        management(scope)?;
        let operation = operation.clone();
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let publisher = owner.history_checkpoints();
                let (mut capture, mode) = requested(input);
                let request = publisher.request(&capture, &operation).map_err(failure)?;
                let repository = publisher
                    .repository(&capture.session_id)
                    .await
                    .map_err(failure)?;
                if let Some(original) = repository
                    .original_request(request)
                    .await
                    .map_err(failure)?
                {
                    return repository
                        .publish(original)
                        .await
                        .map(|p| response(p, mode))
                        .map_err(failure);
                }
                // Keep native admission closed until both history and workspace have been copied.
                // Foreign Hosts and external applications remain covered only by the caller's assertion.
                let runs = owner
                    .runs
                    .clone()
                    .try_lock_owned()
                    .map_err(|_| "agent_checkpoint_busy")?;
                if runs.closing
                    || !runs.controls.is_empty()
                    || !runs.preparing.is_empty()
                    || !runs.retained_cleanup.is_empty()
                {
                    return Err("agent_checkpoint_busy".into());
                }
                let session = owner.session(&capture.session_id).await?;
                if owner.behavior.is_some()
                    || session.configuration.parent_session_id.is_some()
                    || session
                        .configuration
                        .backend
                        .as_ref()
                        .is_some_and(|v| !matches!(v, BackendPreference::Model { .. }))
                {
                    return Err("agent_checkpoint_unsupported_session".into());
                }
                let inventory = owner
                    .store
                    .preview_bundle(&capture.session_id)
                    .await
                    .map_err(|e| e.to_string())?;
                if inventory.sessions.len() != 1 {
                    return Err("agent_checkpoint_multiple_workspaces_unsupported".into());
                }
                workspace::validate(
                    &owner.workspace_roots,
                    &session.configuration.workspace,
                    &owner.managed_worktrees,
                )
                .await
                .map_err(|_| "agent_workspace_unavailable")?;
                capture.workspace = Some(storage::WorkspaceCapture {
                    root: session.configuration.workspace.path.into(),
                    identity: session.configuration.workspace.identity.into(),
                    consistency: consistency(mode),
                });
                let result = publisher
                    .publish(capture, &operation)
                    .await
                    .map(|p| response(p, mode))
                    .map_err(failure);
                drop(runs);
                result
            })
        })
        .await
    }

    pub async fn session_checkpoint_receipt(
        self: &Arc<Self>,
        input: SessionCheckpointReceiptRead,
        context: Context,
    ) -> Result<SessionCheckpointReceipt, String> {
        management(context.scope())?;
        let scope = context.scope().clone();
        self.resource_work(&scope, move |owner, _| {
            Box::pin(async move {
                let publisher = owner.history_checkpoints();
                let (capture, mode) = requested(input.input);
                let request = publisher
                    .request(&capture, &input.reference)
                    .map_err(failure)?;
                let operation = context.recover(input.reference)?.await?;
                let checkpoint = if operation.is_some() {
                    let repository = publisher
                        .repository(&capture.session_id)
                        .await
                        .map_err(failure)?;
                    if let Some(original) = repository
                        .original_request(request)
                        .await
                        .map_err(failure)?
                    {
                        repository
                            .receipt(original)
                            .await
                            .map_err(failure)?
                            .map(|p| response(p, mode))
                    } else {
                        None
                    }
                } else {
                    None
                };
                Ok(SessionCheckpointReceipt {
                    operation,
                    checkpoint,
                })
            })
        })
        .await
    }
}
