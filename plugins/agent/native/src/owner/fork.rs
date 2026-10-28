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

//! History-seeded side conversations retain their original copy receipt.
use super::*;
use maka_agent_facts::session::{CopyPurpose, CopyRequest, CopyState};
use maka_capabilities::call::Scope;
use maka_event_log::{StoreError, root_store::CreationRejection, sessions::SessionCopyResult};
use maka_plugin_core::operation::RecoveryRef;

impl Owner {
    pub async fn fork(
        self: &Arc<Self>,
        input: Fork,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<ForkResult, String> {
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move { owner.fork_inner(input, &operation, &scope).await })
        })
        .await
    }

    async fn fork_inner(
        &self,
        input: Fork,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<ForkResult, String> {
        let request = CopyRequest {
            source_session_id: input.session_id.clone(),
            target_session_id: self.operation_id(operation),
            expected_source_revision: input.expected_revision,
            purpose: CopyPurpose::Branch {
                turn_id: input.turn_id,
                side_conversation: true,
            },
        };
        // Original publication precedes source/configuration checks, including
        // after source deletion. This never recreates a removed destination.
        if let Some(receipt) = self
            .store
            .session_copy_receipt(&request.target_session_id)
            .await
            .map_err(fork_failure)?
        {
            if receipt.request != request || receipt.state != CopyState::Committed {
                return Err("agent_fork_conflict".into());
            }
            let session = self.session(&request.target_session_id).await?;
            return Ok(ForkResult::Forked {
                session: Box::new(crate::service::summary(self, session)),
            });
        }
        if let Some(reason) = metadata_rejection(&input.title, &input.labels) {
            return Ok(ForkResult::Rejected { reason });
        }
        if self.runs.lock().await.closing {
            return Ok(ForkResult::Rejected {
                reason: Rejection::Closed,
            });
        }
        if !self.owns(&input.session_id) {
            return Ok(ForkResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        let Some(source) = self
            .store
            .get_session::<StoredSessionConfiguration>(&input.session_id)
            .await
            .map_err(fork_failure)?
        else {
            return Ok(ForkResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        };
        let source = resolve_session(source)?;
        if source.revision != input.expected_revision {
            return Ok(ForkResult::RevisionConflict {
                expected: input.expected_revision,
                actual: source.revision,
            });
        }
        if !self
            .project_accepts_session(&source.configuration.workspace)
            .await?
        {
            return Ok(ForkResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        if workspace::validate(
            &self.workspace_roots,
            &source.configuration.workspace,
            &self.managed_worktrees,
        )
        .await
        .is_err()
        {
            return Ok(ForkResult::Rejected {
                reason: Rejection::WorkspaceUnavailable,
            });
        }
        if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_fork_cancelled".into());
        }
        let parent = source.configuration;
        let revision = if parent
            .tools
            .as_ref()
            .is_some_and(|names| names.iter().any(|name| name.starts_with("mcp__")))
        {
            self.mcp_projects.capture(&parent.workspace).await?
        } else {
            None
        };
        let catalog = self.mcp_projects.catalog(revision.as_deref())?;
        let tools = parent.tools.map(|names| {
            names
                .into_iter()
                .filter(|name| catalog.tools.contains(name))
                .collect()
        });
        let access = match (parent.permissions.access, self.settings.permissions.access) {
            (WorkspaceAccess::ReadOnly, _) | (_, WorkspaceAccess::ReadOnly) => {
                WorkspaceAccess::ReadOnly
            }
            (WorkspaceAccess::WorkspaceWrite, _) | (_, WorkspaceAccess::WorkspaceWrite) => {
                WorkspaceAccess::WorkspaceWrite
            }
            _ => WorkspaceAccess::DangerFullAccess,
        };
        let workspace = self
            .store
            .attach_workspace(&self.prefix, &parent.workspace)
            .await
            .map_err(fork_failure)?;
        let configuration = StoredSessionConfiguration {
            backend: parent.backend,
            compaction_prompt: parent.compaction_prompt,
            collaboration_mode: CollaborationMode::Agent,
            tools,
            title: input.title,
            title_is_manual: true,
            labels: input.labels,
            workspace,
            permissions: WorkspacePermissions {
                access,
                request_permissions: parent.permissions.request_permissions
                    && self.settings.permissions.request_permissions,
            },
            boundary_revision: 0,
        };
        let copied = match self
            .store
            .copy_session(request, &configuration, now())
            .await
        {
            Ok(copied) => copied,
            Err(
                StoreError::HistoryTurnMissing
                | StoreError::HistoryTurnSplit
                | StoreError::HistoryUnsettled
                | StoreError::HistoryProviderEffectUnresolved
                | StoreError::SessionCreationRejected(
                    CreationRejection::HistoryTurnMissing
                    | CreationRejection::HistoryTurnSplit
                    | CreationRejection::HistoryUnsettled
                    | CreationRejection::HistoryProviderEffectUnresolved,
                ),
            ) => {
                return Ok(ForkResult::Rejected {
                    reason: Rejection::HistoryUnavailable,
                });
            }
            Err(
                StoreError::ManagedSession
                | StoreError::SessionCreationRejected(CreationRejection::ManagedSource),
            ) => {
                return Ok(ForkResult::Rejected {
                    reason: Rejection::ManagedSession,
                });
            }
            Err(
                StoreError::SessionNotFound
                | StoreError::SessionRetired
                | StoreError::SessionCreationRejected(
                    CreationRejection::MissingDependency | CreationRejection::Retired,
                ),
            ) => {
                return Ok(ForkResult::Rejected {
                    reason: Rejection::SessionUnavailable,
                });
            }
            Err(StoreError::SessionCreationRejected(
                CreationRejection::MissingWorkspaceBinding
                | CreationRejection::StaleWorkspaceBinding,
            )) => {
                return Ok(ForkResult::Rejected {
                    reason: Rejection::WorkspaceUnavailable,
                });
            }
            Err(StoreError::SessionCreationRejected(CreationRejection::IdentityConflict)) => {
                return Err("agent_fork_conflict".into());
            }
            Err(StoreError::SessionBusy) => {
                return Ok(ForkResult::Rejected {
                    reason: Rejection::Busy,
                });
            }
            Err(error) => return Err(fork_failure(error)),
        };
        match copied {
            SessionCopyResult::Committed(session) => Ok(ForkResult::Forked {
                session: Box::new(crate::service::summary(self, resolve_session(*session)?)),
            }),
            SessionCopyResult::SourceRevisionConflict { expected, actual } => {
                Ok(ForkResult::RevisionConflict { expected, actual })
            }
        }
    }

    pub async fn fork_receipt(
        self: &Arc<Self>,
        input: ForkReceipt,
        scope: &Scope,
    ) -> Result<ForkReceiptResult, String> {
        input
            .reference
            .validate()
            .map_err(|_| "agent_fork_reference_invalid")?;
        let reference = &input.reference;
        if reference.source.state_domain != self.data_source.state_domain
            || reference.source.deployment != self.data_source.deployment
            || reference.namespace != self.data_source.namespace
            || reference.export != maka_agent_api::EXPORT
            || reference.method != "fork"
        {
            return Err("agent_fork_reference_unavailable".into());
        }
        self.resource_work(scope, move |owner, _scope| {
            Box::pin(async move {
                let target = owner.operation_id(&input.reference);
                let Some(receipt) = owner
                    .store
                    .session_copy_receipt(&target)
                    .await
                    .map_err(fork_failure)?
                else {
                    return Ok(ForkReceiptResult { session: None });
                };
                if receipt.state != CopyState::Committed
                    || receipt.request.target_session_id != target
                    || !owner.owns(&receipt.request.source_session_id)
                    || !matches!(
                        receipt.request.purpose,
                        CopyPurpose::Branch {
                            side_conversation: true,
                            ..
                        }
                    )
                {
                    return Err("agent_fork_reference_unavailable".into());
                }
                let session = owner
                    .store
                    .get_session::<StoredSessionConfiguration>(&target)
                    .await
                    .map_err(fork_failure)?
                    .map(|session| {
                        resolve_session(session)
                            .map(|session| Box::new(crate::service::summary(&owner, session)))
                    })
                    .transpose()?;
                Ok(ForkReceiptResult { session })
            })
        })
        .await
    }
}

fn fork_failure(error: StoreError) -> String {
    tracing::warn!(
        stage = "session_fork",
        cause = crate::diagnostics::store_cause(&error),
        sql_code = crate::diagnostics::store_sql_code(&error),
        "Session fork storage operation failed"
    );
    match error {
        StoreError::CommitUnknown(_) | StoreError::OperationUnknown => "agent_fork_outcome_unknown",
        _ => "agent_fork_failed",
    }
    .into()
}
