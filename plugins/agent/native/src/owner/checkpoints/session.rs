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
                let Some(workspace_mode) = mode else {
                    return publisher
                        .publish(capture, &operation)
                        .await
                        .map(|value| response(value, None))
                        .map_err(failure);
                };
                let (admission, session) = owner
                    .checkpoint_admission(&capture.session_id, None)
                    .await?;
                if owner.behavior.is_some()
                    || session.configuration.parent_session_id.is_some()
                    || session
                        .configuration
                        .backend
                        .as_ref()
                        .is_some_and(|v| !matches!(v, BackendPreference::Model { .. }))
                    || owner.graph_selected(&session.id).await?
                    || owner
                        .store
                        .session(&session.id)
                        .await
                        .map_err(|e| e.to_string())?
                        .session_manager(&session.id)
                        .await
                        .map_err(|_| "agent_session_unavailable")?
                        .is_some()
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
                    consistency: consistency(workspace_mode),
                });
                let result = publisher
                    .publish(capture, &operation)
                    .await
                    .map(|p| response(p, mode))
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
        self.resource_work(&scope, move |owner, _| {
            Box::pin(async move {
                let publisher = owner.history_checkpoints();
                let (capture, mode) = requested(input.input);
                publisher
                    .validate_request(&capture, &input.reference)
                    .map_err(failure)?;
                let request = publisher
                    .request(&capture, &input.reference)
                    .map_err(failure)?;
                let operation = context.recover(input.reference)?.await?;
                let publication = if operation.is_some() {
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
                Ok(CheckpointReceipt {
                    operation,
                    publication,
                })
            })
        })
        .await
    }
}
