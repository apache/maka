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

//! A fork publishes source history, metadata and the original Host return together.
use super::*;
use maka_agent_facts::{
    durable::{RunOrigin, RunOwner, UnixMillis},
    history_snapshot::SnapshotId,
    session::{BranchOrigin, Lineage},
};
use maka_agent_state::{
    session_catalog::{ControlCommand, ControlEdit},
    session_history::snapshot::ForkSnapshotSource,
};
use maka_capabilities::call::Scope;
use maka_event_log::{
    StoreError,
    root_store::CreationRejection,
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::{
    operation::{OperationOutcome, OperationResult, RecoveryRef},
    storage::Namespace,
};

impl Owner {
    pub async fn fork(
        self: &Arc<Self>,
        input: Fork,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<ForkResult>, String> {
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move { owner.fork_inner(input, &operation, &scope).await })
        })
        .await
    }

    async fn original_fork(&self, reference: &RecoveryRef) -> Result<Option<ForkResult>, String> {
        self.check_fork_reference(reference)?;
        let observed = self
            .store
            .operation(reference)
            .map_err(fork_failure)?
            .operation_observation()
            .await
            .map_err(fork_failure)?;
        match observed.map(|observed| observed.outcome) {
            Some(OperationOutcome::Returned {
                result: OperationResult::Success { value },
            }) => {
                let value: ForkResult = serde_json::from_value(value)
                    .map_err(|_| "agent_fork_reference_unavailable")?;
                if let ForkResult::Forked { session } = &value
                    && session.id != self.operation_id(reference)
                {
                    return Err("agent_fork_reference_unavailable".into());
                }
                Ok(Some(value))
            }
            Some(OperationOutcome::Returned {
                result: OperationResult::Failure { diagnostic },
            }) => Err(diagnostic),
            Some(OperationOutcome::Unknown { .. }) => Err("agent_fork_outcome_unknown".into()),
            Some(OperationOutcome::NotExecuted { .. }) => Err("agent_fork_not_executed".into()),
            Some(OperationOutcome::Unresolved) | None => Ok(None),
        }
    }

    fn check_fork_reference(&self, reference: &RecoveryRef) -> Result<(), String> {
        reference
            .validate()
            .map_err(|_| "agent_fork_reference_invalid")?;
        if reference.source.state_domain != self.data_source.state_domain
            || reference.source.deployment != self.data_source.deployment
            || reference.namespace != self.data_source.namespace
            || reference.export != maka_agent_api::EXPORT
            || reference.method != "fork"
        {
            return Err("agent_fork_reference_unavailable".into());
        }
        Ok(())
    }

    async fn fork_inner(
        &self,
        input: Fork,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<ForkResult>, String> {
        // The exact Host receipt wins even after source changes or deletion.
        // Neither this lookup nor forkReceipt recreates a removed destination.
        if let Some(recorded) = self.original_fork(operation).await? {
            return Ok(NativeMutation::Returned(recorded));
        }
        if let Some(reason) = metadata_rejection(&input.title, &input.labels) {
            return Ok(rejected(reason));
        }
        if self.runs.state().await.closing {
            return Ok(rejected(Rejection::Closed));
        }
        if !self.owns(&input.session_id) {
            return Ok(rejected(Rejection::SessionUnavailable));
        }
        let selected = match self.store.session(&input.session_id).await {
            Ok(selected) => selected,
            Err(error) => return publication_error(error),
        };
        let Some(source) = self
            .store
            .get_session::<StoredSessionConfiguration>(&input.session_id)
            .await
            .map_err(fork_failure)?
        else {
            return Ok(rejected(Rejection::SessionUnavailable));
        };
        let source = resolve_session(source)?;
        if source.revision != input.expected_revision {
            return Ok(NativeMutation::Returned(ForkResult::RevisionConflict {
                expected: input.expected_revision,
                actual: source.revision,
            }));
        }
        if !self
            .project_accepts_session(&source.configuration.workspace)
            .await?
        {
            return Ok(rejected(Rejection::SessionUnavailable));
        }
        if workspace::validate(
            &self.workspace_roots,
            &source.configuration.workspace,
            &self.managed_worktrees,
        )
        .await
        .is_err()
        {
            return Ok(rejected(Rejection::WorkspaceUnavailable));
        }
        if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_fork_cancelled".into());
        }
        let writer = if let Some(execution) = scope.identity.agent() {
            let custody = scope.work_custody().ok_or("agent_work_custody_required")?;
            self.store
                .data_writer_for_work(custody.as_ref(), &execution.session_id)
        } else {
            self.store.data_writer()
        }
        .map_err(fork_failure)?;
        let state = self
            .durable
            .with_data_writer(writer.clone())
            .map_err(fork_failure)?;
        let run_owner = RunOwner {
            deployment: self.data_source.deployment,
            namespace: self.data_source.namespace.clone(),
        };
        let history = state.session_history(run_owner.clone(), input.session_id.clone());
        // The complete reference, not a provider-local UUID, names this fork.
        let digest =
            Sha256::digest(serde_json::to_vec(operation).map_err(|error| error.to_string())?);
        let mut bytes = [0; 16];
        bytes.copy_from_slice(&digest[..16]);
        let id = SnapshotId::try_from(uuid::Uuid::from_bytes(bytes))
            .map_err(|error| error.to_string())?;
        let guard = selected
            .revision_guard(&writer, input.expected_revision)
            .map_err(fork_failure)?;
        let cancellation = scope.cancellation.child_token();
        let capture =
            history.capture_fork_snapshot(id, input.position.clone(), guard, cancellation.clone());
        tokio::pin!(capture);
        let capture = tokio::select! {
            biased;
            _=self.stop.cancelled()=> {cancellation.cancel();capture.await},
            capture=&mut capture=>capture,
        };
        let captured = match capture {
            Ok(captured) => captured,
            Err(_) if scope.cancellation.is_cancelled() || self.stop.is_cancelled() => {
                return Err("agent_fork_cancelled".into());
            }
            Err(error) if matches!(error.underlying(), StoreError::InvalidTransition(_)) => {
                fork_failure(error);
                return Ok(rejected(Rejection::HistoryUnavailable));
            }
            Err(error) => return publication_error(error),
        };
        let snapshot = captured.snapshot();
        let parent = source.configuration;
        let catalog = if parent
            .tools
            .as_ref()
            .is_some_and(|names| names.iter().any(|name| name.starts_with("mcp__")))
        {
            let floor = self.capture_sandbox(&parent, scope.sandbox_floor()).await?;
            self.mcp_projects.capture(&parent.workspace, &floor).await?
        } else {
            self.mcp_projects.base.clone()
        };
        let policy = self.creation_policy(scope).await?;
        let tools = intersect_tools(parent.tools, policy.tools).map(|names| {
            names
                .into_iter()
                .filter(|name| catalog.tools.contains(name))
                .collect()
        });
        let ceiling = policy.permissions;
        let access = match (parent.permissions.access, ceiling.access) {
            (WorkspaceAccess::ReadOnly, _) | (_, WorkspaceAccess::ReadOnly) => {
                WorkspaceAccess::ReadOnly
            }
            (WorkspaceAccess::WorkspaceWrite, _) | (_, WorkspaceAccess::WorkspaceWrite) => {
                WorkspaceAccess::WorkspaceWrite
            }
            _ => WorkspaceAccess::DangerFullAccess,
        };
        let (candidate, workspace_statement) = self
            .store
            .prepare_creation_workspace(&self.prefix, &parent.workspace, None, &writer)
            .await
            .map_err(fork_failure)?;
        let workspace = candidate.reference();
        let stamp = candidate.stamp();
        let configuration = StoredSessionConfiguration {
            parent_session_id: scope
                .identity
                .agent()
                .map(|source| source.session_id.clone()),
            backend: parent.backend,
            applied_preset: parent.applied_preset,
            compaction_prompt: parent.compaction_prompt,
            collaboration_mode: CollaborationMode::Agent,
            tools,
            title: input.title,
            title_is_manual: true,
            pinned: false,
            labels: input.labels,
            workspace,
            permissions: WorkspacePermissions {
                access,
                request_permissions: parent.permissions.request_permissions
                    && ceiling.request_permissions,
            },
            boundary_revision: 0,
        };

        let claim = maka_event_log::sessions::PluginSession {
            session_id: self.operation_id(operation),
            creator: Namespace::new(IMPLEMENTATION, maka_plugin_core::scope::Scope::Profile)
                .map_err(|error| error.to_string())?,
            fingerprint: operation.fingerprint.clone(),
            authority_session_id: Some(input.session_id.clone()),
        };
        let guard = selected
            .revision_guard(&writer, input.expected_revision)
            .map_err(fork_failure)?;
        let at = now();
        let recorded_at = UnixMillis(at.try_into().map_err(|_| "agent_clock_invalid")?);
        let catalog = self.canonical_catalog()?;
        let control = catalog.control_statement(
            claim.session_id.clone(),
            ControlCommand {
                id: self.control_id(operation, "fork_lineage"),
                at: recorded_at,
                expected_revision: 0,
                edit: ControlEdit::EstablishLineage {
                    lineage: Lineage::Branch {
                        origin: BranchOrigin {
                            parent_session_id: input.session_id.clone(),
                            position: input.position.clone(),
                        },
                    },
                    source: captured.guard_cut().clone(),
                },
            },
        );
        let serialized_configuration =
            serde_json::to_value(&configuration).map_err(|error| error.to_string())?;
        let change = match captured.source() {
            ForkSnapshotSource::Empty => {
                let planned = catalog
                    .planned_empty(&claim.session_id)
                    .map_err(fork_failure)?
                    .with_control(&control)
                    .map_err(fork_failure)?;
                let statement = control.with(EmptyHistory, &writer).map_err(fork_failure)?;
                let statement = captured
                    .guard(&history, guard, statement)
                    .map_err(fork_failure)?;
                let statement = match self
                    .store
                    .prepare_plugin_session_with_workspace(
                        &claim,
                        &serialized_configuration,
                        at,
                        &writer,
                        workspace_statement,
                        statement,
                    )
                    .await
                {
                    Ok(statement) => statement,
                    Err(error) => return publication_error(error),
                };
                writer
                    .prepare_result(|_| {
                        Ok(ForkPublication {
                            statement,
                            planned,
                            source: self.data_source.clone(),
                            caller: policy.caller,
                        })
                    })
                    .map_err(fork_failure)?
            }
            ForkSnapshotSource::Canonical { .. } | ForkSnapshotSource::Imported => {
                let resolved = configuration
                    .clone()
                    .resolve(
                        serde_json::from_value(candidate.workspace)
                            .map_err(|error| error.to_string())?,
                        stamp,
                    )
                    .map_err(|error| error.to_string())?;
                let (mut spec, contents) = self
                    .history_source_spec(&claim.session_id, &resolved, snapshot, operation, scope)
                    .await?;
                if let ForkSnapshotSource::Canonical { run } = captured.source() {
                    let source = snapshot.run_source(run).await.map_err(fork_failure)?;
                    spec.origin = RunOrigin::Forked {
                        source_run: source.run,
                        source: snapshot.reference().clone(),
                    };
                }
                let target = state.session_history(run_owner, claim.session_id.clone());
                let adoption = snapshot
                    .adopt(&target, id.as_uuid(), spec, recorded_at, contents)
                    .map_err(fork_failure)?;
                let planned = catalog
                    .planned_adoption(&adoption)
                    .await
                    .map_err(fork_failure)?
                    .with_control(&control)
                    .map_err(fork_failure)?;
                let statement = control.with(adoption, &writer).map_err(fork_failure)?;
                let statement = captured
                    .guard(&history, guard, statement)
                    .map_err(fork_failure)?;
                let statement = match self
                    .store
                    .prepare_plugin_session_with_workspace(
                        &claim,
                        &serialized_configuration,
                        at,
                        &writer,
                        workspace_statement,
                        statement,
                    )
                    .await
                {
                    Ok(statement) => statement,
                    Err(error) => return publication_error(error),
                };
                writer
                    .prepare_result(|_| {
                        Ok(ForkPublication {
                            statement,
                            planned,
                            source: self.data_source.clone(),
                            caller: policy.caller,
                        })
                    })
                    .map_err(fork_failure)?
            }
        };
        Ok(NativeMutation::Computed { change })
    }

    pub async fn fork_receipt(
        self: &Arc<Self>,
        input: ForkReceipt,
        scope: &Scope,
    ) -> Result<ForkReceiptResult, String> {
        self.check_fork_reference(&input.reference)?;
        self.resource_work(scope, move |owner, _scope| {
            Box::pin(async move {
                let Some(ForkResult::Forked { .. }) = owner.original_fork(&input.reference).await?
                else {
                    return Ok(ForkReceiptResult { session: None });
                };
                let target = owner.operation_id(&input.reference);
                let session = owner
                    .canonical_catalog()?
                    .record(&target)
                    .await
                    .map_err(fork_failure)?
                    .map(|record| crate::service::summary(&owner, record).map(Box::new))
                    .transpose()?;
                Ok(ForkReceiptResult { session })
            })
        })
        .await
    }
}

struct ForkPublication<S> {
    statement: S,
    planned: maka_agent_state::session_catalog::PlannedCatalog,
    source: DataSource,
    caller: Option<maka_agent_state::CallerFence>,
}

#[derive(Serialize)]
#[serde(transparent)]
struct ForkPublicationValue<T> {
    reply: Value,
    #[serde(skip)]
    inner: Option<T>,
}
impl<S, D> Statement for ForkPublication<S>
where
    S: Statement<Value = (SessionRecord, D)>,
    D: std::marker::Send + 'static,
{
    type Value = ForkPublicationValue<S::Value>;
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
        let rejected = |reply: ForkResult| -> Result<Prepared<Self::Value>, StoreError> {
            Ok(Prepared {
                value: ForkPublicationValue {
                    reply: serde_json::to_value(reply)?,
                    inner: None,
                },
                changed: false,
                notification: Notification::NONE,
            })
        };
        if let Some(caller) = &self.caller {
            let reason = match caller.status(connection)? {
                maka_agent_state::CallerStatus::Current => None,
                maka_agent_state::CallerStatus::Unavailable => Some(Rejection::SessionUnavailable),
                maka_agent_state::CallerStatus::AuthorizationChanged => {
                    Some(Rejection::WorkspaceUnavailable)
                }
            };
            if let Some(reason) = reason {
                return rejected(ForkResult::Rejected { reason });
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
                    value: ForkPublicationValue {
                        reply: serde_json::to_value(ForkResult::Forked {
                            session: Box::new(session),
                        })?,
                        inner: Some(installed.value),
                    },
                    changed: installed.changed,
                    notification: installed.notification,
                })
            },
            fork_rejection,
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
fn fork_rejection(error: &StoreError) -> Option<ForkResult> {
    match creation::rejection_cause(error) {
        StoreError::SessionRevisionConflict { expected, actual }
        | StoreError::SessionCreationRejected(CreationRejection::SourceRevisionConflict {
            expected,
            actual,
        }) => Some(ForkResult::RevisionConflict {
            expected: *expected,
            actual: *actual,
        }),
        StoreError::EventConflict => Some(ForkResult::Rejected {
            reason: Rejection::HistoryUnavailable,
        }),
        StoreError::InvalidTransition(reason)
            if matches!(
                reason.as_str(),
                "fork source cut splits a complete Turn"
                    | "fork source has unresolved original effects or cleanup"
                    | "history cut is not retained; explicit rebuild required"
                    | "fork baseline is not an actual completed historical marker"
                    | "fork baseline guard is not its actual complete marker fence"
            ) =>
        {
            Some(ForkResult::Rejected {
                reason: Rejection::HistoryUnavailable,
            })
        }
        _ => creation::creation_rejection(error).map(|reason| ForkResult::Rejected { reason }),
    }
}

struct EmptyHistory;
impl Statement for EmptyHistory {
    type Value = ();
    type Output = ();
    fn execute(self, _: &rusqlite::Connection) -> Result<Prepared<()>, StoreError> {
        Ok(Prepared {
            value: (),
            changed: false,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
fn rejected(reason: Rejection) -> NativeMutation<ForkResult> {
    NativeMutation::Returned(ForkResult::Rejected { reason })
}
fn publication_error(error: StoreError) -> Result<NativeMutation<ForkResult>, String> {
    let reason = match error {
        StoreError::SessionRevisionConflict { expected, actual }
        | StoreError::SessionCreationRejected(CreationRejection::SourceRevisionConflict {
            expected,
            actual,
        }) => {
            return Ok(NativeMutation::Returned(ForkResult::RevisionConflict {
                expected,
                actual,
            }));
        }
        StoreError::SessionNotFound
        | StoreError::SessionRetired
        | StoreError::SessionCreationRejected(
            CreationRejection::MissingDependency | CreationRejection::Retired,
        ) => Rejection::SessionUnavailable,
        StoreError::SessionCreationRejected(
            CreationRejection::MissingWorkspaceBinding | CreationRejection::StaleWorkspaceBinding,
        ) => Rejection::WorkspaceUnavailable,
        StoreError::SessionCreationRejected(CreationRejection::IdentityConflict)
        | StoreError::EventConflict
        | StoreError::SessionConflict => return Err("agent_fork_conflict".into()),
        StoreError::SessionBusy => Rejection::Busy,
        error => return Err(fork_failure(error)),
    };
    Ok(rejected(reason))
}

fn fork_failure(error: StoreError) -> String {
    tracing::warn!(
        stage = "session_fork",
        cause = crate::diagnostics::store_cause(&error),
        error = ?error,
        sql_code = crate::diagnostics::store_sql_code(&error),
        "Session fork storage operation failed"
    );
    match error.underlying() {
        StoreError::CommitUnknown(_) | StoreError::OperationUnknown => "agent_fork_outcome_unknown",
        _ => "agent_fork_failed",
    }
    .into()
}
