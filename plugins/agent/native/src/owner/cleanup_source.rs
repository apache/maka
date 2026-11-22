/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Bind original cleanup coordinates to this Root's actual factory and claim.
use super::Owner;
use futures_util::future::BoxFuture;
use maka_agent_engine::{
    RunError,
    ports::{ExternalCleanupPorts, ExternalCleanupSource},
};
use maka_agent_facts::durable::UnixMillis;
use maka_agent_state::{CleanupFrontier, DriverClaim};
use std::sync::Arc;

struct CleanupPorts {
    owner: Arc<Owner>,
    claim: DriverClaim,
}

impl Owner {
    pub(super) fn cleanup_ports(
        self: &Arc<Self>,
        claim: DriverClaim,
    ) -> Arc<dyn ExternalCleanupPorts> {
        Arc::new(CleanupPorts {
            owner: self.clone(),
            claim,
        })
    }
}

fn same_original(left: &CleanupFrontier, right: &CleanupFrontier) -> bool {
    left.run == right.run
        && left.owner == right.owner
        && left.session_id == right.session_id
        && left.turn_id == right.turn_id
        && left.task == right.task
        && left.backend == right.backend
        && left.descriptor == right.descriptor
        && left.binding == right.binding
}

impl ExternalCleanupPorts for CleanupPorts {
    fn now(&self) -> UnixMillis {
        UnixMillis(super::now().try_into().expect("Unix milliseconds"))
    }
    fn open(
        &self,
        original: CleanupFrontier,
    ) -> BoxFuture<'_, Result<Box<dyn ExternalCleanupSource>, RunError>> {
        Box::pin(async move {
            // This read validates same Domain/Root, the live ticket and its exact purpose.
            let current = self.owner.durable.cleanup_frontier(&self.claim).await?;
            if current.owner != self.owner.run_owner() || !same_original(&original, &current) {
                return Err(RunError::InvalidInput(
                    "cleanup source differs from its original Root claim".into(),
                ));
            }
            if self.claim.retirement().is_cancelled() {
                return Err(RunError::Cancelled);
            }
            let backend = self
                .owner
                .durable
                .content(current.run, current.backend.clone())
                .await?;
            let prepared = self
                .owner
                .durable
                .content(current.run, current.descriptor.clone())
                .await?;
            let bound = match &current.binding {
                Some(reference) => Some(
                    self.owner
                        .durable
                        .content(current.run, reference.clone())
                        .await?,
                ),
                None => None,
            };
            let checked = self.owner.durable.cleanup_frontier(&self.claim).await?;
            if !same_original(&current, &checked) {
                return Err(RunError::InvalidInput(
                    "original cleanup source changed while reading its contents".into(),
                ));
            }
            let source = crate::executor::cleanup::open(
                &self.owner.services,
                &current.owner,
                &self.owner.data_source.state_domain,
                &self.owner.revision.package_id,
                &checked,
                &backend,
                &prepared,
                bound.as_deref(),
                self.claim.retirement(),
            )
            .await?;
            Ok(Box::new(ClaimedSource {
                owner: self.owner.clone(),
                claim: self.claim.clone(),
                source,
            }) as Box<dyn ExternalCleanupSource>)
        })
    }
}

struct ClaimedSource {
    owner: Arc<Owner>,
    claim: DriverClaim,
    source: Box<dyn ExternalCleanupSource>,
}
impl ExternalCleanupSource for ClaimedSource {
    fn next(
        &mut self,
    ) -> BoxFuture<'_, Result<maka_plugin_core::operation::OperationCleanup, RunError>> {
        Box::pin(async move {
            self.owner.durable.cleanup_frontier(&self.claim).await?;
            let retirement = self.claim.retirement();
            tokio::select! {
                biased;
                () = retirement.cancelled() => Err(RunError::Cancelled),
                result = self.source.next() => result,
            }
        })
    }
    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let Self {
                owner,
                claim,
                source,
            } = *self;
            source.close().await;
            // Even a retired claim stays physically owned until the observer's real fence.
            drop(claim);
            drop(owner);
        })
    }
}
