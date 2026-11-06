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

//! Authorized history publication and bounded reads through the Agent service.
use super::*;
mod load;
mod restore;
mod session;
use crate::checkpoints::{Capture, CheckpointPublisher};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_capabilities::call::Scope;
use maka_event_log::{StoreError, checkpoints as storage};
use maka_host_runtime::application::Context;
use maka_plugin_core::operation::RecoveryRef;
use tokio::io::AsyncReadExt;

pub(super) struct CheckpointAdmission {
    _workspace: runs::Checkpoint,
    _session: runs::Ordered,
    _goal: runs::Ordered,
    _wake: WakeAfterCheckpoint,
}

struct WakeAfterCheckpoint(std::sync::Weak<Owner>);

impl Drop for WakeAfterCheckpoint {
    fn drop(&mut self) {
        if let Some(owner) = self.0.upgrade() {
            owner.wake_after_checkpoint();
        }
    }
}

impl Owner {
    fn wake_after_checkpoint(self: &Arc<Self>) {
        if self.stop.is_cancelled() || self.workers.is_closed() {
            return;
        }
        self.goals.execution_changed();
        if tokio::runtime::Handle::try_current().is_ok() {
            let owner = self.clone();
            self.workers.spawn(async move {
                if owner.stop.is_cancelled() {
                    return;
                }
                owner.schedule().await;
                let _ = owner.schedule_activations(now()).await;
            });
        }
    }

    pub(super) async fn checkpoint_admission(
        self: &Arc<Self>,
        id: &str,
        extra_path: Option<&std::path::Path>,
    ) -> Result<(CheckpointAdmission, SessionRecord<ResolvedConfiguration>), String> {
        let goal = self
            .goals
            .admissions
            .try_ordered(id)
            .map_err(|_| "agent_checkpoint_busy")?;
        let ordered = self
            .runs
            .try_ordered(id)
            .map_err(|_| "agent_checkpoint_busy")?;
        let session = self.session(id).await?;
        let mut paths = vec![std::path::PathBuf::from(
            &session.configuration.workspace.path,
        )];
        if let Some(extra) = extra_path {
            let extra = extra.to_path_buf();
            if !paths.contains(&extra) {
                paths.push(extra);
            }
        }
        let workspace = self.runs.checkpoint(id, paths.clone())?;
        let admission = CheckpointAdmission {
            _workspace: workspace,
            _session: ordered,
            _goal: goal,
            _wake: WakeAfterCheckpoint(Arc::downgrade(self)),
        };
        let mut active = {
            let runs = self.runs.state().await;
            if runs.closing
                || self.stop.is_cancelled()
                || runs.controls.contains_key(id)
                || runs.preparing.contains_key(id)
                || runs.retained_cleanup.contains(id)
                || self.mcp_projects.has_any_client(id)
            {
                return Err("agent_checkpoint_busy".into());
            }
            runs.controls
                .keys()
                .chain(runs.preparing.keys())
                .chain(runs.retained_cleanup.iter())
                .cloned()
                .chain(self.runs.ordered_sessions())
                .chain(self.goals.admissions.ordered_sessions())
                .chain(self.mcp_projects.client_sessions())
                .filter(|active| active != id)
                .collect::<std::collections::BTreeSet<_>>()
        };
        if self.has_parked_invocation(id).await?
            || !self
                .store
                .session(id)
                .await
                .map_err(|_| "agent_store_unavailable")?
                .message_queue(id)
                .await
                .map_err(|_| "agent_store_unavailable")?
                .entries
                .is_empty()
        {
            return Err("agent_checkpoint_busy".into());
        }
        let mut after = None;
        loop {
            let pending = self
                .store
                .pending_message_sessions(&self.prefix, after.as_deref())
                .await
                .map_err(|_| "agent_store_unavailable")?;
            if pending.is_empty() {
                break;
            }
            after = pending.last().cloned();
            active.extend(pending.into_iter().filter(|active| active != id));
        }
        active.extend(
            self.store
                .ready_native_approval_sessions()
                .await
                .map_err(|_| "agent_store_unavailable")?
                .into_iter()
                .filter(|active| self.owns(active) && active != id),
        );
        active.extend(
            self.store
                .due_model_retry_sessions(i64::MAX as u64)
                .await
                .map_err(|_| "agent_store_unavailable")?
                .into_iter()
                .filter(|active| self.owns(active) && active != id),
        );
        for active in active {
            if self.runs.checkpointed(&active) {
                continue;
            }
            let Some(other) = self
                .store
                .get_session::<StoredSessionConfiguration>(&active)
                .await
                .map_err(|_| "agent_store_unavailable")?
            else {
                continue;
            };
            let other = resolve_session(other)?;
            let other_path = std::path::Path::new(&other.configuration.workspace.path);
            if paths.iter().any(|path| runs::overlaps(path, other_path)) {
                return Err("agent_checkpoint_busy".into());
            }
        }
        Ok((admission, session))
    }
}

impl Owner {
    fn history_checkpoints(&self) -> CheckpointPublisher {
        CheckpointPublisher::new(
            self.store.clone(),
            storage::Scope {
                state_domain: self.data_source.state_domain.clone(),
                deployment: self.data_source.deployment,
                namespace: self.data_source.namespace.clone(),
            },
            self.behavior.is_some(),
        )
    }

    pub async fn preview_history_checkpoint(
        self: &Arc<Self>,
        input: SessionRead,
        scope: &Scope,
    ) -> Result<HistoryCheckpointInventory, String> {
        management(scope)?;
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                owner.require_session(&input.session_id).await?;
                owner
                    .store
                    .preview_bundle(&input.session_id)
                    .await
                    .map(inventory)
                    .map_err(|error| match error {
                        maka_event_log::bundle::BundleError::Store(error) => failure(error),
                        maka_event_log::bundle::BundleError::CandidateSetStale => {
                            "agent_history_checkpoint_changed".into()
                        }
                    })
            })
        })
        .await
    }

    pub async fn history_checkpoint_head(
        self: &Arc<Self>,
        input: SessionRead,
        scope: &Scope,
    ) -> Result<Option<HistoryCheckpointHead>, String> {
        management(scope)?;
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                owner
                    .history_checkpoints()
                    .read_head(&input.session_id)
                    .await
                    .map(|value| value.map(head))
                    .map_err(failure)
            })
        })
        .await
    }

    pub async fn read_history_checkpoint(
        self: &Arc<Self>,
        input: HistoryCheckpointRead,
        context: Context,
    ) -> Result<Value, String> {
        management(context.scope())?;
        let scope = context.scope().clone();
        self.resource_work(&scope, move |owner, scope| {
            Box::pin(async move {
                let checkout = owner
                    .history_checkpoints()
                    .checkout_exact(&input.session_id, storage::Revision(input.revision))
                    .await
                    .map_err(failure)?;
                let workspace = checkout
                    .manifest
                    .workspace()
                    .cloned()
                    .map(workspace_snapshot);
                let storage::Manifest {
                    inventory: members,
                    bundle,
                    ..
                } = checkout.manifest;
                let expected = bundle.clone();
                emit(
                    &context,
                    &owner,
                    &scope,
                    HistoryCheckpointFrame::Checkpoint {
                        head: head(checkout.head),
                        inventory: inventory(members),
                        bundle: object(bundle),
                        workspace,
                    },
                )
                .await?;
                let mut file = tokio::fs::File::from_std(checkout.bundle);
                let mut buffer = [0; 32 * 1024];
                let mut offset = 0u64;
                use sha2::Digest;
                let mut hash = sha2::Sha256::new();
                loop {
                    if scope.cancellation.is_cancelled() || owner.stop.is_cancelled() {
                        return Err("agent_history_checkpoint_cancelled".into());
                    }
                    let count = file
                        .read(&mut buffer)
                        .await
                        .map_err(|_| "agent_history_checkpoint_read_failed")?;
                    if count == 0 {
                        break;
                    }
                    hash.update(&buffer[..count]);
                    emit(
                        &context,
                        &owner,
                        &scope,
                        HistoryCheckpointFrame::Chunk {
                            offset,
                            data: STANDARD.encode(&buffer[..count]),
                        },
                    )
                    .await?;
                    offset += count as u64;
                }
                if offset != expected.bytes || hex::encode(hash.finalize()) != expected.digest {
                    return Err("agent_history_checkpoint_integrity_failed".into());
                }
                emit(
                    &context,
                    &owner,
                    &scope,
                    HistoryCheckpointFrame::End {
                        digest: expected.digest,
                        bytes: offset,
                    },
                )
                .await?;
                Ok(Value::Null)
            })
        })
        .await
    }
}

fn management(scope: &Scope) -> Result<(), String> {
    if !matches!(
        scope.identity,
        maka_capabilities::call::Identity::Remote { .. }
    ) {
        return Err("agent_history_checkpoint_user_action_required".into());
    }
    Ok(())
}
async fn emit(
    context: &Context,
    owner: &Owner,
    scope: &Scope,
    frame: HistoryCheckpointFrame,
) -> Result<(), String> {
    if scope.cancellation.is_cancelled() || owner.stop.is_cancelled() {
        return Err("agent_history_checkpoint_cancelled".into());
    }
    context
        .emit(serde_json::to_value(frame).map_err(|_| "agent_history_checkpoint_output_invalid")?)
        .await
}
fn capture(input: CheckpointPublish) -> Capture {
    Capture {
        session_id: input.session_id,
        expected_checkpoint_revision: input.expected_revision.map(storage::Revision),
        confirmed_subtree_digest: input.confirmed_subtree_digest,
        workspace: None,
    }
}
fn object(value: storage::ObjectRef) -> HistoryCheckpointObject {
    HistoryCheckpointObject {
        digest: value.digest,
        bytes: value.bytes,
    }
}
fn workspace_snapshot(w: storage::WorkspaceSnapshot) -> CheckpointWorkspaceSnapshot {
    CheckpointWorkspaceSnapshot {
        identity: w.identity,
        inventory: object(w.inventory),
        consistency: match w.consistency {
            storage::WorkspaceConsistency::CallerConfirmedQuiescent => {
                CheckpointWorkspaceConsistency::CallerConfirmedQuiescent
            }
            storage::WorkspaceConsistency::Unverified => CheckpointWorkspaceConsistency::Unverified,
        },
        warning: CheckpointWorkspaceWarning::ExternalWritersNotFenced,
    }
}
fn head(value: storage::Head) -> HistoryCheckpointHead {
    HistoryCheckpointHead {
        revision: value.revision.0,
        manifest: object(value.manifest),
    }
}
fn inventory(value: maka_event_log::bundle::Inventory) -> HistoryCheckpointInventory {
    HistoryCheckpointInventory {
        root_session_id: value.root_session_id,
        subtree_digest: value.subtree_digest,
        sessions: value
            .sessions
            .into_iter()
            .map(|s| HistoryCheckpointSession {
                id: s.id,
                revision: s.revision,
            })
            .collect(),
    }
}
fn publication(value: storage::Publication) -> CheckpointPublication {
    let state = match value.state {
        storage::PublicationState::Capturing => HistoryCheckpointState::Capturing,
        storage::PublicationState::Prepared { .. } => HistoryCheckpointState::Prepared,
        storage::PublicationState::Published { head: value } => {
            HistoryCheckpointState::Published { head: head(value) }
        }
        storage::PublicationState::Conflict { actual } => HistoryCheckpointState::Conflict {
            actual: actual.map(|r| r.0),
        },
        storage::PublicationState::Interrupted => HistoryCheckpointState::Interrupted,
        storage::PublicationState::Unavailable { .. } => HistoryCheckpointState::Unavailable,
    };
    CheckpointPublication {
        state,
        cleanup_pending: value.cleanup_pending,
        workspace: None,
    }
}
fn failure(error: StoreError) -> String {
    tracing::warn!(
        stage = "history_checkpoint",
        cause = crate::diagnostics::store_cause(&error),
        sql_code = crate::diagnostics::store_sql_code(&error),
        "History checkpoint operation failed"
    );
    match error {
        StoreError::SessionBusy => "agent_history_checkpoint_busy",
        StoreError::SessionNotFound | StoreError::SessionRetired => "agent_session_unavailable",
        StoreError::ConnectionClosed => "agent_work_closed",
        StoreError::CommitUnknown(_) | StoreError::OperationUnknown => {
            "agent_history_checkpoint_outcome_unknown"
        }
        _ => "agent_history_checkpoint_unavailable",
    }
    .into()
}
