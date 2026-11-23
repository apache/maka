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
        let ordered = Arc::new(self.runs.ordered(&id).await);
        {
            let runs = self.runs.state().await;
            if runs.closing || self.stop.is_cancelled() {
                return Ok(rejected(Rejection::Closed));
            }
            if runs.busy(&id) || self.mcp_projects.has_any_client(&id) {
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
        let guard = self
            .durable
            .quiescence_guard(self.run_owner(), id.clone())
            .map_err(|error| error.to_string())?;
        if !guard
            .observe()
            .await
            .map_err(|error| error.to_string())?
            .is_quiescent()
        {
            return Ok(rejected(Rejection::Busy));
        }
        let Some((registration, target)) = self.project_directory(&input.path).await? else {
            return Ok(rejected(Rejection::WorkspaceUnavailable));
        };
        let Some(projects::PreparedProjectWorkspace { workspace, project }) =
            self.create_project_workspace_at(registration).await?
        else {
            return Ok(rejected(Rejection::WorkspaceUnavailable));
        };
        let writer = guard.data_writer().clone();
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
                &id,
                input.expected_revision,
                workspace,
                WorkspaceChange {
                    ordered,
                    guard,
                    root,
                    target,
                },
                &writer,
            )
            .await
        {
            Ok(change) => Ok(NativeMutation::Commit {
                value: SessionWorkspaceChanged::Changed,
                change,
            }),
            Err(error) => match error.underlying() {
                StoreError::SessionBusy => Ok(rejected(Rejection::Busy)),
                StoreError::SessionNotFound | StoreError::SessionRetired => {
                    Ok(rejected(Rejection::SessionUnavailable))
                }
                _ => Err(error.to_string()),
            },
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
    ordered: Arc<runs::Ordered>,
    guard: SessionQuiescenceGuard,
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
        vec![self.ordered.clone()]
    }

    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, StoreError> {
        self.guard
            .validate(connection)
            .map_err(|cause| match cause {
                StoreError::SessionBusy => StoreError::StatementRejected {
                    diagnostic: "agent_session_workspace_busy".into(),
                    cause: Arc::new(cause),
                },
                cause => cause,
            })?;
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
