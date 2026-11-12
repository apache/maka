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
use maka_agent_api::{executor::NativeRuntime, external::ExternalUsageLimits};

impl Owner {
    async fn inspect_external(
        &self,
        cwd: String,
        request: serde_json::Value,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<Option<serde_json::Value>, String> {
        let mut ticket = scope
            .resources
            .reserve()
            .map_err(|error| error.to_string())?;
        ticket.start();
        let result = self
            .executors
            .external_query(cwd, request, scope.cancellation.clone())
            .await;
        ticket.complete(
            if matches!(
                result,
                Err(maka_agent_ports::executor::Error::CleanupUnconfirmed)
            ) {
                Err("Native CLI query cleanup is unconfirmed".into())
            } else {
                Ok(())
            },
        );
        result.map_err(|error| error.to_string())
    }

    pub(crate) async fn external_usage_limits(
        &self,
        runtime: NativeRuntime,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<serde_json::Value, String> {
        let encode = |result| serde_json::to_value(result).map_err(|error| error.to_string());
        if !runtime.reports_usage_limits()
            || !self
                .settings
                .external
                .as_ref()
                .is_some_and(|config| config.runtimes.enabled(runtime))
        {
            return encode(ExternalUsageLimits::Unsupported);
        }
        let cwd = self.external_cwd().await?.or_else(|| {
            self.home
                .as_deref()
                .and_then(std::path::Path::to_str)
                .map(str::to_owned)
        });
        let Some(cwd) = cwd else {
            return encode(ExternalUsageLimits::Unavailable);
        };
        match self
            .inspect_external(
                cwd,
                serde_json::json!({"kind":"usage_limits", "runtime":runtime}),
                scope,
            )
            .await
        {
            Ok(Some(value)) => Ok(value),
            Ok(None) => encode(ExternalUsageLimits::Unsupported),
            Err(error) => {
                tracing::debug!(%error, runtime = runtime.as_str(), "Native usage query failed");
                encode(ExternalUsageLimits::Unavailable)
            }
        }
    }

    pub(crate) async fn external_agents(
        &self,
        inspect: bool,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<maka_agent_api::external::ExternalAgents, String> {
        use maka_agent_api::external::{ConfigurationTarget, ExternalAgents, ExternalAgentsState};
        let target = ConfigurationTarget {
            source: self.data_source.clone(),
            path: vec!["external".into()],
        };
        let state = if !self.executors.contains("external") {
            ExternalAgentsState::Disabled
        } else if inspect {
            ExternalAgentsState::Enabled
        } else {
            match self.external_cwd().await {
                Ok(None) => ExternalAgentsState::WorkspaceRequired,
                Err(message) => ExternalAgentsState::Unavailable { message },
                Ok(Some(cwd)) => {
                    let result = self
                        .inspect_external(cwd, serde_json::json!({"kind":"status"}), scope)
                        .await;
                    match result {
                        Ok(Some(value)) => match serde_json::from_value(value) {
                            Ok(runtimes) => ExternalAgentsState::Ready { runtimes },
                            Err(error) => ExternalAgentsState::Unavailable {
                                message: format!("Invalid Native CLI status: {error}"),
                            },
                        },
                        Ok(None) => ExternalAgentsState::Disabled,
                        Err(message) => ExternalAgentsState::Unavailable { message },
                    }
                }
            }
        };
        Ok(ExternalAgents {
            target,
            configured: self.settings.external.is_some(),
            runtimes: maka_agent_api::external::runtime_options(self.settings.external.as_ref()),
            state,
        })
    }
}
