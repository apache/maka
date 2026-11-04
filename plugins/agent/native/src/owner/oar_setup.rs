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
use maka_agent_api::oar::{Action, Setup, SetupResult};
use maka_host_runtime::application::Context;

impl Owner {
    pub(crate) async fn oar_setup(
        &self,
        input: Setup,
        context: Context,
    ) -> Result<SetupResult, String> {
        if !matches!(
            context.scope().identity,
            maka_capabilities::call::Identity::Remote { .. }
        ) {
            return Err("oar_setup_requires_application_request".into());
        }
        context.operation().ok_or("oar_setup_requires_mutation")?;
        if input.runtime.trim().is_empty() || input.runtime.chars().any(char::is_control) {
            return Err("oar_runtime_invalid".into());
        }
        if !self.executors.contains("oar") {
            return Err("agent_oar_disabled".into());
        }
        let cwd = self.oar_cwd().await?;
        let (action, line) = match input.action {
            Action::Probe => ("probe", None),
            Action::Plan { line } => ("plan", line),
            Action::Install { line } => ("install", line),
        };
        let request = serde_json::json!({"kind":"setup","runtime":input.runtime,"action":action,"options":line.map(|line|serde_json::json!({"line":line})).unwrap_or_else(||serde_json::json!({})),"cwd":cwd});
        let mut ticket = context
            .scope()
            .resources
            .reserve()
            .map_err(|error| error.to_string())?;
        ticket.start();
        let result = self
            .executors
            .oar_query(cwd, request, context.scope().cancellation.clone())
            .await;
        ticket.complete(
            if matches!(
                &result,
                Err(maka_agent_ports::executor::Error::CleanupUnconfirmed)
            ) {
                Err("OAR setup cleanup is unconfirmed".into())
            } else {
                Ok(())
            },
        );
        Ok(SetupResult {
            runtime: input.runtime,
            result: result
                .map_err(|error| error.to_string())?
                .ok_or("agent_oar_disabled")?,
        })
    }
}
