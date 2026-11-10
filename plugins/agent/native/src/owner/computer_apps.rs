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

use super::{Owner, now};
use crate::contract::{ComputerAppActivityState, ComputerApps, StopComputerApp, Stopped};
use maka_capabilities::call::{Identity, Scope};

use maka_agent_facts::durable::UnixMillis;
use maka_event_log::root_store::DataChange;
use maka_plugin_core::operation::RecoveryRef;

impl Owner {
    pub async fn computer_apps(&self, session: &str) -> Result<ComputerApps, String> {
        self.session(session).await?;
        let activities = self
            .durable
            .computer()
            .activities(session, &self.run_owner())
            .await
            .map_err(|e| e.to_string())?;
        Ok(ComputerApps {
            entries: activities
                .into_iter()
                .map(|v| ComputerAppActivityState {
                    activity: v.subject.activity,
                    stopped: v.stopped,
                })
                .collect(),
        })
    }
    pub async fn prepare_stop_computer_app(
        &self,
        input: StopComputerApp,
        scope: &Scope,
        operation: &RecoveryRef,
    ) -> Result<(Stopped, Option<DataChange>), String> {
        if !matches!(&scope.identity, Identity::Remote { .. }) {
            return Err("agent_computer_app_stop_requires_user_control".into());
        }
        if self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        self.session(&input.session_id).await?;
        let Some(source) = self
            .durable
            .computer()
            .subject(&input.session_id, &input.operation_id)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok((Stopped { requested: false }, None));
        };
        if self
            .session_run(&input.session_id, source.activity.execution.run_id)
            .await?
            .is_none()
        {
            return Ok((Stopped { requested: false }, None));
        }
        let change = self.durable.computer().prepare_stop(
            &input.session_id,
            &input.operation_id,
            self.control_id(operation, "stop_computer_app"),
            UnixMillis(now().try_into().expect("Unix milliseconds")),
        );
        Ok((Stopped { requested: true }, Some(change)))
    }
}
