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

//! Trusted local control of the product-owned peer transport.
use super::{Host, PeerId, Result, access::now};
pub use maka_config::remote_access::{
    RelayAuthUpdate, RemoteAccessConfig, RemoteAccessUpdate, RemoteRelayUpdate, RemoteTransport,
};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

pub fn valid_relay_url(url: String) -> bool {
    maka_remote_pairing::RelayEndpoint {
        url,
        quic_port: None,
        cert_sha256: None,
    }
    .validate()
    .is_ok()
}

pub struct ApplyRemoteAccess {
    pub update: RemoteAccessUpdate,
    pub reply: oneshot::Sender<Result<RemoteAccessConfig>>,
}

#[derive(Default)]
pub(super) struct Runtime {
    apply: OnceLock<mpsc::Sender<ApplyRemoteAccess>>,
    state: Mutex<RuntimeState>,
}

#[derive(Default)]
struct RuntimeState {
    online: bool,
    cli_override: bool,
    error: Option<String>,
    sas: Option<SasNotice>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SasNotice {
    pub peer_id: String,
    pub sas: String,
    pub at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    Disabled,
    Starting,
    Connected,
    Error,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessStatus {
    pub config: RemoteAccessConfig,
    pub status: ConnectionStatus,
    pub peer_id: String,
    pub connected_relays: Vec<String>,
    pub sas: Option<SasNotice>,
    pub invite_pending: Option<bool>,
    pub error: Option<String>,
    pub cli_override: bool,
}

impl Host {
    pub fn remote_access_updates(&self) -> Result<mpsc::Receiver<ApplyRemoteAccess>> {
        let (send, receive) = mpsc::channel(1);
        self.remote_access
            .apply
            .set(send)
            .map_err(|_| "remote access transport control already installed")?;
        Ok(receive)
    }

    pub async fn remote_transport_config(&self) -> Result<RemoteTransport> {
        self.access
            .remote_transport()
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn save_remote_access(
        &self,
        update: RemoteAccessUpdate,
    ) -> Result<RemoteAccessConfig> {
        self.access
            .update_remote_access(update, now()?)
            .await
            .map_err(|error| error.to_string())
    }

    pub fn remote_access_reset(&self, online: bool, cli_override: bool) {
        *self.remote_access.state.lock().unwrap() = RuntimeState {
            online,
            cli_override,
            ..Default::default()
        };
    }

    pub fn remote_access_error(&self, error: String) {
        let mut state = self.remote_access.state.lock().unwrap();
        state.error = Some(error);
        state.sas = None;
    }

    pub async fn observe_peer_handshakes(
        &self,
        mut observations: mpsc::Receiver<(PeerId, String, std::time::SystemTime)>,
        stop: CancellationToken,
    ) -> Result<()> {
        // Keep advisory writes off the connection used for authentication and control.
        if stop.is_cancelled() {
            return Ok(());
        }
        // Opening owns a SQLite writer: wait for it before honoring cancellation.
        let store = maka_config::ConfigurationStore::for_root(self.root.clone())
            .await
            .map_err(|error| error.to_string())?;
        loop {
            let (peer, sas, at) = tokio::select! {
                biased;
                () = stop.cancelled() => break,
                next = observations.recv() => match next {
                    Some(next) => next,
                    None => break,
                },
            };
            tokio::select! {
                biased;
                () = stop.cancelled() => break,
                result = self.observe_peer_handshake(&store, peer, sas, at) => {
                    if let Err(error) = result {
                        tracing::warn!(%error, "could not record peer handshake");
                    }
                }
            }
        }
        store.close().await.map_err(|error| error.to_string())
    }

    async fn observe_peer_handshake(
        &self,
        store: &maka_config::ConfigurationStore,
        peer: PeerId,
        sas: String,
        at: std::time::SystemTime,
    ) -> Result<()> {
        let at = time::OffsetDateTime::from(at);
        let timestamp = at
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|error| error.to_string())?;
        let at = u64::try_from(at.unix_timestamp_nanos() / 1_000_000)
            .map_err(|_| "clock precedes Unix epoch")?;
        let grant = self.access_grant.lock().unwrap().clone();
        let peer_id = peer.as_str().to_owned();
        if !store
            .record_host_peer_activity(peer, grant, timestamp)
            .await
            .map_err(|error| error.to_string())?
        {
            self.remote_access.state.lock().unwrap().sas = Some(SasNotice { peer_id, sas, at });
        }
        Ok(())
    }

    pub(super) async fn request_remote_access_update(
        &self,
        update: RemoteAccessUpdate,
    ) -> Result<RemoteAccessConfig> {
        let apply = self
            .remote_access
            .apply
            .get()
            .ok_or("this Host does not accept remote access updates")?;
        let (reply, receive) = oneshot::channel();
        apply
            .send(ApplyRemoteAccess { update, reply })
            .await
            .map_err(|_| "remote access transport is stopping")?;
        receive
            .await
            .map_err(|_| "remote access transport stopped before applying settings")?
    }

    pub(super) async fn remote_access_status(
        &self,
        invite_id: Option<String>,
    ) -> Result<RemoteAccessStatus> {
        let config = self
            .access
            .remote_access_config()
            .await
            .map_err(|error| error.to_string())?;
        let connected_relays: Vec<_> = self
            .native_relays()
            .into_iter()
            .map(|relay| relay.url)
            .collect();
        let now = now()?;
        let invite_pending = match invite_id {
            Some(invite_id) => {
                let grant = self.access_grant.lock().unwrap().clone();
                Some(
                    self.access
                        .host_peer_pairing_invite_pending(invite_id, grant, now)
                        .await
                        .map_err(|error| error.to_string())?,
                )
            }
            None => None,
        };
        let state = self.remote_access.state.lock().unwrap();
        let status = if !connected_relays.is_empty() {
            ConnectionStatus::Connected
        } else if state.error.is_some() {
            ConnectionStatus::Error
        } else if state.online {
            ConnectionStatus::Starting
        } else {
            ConnectionStatus::Disabled
        };
        Ok(RemoteAccessStatus {
            config,
            status,
            peer_id: self.device_identity().public_key().to_string(),
            connected_relays,
            invite_pending,
            sas: state
                .sas
                .as_ref()
                .filter(|notice| now.saturating_sub(notice.at) < 120_000)
                .cloned(),
            error: state.error.clone(),
            cli_override: state.cli_override,
        })
    }
}
