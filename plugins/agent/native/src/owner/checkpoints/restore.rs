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

//! Explicit same-Root workspace recovery; loading never admits a model call.
use super::*;

fn restored(value: storage::RestoredSession) -> SessionCheckpointRestored {
    SessionCheckpointRestored {
        operation: value.operation,
        session_id: value.session_id,
        session_revision: value.session_revision,
        head: head(value.prepared.head),
        workspace: workspace_snapshot(value.prepared.workspace),
        path: value.prepared.path.to_string_lossy().into_owned(),
    }
}
impl Owner {
    async fn restore_request(
        &self,
        input: &SessionCheckpointRestore,
        operation: &RecoveryRef,
    ) -> Result<(maka_event_log::root_store::HistoryCheckpoints, String), String> {
        operation.validate().map_err(|e| e.to_string())?;
        if !self.owns(&input.checkpoint.session_id)
            || operation.method != "restoreSessionCheckpoint"
            || operation.export != maka_agent_api::EXPORT
            || operation.source.state_domain != self.data_source.state_domain
            || operation.source.deployment != self.data_source.deployment
            || operation.namespace != self.data_source.namespace
        {
            return Err("agent_checkpoint_restore_authority_mismatch".into());
        }
        let repository = self
            .history_checkpoints()
            .repository(&input.checkpoint.session_id)
            .await
            .map_err(failure)?;
        let fingerprint = hex::encode(Sha256::digest(
            serde_json::to_vec(operation).map_err(|e| e.to_string())?,
        ));
        Ok((repository, fingerprint))
    }

    pub async fn restore_session_checkpoint(
        self: &Arc<Self>,
        input: SessionCheckpointRestore,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<SessionCheckpointRestored, String> {
        management(scope)?;
        let operation = operation.clone();
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let (repository, fingerprint) = owner.restore_request(&input, &operation).await?;
                if let Some(receipt) = repository
                    .workspace_restore_receipt(
                        operation.operation,
                        fingerprint.clone(),
                        storage::Revision(input.checkpoint.revision),
                    )
                    .await
                    .map_err(failure)?
                {
                    return Ok(restored(receipt));
                }
                if !input.accept_external_writers_risk {
                    return Err("agent_checkpoint_external_writers_not_fenced".into());
                }
                if !matches!(input.backend, BackendPreference::Model { .. }) {
                    return Err("agent_checkpoint_unsupported_session".into());
                }
                if !owner.backend_available(&input.backend).await? {
                    return Err("agent_checkpoint_backend_unavailable".into());
                }
                let root = owner.store.owned_root().map_err(failure)?;
                let parent = workspace::observed(
                    owner.workspace_roots.clone(),
                    &input.parent,
                    owner.home.as_deref(),
                    root.canonical_path().to_owned(),
                )
                .await?
                .ok_or("agent_directory_unavailable")?;
                let path = std::path::PathBuf::from(parent.path);
                let control_dir = std::fs::canonicalize(root.control_directory())
                    .unwrap_or_else(|_| root.control_directory().to_owned());
                if path.starts_with(&control_dir)
                    || path.starts_with(root.control_directory())
                    || path.starts_with(&owner.managed_worktrees)
                {
                    return Err("agent_directory_unavailable".into());
                }
                let (admission, session) = owner
                    .checkpoint_admission(&input.checkpoint.session_id, Some(&path))
                    .await?;
                if session.archived
                    || session.configuration.parent_session_id.is_some()
                    || session
                        .configuration
                        .backend
                        .as_ref()
                        .is_some_and(|v| !matches!(v, BackendPreference::Model { .. }))
                    || owner
                        .goals
                        .repository
                        .read(&session.id)
                        .await
                        .map_err(|e| e.to_string())?
                        .is_some()
                {
                    return Err("agent_checkpoint_unsupported_session".into());
                }
                let request = storage::RestoreOperation {
                    operation: operation.operation,
                    fingerprint,
                    revision: storage::Revision(input.checkpoint.revision),
                    parent: path,
                    parent_identity: parent.identity,
                };
                let prepared = repository
                    .prepare_workspace_restore(request.clone())
                    .await
                    .map_err(failure)?;
                let root = owner.store.owned_root().map_err(failure)?;
                let control_dir = std::fs::canonicalize(root.control_directory())
                    .unwrap_or_else(|_| root.control_directory().to_owned());
                let selected = workspace::initialize(
                    &owner.workspace_roots,
                    prepared
                        .path
                        .to_str()
                        .ok_or("agent_directory_unavailable")?,
                    owner.home.as_deref(),
                    &owner.managed_worktrees,
                    root.canonical_path(),
                    &control_dir,
                )
                .await?
                .ok_or("agent_workspace_unavailable")?;
                let binding = owner
                    .store
                    .attach_workspace(&owner.prefix, &selected)
                    .await
                    .map_err(failure)?;
                let permissions = input.permissions;
                let backend = input.backend;
                let result = repository
                    .commit_workspace_restore(
                        request,
                        now(),
                        move |configuration: &mut StoredSessionConfiguration| {
                            configuration.workspace = binding.clone();
                            configuration.permissions = permissions.clone();
                            configuration.backend = Some(backend.clone());
                            configuration.boundary_revision = configuration
                                .boundary_revision
                                .checked_add(1)
                                .filter(|v| *v <= 9_007_199_254_740_991)
                                .ok_or_else(|| {
                                    StoreError::InvalidTransition(
                                        "permission boundary revision exhausted".into(),
                                    )
                                })?;
                            Ok(())
                        },
                    )
                    .await
                    .map(restored)
                    .map_err(failure);
                drop(admission);
                result
            })
        })
        .await
    }
    pub async fn session_checkpoint_restore_receipt(
        self: &Arc<Self>,
        input: SessionCheckpointRestoreReceiptRead,
        context: Context,
    ) -> Result<SessionCheckpointRestoreReceipt, String> {
        management(context.scope())?;
        let scope = context.scope().clone();
        self.resource_work(&scope, move |owner, _| {
            Box::pin(async move {
                let (repository, fingerprint) = owner
                    .restore_request(&input.input, &input.reference)
                    .await?;
                let id = input.reference.operation;
                let operation = context.recover(input.reference)?.await?;
                let restore = if operation.is_some() {
                    repository
                        .workspace_restore_receipt(
                            id,
                            fingerprint,
                            storage::Revision(input.input.checkpoint.revision),
                        )
                        .await
                        .map_err(failure)?
                        .map(restored)
                } else {
                    None
                };
                Ok(SessionCheckpointRestoreReceipt { operation, restore })
            })
        })
        .await
    }
}
