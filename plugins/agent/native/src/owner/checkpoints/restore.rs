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
    ) -> Result<NativeMutation<SessionCheckpointRestored>, String> {
        management(scope)?;
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                operation.validate().map_err(|error| error.to_string())?;
                if !owner.owns(&input.checkpoint.session_id)
                    || operation.method != "restoreSessionCheckpoint"
                    || operation.export != maka_agent_api::EXPORT
                    || operation.source.state_domain != owner.data_source.state_domain
                    || operation.source.deployment != owner.data_source.deployment
                    || operation.namespace != owner.data_source.namespace
                {
                    return Err("agent_checkpoint_restore_authority_mismatch".into());
                }
                if let Some(observed) = owner
                    .store
                    .operation(&operation)
                    .map_err(failure)?
                    .operation_observation()
                    .await
                    .map_err(failure)?
                {
                    use maka_plugin_core::operation::{OperationOutcome, OperationResult};
                    match observed.outcome {
                        OperationOutcome::Returned {
                            result: OperationResult::Success { value },
                        } => {
                            let value: SessionCheckpointRestored = serde_json::from_value(value)
                                .map_err(|_| "agent_checkpoint_restore_receipt_invalid")?;
                            if value.operation != operation.operation
                                || value.session_id != input.checkpoint.session_id
                                || value.head.revision != input.checkpoint.revision
                            {
                                return Err("agent_checkpoint_restore_receipt_invalid".into());
                            }
                            return Ok(NativeMutation::Returned(value));
                        }
                        OperationOutcome::Returned {
                            result: OperationResult::Failure { diagnostic },
                        } => return Err(diagnostic),
                        OperationOutcome::Unknown { .. } => {
                            return Err("agent_history_checkpoint_outcome_unknown".into());
                        }
                        OperationOutcome::NotExecuted { .. } => {
                            return Err("agent_checkpoint_restore_not_executed".into());
                        }
                        OperationOutcome::Unresolved => {}
                    }
                }
                let (repository, fingerprint) = owner.restore_request(&input, &operation).await?;
                if repository
                    .workspace_restore_receipt(
                        operation.operation,
                        fingerprint.clone(),
                        storage::Revision(input.checkpoint.revision),
                    )
                    .await
                    .map_err(failure)?
                    .is_some()
                {
                    return Err("agent_checkpoint_restore_receipt_inconsistent".into());
                }
                if !input.accept_external_writers_risk {
                    return Err("agent_checkpoint_external_writers_not_fenced".into());
                }
                if !owner.backend_available(&input.backend).await? {
                    return Err("agent_checkpoint_backend_unavailable".into());
                }
                let (admission, session) = owner
                    .checkpoint_admission(&input.checkpoint.session_id, false)
                    .await?;
                if session.archived {
                    return Err("agent_checkpoint_archived_session".into());
                }
                let state = owner.checkpoint_state()?;
                let history = state.session_history(owner.run_owner(), session.id.clone());
                let checkout = repository
                    .checkout_exact(storage::Revision(input.checkpoint.revision))
                    .await
                    .map_err(failure)?;
                let source = match history
                    .imported_snapshot(
                        operation.operation,
                        &checkout.manifest.history,
                        scope.cancellation.child_token(),
                    )
                    .await
                    .map_err(failure)?
                {
                    Some(source) => source,
                    None => history
                        .import_snapshot(
                            operation.operation,
                            checkout.manifest.history,
                            checkout.snapshot,
                            scope.cancellation.child_token(),
                        )
                        .await
                        .map_err(failure)?,
                };
                history
                    .validate_restore_source(&source)
                    .await
                    .map_err(failure)?;
                let root = owner.store.owned_root().map_err(failure)?;
                let parent = workspace::observed(
                    owner.workspace_roots.clone(),
                    &input.parent,
                    owner.home.as_deref(),
                    root.canonical_path().to_owned(),
                )
                .await?
                .ok_or("agent_directory_unavailable")?;
                let path = std::path::PathBuf::from(&parent.path);
                if path.starts_with(root.control_directory())
                    || path.starts_with(&owner.managed_worktrees)
                {
                    return Err("agent_directory_unavailable".into());
                }
                let request = storage::RestoreOperation {
                    operation: operation.operation,
                    fingerprint,
                    revision: storage::Revision(input.checkpoint.revision),
                    parent: path,
                    parent_identity: parent.identity.clone(),
                };
                let parent_directory = workspace::open_directory(
                    &owner.workspace_roots,
                    &parent,
                    root.canonical_path(),
                )
                .await?;
                let parent_clone = parent_directory
                    .try_clone()
                    .map_err(|_| "agent_directory_unavailable")?;
                let parent_cap = owner.store.workspace(parent_clone).await.map_err(failure)?;
                let (prepared, physical) = repository
                    .prepare_workspace_restore(request.clone(), &parent_cap)
                    .await
                    .map_err(failure)?;
                let physical = Arc::new(physical);
                let name = prepared
                    .path
                    .file_name()
                    .ok_or("agent_directory_unavailable")?
                    .to_owned();
                let directory = tokio::task::spawn_blocking(move || {
                    use cap_fs_ext::DirExt;
                    parent_directory.open_dir_nofollow(name)
                })
                .await
                .map_err(|_| "agent_directory_unavailable")?
                .map_err(|_| "agent_directory_unavailable")?;
                let observed = owner
                    .store
                    .workspace(
                        directory
                            .try_clone()
                            .map_err(|_| "agent_directory_unavailable")?,
                    )
                    .await
                    .map_err(failure)?;
                owner
                    .store
                    .validate_workspace_fence(&physical, &observed)
                    .await
                    .map_err(failure)?;
                let (directory, directory_identity) = tokio::task::spawn_blocking(move || {
                    maka_fs_tools::directory::identity(&directory)
                        .map(|identity| (directory, identity))
                })
                .await
                .map_err(|_| "agent_directory_unavailable")?
                .map_err(|_| "agent_directory_unavailable")?;
                let identity = maka_fs_tools::workspace::ensure_directory_identity(
                    prepared.path.clone(),
                    directory,
                    root.canonical_path().to_owned(),
                    root.control_directory().to_owned(),
                    None,
                )
                .await
                .map_err(|_| "agent_workspace_initialization_failed")?;
                let selected = Workspace {
                    path: prepared
                        .path
                        .to_str()
                        .ok_or("agent_directory_unavailable")?
                        .to_owned(),
                    directory_identity,
                    identity,
                    project_id: None,
                    worktree: None,
                };
                let binding = owner
                    .store
                    .attach_workspace(&owner.prefix, &selected)
                    .await
                    .map_err(failure)?;
                let stored = owner
                    .store
                    .get_session::<StoredSessionConfiguration>(&session.id)
                    .await
                    .map_err(failure)?
                    .ok_or("agent_session_unavailable")?;
                let mut candidate = stored.configuration;
                candidate.workspace = binding;
                candidate.permissions = input.permissions;
                candidate.backend = Some(input.backend);
                let current = owner.session(&session.id).await?;
                candidate.boundary_revision = current
                    .configuration
                    .boundary_revision
                    .checked_add(1)
                    .filter(|value| *value <= 9_007_199_254_740_991)
                    .ok_or("agent_permission_boundary_exhausted")?;
                let configuration = candidate
                    .clone()
                    .resolve(
                        selected,
                        maka_sandbox::workspace::BindingStamp {
                            id: binding.id,
                            permission_epoch: binding.permission_epoch_at_attach,
                        },
                    )
                    .map_err(|error| error.to_string())?;
                let (spec, contents) = owner
                    .history_source_spec(&session.id, &configuration, &source, &operation, &scope)
                    .await?;
                let adoption = source
                    .adopt(
                        &history,
                        operation.operation,
                        spec,
                        maka_agent_facts::durable::UnixMillis(
                            now().try_into().map_err(|_| "agent_clock_invalid")?,
                        ),
                        contents,
                    )
                    .map_err(failure)?;
                let guarded = history
                    .guard_restore(&source, adoption)
                    .await
                    .map_err(failure)?;
                let writer = admission.quiescence.data_writer().clone();
                let statement = RestoreAdmission {
                    inner: guarded,
                    admission,
                    physical: physical.clone(),
                };
                let (result, change) = repository
                    .prepare_workspace_restore_change(
                        request,
                        &physical,
                        move |value: &mut StoredSessionConfiguration| {
                            *value = candidate;
                            Ok(())
                        },
                        &writer,
                        statement,
                    )
                    .await
                    .map_err(failure)?;
                Ok(NativeMutation::Commit {
                    value: restored(result),
                    change,
                })
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

struct RestoreAdmission<S> {
    inner: S,
    admission: Arc<CheckpointAdmission>,
    physical: Arc<maka_event_log::root_store::WorkspaceFence>,
}
impl<S: maka_event_log::writeback::Statement> maka_event_log::writeback::Statement
    for RestoreAdmission<S>
{
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.inner = self.inner.prepare()?;
        Ok(self)
    }
    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        let mut retained = self.inner.retain();
        retained.push(self.admission.clone());
        retained.push(self.physical.clone());
        retained
    }
    fn execute(
        self,
        c: &rusqlite::Connection,
    ) -> Result<maka_event_log::writeback::Prepared<Self::Value>, StoreError> {
        self.admission.quiescence.validate(c)?;
        self.inner.execute(c)
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error) || matches!(error.underlying(), StoreError::SessionBusy)
    }
}
