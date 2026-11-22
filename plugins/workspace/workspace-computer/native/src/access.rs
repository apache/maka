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
use maka_agent_api::{contract::WorkspaceAccess, session::ResolvedConfiguration};
use maka_agent_facts::{
    interaction::{
        Decision, GrantTarget, InteractionOutcome, InteractionRecord, InteractionRequest,
    },
    language::Language,
};
use maka_sandbox::workspace::PermissionBasis;
use sha2::{Digest, Sha256};

/// Native targets and browser leases currently carry identity/consent, not an
/// enforced process sandbox compatible with an inherited filesystem floor.
pub(super) fn resource_boundary(floor: &maka_sandbox::Sandbox) -> Result<(), ToolError> {
    if matches!(floor, maka_sandbox::Sandbox::Disabled) {
        Ok(())
    } else {
        Err(failed(
            "IsolationUnavailable: desktop and browser resources cannot prove compatibility with the caller's sandbox floor",
        ))
    }
}

pub(super) async fn current(
    owner: &Computer,
    call: &Call,
    tool: &str,
) -> Result<(ResolvedConfiguration, Language), ToolError> {
    if owner.stopping.is_cancelled() || call.scope.cancellation.is_cancelled() {
        return Err(failed("Computer Use cancelled"));
    }
    let configuration = call.authority.current().await?;
    if configuration.permissions.access == WorkspaceAccess::ReadOnly {
        return Err(failed("Explore mode does not allow Computer Use"));
    }
    if configuration
        .tools
        .as_ref()
        .is_some_and(|tools| !tools.iter().any(|name| name == tool))
    {
        return Err(failed(
            "Computer Use tool is outside the current Session ceiling",
        ));
    }
    Ok((configuration, call.authority.language()))
}

pub(super) async fn granted(
    owner: &Computer,
    call: &Call,
    basis: PermissionBasis,
) -> Result<(), ToolError> {
    granted_target(owner, call, basis, &api::target()).await
}
pub(super) async fn audio_granted(
    owner: &Computer,
    call: &Call,
    basis: PermissionBasis,
) -> Result<(), ToolError> {
    granted_target(owner, call, basis, &api::audio_target()).await
}

/// Cancelling authorization never discards the original native effect future.
pub(super) async fn settle<F, Fut>(
    owner: &Computer,
    call: &Call,
    basis: PermissionBasis,
    targets: &[GrantTarget],
    action: F,
) -> Result<Value, ToolError>
where
    F: FnOnce(CancellationToken) -> Fut,
    Fut: std::future::Future<Output = Result<Value, ToolError>>,
{
    let mut changes = call.authority.changes().map_err(failed)?;
    for target in targets {
        granted_target(owner, call, basis, target).await?;
    }
    let monitor = async {
        loop {
            changes.borrow_and_update();
            for target in targets {
                granted_target(owner, call, basis, target).await?;
            }
            changes.changed().await.map_err(failed)?;
        }
        #[allow(unreachable_code)]
        Ok::<(), ToolError>(())
    };
    let child = call.scope.cancellation.child_token();
    let effect = action(child.clone());
    tokio::pin!(effect);
    let reason = tokio::select! {
        biased;
        result = &mut effect => return result,
        () = call.scope.cancellation.cancelled() => failed("Computer Run stopped"),
        () = owner.stopping.cancelled() => failed("Computer owner closed"),
        result = monitor => result.err().unwrap_or_else(|| failed("Computer grant monitor closed")),
    };
    child.cancel();
    match effect.await {
        Err(
            error @ (ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::OperationCleanupUnconfirmed { .. }),
        ) => Err(error),
        _ => Err(reason),
    }
}

pub(super) async fn browser_decision(
    owner: &Computer,
    call: &Call,
    basis: PermissionBasis,
    target: &GrantTarget,
) -> Result<Option<Decision>, ToolError> {
    let (configuration, _) = current(owner, call, "cua_repl").await?;
    if configuration.permission_basis() != basis {
        return Err(failed("Browser permission boundary changed"));
    }
    if configuration.permissions.access == WorkspaceAccess::DangerFullAccess {
        return Ok(Some(Decision::Allow));
    }
    Ok(call
        .authority
        .client_grant(target)
        .await?
        .filter(|grant| grant.basis == Some(basis))
        .map(|_| Decision::Allow))
}

pub(super) async fn granted_target(
    owner: &Computer,
    call: &Call,
    basis: PermissionBasis,
    target: &GrantTarget,
) -> Result<(), ToolError> {
    let (configuration, _) = current(owner, call, "cua_repl").await?;
    if configuration.permission_basis() != basis {
        return Err(failed("Computer Use permission boundary changed"));
    }
    if configuration.permissions.access == WorkspaceAccess::DangerFullAccess {
        return Ok(());
    }
    let grant = call.authority.client_grant(target).await?;
    if grant.is_none_or(|grant| grant.basis != Some(basis)) {
        return Err(failed(format!(
            "{} Session grant is missing or revoked",
            capability_name(target)
        )));
    }
    Ok(())
}

pub(super) async fn approve(
    owner: &Computer,
    call: &Call,
    configuration: &ResolvedConfiguration,
    cancellation: &CancellationToken,
) -> Result<(), ToolError> {
    approve_target(
        owner,
        call,
        configuration,
        cancellation,
        api::target(),
        None,
    )
    .await
}
pub(super) async fn approve_audio(
    owner: &Computer,
    call: &Call,
    configuration: &ResolvedConfiguration,
    cancellation: &CancellationToken,
    cell: &maka_code_runtime::CellContext,
) -> Result<(), ToolError> {
    approve_target(
        owner,
        call,
        configuration,
        cancellation,
        api::audio_target(),
        Some(cell),
    )
    .await
}
pub(super) async fn approve_target(
    owner: &Computer,
    call: &Call,
    configuration: &ResolvedConfiguration,
    cancellation: &CancellationToken,
    target: GrantTarget,
    cell: Option<&maka_code_runtime::CellContext>,
) -> Result<(), ToolError> {
    if configuration.permissions.access == WorkspaceAccess::DangerFullAccess {
        return granted_target(owner, call, configuration.permission_basis(), &target).await;
    }
    let authority = call.authority.as_ref();
    if authority
        .client_grant(&target)
        .await?
        .is_some_and(|grant| grant.basis == Some(configuration.permission_basis()))
    {
        return Ok(());
    }
    if !configuration.permissions.request_permissions {
        return Err(failed(format!(
            "Current policy does not allow requesting {} access",
            capability_name(&target)
        )));
    }
    let record = InteractionRecord {
        execution: authority.call().execution.clone(),
        request_id: format!(
            "computer_{}",
            hex::encode(Sha256::digest(
                serde_json::to_vec(&(
                    &authority.call().execution,
                    &authority.call().operation_id,
                    configuration.permission_basis(),
                    &target
                ))
                .expect("Computer approval identity")
            ))
        ),
        created_at: maka_agent_authority::now(),
        request: InteractionRequest::ClientCapability {
            tool_use_id: authority.call().tool_use_id(),
            target: target.clone(),
            basis: Some(configuration.permission_basis()),
        },
        outcome: None,
    };
    let observed = async {
        authority
            .establish(&record)
            .await
            .map_err(|_| "Computer approval publication unavailable")?;
        let _timeout = cell.map(maka_code_runtime::CellContext::suspend_timeout);
        maka_agent_authority::interaction_wait::wait(authority, &record, cancellation).await
    }
    .await;
    let outcome = match observed {
        Ok(outcome) => outcome,
        Err(error) => {
            match maka_agent_authority::interaction_wait::withdraw(authority, &record).await {
                Ok(Some(outcome)) => outcome,
                Ok(None) => return Err(failed(error)),
                Err(error) => return Err(ToolError::CleanupUnconfirmed(error.into())),
            }
        }
    };
    if cancellation.is_cancelled() {
        return Err(failed("Computer approval cancelled"));
    }
    if !matches!(
        outcome,
        InteractionOutcome::ClientCapabilityDecision {
            decision: Decision::Allow,
            ..
        }
    ) {
        return Err(failed(format!(
            "{} access was not granted",
            capability_name(&target)
        )));
    }
    granted_target(owner, call, configuration.permission_basis(), &target).await
}
fn capability_name(target: &GrantTarget) -> &'static str {
    use maka_agent_facts::interaction::GrantCapability::*;
    match target.capability {
        ComputerAudio => "Computer audio recording",
        Browser => "Browser site",
        BrowserDownload => "Browser file download",
        BrowserUpload => "Browser file upload",
        BrowserHistory => "Browser history",
        _ => "Computer Use",
    }
}
#[derive(Clone, Copy)]
pub(super) enum ComputerLane {
    Native,
    Other,
}
