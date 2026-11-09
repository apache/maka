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
use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_api::session::ResolvedConfiguration;
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
            .map_err(|error| error.to_string())?;
        let owner = self.clone();
        let worker = self.workers.spawn(async move {
            ticket.start();
            let generation = crate::mcp::ClientGeneration::fresh();
            let configuration = match owner
                .begin_session_mcp(&input.session_id, generation, &context)
                .await
            {
                Ok(configuration) => configuration,
                Err(error) => {
                    ticket.complete(Ok(()));
                    return Err(error);
                }
            };
            let mut servers = None;
            let mut cleanup_materials = Vec::new();
            let operation = async {
                let floor = owner
                    .capture_sandbox(&configuration, context.scope().sandbox_floor())
                    .await?;
                if !input.servers.is_empty() {
                    crate::mcp::require_compatible_floor(&floor).map_err(str::to_owned)?;
                }
                let startup = context.scope().cancellation.child_token();
                let opening = crate::mcp::Servers::open_cancellable(
                    &input.servers, &owner.configuration, startup.clone(),
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
                        if let Some(material) = error.material {
                            cleanup_materials.push((error.message.clone(), material));
                        }
                        return Err(error.message);
                    }
                };
                servers = Some(opened.clone());
                {
                    let _ordered = owner.runs.session(&input.session_id).await;
                    let busy = owner.runs.state().await.busy(&input.session_id);
                    if busy || !owner.durable
                        .session_quiescence(owner.run_owner(), input.session_id.clone())
                        .await.map_err(|error| error.to_string())?.is_quiescent()
                    {
                        return Err("agent_session_busy".into());
                    }
                    if owner.stop.is_cancelled() || context.scope().cancellation.is_cancelled() {
                        return Err("agent_session_mcp_cancelled".into());
                    }
                    let current = owner.mutable_session(&input.session_id).await?;
                    if current.archived
                        || current.configuration.workspace != configuration.workspace
                        || current.configuration.binding != configuration.binding
                        || current.configuration.permissions != configuration.permissions
                        || current.configuration.boundary_revision != configuration.boundary_revision
                    {
                        return Err("agent_session_configuration_changed".into());
                    }
                    let floor = owner
                        .capture_sandbox(&current.configuration, context.scope().sandbox_floor())
                        .await?;
                    if !input.servers.is_empty() {
                        crate::mcp::require_compatible_floor(&floor).map_err(str::to_owned)?;
                    }
                    owner.mcp_projects.publish_client(&input.session_id, generation, opened.clone())?;
                    owner.wake_notify.notify_one();
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
                Err::<Value, String>("agent_session_mcp_closed".into())
            }.await;
            let cleanup = owner.close_session_mcp(
                &input.session_id, generation, servers.as_deref(), &mut cleanup_materials, &ticket,
            ).await;
            match cleanup {
                Ok(()) => {
                    ticket.complete(Ok(()));
                    operation
                }
                Err(error) => {
                    owner.mcp_projects.client_cleanup_failed(error.clone());
                    ticket.unconfirmed(error.clone(), (servers, cleanup_materials));
                    Err(match operation {
                        Err(operation) => format!("{operation}; MCP cleanup unconfirmed: {error}"),
                        Ok(_) => error,
                    })
                }
            }
        });
        worker
            .await
            .map_err(|error| format!("agent_session_mcp_owner_disappeared: {error}"))?
    }

    async fn begin_session_mcp(
        self: &Arc<Self>,
        session: &str,
        generation: crate::mcp::ClientGeneration,
        context: &Context,
    ) -> Result<ResolvedConfiguration, String> {
        let _ordered = self.runs.session(session).await;
        {
            let runs = self.runs.state().await;
            if runs.closing
                || self.stop.is_cancelled()
                || context.scope().cancellation.is_cancelled()
            {
                return Err("agent_closed".into());
            }
            if runs.busy(session) {
                return Err("agent_session_busy".into());
            }
        }
        if !self
            .durable
            .session_quiescence(self.run_owner(), session.into())
            .await
            .map_err(|error| error.to_string())?
            .is_quiescent()
        {
            return Err("agent_session_busy".into());
        }
        let current = self.mutable_session(session).await?;
        if current.archived {
            return Err("agent_session_unavailable".into());
        }
        crate::workspace::validate(
            &self.workspace_roots,
            &current.configuration.workspace,
            &self.managed_worktrees,
        )
        .await?;
        self.mcp_projects.begin_client(session, generation)?;
        Ok(current.configuration)
    }

    async fn withdraw_session_mcp(
        self: &Arc<Self>,
        session: &str,
        generation: crate::mcp::ClientGeneration,
    ) -> Result<Option<BoxFuture<'static, Result<(), String>>>, String> {
        let _ordered = self.runs.session(session).await;
        if !self.mcp_projects.has_client(session, generation) {
            return Ok(None);
        }
        self.mcp_projects.withdraw_client(session, generation);
        self.wake_notify.notify_one();
        let runs = self.runs.state().await;
        if let Some(control) = runs
            .controls
            .get(session)
            .filter(|control| control.basis.client_mcp == Some(generation))
        {
            let observed = (|| {
                let access = control
                    .access
                    .upgrade()
                    .ok_or("agent_original_work_custody_unavailable")?;
                if access.execution() != &control.execution {
                    return Err("agent_original_work_identity_changed".into());
                }
                self.store
                    .observe_work_settlement(access.custody().as_ref(), session)
                    .map_err(|error| error.to_string())
            })();
            control.cancellation.cancel();
            let observer = observed?;
            // The signal-only observer must not retain our local strong custody.
            // Cancellation retires this activation; only explicit user control is Stop.
            return Ok(Some(
                async move { observer.wait().await.map_err(|error| error.to_string()) }.boxed(),
            ));
        }
        if let Some(preparing) = runs.preparing.get(session) {
            let run = preparing.run;
            let cancellation = preparing.cancellation.clone();
            let completion = preparing.completion.clone();
            drop(runs);
            let view = self
                .durable
                .frontier(run)
                .await
                .map_err(|error| error.to_string())?;
            if view.spec.owner != self.run_owner() || view.spec.session_id != session {
                return Err("agent_original_work_identity_changed".into());
            }
            let catalog = self
                .mcp_projects
                .catalog(view.spec.mcp_revision.as_deref())?;
            if catalog.client_mcp != Some(generation) {
                return Ok(None);
            }
            cancellation.cancel();
            return Ok(Some(
                async move {
                    match completion.await {
                        maka_plugin_core::operation::OperationCleanup::Confirmed => Ok(()),
                        result => Err(format!("agent_execution_cleanup_unconfirmed: {result:?}")),
                    }
                }
                .boxed(),
            ));
        }
        if runs.retained_cleanup.contains_key(session) {
            return Err("agent_execution_cleanup_unconfirmed".into());
        }
        Ok(None)
    }

    async fn close_session_mcp(
        self: &Arc<Self>,
        session: &str,
        generation: crate::mcp::ClientGeneration,
        servers: Option<&crate::mcp::Servers>,
        materials: &mut Vec<(String, crate::mcp::CleanupMaterial)>,
        ticket: &maka_plugin_core::work::resources::Ticket,
    ) -> Result<(), String> {
        let withdrawn = self.withdraw_session_mcp(session, generation).await;
        if let Err(error) = &withdrawn {
            ticket.record_failure(error.clone());
            self.mcp_projects.client_cleanup_failed(error.clone());
        }
        // Close the original transport before waiting for its containing work.
        if let Some(servers) = servers {
            if let Err(error) = servers.close().await {
                materials.push((error.message, error.material));
            }
        }
        let mut failures = Vec::new();
        for (cause, material) in materials.iter() {
            if let Err(error) = material.closed().await {
                let error = format!("MCP transport: {cause}; original cleanup: {error}");
                ticket.record_failure(error.clone());
                self.mcp_projects.client_cleanup_failed(error.clone());
                failures.push(error);
            }
        }
        let settled = match withdrawn {
            Ok(Some(settlement)) => settlement.await,
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };
        if let Err(error) = settled {
            failures.push(format!("MCP original work: {error}"));
        }
        if !failures.is_empty() {
            return Err(failures.join("; "));
        }
        self.mcp_projects.remove_client(session, generation);
        self.mcp_projects.prune().await?;
        self.wake_notify.notify_one();
        Ok(())
    }
}
