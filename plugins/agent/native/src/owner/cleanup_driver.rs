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
use maka_agent_engine::Engine;
use maka_agent_facts::durable::{ExternalTaskId, RunId};
use maka_agent_state::{DriverClaim, DriverPurpose};

pub(super) struct DriverActivity(pub DriverClaim);
impl Drop for DriverActivity {
    fn drop(&mut self) {
        self.0.deactivate();
    }
}

impl Owner {
    pub(super) async fn wake_cleanup(
        self: &Arc<Self>,
        run: RunId,
        session: String,
        task: ExternalTaskId,
    ) -> Result<(), String> {
        {
            let runs = self.runs.state().await;
            if runs.closing {
                return Ok(());
            }
        }
        let cancellation = self.stop.child_token();
        let Some(claim) = self
            .durable
            .reserve_driver(
                run,
                DriverPurpose::LateExternalCleanup { task },
                cancellation.clone(),
            )
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(());
        };
        let current = self
            .durable
            .cleanup_frontier(&claim)
            .await
            .map_err(|error| error.to_string())?;
        if current.owner != self.run_owner() || current.session_id != session {
            claim.deactivate();
            return Err("foreign cleanup owner".into());
        }
        let runs = self.runs.state().await;
        if runs.closing {
            claim.deactivate();
            return Ok(());
        }
        let owner = self.clone();
        self.cleanup_workers.spawn(async move {
            let activity = DriverActivity(claim.clone());
            let ports = owner.cleanup_ports(claim.clone());
            let result = Engine::new(owner.durable.clone())
                .drive_cleanup(claim, ports, cancellation)
                .await;
            let changed = matches!(
                &result,
                Ok(maka_agent_engine::DriverExit::Retired { .. })
                    | Ok(maka_agent_engine::DriverExit::Waiting { due_at: None, .. })
            );
            if let Err(error) = result {
                tracing::error!(%run, %error, "Original task cleanup observer stopped");
            }
            drop(activity);
            if changed {
                owner.physical_availability_changed();
            }
        });
        drop(runs);
        Ok(())
    }
}
