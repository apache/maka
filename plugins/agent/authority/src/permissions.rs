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

//! Canonical permission decisions shared by native workspace executors.
use crate::interaction_wait::{wait, withdraw};
use maka_agent_api::session::{ResolvedConfiguration, StoredSessionConfiguration};
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use maka_agent_facts::interaction::PermissionDecision;
use maka_agent_facts::interaction::PermissionRequest;
use maka_agent_facts::tools::{PermissionDenial, PermissionDenialReason, ToolError};
use maka_event_log::{StoreError, sessions::SessionRecord};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

/// A live, native-issued Run capability. No identity or persisted approval can
/// construct this capability; native rechecks RunSpec intersected with current policy.
pub trait Access: maka_agent_ports::execution::Interactions {
    /// Request identity only: preparation has no Host source; a native caller
    /// exposes only the original captured from its actual bound Context.
    fn permission_request_original(
        &self,
    ) -> Result<Option<&maka_plugin_core::operation::RecoveryRef>, ToolError>;
    fn live_configuration(
        &self,
    ) -> futures_util::future::BoxFuture<'_, Result<ResolvedConfiguration, ToolError>>;
    /// Observation only. Preparation once approvals are consumed by the original
    /// admission; Host grants are usable only within that active original scope.
    fn permission_grants<'a>(
        &'a self,
        target: &'a maka_agent_facts::durable::AuthorizationObligation,
        basis: &'a maka_sandbox::workspace::PermissionBasis,
    ) -> futures_util::future::BoxFuture<'a, Result<Vec<PermissionGrant>, ToolError>>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionGrant {
    pub approval_id: Option<maka_agent_facts::durable::ApprovalId>,
    pub request_id: String,
    pub permissions: maka_sandbox::grant::Permissions,
    pub scope: maka_agent_facts::interaction::PermissionScope,
}

pub async fn request(
    access: &dyn Access,
    request: PermissionRequest,
    target: &maka_agent_facts::durable::AuthorizationObligation,
    cancellation: &CancellationToken,
) -> Result<PermissionGrant, ToolError> {
    let configuration = access.live_configuration().await?;
    if !configuration.permissions.request_permissions {
        return Err(denied(
            PermissionDenialReason::RequestsDisabled,
            &request.permissions,
            request.command.as_ref(),
            "Workspace policy does not allow requesting additional permissions",
        ));
    }
    let identity = (
        &access.execution().run_id,
        target,
        configuration.permission_basis(),
        &request,
    );
    let identity = match access.permission_request_original()? {
        None => serde_json::to_vec(&identity),
        Some(original) => serde_json::to_vec(&(identity, "host", original)),
    }
    .expect("authorization obligation identity");
    let record = InteractionRecord {
        execution: access.execution().clone(),
        request_id: format!("permissions_{}", hex::encode(Sha256::digest(identity))),
        created_at: crate::now(),
        request: InteractionRequest::Permissions {
            target: target.clone(),
            tool_use_id: match target {
                maka_agent_facts::durable::AuthorizationObligation::Tool { tool } => {
                    Some(maka_agent_facts::tool_call::tool_use_id(
                        access.execution().run_id,
                        &format!("{}:{}", tool.attempt, tool.call),
                    ))
                }
                maka_agent_facts::durable::AuthorizationObligation::Cell { .. } => None,
                maka_agent_facts::durable::AuthorizationObligation::External {
                    operation, ..
                } => Some(maka_agent_facts::tool_call::tool_use_id(
                    access.execution().run_id,
                    &operation.to_string(),
                )),
            },
            basis: configuration.permission_basis(),
            request: request.clone(),
        },
        outcome: None,
    };
    let observed = async {
        access
            .establish(&record)
            .await
            .map_err(|_| "permission publication unavailable")?;
        wait(access, &record, cancellation).await
    }
    .await;
    let outcome = match observed {
        Ok(outcome) => outcome,
        Err(error) => match withdraw(access, &record).await {
            Ok(Some(outcome)) => outcome,
            Ok(None) => return Err(failed(error)),
            Err(cleanup) => return Err(ToolError::CleanupUnconfirmed(cleanup.into())),
        },
    };
    if cancellation.is_cancelled() {
        return Err(failed("Permission request cancelled"));
    }
    match outcome {
        InteractionOutcome::PermissionsDecision {
            decision: PermissionDecision::Allow { .. },
            ..
        } => {}
        InteractionOutcome::PermissionsDecision {
            decision: PermissionDecision::Deny,
            ..
        } => {
            return Err(denied(
                PermissionDenialReason::UserDenied,
                &request.permissions,
                request.command.as_ref(),
                "User denied additional permissions. Do not repeat this request; continue within existing permissions or report the blocked operation.",
            ));
        }
        _ => {
            let current = access.live_configuration().await?;
            if current.permission_basis() != configuration.permission_basis() {
                return Err(denied(
                    PermissionDenialReason::GrantExpired,
                    &request.permissions,
                    request.command.as_ref(),
                    "Permission authority changed while awaiting approval",
                ));
            }
            return Err(failed("Permission request closed without a decision"));
        }
    }
    access
        .permission_grants(target, &configuration.permission_basis())
        .await
        .map_err(|_| failed("Permission observation unavailable"))?
        .into_iter()
        .find(|grant| grant.request_id == record.request_id)
        .ok_or_else(|| {
            denied(
                PermissionDenialReason::GrantExpired,
                &request.permissions,
                request.command.as_ref(),
                "Approved permissions are no longer current",
            )
        })
}

pub fn denied(
    reason: PermissionDenialReason,
    permissions: &maka_sandbox::grant::Permissions,
    command: Option<&maka_agent_facts::interaction::PermissionCommand>,
    message: impl Into<String>,
) -> ToolError {
    ToolError::PermissionDenied(Box::new(PermissionDenial {
        reason,
        permissions: permissions.clone(),
        command: command.cloned(),
        message: message.into(),
    }))
}

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

pub async fn live(access: &dyn Access) -> Result<ResolvedConfiguration, ToolError> {
    access.live_configuration().await
}

/// Resolve only the binding snapshot read with this Session's canonical metadata.
/// A separate binding lookup would allow a relocation to split the observation.
pub fn resolve_session(
    session: SessionRecord<StoredSessionConfiguration>,
) -> Result<SessionRecord<ResolvedConfiguration>, StoreError> {
    let binding = session.workspace_binding.as_ref().ok_or_else(|| {
        StoreError::InvalidTransition("Session workspace binding is missing".into())
    })?;
    let workspace = serde_json::from_value(binding.workspace.clone())?;
    let configuration = session
        .configuration
        .clone()
        .resolve(workspace, binding.stamp())
        .map_err(|error| StoreError::InvalidTransition(error.into()))?;
    Ok(session.map_configuration(|_| configuration))
}
