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

use crate::{
    contract::{SessionMcp, SessionMcpAttached},
    owner::Owner,
};
use maka_host_runtime::application::Context;
use serde_json::Value;
use std::sync::Arc;

impl Owner {
    pub(crate) async fn session_mcp(
        self: &Arc<Self>,
        input: SessionMcp,
        context: Context,
    ) -> Result<Value, String> {
        if context.scope().identity.agent().is_some() {
            return Err("agent_mcp_user_approval_required".into());
        }
        let mut ticket = context
            .scope()
            .resources
            .reserve()
            .map_err(|_| "agent_work_closed")?;
        let owner = self.clone();
        self.workers.spawn(async move {
            ticket.start();
            let generation = crate::mcp::ClientGeneration::fresh();
            let workspace = match owner.begin_session_mcp(&input.session_id, generation).await {
                Ok(workspace) => workspace,
                Err(error) => { ticket.complete(Ok(())); return Err(error); }
            };
            let mut servers = None;
            let operation: Result<Value, String> = async {
                let startup = context.scope().cancellation.child_token();
                let opening = crate::mcp::Servers::open_cancellable(
                    &input.servers, owner.store.clone(), &owner.configuration,
                    startup.clone(),
                );
                tokio::pin!(opening);
                let opened = tokio::select! {
                    biased;
                    _ = owner.stop.cancelled() => { startup.cancel(); opening.await },
                    result = &mut opening => result,
                };
                let opened = match opened {
                    Ok(servers) => Arc::new(servers),
                    Err(error) => {
                        if !error.cleanup_confirmed {
                            owner.mcp_projects.client_cleanup_failed(error.message.clone());
                            ticket.record_failure(error.message.clone());
                        }
                        return Err(error.message);
                    }
                };
                servers = Some(opened.clone());
                {
                    let admission = owner.runs.session(&input.session_id).await;
                    if admission.state().await.busy(&input.session_id) || owner.has_parked_invocation(&input.session_id).await? { return Err("agent_session_busy".into()); }
                    if owner.stop.is_cancelled() || context.scope().cancellation.is_cancelled() {
                        return Err("agent_session_mcp_cancelled".into());
                    }
                    let current = owner.session(&input.session_id).await?;
                    if current.archived || current.configuration.workspace != workspace {
                        return Err("agent_session_unavailable".into());
                    }
                    owner.mcp_projects.publish_client(&input.session_id, generation, opened.clone())?;
                }
                let ready = serde_json::to_value(SessionMcpAttached {
                    tools: opened.registrations.iter().map(|tool| tool.definition.name.clone()).collect(),
                }).map_err(|error| error.to_string())?;
                tokio::select! {
                    biased;
                    _ = owner.stop.cancelled() => return Err("agent_closed".into()),
                    _ = context.scope().cancellation.cancelled() => return Err("agent_session_mcp_cancelled".into()),
                    result = context.emit(ready) => result.map_err(|error| error.to_string())?,
                }
                tokio::select! {
                    _ = owner.stop.cancelled() => {},
                    _ = context.scope().cancellation.cancelled() => {},
                }
                Err("agent_session_mcp_closed".to_owned())
            }.await;
            let cleanup = owner.close_session_mcp(&input.session_id, generation, servers.as_deref()).await;
            match &cleanup {
                Ok(()) => ticket.complete(Ok(())),
                Err(error) => {
                    owner.mcp_projects.client_cleanup_failed(error.clone());
                    ticket.unconfirmed(error.clone(), servers);
                }
            }
            operation.and(cleanup.map(|()| Value::Null))
        }).await.map_err(|_| "agent_session_mcp_owner_disappeared".to_owned())?
    }

    async fn begin_session_mcp(
        self: &Arc<Self>,
        session: &str,
        generation: crate::mcp::ClientGeneration,
    ) -> Result<crate::contract::Workspace, String> {
        self.require_session(session).await?;
        let store = self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?;
        if let Some(generation) = self
            .revoke_lost_checkpoint(session, &store)
            .await
            .map_err(|error| error.to_string())?
        {
            self.settle_session_mcp(session, generation).await?;
        }
        let admission = self.runs.session(session).await;
        {
            let runs = admission.state().await;
            if runs.closing || self.stop.is_cancelled() {
                return Err("agent_closed".into());
            }
            if runs.busy(session) || runs.retained_cleanup.contains(session) {
                return Err("agent_session_busy".into());
            }
        }
        let current = self.session(session).await?;
        if current.archived || self.has_parked_invocation(session).await? {
            return Err("agent_session_unavailable".into());
        }
        if !self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .message_queue(session)
            .await
            .map_err(|error| error.to_string())?
            .entries
            .is_empty()
        {
            return Err("agent_session_busy".into());
        }
        crate::workspace::validate(
            &self.workspace_roots,
            &current.configuration.workspace,
            &self.managed_worktrees,
        )
        .await?;
        self.mcp_projects.begin_client(session, generation)?;
        Ok(current.configuration.workspace)
    }

    async fn close_session_mcp(
        self: &Arc<Self>,
        session: &str,
        generation: crate::mcp::ClientGeneration,
        servers: Option<&crate::mcp::Servers>,
    ) -> Result<(), String> {
        let settled = async {
            let goal = self.goals.gate.lock().await;
            let admission = self.runs.session(session).await;
            if !self.mcp_projects.has_client(session, generation) {
                return Ok(());
            }
            self.mcp_projects.withdraw_client(session, generation);
            let control = admission
                .state()
                .await
                .controls
                .get(session)
                .filter(|control| control.basis.client_mcp == Some(generation))
                .cloned();
            let mut settlement = control.as_ref().map(|control| {
                control
                    .settlement
                    .as_ref()
                    .expect("client MCP settlement")
                    .subscribe()
            });
            if control.is_none()
                && !self
                    .store
                    .session_is_available(session)
                    .await
                    .map_err(|error| error.to_string())?
            {
                return Ok(());
            }
            let invocation = match &control {
                Some(control) => Some(control.invocation.invocation_id.clone()),
                None => {
                    let parked = self
                        .store
                        .session(session)
                        .await
                        .map_err(|error| error.to_string())?
                        .activation_checkpoint(session)
                        .await
                        .map_err(|error| error.to_string())?;
                    match parked {
                        Some(parked)
                            if client_generation(&parked.checkpoint.native_basis)?
                                == Some(generation) =>
                        {
                            Some(parked.checkpoint.invocation.invocation_id)
                        }
                        _ => None,
                    }
                }
            };
            let stopped = if let Some(invocation) = invocation {
                self.stop_run_id(session, &invocation, generation.interrupt(), &goal)
                    .await
                    .map(|_| ())
            } else {
                Ok(())
            };
            if let Some(control) = &control {
                control.cancellation.cancel();
            }
            drop(admission);
            drop(goal);
            let settled = if let Some(settlement) = &mut settlement {
                loop {
                    if let Some(result) = settlement.borrow().clone() {
                        break result;
                    }
                    if settlement.changed().await.is_err() {
                        break Err("agent_execution_owner_disappeared".into());
                    }
                }
            } else {
                Ok(())
            };
            stopped.and(settled)?;
            self.settle_session_mcp(session, generation).await
        }
        .await;
        // Even failed execution custody must still close the original MCP transport.
        let closed = match servers {
            Some(servers) => servers.close().await,
            None => Ok(()),
        };
        let cleanup = settled.and(closed);
        if cleanup.is_ok() {
            self.mcp_projects.remove_client(session, generation);
            self.mcp_projects.prune().await?;
        }
        cleanup
    }
    async fn settle_session_mcp(
        self: &Arc<Self>,
        session: &str,
        generation: crate::mcp::ClientGeneration,
    ) -> Result<(), String> {
        if !self
            .store
            .session_is_available(session)
            .await
            .map_err(|error| error.to_string())?
        {
            return Ok(());
        }
        let store = self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?;
        let mut changes = store
            .subscribe_commits()
            .map_err(|error| error.to_string())?;
        loop {
            let admission = self.runs.session(session).await;
            let control = {
                let runs = admission.state().await;
                if runs.retained_cleanup.contains(session) {
                    return Err("agent_execution_cleanup_unconfirmed".into());
                }
                runs.controls
                    .get(session)
                    .filter(|control| control.basis.client_mcp == Some(generation))
                    .cloned()
            };
            let parked = match store
                .activation_checkpoint(session)
                .await
                .map_err(|error| error.to_string())?
            {
                Some(parked) => {
                    client_generation(&parked.checkpoint.native_basis)? == Some(generation)
                }
                None => false,
            };
            drop(admission);
            if let Some(control) = control {
                control.cancellation.cancel();
                let mut settlement = control
                    .settlement
                    .as_ref()
                    .expect("client MCP settlement")
                    .subscribe();
                loop {
                    if let Some(result) = settlement.borrow().clone() {
                        result?;
                        break;
                    }
                    settlement
                        .changed()
                        .await
                        .map_err(|_| "agent_execution_owner_disappeared")?;
                }
            } else if !parked || self.stop.is_cancelled() {
                return Ok(());
            } else {
                #[cfg(test)]
                if self
                    .mcp_shutdown_at_parked_wait
                    .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    use futures_util::FutureExt;
                    // Enter the next wait without historical hints masking shutdown.
                    while let Some(changed) = changes.changed().now_or_never() {
                        changed.expect("live MCP test subscription");
                    }
                    self.stop.cancel();
                }
                self.schedule_activations(crate::owner::now())
                    .await
                    .map_err(|error| error.to_string())?;
                // Recovery may have acquired custody during the scan; recheck it on shutdown.
                tokio::select! {
                    _ = self.stop.cancelled() => {},
                    changed = changes.changed() => changed.map_err(|error| error.to_string())?,
                }
            }
        }
    }
    pub(in crate::owner) async fn revoke_lost_client_mcp(
        &self,
    ) -> Result<(), maka_agent_engine::RunError> {
        for session in self.store.activation_checkpoint_sessions().await? {
            if !self.owns(&session) {
                continue;
            }
            let store = self.store.session(&session).await?;
            self.revoke_lost_checkpoint(&session, &store).await?;
        }
        Ok(())
    }
    async fn revoke_lost_checkpoint(
        &self,
        session: &str,
        store: &maka_event_log::SessionStore,
    ) -> Result<Option<crate::mcp::ClientGeneration>, maka_agent_engine::RunError> {
        let Some(checkpoint) = store.activation_checkpoint(session).await? else {
            return Ok(None);
        };
        if let Some(generation) = client_generation(&checkpoint.checkpoint.native_basis)
            .map_err(maka_agent_engine::RunError::InvalidInput)?
            && !self.mcp_projects.has_client(session, generation)
        {
            if !checkpoint.revoked {
                store
                    .stop_native_approvals(&checkpoint.checkpoint.invocation, crate::owner::now())
                    .await?;
            }
            return Ok(Some(generation));
        }
        Ok(None)
    }
}

fn client_generation(basis: &Value) -> Result<Option<crate::mcp::ClientGeneration>, String> {
    match basis.get("client_mcp") {
        Some(value) => serde_json::from_value(value.clone()).map_err(|error| error.to_string()),
        None => Ok(None),
    }
}
