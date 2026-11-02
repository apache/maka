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

//! The operating system's privacy grants native desktop work needs. When one
//! is missing, the Host asks the operating system to show its request and
//! shows a card naming the switches to turn on, then waits: it checks the
//! grants again while the card is open and continues the call once they are
//! in effect. Cancelling the card fails the call as before.
use super::*;
use maka_agent_facts::interaction::{
    InteractionOutcome, InteractionRecord, InteractionRequest, SystemPermissionGrant,
};
use maka_agent_facts::tools::ToolCallContext;
use maka_agent_facts::workspace::PermissionBasis;
use maka_capabilities::call::Scope;
use maka_computer_use::system_permission;
use sha2::{Digest, Sha256};

/// How often the grants are checked again while the card is open.
const RECHECK: std::time::Duration = std::time::Duration::from_millis(1500);

/// The grants still missing; `None` when the check itself failed.
async fn missing() -> Option<Vec<SystemPermissionGrant>> {
    tokio::task::spawn_blocking(system_permission::missing)
        .await
        .ok()
}

pub(super) async fn ensure(
    owner: &Computer,
    call: &Scope,
    basis: PermissionBasis,
    native_operation_id: &str,
    cancellation: &CancellationToken,
    cell: &maka_code_runtime::CellContext,
) -> Result<(), ToolError> {
    // A failed check leaves the native call to report what it meets.
    let grants = missing().await.unwrap_or_default();
    if grants.is_empty() {
        return Ok(());
    }
    let application = tokio::task::spawn_blocking({
        let grants = grants.clone();
        move || {
            system_permission::request(&grants);
            system_permission::application()
        }
    })
    .await
    .map_err(|_| failed("System permission check stopped"))?;
    let still_missing =
        |grants: &[SystemPermissionGrant]| failed(system_permission::failure(grants, &application));
    let (configuration, _) = access::current(owner, call, "cua_repl").await?;
    if configuration.permission_basis() != basis {
        return Err(failed("Computer Use permission boundary changed"));
    }
    if !configuration.permissions.request_permissions {
        return Err(still_missing(&grants));
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
    let request_id = format!(
        "system_permission_{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                &context.invocation,
                &context.operation_id,
                native_operation_id,
                &grants
            ))
            .expect("trusted grant list")
        ))
    );
    let record = InteractionRecord {
        session_id: context.invocation.session_id.clone(),
        turn_id: context.invocation.turn_id.clone(),
        run_id: context.invocation.run_id.clone(),
        request_id,
        created_at: maka_agent_authority::now(),
        outcome: None,
        request: InteractionRequest::SystemPermission {
            tool_use_id: context.tool_use_id(),
            grants: grants.clone(),
            application: application.clone(),
        },
    };
    let observed = async {
        let committed = store
            .establish_run_interaction(&context.invocation, &record)
            .await
            .map_err(|_| "System permission request publication unavailable")?;
        if !committed.matches {
            return Err("System permission request identity conflict");
        }
        let _timeout = cell.suspend_timeout();
        let granted = async {
            loop {
                tokio::time::sleep(RECHECK).await;
                if missing().await.is_some_and(|grants| grants.is_empty()) {
                    // The first outcome stands: a cancel committed meanwhile wins.
                    let _ = store
                        .commit_interaction_outcome(
                            &record.request_id,
                            InteractionOutcome::SystemPermissionGranted {
                                committed_at: maka_agent_authority::now(),
                            },
                        )
                        .await;
                    return;
                }
            }
        };
        tokio::select! {
            outcome = maka_agent_authority::interaction_wait::wait(&store, &record, cancellation) => outcome,
            () = granted => maka_agent_authority::interaction_wait::wait(&store, &record, cancellation).await,
        }
    }
    .await;
    let outcome = match observed {
        Ok(outcome) => outcome,
        Err(error) => match maka_agent_authority::interaction_wait::withdraw(&store, &record).await
        {
            Ok(Some(outcome)) => outcome,
            Ok(None) => return Err(failed(error)),
            Err(error) => return Err(ToolError::CleanupUnconfirmed(error.into())),
        },
    };
    if cancellation.is_cancelled() {
        return Err(failed("System permission request cancelled"));
    }
    if matches!(outcome, InteractionOutcome::SystemPermissionGranted { .. }) {
        return Ok(());
    }
    // A cancel stands even if the grants arrived as the card closed.
    match missing().await {
        Some(missing) if !missing.is_empty() => Err(still_missing(&missing)),
        Some(_) => Err(failed("System permission request cancelled")),
        None => Err(still_missing(&grants)),
    }
}
