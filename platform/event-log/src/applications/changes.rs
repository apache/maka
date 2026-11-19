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

//! Deployment-head observations from the same owned store; no grants or package copies.
use super::{EventLog, StoreError, invalid};
use maka_plugin_core::deployment::DeploymentRef;
use rusqlite::{OptionalExtension, params};
use std::sync::{Arc, Weak};

/// A coalescing cursor, not composition authority. The committed SQL head is
/// re-read after every wake, including the first pull and a concurrent commit.
pub struct DeploymentChanges {
    store: Weak<EventLog>,
    stop: Option<tokio_util::sync::CancellationToken>,
    observed: DeploymentRef,
    observed_idle: bool,
    wakes: tokio::sync::watch::Receiver<()>,
}
impl EventLog {
    pub fn subscribe_application(
        self: &Arc<Self>,
        observed: DeploymentRef,
    ) -> Result<DeploymentChanges, StoreError> {
        observed.validate().map_err(invalid)?;
        if observed.state_domain != self.application_domain()? {
            return Err(invalid("foreign application state domain"));
        }
        Ok(DeploymentChanges {
            store: Arc::downgrade(self),
            stop: None,
            observed,
            observed_idle: false,
            wakes: self.subscribe_commits(),
        })
    }
    /// Head identity only. Exact bytes are loaded separately at that immutable
    /// revision, so unrelated business commits never copy application packages.
    pub async fn application_head(
        &self,
        deployment: uuid::Uuid,
    ) -> Result<Option<DeploymentRef>, StoreError> {
        let state_domain = self.application_domain()?;
        if deployment.is_nil() {
            return Err(invalid("invalid deployment"));
        }
        self.connection
            .read(move |connection| {
                let revision = connection
                    .query_row(
                        "SELECT revision FROM application_deployments WHERE id = ?",
                        params![deployment.to_string()],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?;
                let Some(revision) = revision else {
                    return Ok(None);
                };
                let revision = u64::try_from(revision)
                    .map_err(|_| invalid("invalid stored application revision"))?;
                let source = DeploymentRef {
                    state_domain,
                    deployment,
                    revision,
                };
                source.validate().map_err(invalid)?;
                Ok(Some(source))
            })
            .await
    }
}
impl DeploymentChanges {
    pub(crate) fn with_shutdown(mut self, stop: tokio_util::sync::CancellationToken) -> Self {
        self.stop = Some(stop);
        self
    }

    pub async fn next(&mut self) -> Result<DeploymentRef, StoreError> {
        loop {
            if self.stop.as_ref().is_some_and(|stop| stop.is_cancelled()) {
                return Err(StoreError::ConnectionClosed);
            }
            let store = self.store.upgrade().ok_or(StoreError::ConnectionClosed)?;
            let closed = store.connection.close_receipt();
            if !self.observed_idle {
                // A commit during this read remains observable on the next wake.
                self.wakes.borrow_and_update();
                let source = store
                    .application_head(self.observed.deployment)
                    .await?
                    .ok_or_else(|| invalid("watched deployment not found"))?;
                if source.revision < self.observed.revision {
                    return Err(invalid("watched revision exceeds committed head"));
                }
                if source.revision > self.observed.revision {
                    self.observed = source.clone();
                    return Ok(source);
                }
                self.observed_idle = true;
            }
            drop(store);
            let stopping = async {
                match &self.stop {
                    Some(stop) => stop.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                biased;
                () = stopping => return Err(StoreError::ConnectionClosed),
                result = closed => {
                    return Err(match result {
                        Ok(()) => StoreError::ConnectionClosed,
                        Err(error) => StoreError::CloseFailed(error),
                    });
                }
                wake = self.wakes.changed() => {
                    wake.map_err(|_| invalid("application commit source closed"))?;
                    self.observed_idle = false;
                }
            }
        }
    }
}
