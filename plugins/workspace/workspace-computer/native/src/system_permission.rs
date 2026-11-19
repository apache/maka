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
use maka_computer_use::system_permission;
use maka_sandbox::workspace::PermissionBasis;
use sha2::{Digest, Sha256};

/// How often the grants are checked again while the card is open.
const RECHECK: std::time::Duration = std::time::Duration::from_millis(1500);

trait PermissionReader: Clone + Send + Sync + 'static {
    fn missing(
        &self,
        required: &[SystemPermissionGrant],
    ) -> Result<Vec<SystemPermissionGrant>, String>;
    fn application(&self) -> (String, Option<std::path::PathBuf>);
}

#[derive(Clone, Copy)]
struct Native;
impl PermissionReader for Native {
    fn missing(
        &self,
        required: &[SystemPermissionGrant],
    ) -> Result<Vec<SystemPermissionGrant>, String> {
        system_permission::missing(required)
    }
    fn application(&self) -> (String, Option<std::path::PathBuf>) {
        system_permission::application()
    }
}

async fn missing(
    reader: &impl PermissionReader,
    required: &'static [SystemPermissionGrant],
) -> Result<Vec<SystemPermissionGrant>, String> {
    let reader = reader.clone();
    tokio::task::spawn_blocking(move || reader.missing(required))
        .await
        .map_err(|error| format!("System permission check stopped: {error}"))?
}

pub(super) async fn ensure(
    owner: &Computer,
    call: &Call,
    basis: PermissionBasis,
    required: &'static [SystemPermissionGrant],
    native_operation_id: &str,
    cancellation: &CancellationToken,
    cell: &maka_code_runtime::CellContext,
) -> Result<(), ToolError> {
    ensure_with_reader(
        owner,
        call,
        basis,
        required,
        native_operation_id,
        cancellation,
        cell,
        Native,
    )
    .await
}

#[expect(
    clippy::too_many_arguments,
    reason = "the permission-reader test seam adds one argument to the production consent boundary"
)]
async fn ensure_with_reader(
    owner: &Computer,
    call: &Call,
    basis: PermissionBasis,
    required: &'static [SystemPermissionGrant],
    native_operation_id: &str,
    cancellation: &CancellationToken,
    cell: &maka_code_runtime::CellContext,
    reader: impl PermissionReader,
) -> Result<(), ToolError> {
    let initial_missing = missing(&reader, required).await.map_err(failed)?;
    if initial_missing.is_empty() {
        return Ok(());
    }
    let (configuration, _) = access::current(owner, call, "cua_repl").await?;
    if configuration.permission_basis() != basis {
        return Err(failed("Computer Use permission boundary changed"));
    }
    let request_permissions = configuration.permissions.request_permissions;
    let identity_reader = reader.clone();
    let (application, bundle) = tokio::task::spawn_blocking(move || identity_reader.application())
        .await
        .map_err(|_| failed("System permission check stopped"))?;
    let still_missing =
        |grants: &[SystemPermissionGrant]| failed(system_permission::failure(grants, &application));
    if !request_permissions {
        return Err(still_missing(&initial_missing));
    }
    let authority = call.authority.as_ref();
    let execution = authority.execution();
    let request_id = format!(
        "system_permission_{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                execution,
                &authority.call().operation_id,
                native_operation_id,
                required
            ))
            .expect("trusted grant list")
        ))
    );
    let record = InteractionRecord {
        execution: execution.clone(),
        request_id,
        created_at: maka_agent_authority::now(),
        outcome: None,
        request: InteractionRequest::SystemPermission {
            tool_use_id: call.authority.call().tool_use_id(),
            // Keep the UI's observation/request set equal to the producer's:
            // an initially effective grant can disappear during this wait.
            grants: required.to_vec(),
            application: application.clone(),
            application_location: bundle
                .map(|path| -> Result<_, ToolError> {
                    let root = owner
                        .store
                        .owned_root()
                        .map_err(|error| failed(error.to_string()))?;
                    Ok(
                        maka_agent_facts::interaction::SystemPermissionApplicationLocation {
                            file_url: url::Url::from_file_path(path)
                                .map_err(|_| failed("Invalid responsible application bundle path"))?
                                .to_string(),
                            state_domain: root.root_id().into(),
                        },
                    )
                })
                .transpose()?,
        },
    };
    let observed = async {
        authority.establish(&record).await
            .map_err(|error| format!("System permission request publication unavailable: {error}"))?;
        let _timeout = cell.suspend_timeout();
        let granted = async {
            loop {
                tokio::time::sleep(RECHECK).await;
                if missing(&reader, required).await?.is_empty() {
                    // The first outcome stands: a cancel committed meanwhile wins.
                    authority
                        .system_permission_observed(&record.request_id, required.to_vec())
                        .await
                        .map_err(|error| format!("System permission outcome unavailable: {error}"))?;
                    return Ok::<_, String>(());
                }
            }
        };
        tokio::select! {
            outcome = maka_agent_authority::interaction_wait::wait(authority, &record, cancellation) => outcome.map_err(str::to_owned),
            result = granted => {
                result?;
                maka_agent_authority::interaction_wait::wait(authority, &record, cancellation).await.map_err(str::to_owned)
            },
        }
    }
    .await;
    let outcome = match observed {
        Ok(outcome) => outcome,
        Err(error) => {
            match maka_agent_authority::interaction_wait::withdraw(authority, &record).await {
                Ok(Some(outcome)) => {
                    if !cancellation.is_cancelled()
                        && !matches!(outcome, InteractionOutcome::SystemPermissionGranted { .. })
                    {
                        return Err(failed(error));
                    }
                    outcome
                }
                Ok(None) => return Err(failed(error)),
                Err(error) => return Err(ToolError::CleanupUnconfirmed(error.into())),
            }
        }
    };
    if cancellation.is_cancelled() {
        return Err(failed("System permission request cancelled"));
    }
    if matches!(outcome, InteractionOutcome::SystemPermissionGranted { .. }) {
        return Ok(());
    }
    // A cancel stands even if the grants arrived as the card closed.
    let missing = missing(&reader, required).await.map_err(failed)?;
    if missing.is_empty() {
        Err(failed("System permission request cancelled"))
    } else {
        Err(still_missing(&missing))
    }
}
