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
use maka_agent_facts::language::Language;
use maka_agent_facts::workspace::PermissionBasis;
use maka_agent_facts::{
    event::{CommitFuture, EventSink, EventWrite, Fact},
    interaction::{Decision, InteractionOutcome, InteractionRecord, InteractionRequest},
    tools::ToolCallContext,
};
use maka_capabilities::call::Scope;
use sha2::{Digest, Sha256};

pub(super) async fn current(
    owner: &Computer,
    call: &Scope,
    tool: &str,
) -> Result<(ResolvedConfiguration, Language), ToolError> {
    if owner.stopping.is_cancelled() || call.cancellation.is_cancelled() {
        return Err(failed("Computer Use cancelled"));
    }
    let invocation = call
        .identity
        .agent()
        .ok_or_else(|| failed("Computer Use requires an Agent invocation"))?;
    if call.identity.operation_id().is_none() {
        return Err(failed("Computer Use requires an original tool operation"));
    }
    let store = maka_agent_authority::permissions::execution(
        &owner.store,
        invocation,
        call.execution().map(|token| token.as_ref()),
    )?;
    let configuration = maka_agent_authority::permissions::live(&store, invocation).await?;
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
    let accepted = store
        .invocation_configuration(invocation)
        .await
        .map_err(|e| ToolError::Persistence(message(e)))?
        .ok_or_else(|| failed("Computer Use invocation configuration unavailable"))?;
    if accepted
        .tool_composition
        .as_ref()
        .and_then(|composition| composition.bound_tools.as_ref())
        .is_some_and(|tools| !tools.contains(tool))
    {
        return Err(failed(
            "Computer Use tool is outside the original invocation ceiling",
        ));
    }
    Ok((configuration, accepted.language))
}
pub(super) async fn granted(
    owner: &Computer,
    call: &Scope,
    basis: PermissionBasis,
) -> Result<(), ToolError> {
    granted_target(owner, call, basis, &api::target()).await
}

pub(super) async fn audio_granted(
    owner: &Computer,
    call: &Scope,
    basis: PermissionBasis,
) -> Result<(), ToolError> {
    granted_target(owner, call, basis, &api::audio_target()).await
}

/// An admitted effect keeps its real Run lifetime after its VM observer has
/// ended. Canonical grant changes and Host retirement still request cancellation
/// of that same effect; its original future must then confirm settlement.
pub(super) async fn settle<F, Fut>(
    owner: &Computer,
    call: &Scope,
    basis: PermissionBasis,
    targets: &[maka_agent_facts::interaction::GrantTarget],
    action: F,
) -> Result<Value, ToolError>
where
    F: FnOnce(CancellationToken) -> Fut,
    Fut: std::future::Future<Output = Result<Value, ToolError>>,
{
    let invocation = call.identity.agent().expect("checked Agent");
    let store = maka_agent_authority::permissions::execution(
        &owner.store,
        invocation,
        call.execution().map(|token| token.as_ref()),
    )?;
    let mut changes = store.subscribe_commits().map_err(failed)?;
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
    let child = call.cancellation.child_token();
    let effect = action(child.clone());
    tokio::pin!(effect);
    let reason = tokio::select! {
        biased;
        result = &mut effect => return result,
        () = call.cancellation.cancelled() => failed("Computer Run stopped"),
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
    call: &Scope,
    basis: PermissionBasis,
    target: &maka_agent_facts::interaction::GrantTarget,
) -> Result<Option<Decision>, ToolError> {
    let (configuration, _) = current(owner, call, "cua_repl").await?;
    if configuration.permission_basis() != basis {
        return Err(failed("Browser permission boundary changed"));
    }
    if configuration.permissions.access == WorkspaceAccess::DangerFullAccess {
        return Ok(Some(Decision::Allow));
    }
    let invocation = call.identity.agent().expect("checked Agent");
    maka_agent_authority::permissions::execution(
        &owner.store,
        invocation,
        call.execution().map(|token| token.as_ref()),
    )?
    .browser_origin_decision(&invocation.session_id, target, &basis)
    .await
    .map_err(|error| ToolError::Persistence(message(error)))
}

pub(super) async fn granted_target(
    owner: &Computer,
    call: &Scope,
    basis: PermissionBasis,
    target: &maka_agent_facts::interaction::GrantTarget,
) -> Result<(), ToolError> {
    let (current, _) = current(owner, call, "cua_repl").await?;
    if current.permission_basis() != basis {
        return Err(failed("Computer Use permission boundary changed"));
    }
    if current.permissions.access == WorkspaceAccess::DangerFullAccess {
        return Ok(());
    }
    let store = maka_agent_authority::permissions::execution(
        &owner.store,
        call.identity.agent().expect("checked Agent"),
        call.execution().map(|token| token.as_ref()),
    )?;
    let grant = store
        .client_capability_grant(
            &call.identity.agent().expect("checked Agent").session_id,
            target,
        )
        .await
        .map_err(|e| ToolError::Persistence(message(e)))?;
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
    call: &Scope,
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
    call: &Scope,
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
    call: &Scope,
    configuration: &ResolvedConfiguration,
    cancellation: &CancellationToken,
    target: maka_agent_facts::interaction::GrantTarget,
    cell: Option<&maka_code_runtime::CellContext>,
) -> Result<(), ToolError> {
    if configuration.permissions.access == WorkspaceAccess::DangerFullAccess {
        return granted_target(owner, call, configuration.permission_basis(), &target).await;
    }
    let context = ToolCallContext {
        execution: call.execution().cloned(),
        invocation: call.identity.agent().expect("checked Agent").clone(),
        operation_id: call.identity.operation_id().expect("checked tool").into(),
    };
    let store = maka_agent_authority::permissions::execution(
        &owner.store,
        &context.invocation,
        context.execution.as_deref(),
    )?;
    let browser = matches!(
        target.capability,
        maka_agent_facts::interaction::GrantCapability::Browser
            | maka_agent_facts::interaction::GrantCapability::BrowserDownload
            | maka_agent_facts::interaction::GrantCapability::BrowserUpload
    );
    if browser {
        match browser_decision(owner, call, configuration.permission_basis(), &target).await? {
            Some(Decision::Allow) => return Ok(()),
            Some(Decision::Deny) => {
                return Err(failed(format!(
                    "{} access was denied for this Session",
                    capability_name(&target)
                )));
            }
            None => {}
        }
    } else if store
        .client_capability_grant(&context.invocation.session_id, &target)
        .await
        .map_err(|e| ToolError::Persistence(message(e)))?
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
        session_id: context.invocation.session_id.clone(),
        turn_id: context.invocation.turn_id.clone(),
        run_id: context.invocation.run_id.clone(),
        request_id: format!(
            "computer_{}",
            hex::encode(Sha256::digest(
                serde_json::to_vec(&(
                    &context.invocation,
                    &context.operation_id,
                    configuration.permission_basis(),
                    &target
                ))
                .expect("Computer approval identity")
            ))
        ),
        created_at: maka_agent_authority::now(),
        request: InteractionRequest::ClientCapability {
            tool_use_id: context.tool_use_id(),
            target: target.clone(),
            basis: Some(configuration.permission_basis()),
        },
        outcome: None,
    };
    let observed = async {
        let committed = store
            .establish_run_interaction(&context.invocation, &record)
            .await
            .map_err(|_| "Computer approval publication unavailable")?;
        if !committed.matches {
            return Err("Computer approval identity conflict");
        }
        let _timeout = cell.map(maka_code_runtime::CellContext::suspend_timeout);
        maka_agent_authority::interaction_wait::wait(&store, &record, cancellation).await
    }
    .await;
    let outcome = match observed {
        Ok(outcome) => outcome,
        Err(error) => {
            match maka_agent_authority::interaction_wait::withdraw(&store, &record).await {
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
    if browser {
        if browser_decision(owner, call, configuration.permission_basis(), &target).await?
            != Some(Decision::Allow)
        {
            return Err(failed(format!(
                "{} approval is no longer current",
                capability_name(&target)
            )));
        }
        Ok(())
    } else {
        granted_target(owner, call, configuration.permission_basis(), &target).await
    }
}

fn capability_name(target: &maka_agent_facts::interaction::GrantTarget) -> &'static str {
    match target.capability {
        maka_agent_facts::interaction::GrantCapability::ComputerAudio => "Computer audio recording",
        maka_agent_facts::interaction::GrantCapability::Browser => "Browser site",
        maka_agent_facts::interaction::GrantCapability::BrowserDownload => "Browser file download",
        maka_agent_facts::interaction::GrantCapability::BrowserUpload => "Browser file upload",
        maka_agent_facts::interaction::GrantCapability::BrowserHistory => "Browser history",
        _ => "Computer Use",
    }
}

/// T1 is committed under the original grant fence. T2 must still settle even
/// after permission revocation, so only the dispatch uses the checked append.
#[derive(Clone, Copy)]
pub(super) enum ComputerLane {
    Native,
    Other,
}

pub(super) struct Journal {
    pub lane: ComputerLane,
    pub store: maka_event_log::SessionStore,
    pub basis: PermissionBasis,
    pub targets: Vec<maka_agent_facts::interaction::GrantTarget>,
    pub app: Option<(
        maka_agent_facts::interaction::GrantTarget,
        maka_agent_facts::interaction::ComputerAppDisplay,
    )>,
}
impl EventSink for Journal {
    fn commit(self: Arc<Self>, event: EventWrite) -> CommitFuture {
        Box::pin(async move {
            self.commit_with_prefix(&[], event)
                .await
                .map(|receipt| receipt.last_sequence)
        })
    }

    fn commit_with_prefix(
        self: Arc<Self>,
        prefix: &[EventWrite],
        event: EventWrite,
    ) -> maka_agent_facts::event::PrefixCommitFuture {
        let mut events = prefix.to_vec();
        events.push(event);
        Box::pin(async move {
            let (event, prefix) = events.split_last().expect("last event is present");
            if matches!(event.event().fact, Fact::ToolDispatched { .. }) {
                if matches!(self.lane, ComputerLane::Native) {
                    if let Some((app, display)) = &self.app {
                        self.store
                            .append_native_computer_app_dispatch(
                                prefix,
                                event,
                                &self.targets,
                                app,
                                display,
                                &self.basis,
                            )
                            .await
                    } else {
                        self.store
                            .append_native_computer_dispatch(
                                prefix,
                                event,
                                &self.targets,
                                &self.basis,
                            )
                            .await
                    }
                } else if let Some((app, display)) = &self.app {
                    self.store
                        .append_computer_app_dispatch(
                            prefix,
                            event,
                            &self.targets,
                            app,
                            display,
                            &self.basis,
                        )
                        .await
                } else {
                    self.store
                        .append_capability_dispatch(prefix, event, &self.targets, &self.basis)
                        .await
                }
            } else {
                self.store
                    .append_batch(&events)
                    .await
                    .map(maka_agent_facts::event::PrefixReceipt::from_sequences)
            }
        })
    }
}
