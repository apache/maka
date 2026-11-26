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
use maka_agent_state::SessionQuiescenceGuard;
use maka_capabilities::call::{Identity, Scope};
use maka_event_log::{
    StoreError,
    writeback::{Notification, Prepared, Statement},
};
use maka_fs_tools::workspace::project::{ResolvedProject, resolve_selected_sync};
use serde::Serialize;

impl Owner {
    pub(crate) async fn session_workspace_available(
        &self,
        input: SessionRead,
        scope: &Scope,
    ) -> Result<bool, String> {
        require_workspace_client(scope)?;
        let session = self.session(&input.session_id).await?;
        match workspace::validate(
            &self.workspace_roots,
            &session.configuration.workspace,
            &self.managed_worktrees,
        )
        .await
        {
            Ok(()) => Ok(true),
            Err(error) if error == "agent_workspace_unavailable" => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn change_session_workspace(
        self: &Arc<Self>,
        input: ChangeSessionWorkspace,
        scope: &Scope,
    ) -> Result<NativeMutation<SessionWorkspaceChanged>, String> {
        require_workspace_client(scope)?;
        self.resource_work(scope, move |owner, _scope| {
            Box::pin(async move { owner.prepare_session_workspace_change(input).await })
        })
        .await
    }

    async fn prepare_session_workspace_change(
        &self,
        input: ChangeSessionWorkspace,
    ) -> Result<NativeMutation<SessionWorkspaceChanged>, String> {
        let id = input.session_id;
        if !self.owns(&id) {
            return Ok(rejected(Rejection::SessionUnavailable));
        }
        let family = self
            .store
            .workspace_change_family(&id, &self.prefix)
            .await
            .map_err(|error| error.to_string())?;
        let mut ordered = Vec::with_capacity(family.members().len());
        for member in family.members() {
            if !self.owns(member) {
                return Ok(rejected(Rejection::SessionUnavailable));
            }
            let Ok(gate) = self.runs.try_ordered(member) else {
                return Ok(rejected(Rejection::Busy));
            };
            ordered.push(Arc::new(gate));
        }
        {
            let runs = self.runs.state().await;
            if runs.closing || self.stop.is_cancelled() {
                return Ok(rejected(Rejection::Closed));
            }
            if family
                .members()
                .iter()
                .any(|member| runs.busy(member) || self.mcp_projects.has_any_client(member))
            {
                return Ok(rejected(Rejection::Busy));
            }
        }
        let Some(record) = self
            .canonical_catalog()?
            .record(&id)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(rejected(Rejection::SessionUnavailable));
        };
        if record.is_room || record.metadata.archived {
            return Ok(rejected(Rejection::SessionUnavailable));
        }
        if record.metadata.revision != input.expected_revision {
            return Ok(NativeMutation::Returned(
                SessionWorkspaceChanged::RevisionConflict {
                    expected: input.expected_revision,
                    actual: record.metadata.revision,
                },
            ));
        }
        let mut guards = Vec::with_capacity(family.members().len());
        let rooms = self.rooms()?;
        for member in family.members() {
            if member != &id
                && rooms
                    .exists(member)
                    .await
                    .map_err(|error| error.to_string())?
            {
                return Ok(rejected(Rejection::SessionUnavailable));
            }
            let guard = self
                .durable
                .quiescence_guard(self.run_owner(), member.clone())
                .map_err(|error| error.to_string())?;
            if !guard
                .observe()
                .await
                .map_err(|error| error.to_string())?
                .is_quiescent()
            {
                return Ok(rejected(Rejection::Busy));
            }
            guards.push(guard);
        }
        let writer = self
            .store
            .data_writer()
            .map_err(|error| error.to_string())?;
        let Some((projects::PreparedProjectWorkspace { workspace, project }, target)) =
            self.prepare_project_workspace(&input.path, &writer).await?
        else {
            return Ok(rejected(Rejection::WorkspaceUnavailable));
        };
        let (_, workspace) = match self
            .store
            .prepare_creation_workspace(
                &self.prefix,
                move |project_id| Workspace {
                    project_id,
                    ..workspace
                },
                Some(project),
                &writer,
            )
            .await
        {
            Ok(value) => value,
            Err(error) if matches!(error.underlying(), StoreError::Project(_)) => {
                return Ok(rejected(Rejection::WorkspaceUnavailable));
            }
            Err(error) => return Err(error.to_string()),
        };
        let root = self.store.owned_root().map_err(|error| error.to_string())?;
        match self
            .store
            .prepare_session_workspace_change(
                input.expected_revision,
                family,
                workspace,
                WorkspaceChange {
                    ordered,
                    guards,
                    root,
                    target,
                },
                &writer,
            )
            .await
        {
            Ok(statement) => Ok(NativeMutation::Computed {
                change: writer
                    .prepare_result(|_| Ok(WorkspaceChangeCompletion::Ready(statement)))
                    .map_err(|error| error.to_string())?,
            }),
            Err(error) => workspace_change_rejection(&error)
                .map(NativeMutation::Returned)
                .ok_or_else(|| error.to_string()),
        }
    }
}

fn require_workspace_client(scope: &Scope) -> Result<(), String> {
    if !matches!(scope.identity, Identity::Native | Identity::Remote { .. }) {
        return Err("agent_workspace_user_action_required".into());
    }
    Ok(())
}

fn rejected(reason: Rejection) -> NativeMutation<SessionWorkspaceChanged> {
    NativeMutation::Returned(SessionWorkspaceChanged::Rejected { reason })
}

struct WorkspaceChange {
    ordered: Vec<Arc<runs::Ordered>>,
    guards: Vec<SessionQuiescenceGuard>,
    root: Arc<maka_event_log::root::RootOwner>,
    target: ResolvedProject,
}
impl Statement for WorkspaceChange {
    type Value = Arc<maka_event_log::root::RootOwner>;
    type Output = ();
    const PREPARE_OFF_THREAD: bool = true;

    fn prepare(self) -> Result<Self, StoreError> {
        let observed = resolve_selected_sync(&self.target.path).map_err(|error| {
            StoreError::StatementRejected {
                diagnostic: "agent_workspace_unavailable".into(),
                cause: Arc::new(StoreError::Io(error)),
            }
        })?;
        if observed != self.target {
            return Err(StoreError::StatementRejected {
                diagnostic: "agent_workspace_unavailable".into(),
                cause: Arc::new(StoreError::InvalidTransition(
                    "workspace identity changed".into(),
                )),
            });
        }
        Ok(self)
    }

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        self.ordered
            .iter()
            .cloned()
            .map(|gate| gate as Arc<dyn std::marker::Send + Sync>)
            .collect()
    }

    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        for guard in self.guards {
            guard.validate(connection)?;
        }
        Ok(Prepared {
            value: self.root,
            changed: false,
            notification: Notification::NONE,
        })
    }

    fn committed(root: Self::Value) {
        root.capability_source_changed();
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::StatementRejected { .. }
        )
    }
}

fn workspace_change_rejection(error: &StoreError) -> Option<SessionWorkspaceChanged> {
    let reason = match creation::rejection_cause(error) {
        StoreError::SessionRevisionConflict { expected, actual } => {
            return Some(SessionWorkspaceChanged::RevisionConflict {
                expected: *expected,
                actual: *actual,
            });
        }
        StoreError::SessionBusy => Rejection::Busy,
        StoreError::SessionNotFound | StoreError::SessionRetired => Rejection::SessionUnavailable,
        _ if matches!(error.underlying(), StoreError::StatementRejected { diagnostic, .. }
            if diagnostic == "agent_workspace_unavailable") =>
        {
            Rejection::WorkspaceUnavailable
        }
        _ => creation::creation_rejection(error)?,
    };
    Some(SessionWorkspaceChanged::Rejected { reason })
}

#[derive(Serialize)]
#[serde(transparent)]
struct WorkspaceChangeResult {
    result: SessionWorkspaceChanged,
    #[serde(skip)]
    notify: Option<Arc<maka_event_log::root::RootOwner>>,
}

enum WorkspaceChangeCompletion<S> {
    Ready(S),
    Rejected(SessionWorkspaceChanged),
}
impl<S: Statement<Value = Arc<maka_event_log::root::RootOwner>, Output = ()>> Statement
    for WorkspaceChangeCompletion<S>
{
    type Value = WorkspaceChangeResult;
    type Output = SessionWorkspaceChanged;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        match self {
            Self::Ready(statement) => statement.retain(),
            Self::Rejected(_) => Vec::new(),
        }
    }

    fn prepare(self) -> Result<Self, StoreError> {
        match self {
            Self::Ready(statement) => match statement.prepare() {
                Ok(statement) => Ok(Self::Ready(statement)),
                Err(error) => workspace_change_rejection(&error)
                    .map(Self::Rejected)
                    .ok_or(error),
            },
            Self::Rejected(_) => Ok(self),
        }
    }

    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        let result = match self {
            Self::Ready(statement) => creation::creation_sql(
                connection,
                || statement.execute(connection),
                workspace_change_rejection,
            )?,
            Self::Rejected(result) => Err(result),
        };
        Ok(match result {
            Ok(prepared) => Prepared {
                value: WorkspaceChangeResult {
                    result: SessionWorkspaceChanged::Changed,
                    notify: Some(prepared.value),
                },
                changed: prepared.changed,
                notification: prepared.notification,
            },
            Err(result) => Prepared {
                value: WorkspaceChangeResult {
                    result,
                    notify: None,
                },
                changed: false,
                notification: Notification::NONE,
            },
        })
    }

    fn committed(value: Self::Value) -> Self::Output {
        if let Some(root) = value.notify {
            WorkspaceChange::committed(root);
        }
        value.result
    }

    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
