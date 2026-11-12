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

use super::*;
use maka_agent_facts::{durable::UnixMillis, history_snapshot::SnapshotId};
use maka_agent_state::session_history::snapshot::Adoption;
use maka_agent_state::session_history::snapshot::ImportedCaptureRequest;
use maka_event_log::writeback::{Prepared, Statement};

impl Owner {
    pub(super) async fn import_copy(
        &self,
        selection: ImportSelection,
        path: String,
        title: String,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<ImportResult>, Failure> {
        if metadata_rejection(&title, &[]).is_some() {
            return Err(Failure::Invalid);
        }
        if self.runs.state().await.closing
            || scope.cancellation.is_cancelled()
            || self.stop.is_cancelled()
        {
            return Err(Failure::Unavailable);
        }
        let writer = self.import_writer(scope)?;
        let state = self
            .durable
            .with_data_writer(writer.clone())
            .map_err(Failure::from)?;
        let target = self.operation_id(operation);
        let history = state.session_history(self.run_owner(), target.clone());
        let id = snapshot_id(operation)?;
        let snapshot = match history
            .captured_imported(id, scope.cancellation.child_token())
            .await
            .map_err(Failure::from)?
        {
            Some((_, original)) => original,
            None => {
                let reader = self.import_source(&selection.source, scope).await?;
                let source = maka_agent_facts::import::Source {
                    adapter: match &reader.source.location {
                        ImportLocation::Codex { .. } => "codex",
                        ImportLocation::ClaudeCode { .. } => "claude-code",
                        ImportLocation::OpenCode { .. } => "opencode",
                    }
                    .into(),
                    session_id: selection.entry.session_id.clone(),
                };
                let mut capture = capture::Capture::new(
                    self.run_owner(),
                    target.clone(),
                    source,
                    operation.operation,
                    history_source::turn(operation),
                    now(),
                )
                .await?;
                let selected = source::Selection {
                    source_id: selection.source.id,
                    source_revision: selection.source.revision,
                    session_id: selection.entry.session_id.clone(),
                    path: selection.entry.path.clone(),
                };
                let transcript = reader
                    .adapter
                    .read_exact(&reader, &selected, &mut capture)
                    .await?;
                reader.validate(self).await?;
                if preview::digest(&transcript.fingerprint)? != selection.digest
                    || self.import_sources().await?.revision != selection.source.revision
                {
                    return Err(Failure::Changed);
                }
                let (file, fingerprint) = capture.finish(&transcript).await?;
                let request = ImportedCaptureRequest {
                    id,
                    source: transcript.source,
                    fingerprint,
                    model_start: None,
                };
                match history
                    .capture_imported(request, file, scope.cancellation.child_token())
                    .await
                {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        let failure = Failure::from(error);
                        if !matches!(failure, Failure::Unknown) {
                            return Err(failure);
                        }
                        // Reconcile the original write; never read a changed CLI source to retry it.
                        match history
                            .captured_imported(id, scope.cancellation.child_token())
                            .await
                        {
                            Ok(Some((_, original))) => original,
                            Ok(None) => return Err(Failure::Unknown),
                            Err(error) => {
                                let _ = Failure::from(error);
                                return Err(Failure::Unknown);
                            }
                        }
                    }
                }
            }
        };
        if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err(Failure::Unavailable);
        }
        let workspace = self
            .create_project_workspace(&path)
            .await
            .map_err(|_| Failure::Unknown)?
            .ok_or(Failure::Unavailable)?;
        let (candidate, workspace_statement) = self
            .store
            .prepare_creation_workspace(
                &self.prefix,
                &workspace.workspace,
                Some(workspace.project),
                &writer,
            )
            .await
            .map_err(Failure::from)?;
        let binding = candidate.reference();
        let stamp = candidate.stamp();
        let selected_workspace: Workspace =
            serde_json::from_value(candidate.workspace).map_err(|_| Failure::Invalid)?;
        let policy = self
            .creation_policy(scope)
            .await
            .map_err(|_| Failure::Unavailable)?;
        let configuration = StoredSessionConfiguration {
            parent_session_id: scope
                .identity
                .agent()
                .map(|source| source.session_id.clone()),
            backend: None,
            applied_preset: None,
            compaction_prompt: None,
            collaboration_mode: CollaborationMode::Agent,
            tools: policy.tools,
            title,
            title_is_manual: true,
            pinned: false,
            labels: vec![],
            workspace: binding,
            permissions: policy.permissions,
            boundary_revision: 0,
        };
        let resolved = configuration
            .clone()
            .resolve(selected_workspace, stamp)
            .map_err(|_| Failure::Changed)?;
        let (spec, contents) = self
            .history_source_spec(&target, &resolved, &snapshot, operation, scope)
            .await
            .map_err(|_| Failure::Unavailable)?;
        let at = now();
        let adoption = snapshot
            .adopt(
                &history,
                id.as_uuid(),
                spec,
                UnixMillis(at as i64),
                contents,
            )
            .map_err(Failure::from)?;
        let planned = maka_agent_state::session_catalog::SessionCatalog::new(
            writer.clone(),
            self.run_owner(),
            self.prefix.clone(),
        )
        .map_err(Failure::from)?
        .planned_adoption(&adoption)
        .await
        .map_err(Failure::from)?;
        let claim = maka_event_log::sessions::PluginSession {
            session_id: target,
            creator: namespace(),
            fingerprint: operation.fingerprint.clone(),
            authority_session_id: scope
                .identity
                .agent()
                .map(|source| source.session_id.clone()),
        };
        let configuration = serde_json::to_value(configuration).map_err(|_| Failure::Invalid)?;
        let statement = self
            .store
            .prepare_plugin_session_with_workspace(
                &claim,
                &configuration,
                at,
                &writer,
                workspace_statement,
                adoption,
            )
            .await
            .map_err(Failure::from)?;
        let source = self.data_source.clone();
        let change = writer
            .prepare_result(|_| {
                Ok(ImportedPublication {
                    statement,
                    planned,
                    source,
                    caller: policy.caller,
                })
            })
            .map_err(Failure::from)?;
        Ok(NativeMutation::Computed { change })
    }
}
struct ImportedPublication<S> {
    statement: S,
    planned: maka_agent_state::session_catalog::PlannedCatalog,
    source: DataSource,
    caller: Option<maka_agent_state::CallerFence>,
}

#[derive(Serialize)]
#[serde(transparent)]
struct ImportedResult {
    reply: Value,
    #[serde(skip)]
    inner: Option<(SessionRecord, Adoption)>,
}
impl<S> Statement for ImportedPublication<S>
where
    S: Statement<Value = (SessionRecord, Adoption)>,
{
    type Value = ImportedResult;
    type Output = (Value, Option<S::Output>);
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        self.statement.retain()
    }
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(Self {
            statement: self.statement.prepare()?,
            ..self
        })
    }
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        let rejected = |reply: ImportResult| -> Result<Prepared<Self::Value>, StoreError> {
            Ok(Prepared {
                value: ImportedResult {
                    reply: serde_json::to_value(reply)?,
                    inner: None,
                },
                changed: false,
                notification: maka_event_log::writeback::Notification::NONE,
            })
        };
        if let Some(caller) = &self.caller {
            let reply = match caller.status(connection)? {
                maka_agent_state::CallerStatus::Current => None,
                maka_agent_state::CallerStatus::Unavailable => Some(ImportResult::Unavailable),
                maka_agent_state::CallerStatus::AuthorizationChanged => Some(ImportResult::Changed),
            };
            if let Some(reply) = reply {
                return rejected(reply);
            }
        }
        let written = creation::creation_sql(
            connection,
            || {
                let installed = self.statement.execute(connection)?;
                let record = self.planned.record(installed.value.0.clone())?;
                let session =
                    crate::service::summary_for(&self.source, record).map_err(|diagnostic| {
                        StoreError::StatementRejected {
                            cause: Arc::new(StoreError::InvalidTransition(diagnostic.clone())),
                            diagnostic,
                        }
                    })?;
                Ok(Prepared {
                    value: ImportedResult {
                        reply: serde_json::to_value(ImportResult::Imported {
                            session: Box::new(session),
                        })?,
                        inner: Some(installed.value),
                    },
                    changed: installed.changed,
                    notification: installed.notification,
                })
            },
            import_rejection,
        )?;
        match written {
            Ok(success) => Ok(success),
            Err(reply) => rejected(reply),
        }
    }
    fn committed(value: Self::Value) -> Self::Output {
        (value.reply, value.inner.map(S::committed))
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error.underlying(), StoreError::StatementRejected { .. })
            || S::isolated_rejection(error)
    }
}
fn import_rejection(error: &StoreError) -> Option<ImportResult> {
    use maka_event_log::{projects::ProjectError, root_store::CreationRejection};
    match creation::rejection_cause(error) {
        StoreError::Project(ProjectError::Changed)
        | StoreError::RevisionConflict { .. }
        | StoreError::SessionRevisionConflict { .. }
        | StoreError::EventConflict
        | StoreError::SessionConflict
        | StoreError::SessionCreationRejected(
            CreationRejection::IdentityConflict
            | CreationRejection::SourceRevisionConflict { .. }
            | CreationRejection::StaleWorkspaceBinding,
        ) => Some(ImportResult::Changed),
        StoreError::Project(
            ProjectError::Archived
            | ProjectError::NotFound
            | ProjectError::Unavailable
            | ProjectError::PathMismatch,
        )
        | StoreError::SessionNotFound
        | StoreError::SessionRetired
        | StoreError::SessionBusy
        | StoreError::SessionCreationRejected(
            CreationRejection::MissingDependency
            | CreationRejection::Retired
            | CreationRejection::MissingWorkspaceBinding,
        ) => Some(ImportResult::Unavailable),
        StoreError::InvalidTransition(reason)
            if matches!(
                reason.as_str(),
                "prepared workspace binding changed"
                    | "prepared project identity changed"
                    | "historical source cannot replace an active execution"
            ) =>
        {
            Some(ImportResult::Changed)
        }
        _ => None,
    }
}

fn snapshot_id(operation: &RecoveryRef) -> Result<SnapshotId, Failure> {
    let encoded =
        serde_json::to_vec(&("maka.import.capture.v1", operation)).map_err(|_| Failure::Invalid)?;
    let digest = Sha256::digest(encoded);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    SnapshotId::try_from(Uuid::from_bytes(bytes)).map_err(|_| Failure::Invalid)
}
