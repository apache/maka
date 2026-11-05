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
    _session: runs::Ordered,
    _goal: runs::Ordered,
    _workspace: runs::Checkpoint,
}

impl Owner {
    pub(super) async fn checkpoint_admission(
        self: &Arc<Self>,
        id: &str,
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
        let runs = self.runs.state().await;
        if runs.closing || runs.busy(id) || runs.retained_cleanup.contains(id) {
            return Err("agent_checkpoint_busy".into());
        }
        let session = self.session(id).await?;
        let path = std::path::PathBuf::from(&session.configuration.workspace.path);
        let mut active = runs
            .controls
            .keys()
            .chain(runs.preparing.keys())
            .chain(runs.retained_cleanup.iter())
            .cloned()
            .chain(self.runs.ordered_sessions())
            .chain(self.goals.admissions.ordered_sessions())
            .filter(|active| active != id)
            .collect::<std::collections::BTreeSet<_>>();
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
        for active in active {
            // Existing checkpoint reservations are compared atomically below.
            if self.runs.checkpointed(&active) {
                continue;
            }
            let other = resolve_session(
                self.store
                    .get_session::<StoredSessionConfiguration>(&active)
                    .await
                    .map_err(|_| "agent_store_unavailable")?
                    .ok_or("agent_session_unavailable")?,
            )?;
            if runs::overlaps(
                &path,
                std::path::Path::new(&other.configuration.workspace.path),
            ) {
                return Err("agent_checkpoint_busy".into());
            }
        }
        let workspace = self.runs.checkpoint(id, path)?;
        drop(runs);
        Ok((
            CheckpointAdmission {
                _session: ordered,
                _goal: goal,
                _workspace: workspace,
            },
            session,
        ))
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
    if scope.identity.agent().is_some() {
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
