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

//! Process residency observes physical connections; only Application decides work is idle.
use super::{Host, LifecycleMode, Result};
use maka_plugin_core::runtime::Phase;
use std::{sync::Arc, time::Duration};
use tokio::time::Instant;

pub(super) struct Residency {
    pub connections: usize,
    pub paused: bool,
    pub admitted: bool,
    pub last_activity: Instant,
}
impl Default for Residency {
    fn default() -> Self {
        Self {
            connections: 0,
            paused: false,
            admitted: false,
            last_activity: Instant::now(),
        }
    }
}
/// Physical channels are counted under the expiry decision's lock. Even a
/// complete probe between two observations restarts its idle grace.
pub(super) struct Connection {
    pub host: Arc<Host>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        let mut residency = self.host.residency.lock().unwrap();
        residency.last_activity = Instant::now();
        residency.connections -= 1;
    }
}
impl Host {
    pub async fn retire(
        &self,
        interrupt: bool,
        allow_idle_connections: bool,
        refuse_active_sessions: bool,
    ) -> Result<bool> {
        if !interrupt {
            let mut updates = self.application.client().updates;
            loop {
                let pending = {
                    let snapshot = updates.borrow_and_update();
                    snapshot.startup_error.is_some()
                        && !snapshot.initialization_failures.is_empty()
                        && !snapshot.closing
                        && snapshot.cleanup_error.is_none()
                        && snapshot
                            .instances
                            .iter()
                            .all(|instance| instance.calls == 0)
                        && (snapshot.starting
                            || snapshot.instances.iter().any(|instance| {
                                instance.phase == Phase::Retiring
                                    && snapshot
                                        .initialization_failures
                                        .contains(instance.activation.instance())
                            }))
                };
                if !pending {
                    break;
                }
                // Failed readiness can precede its original cleanup. Keep admission
                // open while that owner settles, then recheck every atomic idle guard.
                tokio::select! {
                    result = updates.changed() => if result.is_err() { break; },
                    () = self.stop.cancelled() => break,
                }
            }
        }
        let _gate = self.access_gate.lock().await;
        if (refuse_active_sessions || (!interrupt && !allow_idle_connections))
            && !self.sessions.lock().unwrap().is_empty()
        {
            return Ok(false);
        }
        if interrupt {
            self.residency.lock().unwrap().paused = true;
            self.stop.cancel();
            return Ok(true);
        }
        // Never cancel accepted execution just to manufacture an idle result.
        let result = self.application.shutdown_if_idle().await;
        if matches!(result, Ok(true)) || self.application.client().snapshot().closing {
            self.stop.cancel();
        }
        result
    }
    pub async fn abandon_unaccepted_startup(&self) {
        if self.options.lifecycle_mode != LifecycleMode::Ephemeral {
            return;
        }
        let _gate = self.access_gate.lock().await;
        let mut residency = self.residency.lock().unwrap();
        if !residency.admitted {
            residency.paused = true;
            self.stop.cancel();
        }
    }
    /// Success has already atomically fenced native producers and completed
    /// Application cleanup. Connections or request counts alone never authorize exit.
    pub async fn wait_until_idle(
        &self,
        initial_timeout: Duration,
        idle_grace: Duration,
    ) -> Result<()> {
        let initial = Instant::now() + initial_timeout;
        loop {
            tokio::select! {
                () = self.stop.cancelled() => return Ok(()),
                () = tokio::time::sleep(Duration::from_millis(100)) => {},
            }
            let _gate = self.access_gate.lock().await;
            {
                let mut residency = self.residency.lock().unwrap();
                if residency.connections != 0
                    || Instant::now().duration_since(residency.last_activity) < idle_grace
                    || (!residency.admitted && Instant::now() < initial)
                {
                    continue;
                }
                // Close listener admission while the real owner tries its idle fence.
                residency.paused = true;
            }
            match self.application.shutdown_if_idle().await {
                Ok(true) => {
                    self.stop.cancel();
                    return Ok(());
                }
                Ok(false) => {
                    let mut residency = self.residency.lock().unwrap();
                    residency.paused = false;
                    residency.last_activity = Instant::now();
                }
                Err(error) => {
                    self.stop.cancel();
                    return Err(error);
                }
            }
        }
    }
}
