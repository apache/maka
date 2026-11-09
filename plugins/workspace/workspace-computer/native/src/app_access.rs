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

//! Consent uses the original call-bound native capability and canonical interaction.
use super::*;
use maka_agent_authority::computer::ComputerAppObservation;
use maka_agent_facts::interaction::{
    ComputerAppDecision, GrantScope, GrantTarget, InteractionOutcome,
};
use maka_sandbox::workspace::PermissionBasis;

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
    call: &Call,
    basis: PermissionBasis,
    subject: &maka_computer_use::ComputerAppTarget,
    native_operation_id: &str,
    capture: Value,
    cancellation: &CancellationToken,
    cell: &maka_code_runtime::CellContext,
) -> Result<GrantTarget, ToolError> {
    access::granted(owner, call, basis).await?;
    let authority = call.authority.as_ref();
    let target = target(subject);
    let original = call
        .operation
        .as_ref()
        .ok_or_else(|| failed("Computer original operation is missing"))?;
    let status = authority
        .observe_app(
            original,
            ComputerAppObservation {
                native_operation_id: native_operation_id.into(),
                target: target.clone(),
                display: subject.display.clone(),
                allow_always: subject.allow_always,
                capture,
            },
        )
        .await?;
    if status.stopped {
        return Err(stopped());
    }
    if status.granted {
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
    let record = authority.request_app(native_operation_id).await?;
    let observed = {
        let _timeout = cell.suspend_timeout();
        maka_agent_authority::interaction_wait::wait(authority, &record, cancellation).await
    };
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
    let status = authority.app_status(native_operation_id).await?;
    if status.stopped {
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
    if !status.granted {
        return Err(failed("Computer Use app access is no longer current"));
    }
    Ok(target)
}
fn stopped() -> ToolError {
    failed("Computer Use was stopped for this app in the current Run")
}

/// Permission loss cancels this exact promise, then awaits its real cleanup.
pub(super) async fn settle<F, Fut>(
    call: &Call,
    operation: &str,
    has_app: bool,
    cancellation: CancellationToken,
    action: F,
) -> Result<Value, ToolError>
where
    F: FnOnce(CancellationToken) -> Fut,
    Fut: std::future::Future<Output = Result<Value, ToolError>>,
{
    if !has_app {
        return action(cancellation).await;
    }
    let child = cancellation.child_token();
    let mut changes = call.authority.changes().map_err(failed)?;
    let monitor = async {
        loop {
            changes.borrow_and_update();
            let status = call.authority.app_status(operation).await?;
            if status.stopped || !status.granted {
                return Err::<(), _>(stopped());
            }
            changes.changed().await.map_err(failed)?;
        }
    };
    // Recheck the admitted original before constructing native work.
    let status = call.authority.app_status(operation).await?;
    if status.stopped || !status.granted {
        return Err(stopped());
    }
    let native = action(child.clone());
    tokio::pin!(native);
    let reason = tokio::select! {
        biased;
        result = &mut native => return result,
        stopped = monitor => stopped.err().unwrap_or_else(|| failed("App Stop monitor closed")),
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
