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
use maka_agent_authority::computer::NativeCallContext;
use maka_agent_facts::interaction::PermissionRequest;
use maka_agent_facts::tools::ToolError;
use maka_capabilities::call::Scope;
use maka_capabilities::http::Error;
use maka_host_runtime::http::{Authority, Worker};
use maka_sandbox::{Destination, Network, Sandbox};
use std::panic::AssertUnwindSafe;

#[derive(Clone, Default)]
pub(super) struct Failure(Arc<std::sync::Mutex<Option<ToolError>>>);
impl Failure {
    pub(super) fn observe(&self, error: &ToolError) {
        if matches!(
            error,
            ToolError::OutcomeUnknown(_)
                | ToolError::CleanupUnconfirmed(_)
                | ToolError::Persistence(_)
        ) {
            self.0
                .lock()
                .expect("Web call failure")
                .get_or_insert_with(|| error.clone());
        }
    }
    pub(super) fn is_uncertain(&self) -> bool {
        self.0.lock().expect("Web call failure").is_some()
    }
    pub(super) fn returned(&self, diagnostic: String) -> HandlerError {
        match self.0.lock().expect("Web call failure").as_ref() {
            Some(error) => HandlerError::Unknown {
                diagnostic: format!("{diagnostic}; {error}"),
            },
            None => HandlerError::Returned { diagnostic },
        }
    }
}

pub(super) async fn native_call(
    owner: &Web,
    context: &Context,
    failure: &Failure,
) -> Result<Option<Arc<NativeCallContext>>, String> {
    let Some(execution) = context.scope().identity.agent() else {
        return Ok(None);
    };
    let native = context
        .native_context::<NativeCallContext>()
        .ok_or("web_requires_native_call")?;
    let access = native.access();
    let call = access.call();
    let custody = context.work_custody().ok_or("web_work_custody_missing")?;
    if execution != &call.execution
        || context.scope().identity.operation_id() != Some(call.operation_id.as_str())
        || call
            .custody
            .as_ref()
            .is_none_or(|original| !Arc::ptr_eq(original, custody))
    {
        return Err("web_native_call_mismatch".into());
    }
    owner
        .log
        .session_for_work(custody.as_ref(), &call.execution.session_id)
        .map_err(message)?;
    if context.operation().is_some() {
        access.bind_original(context).await.map_err(|error| {
            failure.observe(&error);
            message(error)
        })?;
    }
    access.current().await.map_err(|error| {
        failure.observe(&error);
        message(error)
    })?;
    Ok(Some(native))
}

#[derive(Clone)]
pub(super) enum Purpose {
    Fetch { basis: Basis },
    Search { basis: Basis, key: Option<String> },
    Health,
}
#[derive(Clone)]
pub(super) struct Access {
    owner: Arc<Web>,
    native: Arc<NativeCallContext>,
    caller: Scope,
    purpose: Purpose,
    failure: Failure,
}
impl Access {
    pub fn new(
        owner: Arc<Web>,
        scope: &Scope,
        native: Arc<NativeCallContext>,
        purpose: Purpose,
        failure: Failure,
    ) -> Result<Self, String> {
        Ok(Self {
            owner,
            native,
            caller: scope.clone(),
            purpose,
            failure,
        })
    }
    pub fn health(
        owner: Arc<Web>,
        scope: &Scope,
        native: Arc<NativeCallContext>,
        failure: Failure,
    ) -> Result<Self, String> {
        Self::new(owner, scope, native, Purpose::Health, failure)
    }
    async fn current(
        &self,
        call: &Scope,
        destination: &Destination,
    ) -> Result<(maka_agent_api::session::ResolvedConfiguration, bool), Error> {
        let _lease = self.admit(call)?;
        let available = match &self.purpose {
            Purpose::Fetch { basis } => self.owner.fetch_is_current(basis).await,
            Purpose::Search { basis, key } => self
                .owner
                .repository
                .search_is_current(basis, key.as_deref())
                .await
                .map_err(message),
            Purpose::Health => Ok(true),
        }
        .map_err(Error::Failed)?;
        if !available {
            return Err(Error::Denied);
        }
        let configuration = self.native.access().current().await.map_err(|error| {
            self.failure.observe(&error);
            Error::Denied
        })?;
        let workspace = configuration.workspace.clone();
        let ceiling = self.owner.network.clone();
        let floor = self
            .caller
            .sandbox_floor()
            .intersect(call.sandbox_floor())
            .map_err(|_| Error::Denied)?;
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
            let metadata = match policy.intersect(&floor).map_err(|_| Error::Denied)? {
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
        let grants = self
            .native
            .access()
            .permission_grants(
                self.native.access().target(),
                &configuration.permission_basis(),
            )
            .await
            .map_err(|error| {
                self.failure.observe(&error);
                Error::Failed(error.to_string())
            })?;
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
        let (_, granted) = self.current(call, destination).await?;
        if !granted {
            let cancellation = call.cancellation.child_token();
            let request = maka_agent_authority::permissions::request(
                self.native.access(),
                PermissionRequest {
                    reason: match self.purpose {
                        Purpose::Health => format!("Allow health check access to {origin}"),
                        Purpose::Fetch { .. } | Purpose::Search { .. } => {
                            format!("Allow Web access to {origin}")
                        }
                    },
                    command: None,
                    permissions: maka_sandbox::grant::Permissions {
                        filesystem: Vec::new(),
                        network: Network::destination(destination.clone()),
                    },
                },
                self.native.access().target(),
                &cancellation,
            );
            tokio::pin!(request);
            let result = tokio::select! {
                result = &mut request => result,
                _ = self.owner.stopping.cancelled() => { cancellation.cancel(); request.await },
            };
            result.map_err(|error| {
                self.failure.observe(&error);
                match error {
                    ToolError::CleanupUnconfirmed(_) => Error::CleanupUnconfirmed,
                    _ => Error::Denied,
                }
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
            || match (call.work_custody(), self.caller.work_custody()) {
                (Some(actual), Some(original)) => !Arc::ptr_eq(actual, original),
                (None, None) => false,
                _ => true,
            }
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
                    owner.failure.observe(&ToolError::CleanupUnconfirmed(
                        "Web permission cleanup unconfirmed".into(),
                    ));
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
        _operation: maka_event_log::effects::Operation,
        destination: Destination,
        effect: BoxFuture<'static, Result<Value, ToolError>>,
    ) -> BoxFuture<'static, Result<Value, ToolError>> {
        let owner = self.clone();
        Box::pin(async move {
            owner
                .check(&call, &destination)
                .await
                .map_err(|e| ToolError::Failed(e.to_string()))?;
            let result = effect.await;
            if let Err(error) = &result {
                owner.failure.observe(error);
            }
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
/// They cannot borrow a Session's Agent tool grants.
#[derive(Clone)]
pub(super) struct CredentialCheck {
    pub owner: Arc<Web>,
    pub caller: Scope,
    pub basis: Basis,
    pub key: Option<String>,
    pub destination: Destination,
    pub failure: Failure,
}
impl Authority for CredentialCheck {
    fn admit(&self, call: &Scope) -> Result<Box<dyn Send>, Error> {
        if self.owner.stopping.is_cancelled()
            || self.caller.cancellation.is_cancelled()
            || call.cancellation.is_cancelled()
            || call.identity != self.caller.identity
            || match (call.work_custody(), self.caller.work_custody()) {
                (Some(actual), Some(original)) => !Arc::ptr_eq(actual, original),
                (None, None) => false,
                _ => true,
            }
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
            if *destination != self.destination
                || !self.owner.network.allows(destination)
                || !floor_network(call.sandbox_floor()).allows(destination)
                || !floor_network(self.caller.sandbox_floor()).allows(destination)
            {
                return Err(Error::Denied);
            }
            if !self
                .owner
                .repository
                .search_is_current(&self.basis, self.key.as_deref())
                .await
                .map_err(|error| Error::Failed(error.to_string()))?
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
            let result = effect.await;
            if let Err(error) = &result {
                authority.failure.observe(error);
            }
            result
        })
    }
    fn spawn(&self, worker: Worker) -> Result<(), Error> {
        spawn(&self.owner, worker)
    }
}

fn floor_network(floor: &Sandbox) -> Network {
    match floor {
        Sandbox::Disabled => Network::Allowed,
        Sandbox::Managed { network, .. } | Sandbox::External { network } => network.clone(),
    }
}
