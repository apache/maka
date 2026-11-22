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
use maka_agent_facts::tools::ToolError;
use maka_capabilities::call::Scope;
use maka_capabilities::http::Error;
use maka_host_runtime::http::{Authority, Worker};
use maka_sandbox::Destination;
use std::panic::AssertUnwindSafe;

/// The installed Decisions API capability authorizes only its configured endpoint.
/// No caller-supplied URL or redirect can widen that authority.
#[derive(Clone)]
pub(super) struct Access {
    owner: Arc<DecisionsApi>,
    caller: Scope,
    destination: Destination,
    revision: Option<u64>,
    credential_revision: Option<u64>,
}
impl Access {
    pub fn new(
        owner: Arc<DecisionsApi>,
        caller: Scope,
        snapshot: &Snapshot,
    ) -> Result<Self, String> {
        let url = url::Url::parse(&snapshot.settings.url).map_err(message)?;
        let destination = Destination::new(
            url.host_str().ok_or("decisions_api_invalid_host")?,
            url.port_or_known_default()
                .ok_or("decisions_api_invalid_port")?,
        )
        .map_err(message)?;
        Ok(Self {
            owner,
            caller,
            destination,
            revision: snapshot.revision,
            credential_revision: snapshot.credential_revision,
        })
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
        _origin: String,
    ) -> BoxFuture<'a, Result<maka_network::Policy, Error>> {
        Box::pin(async move {
            self.check(call, destination).await?;
            let network = self
                .owner
                .configuration
                .network_configuration()
                .await
                .map_err(|e| Error::Failed(message(e)))?;
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|e| Error::Failed(message(e)))
        })
    }
    fn check<'a>(
        &'a self,
        call: &'a Scope,
        destination: &'a Destination,
    ) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(async move {
            let _lease = self.admit(call)?;
            if destination != &self.destination || !self.owner.network.allows(destination) {
                return Err(Error::Denied);
            }
            let snapshot = self
                .owner
                .repository
                .snapshot()
                .await
                .map_err(|e| Error::Failed(message(e)))?;
            if snapshot.revision != self.revision
                || snapshot.credential_revision != self.credential_revision
                || !snapshot.settings.enabled
                || !snapshot.configured
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
                .map_err(|e| ToolError::Failed(message(e)))?;
            // The admitted evaluate mutation already owns its durable operation.
            effect.await
        })
    }
    fn spawn(&self, worker: Worker) -> Result<(), Error> {
        if self.owner.stopping.is_cancelled() {
            return Err(Error::Denied);
        }
        let mut ticket = self.owner.resources.reserve().map_err(|_| Error::Denied)?;
        let stopping = self.owner.stopping.clone();
        tokio::spawn(async move {
            ticket.start();
            let result = AssertUnwindSafe(worker(stopping.child_token()))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err("Decisions API HTTP worker panicked".into()));
            if result.is_err() {
                stopping.cancel();
            }
            ticket.complete(result);
        });
        Ok(())
    }
}
