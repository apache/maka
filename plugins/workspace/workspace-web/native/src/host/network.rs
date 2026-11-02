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
use futures_util::FutureExt;
use maka_agent_facts::interaction::PermissionRequest;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tools::PreparedEffect;
use maka_agent_facts::tools::ToolCallContext;
use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolJournal;
use maka_capabilities::call::Scope;
use maka_capabilities::http::Error;
use maka_host_runtime::http::{Authority, Worker};
use maka_sandbox::{Destination, Network, Sandbox};
use std::panic::AssertUnwindSafe;

#[derive(Clone)]
enum Purpose {
    Retrieval { basis: Basis, search: bool },
    Health,
}
#[derive(Clone)]
pub(super) struct Access {
    owner: Arc<Web>,
    tool: ToolCallContext,
    caller: Scope,
    purpose: Purpose,
}
impl Access {
    pub fn new(owner: Arc<Web>, scope: &Scope, basis: Basis, search: bool) -> Result<Self, String> {
        Self::for_purpose(owner, scope, Purpose::Retrieval { basis, search })
    }
    pub fn health(owner: Arc<Web>, scope: &Scope) -> Result<Self, String> {
        Self::for_purpose(owner, scope, Purpose::Health)
    }
    fn for_purpose(owner: Arc<Web>, scope: &Scope, purpose: Purpose) -> Result<Self, String> {
        let invocation = scope.identity.agent().ok_or("web_requires_agent")?.clone();
        let operation_id = scope
            .identity
            .operation_id()
            .ok_or("web_requires_tool")?
            .into();
        Ok(Self {
            owner,
            tool: ToolCallContext {
                execution: scope.execution().cloned(),
                invocation,
                operation_id,
            },
            caller: scope.clone(),
            purpose,
        })
    }
    async fn current(
        &self,
        call: &Scope,
        destination: &Destination,
    ) -> Result<(maka_agent_api::session::ResolvedConfiguration, bool), Error> {
        let _lease = self.admit(call)?;
        let available = match &self.purpose {
            Purpose::Retrieval { basis, search } => self.owner.current(basis, *search).await,
            Purpose::Health => self
                .owner
                .configuration
                .runtime_policy()
                .await
                .map(|policy| !policy.policy.privacy.incognito_active)
                .map_err(message),
        }
        .map_err(Error::Failed)?;
        if !available {
            return Err(Error::Denied);
        }
        let configuration = maka_agent_authority::permissions::live(
            &maka_agent_authority::permissions::execution(
                &self.owner.log,
                &self.tool.invocation,
                self.tool.execution.as_deref(),
            )
            .map_err(|_| Error::Denied)?,
            &self.tool.invocation,
        )
        .await
        .map_err(|_| Error::Denied)?;
        let workspace = configuration.workspace.clone();
        let ceiling = self.owner.network.clone();
        let destination_copy = destination.clone();
        let allowed = tokio::task::spawn_blocking(move || {
            let path = std::path::PathBuf::from(&workspace.path);
            let directory = maka_fs_tools::directory::open(&path, &workspace.directory_identity)
                .map_err(|_| Error::Denied)?;
            if maka_fs_tools::workspace::read_directory_identity(path.clone(), directory)
                .map_err(|_| Error::Denied)?
                != workspace.identity
            {
                return Err(Error::Denied);
            }
            let (_, policy) =
                maka_fs_tools::workspace::permissions::resolve(maka_sandbox::Mode::ReadOnly, &path)
                    .map_err(|_| Error::Denied)?;
            let metadata = match policy {
                Sandbox::Managed { network, .. } | Sandbox::External { network } => network,
                Sandbox::Disabled => Network::Allowed,
            };
            Ok::<_, Error>(ceiling.intersect(&metadata).allows(&destination_copy))
        })
        .await
        .map_err(|_| Error::Denied)??;
        if !allowed {
            return Err(Error::Denied);
        }
        let grants = maka_agent_authority::permissions::execution(
            &self.owner.log,
            &self.tool.invocation,
            self.tool.execution.as_deref(),
        )
        .map_err(|_| Error::Denied)?
        .permission_grants(
            &self.tool.invocation,
            Some(&self.tool.tool_use_id()),
            &configuration.permission_basis(),
        )
        .await
        .map_err(|error| Error::Failed(error.to_string()))?;
        Ok((
            configuration,
            grants
                .iter()
                .any(|grant| grant.permissions.network.allows(destination)),
        ))
    }
    async fn authorize(
        &self,
        call: &Scope,
        destination: &Destination,
        origin: String,
    ) -> Result<maka_network::Policy, Error> {
        let (configuration, granted) = self.current(call, destination).await?;
        if !granted {
            let cancellation = call.cancellation.child_token();
            let store = maka_agent_authority::permissions::execution(
                &self.owner.log,
                &self.tool.invocation,
                self.tool.execution.as_deref(),
            )
            .map_err(|_| Error::Denied)?;
            let request = maka_agent_authority::permissions::request(
                &store,
                &configuration,
                PermissionRequest {
                    reason: match self.purpose {
                        Purpose::Health => format!("Allow health check access to {origin}"),
                        Purpose::Retrieval { .. } => format!("Allow Web access to {origin}"),
                    },
                    command: None,
                    permissions: maka_sandbox::grant::Permissions {
                        filesystem: Vec::new(),
                        network: Network::destination(destination.clone()),
                    },
                },
                &self.tool,
                &cancellation,
            );
            tokio::pin!(request);
            let result = tokio::select! {
                result = &mut request => result,
                _ = self.owner.stopping.cancelled() => { cancellation.cancel(); request.await },
            };
            result.map_err(|error| match error {
                ToolError::CleanupUnconfirmed(_) => Error::CleanupUnconfirmed,
                _ => Error::Denied,
            })?;
        }
        self.check(call, destination).await?;
        let network = self
            .owner
            .configuration
            .network_configuration()
            .await
            .map_err(|e| Error::Failed(e.to_string()))?;
        maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
            .map_err(|e| Error::Failed(e.to_string()))
    }
}
impl Authority for Access {
    fn admit(&self, call: &Scope) -> Result<Box<dyn Send>, Error> {
        if self.owner.stopping.is_cancelled()
            || self.caller.cancellation.is_cancelled()
            || call.cancellation.is_cancelled()
            || call.identity != self.caller.identity
        {
            return Err(Error::Denied);
        }
        Ok(Box::new(()))
    }
    fn policy<'a>(
        &'a self,
        call: &'a Scope,
        destination: &'a Destination,
        origin: String,
    ) -> BoxFuture<'a, Result<maka_network::Policy, Error>> {
        let owner = self.clone();
        let call = call.clone();
        let destination = destination.clone();
        Box::pin(async move {
            // Permission publication/withdrawal outlives a dropped Fetch deadline.
            let mut ticket = call.resources.reserve().map_err(|_| Error::Denied)?;
            let mut owned = owner.owner.resources.reserve().map_err(|_| Error::Denied)?;
            tokio::spawn(async move {
                ticket.start();
                owned.start();
                let result = owner.authorize(&call, &destination, origin).await;
                let cleanup = if matches!(result, Err(Error::CleanupUnconfirmed)) {
                    owner.owner.stopping.cancel();
                    Err("Web permission cleanup unconfirmed".into())
                } else {
                    Ok(())
                };
                ticket.complete(cleanup.clone());
                owned.complete(cleanup);
                result
            })
            .await
            .map_err(|_| Error::CleanupUnconfirmed)?
        })
    }
    fn check<'a>(
        &'a self,
        call: &'a Scope,
        destination: &'a Destination,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            if self.current(call, destination).await?.1 {
                Ok(())
            } else {
                Err(Error::Denied)
            }
        })
    }
    fn record(
        &self,
        call: Scope,
        operation: maka_event_log::effects::Operation,
        destination: Destination,
        effect: BoxFuture<'static, Result<Value, ToolError>>,
    ) -> BoxFuture<'static, Result<Value, ToolError>> {
        let owner = self.clone();
        Box::pin(async move {
            owner
                .check(&call, &destination)
                .await
                .map_err(|e| ToolError::Failed(e.to_string()))?;
            let mut origin = owner.owner.origin.clone();
            if let maka_agent_facts::tool_call::ToolOrigin::HostSdk { parent, .. } = &mut origin {
                *parent = Some(maka_agent_facts::tool_call::HostSdkParent::NestedEffect {
                    operation_id: owner.tool.operation_id.clone(),
                });
            }
            let journal = ToolJournal::new(
                Arc::new(maka_agent_authority::permissions::execution(
                    &owner.owner.log,
                    &owner.tool.invocation,
                    owner.tool.execution.as_deref(),
                )?),
                owner.tool.invocation.clone(),
            );
            let effect_owner = owner.clone();
            let result = journal
                .invoke_prepared_call(
                    uuid::Uuid::new_v4().to_string(),
                    ToolCallIdentity {
                        tool_call_id: uuid::Uuid::new_v4().to_string(),
                        origin,
                    },
                    "Http".into(),
                    serde_json::to_value(operation)
                        .map_err(|e| ToolError::Failed(e.to_string()))?,
                    None,
                    call.cancellation.clone(),
                    PreparedEffect::new(move |_| {
                        Box::pin(async move {
                            effect_owner
                                .check(&call, &destination)
                                .await
                                .map_err(|e| ToolError::Failed(e.to_string()))?;
                            effect.await.map(Into::into)
                        })
                    }),
                )
                .await;
            if matches!(
                result,
                Err(ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_))
            ) {
                owner.owner.stopping.cancel();
            }
            result
        })
    }
    fn spawn(&self, worker: Worker) -> Result<(), Error> {
        spawn(&self.owner, worker)
    }
}
fn spawn(owner: &Web, worker: Worker) -> Result<(), Error> {
    if owner.stopping.is_cancelled() {
        return Err(Error::Denied);
    }
    let mut ticket = owner.resources.reserve().map_err(|_| Error::Denied)?;
    let stopping = owner.stopping.clone();
    tokio::spawn(async move {
        ticket.start();
        let result = AssertUnwindSafe(worker(stopping.child_token()))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Err("Web HTTP worker panicked".into()));
        if result.is_err() {
            stopping.cancel();
        }
        ticket.complete(result);
    });
    Ok(())
}

/// Explicit credential checks belong to their admitted application operation.
/// They have no Agent invocation and cannot borrow a session's tool grants.
#[derive(Clone)]
pub(super) struct CredentialCheck {
    pub owner: Arc<Web>,
    pub caller: Scope,
    pub revision: u64,
}
impl Authority for CredentialCheck {
    fn admit(&self, call: &Scope) -> Result<Box<dyn Send>, Error> {
        if self.owner.stopping.is_cancelled()
            || self.caller.cancellation.is_cancelled()
            || call.cancellation.is_cancelled()
            || call.identity != self.caller.identity
        {
            return Err(Error::Denied);
        }
        Ok(Box::new(()))
    }
    fn policy<'a>(
        &'a self,
        call: &'a Scope,
        destination: &'a Destination,
        _origin: String,
    ) -> BoxFuture<'a, Result<maka_network::Policy, Error>> {
        Box::pin(async move {
            self.check(call, destination).await?;
            let network = self
                .owner
                .configuration
                .network_configuration()
                .await
                .map_err(|e| Error::Failed(e.to_string()))?;
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|e| Error::Failed(e.to_string()))
        })
    }
    fn check<'a>(
        &'a self,
        call: &'a Scope,
        destination: &'a Destination,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let _lease = self.admit(call)?;
            if destination.host() != "api.tavily.com"
                || destination.port() != 443
                || !self.owner.network.allows(destination)
            {
                return Err(Error::Denied);
            }
            let snapshot = self
                .owner
                .repository
                .snapshot()
                .await
                .map_err(|e| Error::Failed(e.to_string()))?;
            let policy = self
                .owner
                .configuration
                .runtime_policy()
                .await
                .map_err(|e| Error::Failed(e.to_string()))?;
            if snapshot.credential.revision != Some(self.revision)
                || !snapshot.credential.configured
                || policy.policy.privacy.incognito_active
            {
                return Err(Error::Denied);
            }
            Ok(())
        })
    }
    fn record(
        &self,
        call: Scope,
        _operation: maka_event_log::effects::Operation,
        destination: Destination,
        effect: BoxFuture<'static, Result<Value, ToolError>>,
    ) -> BoxFuture<'static, Result<Value, ToolError>> {
        let authority = self.clone();
        Box::pin(async move {
            authority
                .check(&call, &destination)
                .await
                .map_err(|e| ToolError::Failed(e.to_string()))?;
            // The actual checkKey operation was durably recorded before dispatch.
            // The shared worker owns socket settlement, even after observer loss.
            effect.await
        })
    }
    fn spawn(&self, worker: Worker) -> Result<(), Error> {
        spawn(&self.owner, worker)
    }
}
