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

use crate::host::Connection;
use maka_host_runtime::application::host::{Channel, Client, WebSocketStreamOpener};
use maka_peer::{Endpoint, Multiaddr, PeerId};
use serde::Deserialize;
use std::{ffi::OsString, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    runtime::Handle,
};
use uuid::Uuid;

pub(crate) struct Target {
    distro: OsString,
    executable: OsString,
    root: OsString,
    directory: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    root_id: String,
    host_epoch: Uuid,
    peer_id: String,
    address: String,
    client_peer_id: String,
}

impl Target {
    pub(crate) fn from_env(distro: OsString) -> Result<Self, String> {
        let get = |key: &str| {
            std::env::var_os(key)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{key} is required for a WSL Desktop target"))
        };
        let directory = PathBuf::from(get("MAKA_DESKTOP_WSL_CLIENT_DIR")?);
        if distro.is_empty() {
            return Err("WSL distribution must not be empty".into());
        }
        if !directory.is_absolute() {
            return Err("WSL Desktop client directory must be absolute".into());
        }
        Ok(Self {
            distro,
            executable: get("MAKA_DESKTOP_WSL_MAKA")?,
            root: get("MAKA_DESKTOP_WSL_ROOT")?,
            directory,
        })
    }

    pub(crate) async fn endpoint(&self) -> Result<Arc<Endpoint>, String> {
        maka_event_log::root::private_directory(&self.directory)
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(
            Endpoint::start(self.directory.join("desktop-peer.key"), None).await?,
        ))
    }

    pub(crate) async fn connect(
        &self,
        endpoint: Arc<Endpoint>,
        expected: Option<(&str, PeerId)>,
    ) -> Result<(Connection, String, PeerId), String> {
        let client_peer_id = endpoint.peer_id().to_string();
        let output = tokio::time::timeout(
            Duration::from_secs(60),
            Command::new("wsl.exe")
                .arg("--distribution")
                .arg(&self.distro)
                .arg("--exec")
                .arg(&self.executable)
                .args(["host", "wsl-connect", "--root"])
                .arg(&self.root)
                .arg("--peer-id")
                .arg(&client_peer_id)
                .stdin(Stdio::null())
                .creation_flags(0x0800_0000)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| "WSL Host startup timed out")?
        .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "WSL Host startup failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let ready: Ready = serde_json::from_slice(&output.stdout)
            .map_err(|_| "invalid WSL Host startup response")?;
        let peer: PeerId = ready
            .peer_id
            .parse()
            .map_err(|_| "invalid WSL Host PeerId")?;
        let address: Multiaddr = ready
            .address
            .parse()
            .map_err(|_| "invalid WSL Host peer address")?;
        if ready.client_peer_id != client_peer_id
            || expected.is_some_and(|(root, id)| root != ready.root_id || id != peer)
        {
            return Err("WSL Host Root or peer identity changed".into());
        }
        let bearer = {
            let mut stream = endpoint.open(peer, address.clone()).await?;
            stream
                .write_u8(1)
                .await
                .map_err(|error| error.to_string())?;
            let mut bounded = stream.take(1025);
            let mut token = String::new();
            tokio::time::timeout(Duration::from_secs(5), bounded.read_to_string(&mut token))
                .await
                .map_err(|_| "WSL Host pairing timed out")?
                .map_err(|_| "invalid WSL Host pairing response")?;
            if token.is_empty() || token.len() > 1024 {
                return Err("invalid WSL Host pairing response size".into());
            }
            token
        };
        let open: WebSocketStreamOpener = Arc::new(move || {
            let endpoint = endpoint.clone();
            let address = address.clone();
            Box::pin(async move {
                let mut stream = endpoint.open(peer, address).await?;
                stream
                    .write_u8(2)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(Box::new(stream) as Channel)
            })
        });
        let client = tokio::time::timeout(
            Duration::from_secs(20),
            Client::connect_websocket(open, bearer.into(), client_peer_id.into(), ready.host_epoch),
        )
        .await
        .map_err(|_| "WSL Host session admission timed out")??;
        let connection =
            Connection::admit_wsl(client, &ready.root_id, &self.directory, Handle::current())
                .await?;
        Ok((connection, ready.root_id, peer))
    }
}
