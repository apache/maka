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
    let (current, _) = current(owner, call, "cua_repl").await?;
    if current.permission_basis() != basis {
        return Err(failed("Computer Use permission boundary changed"));
    }
    let store = maka_agent_authority::permissions::execution(
        &owner.store,
        call.identity.agent().expect("checked Agent"),
        call.execution().map(|token| token.as_ref()),
    )?;
    let grant = store
        .client_capability_grant(
            &call.identity.agent().expect("checked Agent").session_id,
            &api::target(),
        )
        .await
        .map_err(|e| ToolError::Persistence(message(e)))?;
    if grant.is_none_or(|grant| grant.basis != Some(basis)) {
        return Err(failed("Computer Use Session grant is missing or revoked"));
    }
    Ok(())
}
pub(super) async fn approve(
    owner: &Computer,
    call: &Scope,
    configuration: &ResolvedConfiguration,
    cancellation: &CancellationToken,
) -> Result<(), ToolError> {
    let context = ToolCallContext {
        execution: call.execution().cloned(),
        invocation: call.identity.agent().expect("checked Agent").clone(),
        operation_id: call.identity.operation_id().expect("checked tool").into(),
    };
    let target = api::target();
    let store = maka_agent_authority::permissions::execution(
        &owner.store,
        &context.invocation,
        context.execution.as_deref(),
    )?;
    if store
        .client_capability_grant(&context.invocation.session_id, &target)
        .await
        .map_err(|e| ToolError::Persistence(message(e)))?
        .is_some_and(|grant| grant.basis == Some(configuration.permission_basis()))
    {
        return Ok(());
    }
    if !configuration.permissions.request_permissions {
        return Err(failed(
            "Current policy does not allow requesting Computer Use access",
        ));
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
            target,
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
        return Err(failed("Computer Use access was not granted"));
    }
    granted(owner, call, configuration.permission_basis()).await
}

/// T1 is committed under the original grant fence. T2 must still settle even
/// after permission revocation, so only the dispatch uses the checked append.
pub(super) struct Journal {
    pub store: maka_event_log::SessionStore,
    pub basis: PermissionBasis,
}
impl EventSink for Journal {
    fn commit(self: Arc<Self>, event: EventWrite) -> CommitFuture {
        Box::pin(async move {
            if matches!(event.event().fact, Fact::ToolDispatched { .. }) {
                self.store
                    .append_capability_dispatch(&event, &api::target(), &self.basis)
                    .await
            } else {
                self.store.append(&event).await
            }
        })
    }
}
