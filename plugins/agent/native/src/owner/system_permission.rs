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

use super::Owner;
use super::access::RunAccess;
use crate::contract::{
    InteractionRead, RequestSystemPermission, SystemPermissionOutcome, SystemPermissionState,
    SystemPermissionStatus,
};
use maka_agent_authority::permissions::Access;
use maka_agent_facts::interaction::{
    InteractionOutcome, InteractionRecord, InteractionRequest, SystemPermissionGrant,
};
use maka_capabilities::call::Scope;
use maka_computer_use::system_permission;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

type Missing = fn(&[SystemPermissionGrant]) -> Result<Vec<SystemPermissionGrant>, String>;
type Request = fn(&[SystemPermissionGrant], &(dyn Fn() -> bool + Sync)) -> Result<(), String>;

impl Owner {
    pub async fn system_permission_status(
        &self,
        input: InteractionRead,
    ) -> Result<SystemPermissionStatus, String> {
        self.system_permission_status_with(
            input,
            system_permission::supported(),
            system_permission::missing,
        )
        .await
    }

    pub(super) async fn system_permission_status_with(
        &self,
        input: InteractionRead,
        supported: bool,
        missing: Missing,
    ) -> Result<SystemPermissionStatus, String> {
        let record = self
            .interaction(&input.session_id, &input.request_id)
            .await?;
        let InteractionRequest::SystemPermission { grants, .. } = &record.request else {
            return Err("agent_system_permission_request_required".into());
        };
        let grants = grants.clone();
        let grants = tokio::task::spawn_blocking(move || {
            let missing = if supported {
                missing(&grants)?
            } else {
                grants.clone()
            };
            Ok::<_, String>(
                grants
                    .into_iter()
                    .map(|grant| SystemPermissionState {
                        grant,
                        effective: !missing.contains(&grant),
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .await
        .map_err(|error| format!("System permission observation stopped: {error}"))??;
        // Observe the canonical result again after the OS check; never complete
        // the interaction here. Only the original producer can do that.
        let record = self
            .interaction(&input.session_id, &input.request_id)
            .await?;
        let requestable = supported && self.system_permission_requestable(&record).await?;
        let outcome = match record.outcome {
            None => None,
            Some(InteractionOutcome::SystemPermissionGranted { committed_at }) => {
                Some(SystemPermissionOutcome::SystemPermissionGranted { committed_at })
            }
            Some(InteractionOutcome::Closure {
                reason,
                committed_at,
            }) => Some(SystemPermissionOutcome::Closure {
                reason,
                committed_at,
            }),
            Some(_) => return Err("agent_system_permission_outcome_invalid".into()),
        };
        Ok(SystemPermissionStatus {
            outcome,
            grants,
            requestable,
        })
    }

    async fn system_permission_access(
        &self,
        record: &InteractionRecord,
    ) -> Result<Option<(Arc<RunAccess>, CancellationToken)>, String> {
        if record.outcome.is_some() || self.stop.is_cancelled() {
            return Ok(None);
        }
        let current = self
            .durable
            .interactions()
            .read(&record.execution.session_id, &record.request_id)
            .await
            .map_err(|error| error.to_string())?;
        if current.as_ref() != Some(record) {
            return Ok(None);
        }
        let active = {
            let runs = self.runs.state().await;
            runs.controls
                .get(&record.execution.session_id)
                .filter(|control| control.execution == record.execution)
                .and_then(|control| {
                    control
                        .access
                        .upgrade()
                        .map(|access| (access, control.cancellation.clone()))
                })
        };
        let Some((access, cancellation)) = active else {
            return Ok(None);
        };
        if cancellation.is_cancelled() {
            return Ok(None);
        }
        let configuration = access
            .live_configuration()
            .await
            .map_err(|error| error.to_string())?;
        Ok(configuration
            .permissions
            .request_permissions
            .then_some((access, cancellation)))
    }

    async fn system_permission_requestable(
        &self,
        record: &InteractionRecord,
    ) -> Result<bool, String> {
        Ok(self.system_permission_access(record).await?.is_some())
    }

    pub async fn request_system_permission(
        self: &Arc<Self>,
        input: RequestSystemPermission,
        scope: &Scope,
    ) -> Result<SystemPermissionStatus, String> {
        self.request_system_permission_with(
            input,
            scope,
            system_permission::supported(),
            system_permission::missing,
            system_permission::request,
        )
        .await
    }

    pub(super) async fn request_system_permission_with(
        self: &Arc<Self>,
        input: RequestSystemPermission,
        scope: &Scope,
        supported: bool,
        missing: Missing,
        request: Request,
    ) -> Result<SystemPermissionStatus, String> {
        if scope.identity.agent().is_some() {
            return Err("agent_system_permission_human_action_required".into());
        }
        self.require_interaction_access(scope, &input.session_id)
            .await?;
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let record = owner
                    .interaction(&input.session_id, &input.request_id)
                    .await?;
                let InteractionRequest::SystemPermission { grants, .. } = &record.request else {
                    return Err("agent_system_permission_request_required".into());
                };
                if !grants.contains(&input.grant) {
                    return Err("agent_system_permission_grant_not_requested".into());
                }
                if !supported {
                    return Err("agent_system_permission_not_requestable".into());
                }
                let Some((_access, run_cancellation)) =
                    owner.system_permission_access(&record).await?
                else {
                    return Err("agent_system_permission_not_requestable".into());
                };
                if scope.cancellation.is_cancelled() {
                    return Err("agent_work_cancelled".into());
                }
                let cancellation = scope.cancellation.clone();
                let stopped = owner.stop.clone();
                tokio::task::spawn_blocking(move || {
                    let cancelled = || {
                        cancellation.is_cancelled()
                            || stopped.is_cancelled()
                            || run_cancellation.is_cancelled()
                    };
                    if cancelled() {
                        return Err("agent_work_cancelled".into());
                    }
                    if !missing(&[input.grant])?.is_empty() {
                        request(&[input.grant], &cancelled)?;
                    }
                    Ok::<_, String>(())
                })
                .await
                .map_err(|error| format!("System permission request stopped: {error}"))??;
                owner
                    .system_permission_status_with(
                        InteractionRead {
                            session_id: input.session_id,
                            request_id: input.request_id,
                        },
                        supported,
                        missing,
                    )
                    .await
            })
        })
        .await
    }
}
