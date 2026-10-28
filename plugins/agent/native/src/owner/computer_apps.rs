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

impl Owner {
    pub async fn computer_apps(&self, session: &str) -> Result<ComputerApps, String> {
        self.session(session).await?;
        let entries = self
            .store
            .session(session)
            .await
            .map_err(|error| error.to_string())?
            .computer_apps(session)
            .await
            .map_err(|_| "agent_computer_apps_unavailable")?;
        Ok(ComputerApps {
            entries: entries
                .into_iter()
                .map(|(activity, stopped)| ComputerAppActivityState { activity, stopped })
                .collect(),
        })
    }

    pub async fn stop_computer_app(
        &self,
        input: StopComputerApp,
        scope: &Scope,
    ) -> Result<Stopped, String> {
        // Host dispatch owns this nonforgeable scope. A model/SDK Agent or a
        // background grant cannot turn JSON app identity into user authority.
        if !matches!(&scope.identity, Identity::Remote { .. }) {
            return Err("agent_computer_app_stop_requires_user_control".into());
        }
        let runs = self.runs.lock().await;
        if runs.closing {
            return Err("agent_closed".into());
        }
        self.session(&input.session_id).await?;
        let requested = self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .stop_computer_app_operation(&input.operation_id, now())
            .await
            .map_err(|_| "agent_computer_app_stop_unavailable")?;
        Ok(Stopped { requested })
    }
}
