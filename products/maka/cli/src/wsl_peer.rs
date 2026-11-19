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

use clap::Args;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_host_runtime::{
    HostError,
    application::host::{Client, Host, discovery},
};
use maka_peer::{Endpoint, PeerId};
use serde::{Deserialize, Serialize};
use std::{
    io,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const RECORD: &str = "wsl-peer.json";

#[derive(Args)]
pub(crate) struct Connect {
    #[command(flatten)]
    root: crate::args::Root,
    #[arg(long)]
    peer_id: PeerId,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    root_id: String,
    host_epoch: Uuid,
    peer_id: String,
    address: String,
    client_peer_id: String,
}

impl Connect {
    pub(crate) async fn run(self) -> Result<(), HostError> {
        let path = &self.root.root;
        if !path.is_absolute() {
            return Err("WSL Host Root must be an absolute Linux path".into());
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        let (_launch, root_id) =
            tokio::time::timeout_at(deadline, crate::deployment::acquire_launch(path))
                .await
                .map_err(|_| "timed out waiting for the Root launcher")??;
        let mut child: Option<maka_process::detached::Child> = None;
        loop {
            if let Some(ready) = live(path, self.peer_id).await? {
                if ready.root_id != root_id {
                    return Err("WSL Root changed during launch".into());
                }
                println!("{}", serde_json::to_string(&ready)?);
                return Ok(());
            }
            if let Some(child) = &mut child {
                if let Some(status) = child.try_wait()? {
                    return Err(format!("WSL Host exited before publishing its peer address ({status}); check Host diagnostics").into());
                }
            } else {
                let path = path.clone();
                let root = tokio::task::spawn_blocking(move || {
                    RootOwner::open(&path, &RootNamespaces::for_current_account()?)
                })
                .await?;
                match root {
                    Ok(owner) => {
                        if owner.root_id() != root_id {
                            return Err("WSL Root changed before launch".into());
                        }
                        let canonical = owner.canonical_path().to_owned();
                        drop(owner);
                        child = Some(
                            maka_process::detached::spawn(
                                &std::env::current_exe()?,
                                &[
                                    "host",
                                    "serve",
                                    "--root",
                                    canonical.to_str().ok_or("WSL Root must be UTF-8")?,
                                    "--wsl-peer",
                                    &self.peer_id.to_string(),
                                ],
                                None,
                            )
                            .await?,
                        );
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(error.into()),
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(
                    "WSL Host did not publish its peer address before the startup deadline".into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
}

async fn live(path: &Path, expected: PeerId) -> Result<Option<Ready>, HostError> {
    let discovery = match discovery::read(path) {
        Ok(discovery) => discovery,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let status = match tokio::time::timeout(
        Duration::from_secs(2),
        Client::status(&discovery.endpoint, Some(discovery.host_epoch)),
    )
    .await
    {
        Ok(Ok(status)) => status,
        _ => return Ok(None),
    };
    if status.closing || status.closed {
        return Ok(None);
    }
    discovery.verify(&status)?;
    let path = RootNamespaces::for_current_account()?
        .control
        .join(&discovery.root_id)
        .join(RECORD);
    let ready: Ready = match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(
                "this Root is already served by a non-WSL Host; choose a dedicated WSL Root".into(),
            );
        }
        Err(error) => return Err(error.into()),
    };
    if ready.host_epoch != discovery.host_epoch || ready.root_id != discovery.root_id {
        return Err("WSL peer registration does not match the live Host".into());
    }
    if ready.client_peer_id != expected.to_string() {
        return Err("WSL Host was started for a different Desktop peer".into());
    }
    Ok(Some(ready))
}

async fn command_output(program: &str, args: &[&str]) -> Result<Vec<u8>, HostError> {
    let output = tokio::process::Command::new(program)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("cannot run {program}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(output.stdout)
}

async fn peer_listen_ip() -> Result<Ipv4Addr, HostError> {
    let mode = command_output("wslinfo", &["--networking-mode"]).await?;
    match std::str::from_utf8(&mode)?.trim() {
        "mirrored" => Ok(Ipv4Addr::LOCALHOST),
        "nat" => {
            #[derive(Deserialize)]
            struct Route {
                gateway: Option<Ipv4Addr>,
                #[serde(default)]
                metric: u32,
            }
            let routes: Vec<Route> = serde_json::from_slice(
                &command_output("ip", &["-j", "-4", "route", "show", "default"]).await?,
            )?;
            let gateway = routes
                .iter()
                .min_by_key(|route| route.metric)
                .and_then(|route| route.gateway)
                .ok_or("WSL NAT has no default IPv4 gateway")?;
            // UDP connect selects the guest source address without sending a packet.
            let socket = tokio::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
            socket.connect((gateway, 9)).await?;
            match socket.local_addr()? {
                SocketAddr::V4(addr) if !addr.ip().is_loopback() && !addr.ip().is_unspecified() => {
                    Ok(*addr.ip())
                }
                addr => Err(format!("no WSL NAT guest IPv4 route to {gateway}: {addr}").into()),
            }
        }
        mode => Err(format!("unsupported WSL networking mode: {mode}").into()),
    }
}

pub(crate) struct Listener {
    endpoint: Endpoint,
    expected: PeerId,
    record: PathBuf,
    host: Arc<Host>,
    address: SocketAddr,
}

impl Listener {
    pub(crate) async fn new(
        host: Arc<Host>,
        expected: PeerId,
        address: SocketAddr,
    ) -> Result<Self, HostError> {
        let dir = RootNamespaces::for_current_account()?
            .control
            .join(host.root_id());
        let endpoint = Endpoint::start(
            dir.join("wsl-peer.key"),
            Some(format!("/ip4/{}/tcp/0", peer_listen_ip().await?).parse()?),
        )
        .await?;
        let ready = Ready {
            root_id: host.root_id().into(),
            host_epoch: host.epoch(),
            peer_id: endpoint.peer_id().to_string(),
            client_peer_id: expected.to_string(),
            address: endpoint
                .address()
                .ok_or("WSL peer listener has no bound address")?
                .to_string(),
        };
        let record = dir.join(RECORD);
        let temporary = dir.join(format!("{RECORD}.{}", host.epoch()));
        tokio::fs::write(&temporary, serde_json::to_vec(&ready)?).await?;
        tokio::fs::rename(temporary, &record).await?;
        Ok(Self {
            endpoint,
            expected,
            record,
            host,
            address,
        })
    }

    pub(crate) async fn run(mut self, stop: CancellationToken) -> Result<(), HostError> {
        let mut tasks = JoinSet::new();
        let credential = Arc::new(tokio::sync::OnceCell::new());
        let expected = self.expected;
        let result = loop {
            tokio::select! {
                biased;
                () = stop.cancelled() => break Ok(()),
                Some(completed) = tasks.join_next(), if !tasks.is_empty() => {
                    if let Ok(Err(error)) = completed {
                        eprintln!("WSL peer channel failed: {error}");
                    }
                }
                stream = self.endpoint.accept(self.expected), if tasks.len() < 128 => {
                    let mut stream = match stream {
                        Ok(stream) => stream,
                        Err(error) => break Err(error.into()),
                    };
                    let address = self.address;
                    let credential = credential.clone();
                    let host = self.host.clone();
                    tasks.spawn(async move {
                        let kind = tokio::time::timeout(Duration::from_secs(5), stream.read_u8()).await??;
                        match kind {
                            // The paired Desktop receives this only on a pinned, authenticated stream.
                            1 => {
                                let bearer = credential.get_or_try_init(|| async {
                                    host.pair_authenticated_client(format!("wsl:{expected}"), expected.to_string())
                                        .await.map_err(io::Error::other)
                                }).await?;
                                stream.write_all(bearer.as_bytes()).await?;
                                stream.shutdown().await
                            }
                            2 => {
                                let mut host = tokio::net::TcpStream::connect(address).await?;
                                tokio::io::copy_bidirectional(&mut stream, &mut host).await?;
                                Ok(())
                            }
                            _ => Err(io::Error::new(io::ErrorKind::InvalidData, "unknown WSL peer channel kind")),
                        }
                    });
                }
            }
        };
        tasks.shutdown().await;
        tokio::fs::remove_file(self.record).await?;
        result
    }
}
