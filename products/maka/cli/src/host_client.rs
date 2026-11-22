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

use maka_host_runtime::{
    HostError,
    application::host::{
        Client, Pairing, Status,
        discovery::{self, Discovery},
    },
    ipc::{self, LocalStream},
};
use std::{
    num::{NonZeroU16, NonZeroU32},
    path::Path,
    time::Duration,
};

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum RetirementResult {
    Prepared { pid: NonZeroU32 },
    ActiveTasks,
}

#[derive(serde::Serialize)]
pub(super) struct LiveHost {
    #[serde(rename = "hostEpoch")]
    pub epoch: String,
    pub pid: NonZeroU32,
    pub port: NonZeroU16,
}

pub(super) struct HostClient {
    discovery: Discovery,
}
impl HostClient {
    pub async fn connect(root: &Path, generation: Option<&str>) -> Result<Self, HostError> {
        let root = root.to_owned();
        tokio::time::timeout(Duration::from_secs(5), async {
            let discovery = tokio::task::spawn_blocking(move || discovery::read(&root)).await??;
            if generation.is_some_and(|expected| discovery.generation.as_deref() != Some(expected))
            {
                return Err("Host discovery belongs to another deployment revision".into());
            }
            let client = Self { discovery };
            client.live_status().await?;
            Ok(client)
        })
        .await?
    }
    pub async fn anchor(&self) -> Result<Client, HostError> {
        Ok(tokio::time::timeout(
            Duration::from_secs(5),
            Client::connect(&self.discovery.endpoint, Some(self.discovery.host_epoch)),
        )
        .await??)
    }
    pub async fn open_bridge(&self) -> Result<LocalStream, HostError> {
        tokio::time::timeout(
            Duration::from_secs(5),
            ipc::connect(&self.discovery.endpoint),
        )
        .await?
    }
    async fn live_status(&self) -> Result<Status, HostError> {
        tokio::time::timeout(Duration::from_secs(5), async {
            let stream = ipc::connect(&self.discovery.endpoint).await?;
            let status = Client::status_stream(stream, Some(self.discovery.host_epoch)).await?;
            self.discovery.verify(&status)?;
            Ok(status)
        })
        .await?
    }
    pub async fn status(&mut self) -> Result<Status, HostError> {
        self.live_status().await
    }
    pub async fn live_host(&mut self, configured_port: u16) -> Result<LiveHost, HostError> {
        let status = self.live_status().await?;
        let [endpoint] = self.discovery.websocket_endpoints.as_slice() else {
            return Err("managed Host must publish exactly one WebSocket endpoint".into());
        };
        let port: NonZeroU16 = endpoint
            .strip_prefix("ws://127.0.0.1:")
            .and_then(|value| value.strip_suffix("/runtime-host"))
            .ok_or("managed Host published an invalid WebSocket endpoint")?
            .parse()?;
        if configured_port != 0 && configured_port != port.get() {
            return Err("managed Host listener differs from deployment configuration".into());
        }
        Ok(LiveHost {
            epoch: status.epoch.to_string(),
            pid: status.pid,
            port,
        })
    }
    pub async fn retire(
        &mut self,
        expected_epoch: Option<&str>,
        interrupt: bool,
        allow_idle_connections: bool,
    ) -> Result<RetirementResult, HostError> {
        if expected_epoch.is_some_and(|epoch| epoch != self.discovery.host_epoch.to_string()) {
            return Err("Host epoch does not match the retirement target".into());
        }
        let prepared = tokio::time::timeout(
            Duration::from_secs(15),
            Client::retire_with_options(
                &self.discovery.endpoint,
                self.discovery.host_epoch,
                interrupt,
                allow_idle_connections,
            ),
        )
        .await??;
        Ok(if prepared {
            RetirementResult::Prepared {
                pid: self.discovery.pid,
            }
        } else {
            RetirementResult::ActiveTasks
        })
    }
    pub async fn prepare_access(&self, principal: String) -> Result<Pairing, HostError> {
        Ok(tokio::time::timeout(
            Duration::from_secs(15),
            Client::prepare_access(
                &self.discovery.endpoint,
                self.discovery.host_epoch,
                principal,
            ),
        )
        .await??)
    }
    pub async fn revoke_access(&self, credential: String) -> Result<bool, HostError> {
        Ok(tokio::time::timeout(
            Duration::from_secs(15),
            Client::revoke_access(
                &self.discovery.endpoint,
                self.discovery.host_epoch,
                credential,
            ),
        )
        .await??)
    }
}
