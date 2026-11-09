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
use crate::owner::access::RunAccess;
use maka_agent_authority::{
    computer::{NativeCallAccess, NativeCallContext},
    permissions::Access,
};
use maka_agent_facts::{
    durable::ExecutionIdentity,
    interaction::{
        Decision, InteractionOutcome, PermissionDecision, PermissionScope, SessionApprovalAnswer,
    },
};
use maka_capabilities::call::{Identity, Scope};
use maka_host_runtime::application::Context;
use maka_plugin_core::operation::RecoveryRef;
use std::sync::Arc;

enum ChildConfirmation {
    Allowed,
    Denied(InteractionAnswer),
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
            Identity::Agent { execution, .. }
                if session.configuration.parent_session_id.as_deref()
                    == Some(execution.session_id.as_str()) =>
            {
                self.access_for_scope(scope).await?;
                Ok(None)
            }
            _ => Ok(Some(InteractionRejection::NotYourChild)),
        }
    }

    pub async fn respond(
        self: &Arc<Self>,
        input: InteractionRespond,
        operation: &RecoveryRef,
        context: &Context,
    ) -> Result<NativeMutation<InteractionResult>, String> {
        let scope = context.scope();
        let native_access = if scope.identity.agent().is_some() {
            let native = context
                .native_context::<NativeCallContext>()
                .ok_or("agent_native_call_context_missing")?;
            let call = native.access().call();
            let access = self.access_for_scope(scope).await?;
            let target = access
                .target_for_context(call)
                .await
                .map_err(|error| error.to_string())?;
            if native.access().target() != &target
                || scope.identity.operation_id() != Some(call.operation_id.as_str())
            {
                return Err("agent_native_call_obligation_mismatch".into());
            }
            native
                .access()
                .bind_original(context)
                .await
                .map_err(|error| error.to_string())?;
            let access: Arc<dyn NativeCallAccess> = match native.as_ref() {
                NativeCallContext::Agent(access) => access.clone(),
                NativeCallContext::Computer(access) => access.clone(),
            };
            Some(access)
        } else {
            None
        };
        let operation = operation.clone();
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                owner
                    .respond_inner(input, &operation, &scope, native_access.as_deref())
                    .await
            })
        })
        .await
    }

    async fn respond_inner(
        &self,
        mut input: InteractionRespond,
        operation: &RecoveryRef,
        scope: &Scope,
        native_access: Option<&dyn NativeCallAccess>,
    ) -> Result<NativeMutation<InteractionResult>, String> {
        if let Some(reason) = self.interaction_rejection(scope, &input.session_id).await? {
            return Ok(NativeMutation::Returned(InteractionResult::Rejected {
                reason,
            }));
        }
        let Some(record) = self
            .find_interaction(&input.session_id, &input.request_id)
            .await?
        else {
            return Ok(NativeMutation::Returned(InteractionResult::Rejected {
                reason: InteractionRejection::Unavailable,
            }));
        };
        if input.answer.validate_for_request(&record.request).is_err() {
            return Ok(NativeMutation::Returned(InteractionResult::Rejected {
                reason: InteractionRejection::InvalidAnswer,
            }));
        }
        if let Some(execution) = scope.identity.agent() {
            if matches!(record.request, InteractionRequest::SessionApproval { .. }) {
                return Ok(NativeMutation::Returned(InteractionResult::Rejected {
                    reason: InteractionRejection::HumanActionRequired,
                }));
            }
            if record.outcome.is_some() {
                return Ok(NativeMutation::Returned(InteractionResult::Recorded {
                    record: Box::new(record),
                }));
            }
            let access = self.access_for_scope(scope).await?;
            let parent = access
                .live_configuration()
                .await
                .map_err(|error| error.to_string())?;
            let mut human_denied = false;
            if !self
                .may_approve(&record, &input.answer, &parent, execution, access.as_ref())
                .await?
            {
                if !parent.permissions.request_permissions
                    && matches!(record.request, InteractionRequest::Permissions { .. })
                {
                    return Ok(NativeMutation::Returned(InteractionResult::Rejected {
                        reason: InteractionRejection::PermissionRequestsDisabled,
                    }));
                }
                match self
                    .confirm_child_response(
                        &record,
                        SessionApprovalAnswer::try_from(&input.answer).map_err(str::to_owned)?,
                        &parent,
                        operation,
                        scope,
                        native_access.ok_or("agent_native_call_context_missing")?,
                    )
                    .await?
                {
                    ChildConfirmation::Allowed => {}
                    ChildConfirmation::Denied(answer) => {
                        input.answer = answer;
                        human_denied = true;
                    }
                    ChildConfirmation::Withdrawn => {
                        return Ok(NativeMutation::Returned(InteractionResult::Rejected {
                            reason: InteractionRejection::Unavailable,
                        }));
                    }
                    ChildConfirmation::ChildSettled => {
                        return Ok(NativeMutation::Returned(InteractionResult::Recorded {
                            record: Box::new(
                                self.interaction(&input.session_id, &input.request_id)
                                    .await?,
                            ),
                        }));
                    }
                }
            }
            // Do not hold owner state while waiting for a person. The final SQL
            // transaction also rechecks the caller's Run and permission basis.
            let runs = Arc::new(self.runs.lock().await);
            if runs.closing || scope.cancellation.is_cancelled() {
                return Ok(NativeMutation::Returned(InteractionResult::Rejected {
                    reason: InteractionRejection::Unavailable,
                }));
            }
            let current = access
                .live_configuration()
                .await
                .map_err(|error| error.to_string())?;
            // A committed human denial grants nothing; a permission edit must
            // not discard it. Stop and Run liveness still fence settlement.
            if !human_denied && current.permission_basis() != parent.permission_basis() {
                return Ok(NativeMutation::Returned(InteractionResult::Rejected {
                    reason: InteractionRejection::AuthorizationChanged,
                }));
            }
            let caller = maka_agent_state::CallerFence {
                execution: execution.clone(),
                expected_basis: (!human_denied).then(|| current.permission_basis()),
            };
            return self
                .prepare_response_locked(input, runs, Some(caller))
                .await;
        }
        self.prepare_response(input).await
    }

    async fn may_approve(
        &self,
        record: &InteractionRecord,
        answer: &InteractionAnswer,
        parent: &ResolvedConfiguration,
        execution: &ExecutionIdentity,
        access: &RunAccess,
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
                    decision: PermissionDecision::Deny,
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
                        PermissionDecision::Allow {
                            permissions,
                            scope: requested_scope,
                        },
                },
            ) => {
                let grants = self
                    .durable
                    .interactions()
                    .permission_grants(execution, None, &parent.permission_basis())
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
                        granted.scope == maka_agent_facts::interaction::PermissionScope::Session
                            || requested_scope == PermissionScope::Once
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
                let held = self.admitted_tools(&execution.session_id, &parent.tools);
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
                access.fresh().await?;
                let granted = self
                    .durable
                    .interactions()
                    .client_capability_grant(&execution.session_id, target)
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
        answer: SessionApprovalAnswer,
        parent: &ResolvedConfiguration,
        operation: &RecoveryRef,
        scope: &Scope,
        access: &dyn NativeCallAccess,
    ) -> Result<ChildConfirmation, String> {
        let execution = access.execution();
        let operation_id = scope
            .identity
            .operation_id()
            .ok_or("agent_interaction_operation_missing")?;
        let record = InteractionRecord {
            execution: execution.clone(),
            request_id: format!("session_approval_{}", self.operation_id(operation)),
            created_at: now(),
            request: InteractionRequest::SessionApproval {
                tool_use_id: maka_agent_facts::tool_call::tool_use_id(
                    execution.run_id,
                    operation_id,
                ),
                basis: parent.permission_basis(),
                session_id: child.execution.session_id.clone(),
                request_id: child.request_id.clone(),
                answer: answer.clone(),
            },
            outcome: None,
        };
        let publication = access.establish(&record).await;
        let observed = match publication {
            Ok(_) => None,
            Err(failure) => {
                match maka_agent_authority::interaction_wait::withdraw(access, &record).await {
                    Ok(Some(outcome)) => Some(outcome),
                    Ok(None) => return Err(failure),
                    Err(cleanup) => return Err(format!("{failure}; {cleanup}")),
                }
            }
        };
        let child_store = self.durable.interactions();
        let observed = if let Some(outcome) = observed {
            Ok(outcome)
        } else {
            tokio::select! {
            result = maka_agent_authority::interaction_wait::wait(access, &record, &scope.cancellation) => result,
            result = child_answered(&child_store, &child.execution.session_id, &child.request_id) => {
                // The child was answered elsewhere or stopped; withdraw the now
                // obsolete parent prompt instead of leaving a second live decision.
                let cleanup = maka_agent_authority::interaction_wait::withdraw(access, &record).await;
                cleanup.map_err(|_| "agent_interaction_cleanup_unconfirmed")?;
                result.map_err(str::to_owned)?;
                return Ok(ChildConfirmation::ChildSettled);
            }
            }
        };
        let outcome = match observed {
            Ok(outcome) => outcome,
            Err(error) => {
                match maka_agent_authority::interaction_wait::withdraw(access, &record).await {
                    Ok(Some(outcome)) => outcome,
                    Ok(None) => return Err(error.into()),
                    Err(cleanup) => return Err(cleanup.into()),
                }
            }
        };
        match outcome {
            InteractionOutcome::SessionApprovalDecision { decision, .. } => Ok(match decision {
                Decision::Allow => ChildConfirmation::Allowed,
                Decision::Deny => ChildConfirmation::Denied(answer.denied()),
            }),
            InteractionOutcome::Closure { .. } => Ok(ChildConfirmation::Withdrawn),
            _ => Err("agent_interaction_confirmation_invalid".into()),
        }
    }
}

async fn child_answered(
    store: &maka_agent_state::interactions::InteractionsStore,
    session: &str,
    request: &str,
) -> Result<(), &'static str> {
    let mut commits = store
        .subscribe()
        .map_err(|_| "agent_interaction_store_closed")?;
    loop {
        let record = store
            .read(session, request)
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
