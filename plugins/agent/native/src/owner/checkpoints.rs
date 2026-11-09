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
    _ordered: Arc<runs::Ordered>,
    _goal: Arc<runs::Ordered>,
    quiescence: maka_agent_state::SessionQuiescenceGuard,
    physical: Option<Arc<maka_event_log::root_store::WorkspaceFence>>,
}
impl Owner {
    pub(super) async fn checkpoint_admission(
        self: &Arc<Self>,
        id: &str,
        capture_workspace: bool,
    ) -> Result<
        (
            Arc<CheckpointAdmission>,
            SessionRecord<ResolvedConfiguration>,
        ),
        String,
    > {
        let goal = Arc::new(
            self.goals
                .admissions
                .try_ordered(id)
                .map_err(|_| "agent_checkpoint_busy")?,
        );
        let ordered = Arc::new(
            self.runs
                .try_ordered(id)
                .map_err(|_| "agent_checkpoint_busy")?,
        );
        {
            let runs = self.runs.state().await;
            if runs.closing
                || self.stop.is_cancelled()
                || runs.busy(id)
                || self.mcp_projects.has_any_client(id)
            {
                return Err("agent_checkpoint_busy".into());
            }
        }
        let session = self.session(id).await?;
        let quiescence = self
            .durable
            .quiescence_guard(self.run_owner(), id.to_owned())
            .map_err(failure)?;
        if !quiescence.observe().await.map_err(failure)?.is_quiescent() {
            return Err("agent_checkpoint_busy".into());
        }
        let physical = if capture_workspace {
            let directory = workspace::open_workspace(
                &self.workspace_roots,
                &session.configuration.workspace,
                &self.managed_worktrees,
            )
            .await?;
            let workspace = self.store.workspace(directory).await.map_err(failure)?;
            Some(Arc::new(
                self.store
                    .fence_workspace(&workspace)
                    .await
                    .map_err(failure)?,
            ))
        } else {
            None
        };
        Ok((
            Arc::new(CheckpointAdmission {
                _ordered: ordered,
                _goal: goal,
                quiescence,
                physical,
            }),
            session,
        ))
    }

    async fn checkpoint_file(&self, id: &str) -> Result<std::fs::File, String> {
        self.history_checkpoints()
            .request_file(id)
            .await
            .map_err(failure)
    }

    fn checkpoint_state(&self) -> Result<maka_agent_state::Store, String> {
        self.durable
            .with_data_writer(self.store.data_writer().map_err(failure)?)
            .map_err(failure)
    }
    async fn checkpoint_inventory(&self, id: &str) -> Result<HistoryCheckpointInventory, String> {
        let session = self.session(id).await?;
        let children = self
            .canonical_catalog()?
            .page(
                maka_event_log::sessions::CatalogScope::Owned {
                    id_prefix: self.prefix.clone(),
                    selection: maka_event_log::sessions::CatalogSelection::Children(id.to_owned()),
                    title_query: String::new(),
                },
                None,
                maka_agent_state::session_catalog::Position::Start,
                maka_agent_state::session_catalog::Filter {
                    base: maka_event_log::sessions::CatalogFilter {
                        roots_only: false,
                        archived_only: false,
                        include_archived: true,
                    },
                    needs_you_only: false,
                },
                1,
            )
            .await
            .map_err(failure)?;
        if !children.sessions.is_empty() {
            return Err("agent_checkpoint_multiple_sessions_require_separate_sources".into());
        }
        let subtree_digest = hex::encode(Sha256::digest(
            serde_json::to_vec(&("maka.agent.checkpoint-membership.v1", self.run_owner(), id))
                .map_err(|error| error.to_string())?,
        ));
        Ok(HistoryCheckpointInventory {
            root_session_id: id.to_owned(),
            subtree_digest,
            sessions: vec![HistoryCheckpointSession {
                id: id.to_owned(),
                revision: session.revision,
            }],
        })
    }
}

fn snapshot_id(
    operation: &RecoveryRef,
) -> Result<maka_agent_facts::history_snapshot::SnapshotId, String> {
    let digest = Sha256::digest(serde_json::to_vec(operation).map_err(|error| error.to_string())?);
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    maka_agent_facts::history_snapshot::SnapshotId::try_from(Uuid::from_bytes(bytes))
        .map_err(|error| error.to_string())
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
                owner.checkpoint_inventory(&input.session_id).await
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
                let expected = checkout.manifest.history.object.clone();
                let history = checkpoint_snapshot(checkout.manifest.history);
                emit(
                    &context,
                    &owner,
                    &scope,
                    HistoryCheckpointFrame::Checkpoint {
                        head: head(checkout.head),
                        history,
                        workspace,
                    },
                )
                .await?;
                let mut file = tokio::fs::File::from_std(checkout.snapshot);
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
fn checkpoint_snapshot(value: storage::HistorySnapshot) -> HistoryCheckpointSnapshot {
    HistoryCheckpointSnapshot {
        object: object(value.object),
        inventory: value.inventory,
        cut: value.cut,
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
    match error.underlying() {
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
