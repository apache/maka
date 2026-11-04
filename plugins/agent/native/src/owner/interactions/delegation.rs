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
use crate::owner::ResolvedConfiguration;
use maka_agent_facts::{
    event::Invocation,
    interaction::{Decision, InteractionOutcome},
    tools::ToolCallContext,
};
use maka_capabilities::call::{Identity, Scope};
use maka_plugin_core::operation::RecoveryRef;
use maka_sandbox::grant;
use std::sync::Arc;

enum ChildConfirmation {
    Allowed,
    Denied,
    ChildSettled,
    Withdrawn,
}

impl Owner {
    pub(crate) async fn require_interaction_access(
        &self,
        scope: &Scope,
        target: &str,
    ) -> Result<(), String> {
        match self.interaction_rejection(scope, target).await? {
            None => Ok(()),
            Some(reason) => Err(format!(
                "Interaction access rejected: {}",
                serde_json::to_string(&reason).expect("interaction rejection")
            )),
        }
    }

    async fn interaction_rejection(
        &self,
        scope: &Scope,
        target: &str,
    ) -> Result<Option<InteractionRejection>, String> {
        if !self.owns(target) {
            return Ok(Some(InteractionRejection::Unavailable));
        }
        let session = self
            .store
            .get_session::<StoredSessionConfiguration>(target)
            .await
            .map_err(|error| error.to_string())?;
        let Some(session) = session.filter(|session| !session.archived) else {
            return Ok(Some(InteractionRejection::Unavailable));
        };
        match &scope.identity {
            Identity::Remote { .. } => Ok(None),
            Identity::Agent { invocation, .. }
                if session.configuration.parent_session_id.as_deref()
                    == Some(invocation.session_id.as_str()) =>
            {
                let store = self.scoped_store(scope, &invocation.session_id).await?;
                maka_agent_authority::permissions::live(&store, invocation)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(None)
            }
            _ => Ok(Some(InteractionRejection::NotYourChild)),
        }
    }

    pub async fn respond(
        self: &Arc<Self>,
        input: InteractionRespond,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<InteractionResult, String> {
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move { owner.respond_inner(input, &operation, &scope).await })
        })
        .await
    }

    async fn respond_inner(
        &self,
        mut input: InteractionRespond,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<InteractionResult, String> {
        if let Some(reason) = self.interaction_rejection(scope, &input.session_id).await? {
            return Ok(InteractionResult::Rejected { reason });
        }
        let record = self
            .interaction(&input.session_id, &input.request_id)
            .await?;
        if input.answer.validate_for_request(&record.request).is_err() {
            return Ok(InteractionResult::Rejected {
                reason: InteractionRejection::InvalidAnswer,
            });
        }
        if let Some(invocation) = scope.identity.agent() {
            if matches!(record.request, InteractionRequest::SessionApproval { .. }) {
                return Ok(InteractionResult::Rejected {
                    reason: InteractionRejection::HumanActionRequired,
                });
            }
            if record.outcome.is_some() {
                return Ok(InteractionResult::Recorded {
                    record: Box::new(record),
                });
            }
            let store = self.scoped_store(scope, &invocation.session_id).await?;
            let parent = maka_agent_authority::permissions::live(&store, invocation)
                .await
                .map_err(|error| error.to_string())?;
            if !self
                .may_approve(&record, &input.answer, &parent, invocation, scope)
                .await?
            {
                if !parent.permissions.request_permissions
                    && matches!(record.request, InteractionRequest::Permissions { .. })
                {
                    return Ok(InteractionResult::Rejected {
                        reason: InteractionRejection::PermissionRequestsDisabled,
                    });
                }
                match self
                    .confirm_child_response(&record, &input.answer, &parent, operation, scope)
                    .await?
                {
                    ChildConfirmation::Allowed => {}
                    ChildConfirmation::Denied => input.answer = denied(input.answer)?,
                    ChildConfirmation::Withdrawn => {
                        return Ok(InteractionResult::Rejected {
                            reason: InteractionRejection::Unavailable,
                        });
                    }
                    ChildConfirmation::ChildSettled => {
                        return Ok(InteractionResult::Recorded {
                            record: Box::new(
                                self.interaction(&input.session_id, &input.request_id)
                                    .await?,
                            ),
                        });
                    }
                }
            }
            // Permission edits and Stop use this same owner gate. Never hold it
            // while waiting for a person; only the final check and commit are fenced.
            let runs = self.runs.lock().await;
            if runs.closing || scope.cancellation.is_cancelled() {
                return Ok(InteractionResult::Rejected {
                    reason: InteractionRejection::Unavailable,
                });
            }
            let current = maka_agent_authority::permissions::live(&store, invocation)
                .await
                .map_err(|error| error.to_string())?;
            if current.permission_basis() != parent.permission_basis() {
                return Ok(InteractionResult::Rejected {
                    reason: InteractionRejection::AuthorizationChanged,
                });
            }
            return self.commit_response_unlocked(input).await;
        }
        self.commit_response(input).await
    }

    async fn may_approve(
        &self,
        record: &InteractionRecord,
        answer: &InteractionAnswer,
        parent: &ResolvedConfiguration,
        invocation: &Invocation,
        scope: &Scope,
    ) -> Result<bool, String> {
        match (&record.request, answer) {
            (
                _,
                InteractionAnswer::ServiceApproval {
                    decision: Decision::Deny,
                }
                | InteractionAnswer::ClientCapability {
                    decision: Decision::Deny,
                }
                | InteractionAnswer::Permissions {
                    decision: grant::Decision::Deny,
                }
                | InteractionAnswer::ComputerApp {
                    decision: maka_agent_facts::interaction::ComputerAppDecision::Deny,
                }
                | InteractionAnswer::ComputerAppCancel {}
                | InteractionAnswer::SystemPermissionCancel {},
            ) => Ok(true),
            (
                InteractionRequest::Permissions { .. },
                InteractionAnswer::Permissions {
                    decision:
                        grant::Decision::Allow {
                            permissions,
                            scope: requested_scope,
                        },
                },
            ) => {
                let store = self.scoped_store(scope, &invocation.session_id).await?;
                let grants = store
                    .permission_grants(invocation, None, &parent.permission_basis())
                    .await
                    .map_err(|error| error.to_string())?;
                let workspace = parent.workspace.clone();
                let access = parent.permissions.access;
                let state_root = self
                    .store
                    .owned_root()
                    .map_err(|error| error.to_string())?
                    .canonical_path()
                    .to_owned();
                let requested = permissions.clone();
                let requested_scope = *requested_scope;
                tokio::task::spawn_blocking(move || {
                    let (mut sandbox, ceiling) =
                        maka_workspace_support::sandbox(&workspace, access, &state_root)?;
                    for granted in grants.into_iter().filter(|granted| {
                        granted.scope == grant::Scope::Session
                            || requested_scope == grant::Scope::Once
                    }) {
                        sandbox = sandbox
                            .with_grant(&granted.permissions, &ceiling)
                            .map_err(|error| error.to_string())?;
                    }
                    let requested = maka_fs_tools::workspace::permissions::materialize(requested)
                        .map_err(|error| error.to_string())?;
                    sandbox
                        .permits(&requested)
                        .map_err(|error| error.to_string())
                })
                .await
                .map_err(|_| "agent_interaction_policy_unavailable".to_owned())?
            }
            (
                InteractionRequest::ServiceApproval {
                    tool_name,
                    method,
                    binding,
                    ..
                },
                InteractionAnswer::ServiceApproval {
                    decision: Decision::Allow,
                },
            ) => {
                let held = self.admitted_tools(&invocation.session_id, &parent.tools);
                Ok(held.as_ref().is_none_or(|names| names.contains(tool_name))
                    && self
                        .tool_basis
                        .iter()
                        .any(|tool| tool.permits_approval(tool_name, method, binding)))
            }
            (
                InteractionRequest::ClientCapability { target, .. },
                InteractionAnswer::ClientCapability {
                    decision: Decision::Allow,
                },
            ) => {
                if parent.permissions.access == WorkspaceAccess::DangerFullAccess {
                    return Ok(true);
                }
                let granted = self
                    .scoped_store(scope, &invocation.session_id)
                    .await?
                    .client_capability_grant(&invocation.session_id, target)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(granted.is_some_and(|grant| grant.basis == Some(parent.permission_basis())))
            }
            (
                InteractionRequest::ComputerApp { .. },
                InteractionAnswer::ComputerApp {
                    decision:
                        maka_agent_facts::interaction::ComputerAppDecision::Once
                        | maka_agent_facts::interaction::ComputerAppDecision::Session,
                },
            ) => Ok(parent.permissions.access == WorkspaceAccess::DangerFullAccess),
            (InteractionRequest::Question { .. }, InteractionAnswer::Question { .. })
            | (InteractionRequest::Form { .. }, InteractionAnswer::Form { .. }) => Ok(true),
            _ => Ok(false),
        }
    }

    async fn confirm_child_response(
        &self,
        child: &InteractionRecord,
        answer: &InteractionAnswer,
        parent: &ResolvedConfiguration,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<ChildConfirmation, String> {
        let invocation = scope
            .identity
            .agent()
            .ok_or("agent_interaction_source_missing")?;
        let tool = ToolCallContext {
            invocation: invocation.clone(),
            operation_id: scope
                .identity
                .operation_id()
                .ok_or("agent_interaction_operation_missing")?
                .into(),
            execution: scope.execution().cloned(),
        };
        let record = InteractionRecord {
            session_id: invocation.session_id.clone(),
            turn_id: invocation.turn_id.clone(),
            run_id: invocation.run_id.clone(),
            request_id: format!("session_approval_{}", self.operation_id(operation)),
            created_at: now(),
            request: InteractionRequest::SessionApproval {
                tool_use_id: tool.tool_use_id(),
                basis: parent.permission_basis(),
                session_id: child.session_id.clone(),
                request_id: child.request_id.clone(),
                answer: Box::new(answer.clone()),
            },
            outcome: None,
        };
        let store = self.scoped_store(scope, &invocation.session_id).await?;
        let child_store = self
            .store
            .session(&child.session_id)
            .await
            .map_err(|error| error.to_string())?;
        let publication = store.establish_run_interaction(invocation, &record).await;
        let observed = match publication {
            Ok(committed) if committed.matches => None,
            result => {
                let failure = match result {
                    Ok(_) => "agent_interaction_identity_conflict".to_owned(),
                    Err(error) => format!("agent_interaction_publication_unavailable: {error}"),
                };
                match maka_agent_authority::interaction_wait::withdraw(&store, &record).await {
                    Ok(Some(outcome)) => Some(outcome),
                    Ok(None) => return Err(failure),
                    Err(cleanup) => return Err(format!("{failure}; {cleanup}")),
                }
            }
        };
        let observed = if let Some(outcome) = observed {
            Ok(outcome)
        } else {
            tokio::select! {
            result = maka_agent_authority::interaction_wait::wait(&store, &record, &scope.cancellation) => result,
            result = child_answered(&child_store, &child.request_id) => {
                // The child was answered elsewhere or stopped; withdraw the now
                // obsolete parent prompt instead of leaving a second live decision.
                let cleanup = maka_agent_authority::interaction_wait::withdraw(&store, &record).await;
                cleanup.map_err(|_| "agent_interaction_cleanup_unconfirmed")?;
                result.map_err(str::to_owned)?;
                return Ok(ChildConfirmation::ChildSettled);
            }
            }
        };
        let outcome = match observed {
            Ok(outcome) => outcome,
            Err(error) => {
                match maka_agent_authority::interaction_wait::withdraw(&store, &record).await {
                    Ok(Some(outcome)) => outcome,
                    Ok(None) => return Err(error.into()),
                    Err(cleanup) => return Err(cleanup.into()),
                }
            }
        };
        match outcome {
            InteractionOutcome::SessionApprovalDecision { decision, .. } => Ok(match decision {
                Decision::Allow => ChildConfirmation::Allowed,
                Decision::Deny => ChildConfirmation::Denied,
            }),
            InteractionOutcome::Closure { .. } => Ok(ChildConfirmation::Withdrawn),
            _ => Err("agent_interaction_confirmation_invalid".into()),
        }
    }
}

fn denied(answer: InteractionAnswer) -> Result<InteractionAnswer, String> {
    Ok(match answer {
        InteractionAnswer::ServiceApproval { .. } => InteractionAnswer::ServiceApproval {
            decision: Decision::Deny,
        },
        InteractionAnswer::Permissions { .. } => InteractionAnswer::Permissions {
            decision: grant::Decision::Deny,
        },
        InteractionAnswer::ClientCapability { .. } => InteractionAnswer::ClientCapability {
            decision: Decision::Deny,
        },
        InteractionAnswer::ComputerApp { .. } => InteractionAnswer::ComputerApp {
            decision: maka_agent_facts::interaction::ComputerAppDecision::Deny,
        },
        _ => return Err("agent_interaction_confirmation_denied".into()),
    })
}

async fn child_answered(
    store: &maka_event_log::SessionStore,
    request: &str,
) -> Result<(), &'static str> {
    let mut commits = store
        .subscribe_commits()
        .map_err(|_| "agent_interaction_store_closed")?;
    loop {
        let record = store
            .interaction(request)
            .await
            .map_err(|_| "agent_interaction_read_unavailable")?
            .ok_or("agent_interaction_unavailable")?;
        if record.outcome.is_some() {
            return Ok(());
        }
        commits
            .changed()
            .await
            .map_err(|_| "agent_interaction_store_closed")?;
    }
}
