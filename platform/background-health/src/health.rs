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

use maka_agent_facts::tools::ToolError;
use maka_capabilities::call;
use maka_capabilities::filesystem;
use maka_capabilities::http;
use maka_plugin_core::{
    http::Method,
    shell_result::{ShellOutput, ShellSnapshot, ShellStatus},
};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Instant};

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Input {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub include_logs: bool,
    pub url: Option<String>,
}
impl Input {
    pub fn validate(&self) -> Result<(), String> {
        self.reference
            .strip_prefix("maka://runtime/background-tasks/")
            .filter(|id| maka_agent_facts::interaction::entity_id(id).is_ok())
            .ok_or("Expected a background-task reference returned by Shell")?;
        if let Some(value) = &self.url {
            let url = url::Url::parse(value).map_err(|_| "Invalid health endpoint URL")?;
            if value.len() > 8192
                || !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err(
                    "Use an HTTP(S) health URL without user credentials or fragment".into(),
                );
            }
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub status: ShellStatus,
    pub tracked: bool,
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logs: Option<ShellOutput>,
}
#[derive(Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Endpoint {
    NotChecked,
    Unknown {
        target: String,
        error: String,
    },
    Checked {
        target: String,
        http_status: u16,
        elapsed_ms: u64,
        health: Readiness,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    Healthy,
    Unknown,
    Unhealthy,
}
#[derive(Serialize)]
pub struct Report {
    pub process: Process,
    pub endpoint: Endpoint,
}
#[derive(Clone)]
pub struct Health {
    pub files: Arc<dyn filesystem::Files>,
    pub http: Arc<dyn http::Client>,
}
impl Health {
    pub async fn check(&self, parent: &call::Scope, input: Input) -> Result<Report, ToolError> {
        input.validate().map_err(failed)?;
        let snapshot = self
            .files
            .invoke(
                parent.clone(),
                filesystem::Operation::Read(maka_agent_facts::read::ReadInput {
                    path: input.reference.clone(),
                    offset: None,
                    limit: None,
                }),
            )
            .await?
            .into_json();
        let snapshot: ShellSnapshot = serde_json::from_value(snapshot)
            .map_err(|_| failed("Host returned an invalid background-task snapshot"))?;
        snapshot.validate().map_err(failed)?;
        if snapshot.resource_ref != input.reference {
            return Err(failed("Host returned a different background task"));
        }
        let process = Process {
            status: snapshot.status,
            tracked: true,
            started_at: snapshot.started_at,
            updated_at: snapshot.updated_at,
            completed_at: snapshot.completed_at,
            exit_code: snapshot.exit_code,
            failure_message: snapshot.failure_message,
            logs: input.include_logs.then_some(snapshot.output).flatten(),
        };
        let endpoint = match input.url {
            None => Endpoint::NotChecked,
            Some(url) => {
                let target = url::Url::parse(&url)
                    .map_err(|_| failed("Invalid health URL"))?
                    .to_string();
                self.probe(parent, target).await?
            }
        };
        Ok(Report { process, endpoint })
    }
    async fn probe(&self, parent: &call::Scope, target: String) -> Result<Endpoint, ToolError> {
        let owned = call::Owned::new(parent.child()?);
        let scope = owned.scope();
        let started = Instant::now();
        let result = tokio::select! {
            biased;
            _ = scope.cancellation.cancelled() => Err(http::Error::Failed("cancelled".into())),
            result = async {
                let status = self.request(&scope, &target, Method::Head).await?;
                if matches!(status, 405 | 501) {
                    self.request(&scope, &target, Method::Get).await
                } else {
                    Ok(status)
                }
            } => result,
        };
        scope.cancellation.cancel();
        owned.finish().await?;
        if parent.cancellation.is_cancelled() {
            return Err(failed("Background health check cancelled"));
        }
        match result {
            Ok(status) => Ok(Endpoint::Checked {
                target,
                http_status: status,
                elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                health: if (200..300).contains(&status) {
                    Readiness::Healthy
                } else if status < 400 {
                    Readiness::Unknown
                } else {
                    Readiness::Unhealthy
                },
            }),
            Err(http::Error::CleanupUnconfirmed) => Err(ToolError::CleanupUnconfirmed(
                "Health probe cleanup is unconfirmed".into(),
            )),
            Err(http::Error::Denied) => Ok(Endpoint::Unknown {
                target,
                error: "Endpoint access was not authorized".into(),
            }),
            Err(_) => Ok(Endpoint::Unknown {
                target,
                error: "Endpoint probe failed or timed out".into(),
            }),
        }
    }
    async fn request(
        &self,
        scope: &call::Scope,
        url: &str,
        method: Method,
    ) -> Result<u16, http::Error> {
        let response = self
            .http
            .request(
                scope.clone(),
                http::Request {
                    url: url.into(),
                    method,
                    headers: vec![],
                    body: Default::default(),
                },
            )
            .await?;
        let status = response.head.status;
        // Discard the body and never follow redirects, including on GET fallback.
        response.body.cancel();
        response.body.close().await?;
        Ok(status)
    }
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
