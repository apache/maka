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

//! Trusted native app consent through the canonical interaction owner. There is
//! no model-supplied identity and no plugin-local approval or persistence map.
use super::*;
use maka_agent_facts::interaction::{
    ComputerAppDecision, GrantScope, GrantTarget, InteractionOutcome, InteractionRecord,
    InteractionRequest,
};
use maka_agent_facts::tools::ToolCallContext;
use maka_agent_facts::workspace::PermissionBasis;
use maka_capabilities::call::Scope;
use sha2::{Digest, Sha256};

pub(super) fn target(subject: &maka_computer_use::ComputerAppTarget) -> GrantTarget {
    GrantTarget {
        scope: GrantScope::ComputerApp {
            platform: subject.identity.platform,
            application_id: subject.identity.application_id.clone(),
        },
        ..api::target()
    }
}

pub(super) async fn approve(
    owner: &Computer,
    call: &Scope,
    basis: PermissionBasis,
    subject: &maka_computer_use::ComputerAppTarget,
    native_operation_id: &str,
    cancellation: &CancellationToken,
    cell: &maka_code_runtime::CellContext,
) -> Result<GrantTarget, ToolError> {
    access::granted(owner, call, basis).await?;
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
    let target = target(subject);
    if store
        .computer_app_stopped(&context.invocation, &target, &subject.display)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?
    {
        return Err(stopped());
    }
    if store
        .computer_app_granted(&context.invocation, native_operation_id, &target, &basis)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?
    {
        return Ok(target);
    }
    let (configuration, _) = access::current(owner, call, "cua_repl").await?;
    if configuration.permission_basis() != basis {
        return Err(failed(
            "Computer Use permission boundary changed before app consent",
        ));
    }
    if !configuration.permissions.request_permissions {
        return Err(failed(
            "Current policy does not allow requesting app access",
        ));
    }
    let authority_revision = store
        .computer_app_authority_revision(&target)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?;
    let request_id = format!(
        "computer_app_{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                &context.invocation,
                &context.operation_id,
                native_operation_id,
                &target,
                basis,
                authority_revision
            ))
            .expect("trusted app identity")
        ))
    );
    let record = InteractionRecord {
        session_id: context.invocation.session_id.clone(),
        turn_id: context.invocation.turn_id.clone(),
        run_id: context.invocation.run_id.clone(),
        request_id,
        created_at: maka_agent_authority::now(),
        outcome: None,
        request: InteractionRequest::ComputerApp {
            tool_use_id: context.tool_use_id(),
            native_operation_id: native_operation_id.into(),
            target: target.clone(),
            basis,
            display: subject.display.clone(),
            allow_always: subject.allow_always,
            authority_revision,
        },
    };
    let observed = async {
        let committed = store
            .establish_run_interaction(&context.invocation, &record)
            .await
            .map_err(|_| "App approval publication unavailable")?;
        if !committed.matches {
            return Err("App approval identity conflict");
        }
        let _timeout = cell.suspend_timeout();
        maka_agent_authority::interaction_wait::wait(&store, &record, cancellation).await
    }
    .await;
    let outcome = match observed {
        Ok(outcome) => outcome,
        Err(error) => match maka_agent_authority::interaction_wait::withdraw(&store, &record).await
        {
            Ok(Some(outcome)) => outcome,
            Ok(None) => {
                if store
                    .computer_app_stopped(&context.invocation, &target, &subject.display)
                    .await
                    .map_err(|error| ToolError::Persistence(message(error)))?
                {
                    return Err(stopped());
                }
                return Err(failed(error));
            }
            Err(error) => return Err(ToolError::CleanupUnconfirmed(error.into())),
        },
    };
    if store
        .computer_app_stopped(&context.invocation, &target, &subject.display)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?
    {
        return Err(stopped());
    }
    if cancellation.is_cancelled() {
        return Err(failed("App approval cancelled"));
    }
    if !matches!(
        outcome,
        InteractionOutcome::ComputerAppDecision {
            decision: ComputerAppDecision::Once
                | ComputerAppDecision::Session
                | ComputerAppDecision::Always,
            ..
        }
    ) {
        return Err(failed("Computer Use app access was not granted"));
    }
    access::granted(owner, call, basis).await?;
    // T1 performs the authoritative comparison again. This observation gives a
    // useful failure if the profile grant was revoked while consent completed.
    if !store
        .computer_app_granted(&context.invocation, native_operation_id, &target, &basis)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?
    {
        return Err(failed("Computer Use app access is no longer current"));
    }
    Ok(target)
}

fn stopped() -> ToolError {
    failed("Computer Use was stopped for this app in the current turn")
}

/// Stop owns only this native promise. Its existing cleanup must settle before
/// the journal records T2; cancelling the parent evaluation would stop unrelated
/// work and erase the distinction from the ordinary whole-Turn Stop control.
pub(super) async fn settle<F, Fut>(
    store: &maka_event_log::SessionStore,
    invocation: &maka_agent_facts::event::Invocation,
    app: Option<&(
        GrantTarget,
        maka_agent_facts::interaction::ComputerAppDisplay,
    )>,
    cancellation: CancellationToken,
    action: F,
) -> Result<Value, ToolError>
where
    F: FnOnce(CancellationToken) -> Fut,
    Fut: std::future::Future<Output = Result<Value, ToolError>>,
{
    let Some((target, display)) = app else {
        return action(cancellation).await;
    };
    let child = cancellation.child_token();
    let mut changes = store
        .subscribe_commits()
        .map_err(|error| ToolError::Persistence(message(error)))?;
    if store
        .computer_app_stopped(invocation, target, display)
        .await
        .map_err(|error| ToolError::Persistence(message(error)))?
    {
        return Err(stopped());
    }
    let monitor = async {
        loop {
            changes.borrow_and_update();
            if store
                .computer_app_stopped(invocation, target, display)
                .await
                .map_err(|error| ToolError::Persistence(message(error)))?
            {
                return Err::<(), _>(stopped());
            }
            changes
                .changed()
                .await
                .map_err(|error| ToolError::Persistence(message(error)))?;
        }
    };
    let native = action(child.clone());
    tokio::pin!(native);
    let reason = tokio::select! {
        biased;
        result=&mut native=>return result,
        stopped=monitor=>stopped.err().unwrap_or_else(||failed("App Stop monitor closed")),
    };
    child.cancel();
    match native.await {
        Err(
            error @ (ToolError::OutcomeUnknown(_)
            | ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::OperationCleanupUnconfirmed { .. }),
        ) => Err(error),
        _ => Err(reason),
    }
}

#[cfg(test)]
mod tests;
