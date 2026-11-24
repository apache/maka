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

//! Planned handoff uses the Host's real transport, plugin, process and SQL drain.
use super::Host;
use maka_event_log::{
    StoreError,
    checkpoints::execution::{Environment, Grant},
};
use std::{sync::Arc, time::Duration};

impl Host {
    pub(super) fn watch_execution(self: &Arc<Self>) {
        let Some(execution) = self.store.checkpoint_execution().cloned() else {
            return;
        };
        let host = Arc::downgrade(self);
        let stopped = self.stop.clone();
        tokio::spawn(async move {
            loop {
                if host.strong_count() == 0 {
                    return;
                }
                if execution.check().await.is_err() {
                    // This is cleanup, not permission to issue a successor. The
                    // supervisor still needs stop_execution's durable acknowledgement.
                    if let Some(host) = host.upgrade()
                        && let Err(error) = host.shutdown().await
                    {
                        tracing::error!(%error, "Session execution cleanup remains unconfirmed");
                    }
                    return;
                }
                tokio::select! {
                    _ = stopped.cancelled() => return,
                    _ = execution.cancellation().cancelled_owned() => {},
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {},
                }
            }
        });
    }

    /// Trusted embedding requests a planned stop. The original generation stays
    /// non-transferable if any transport, provider or physical cleanup fails.
    pub async fn stop_execution(&self) -> Result<(), String> {
        let execution = self
            .store
            .checkpoint_execution()
            .ok_or("Host has no control-plane execution grant")?;
        execution
            .stop(self)
            .await
            .map_err(|error| error.to_string())
    }
}
impl Environment for Host {
    fn stop_and_drain(
        &self,
        grant: &Grant,
    ) -> maka_event_log::connection::BoxFuture<'_, Result<(), StoreError>> {
        let matches = self
            .store
            .checkpoint_execution()
            .is_some_and(|e| e.grant() == grant);
        Box::pin(async move {
            if !matches {
                return Err(StoreError::InvalidTransition(
                    "Host execution grant differs".into(),
                ));
            }
            self.shutdown()
                .await
                .map_err(StoreError::CleanupUnconfirmed)
        })
    }
}
