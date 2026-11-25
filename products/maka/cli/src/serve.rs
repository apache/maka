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

mod remote_access;

use clap::Args;
use maka_host_runtime::{
    HostError,
    application::host::{Host, LifecycleMode, Options, websocket::WebSocketListener},
};
use maka_remote_pairing::RelayEndpoint;
use maka_remote_transport::{Relay, host::HostPeerTransport};
use serde_json::json;
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

#[derive(Args)]
pub(super) struct Serve {
    #[command(flatten)]
    root: super::args::Root,
    #[arg(long)]
    websocket: Option<SocketAddr>,
    /// Self-hosted relay URL (repeatable). Relay modifiers require a single URL.
    #[arg(long)]
    relay: Vec<String>,
    #[arg(long, requires = "relay")]
    relay_quic_port: Option<u16>,
    #[arg(long, requires = "relay", conflicts_with = "relay_ca_der")]
    relay_cert_sha256: Option<String>,
    #[arg(long, requires = "relay")]
    relay_ca_der: Option<PathBuf>,
    #[arg(long, requires = "relay", conflicts_with = "relay_auth_token_env")]
    relay_auth_token: Option<String>,
    #[arg(long, requires = "relay")]
    relay_auth_token_env: Option<String>,
    /// Disable direct IP transports.
    #[arg(long, requires = "relay")]
    relay_only: bool,
}

pub(super) struct Remote {
    relays: Vec<Relay>,
    relay_only: bool,
    pairing_output: std::fs::File,
}

impl Serve {
    pub async fn run(self) -> Result<(), HostError> {
        #[cfg(windows)]
        crate::windows::own_process_tree()?;
        let remote = if self.relay.is_empty() {
            None
        } else {
            if self.relay.len() > 1
                && (self.relay_quic_port.is_some()
                    || self.relay_cert_sha256.is_some()
                    || self.relay_ca_der.is_some()
                    || self.relay_auth_token.is_some()
                    || self.relay_auth_token_env.is_some())
            {
                return Err(
                    "relay TLS, QUIC port and Bearer options require exactly one --relay".into(),
                );
            }
            let ca = match self.relay_ca_der {
                Some(path) => Some(remote_access::read_ca(path).await?),
                None => None,
            };
            let token = crate::relay::bearer(self.relay_auth_token, self.relay_auth_token_env)?;
            let public_routes: Vec<_> = self
                .relay
                .into_iter()
                .map(|url| RelayEndpoint {
                    url,
                    quic_port: self.relay_quic_port,
                    cert_sha256: self.relay_cert_sha256.clone(),
                })
                .collect();
            let relays = public_routes
                .iter()
                .map(|route| Relay::new(route, ca.clone(), token.clone()))
                .collect::<Result<_, _>>()?;
            Some(Remote {
                relays,
                relay_only: self.relay_only,
                pairing_output: crate::logging::operator_stderr()?,
            })
        };
        run(&self.root.root, self.websocket, None, remote).await
    }
}

pub(super) async fn run(
    path: &Path,
    websocket: Option<std::net::SocketAddr>,
    expected_root: Option<&str>,
    remote: Option<Remote>,
) -> Result<(), maka_host_runtime::HostError> {
    use maka_event_log::root::{ROOT_MARKER, RootNamespaces, RootOwner};
    let namespaces = RootNamespaces::for_current_account()?;
    let owner = if path.join(ROOT_MARKER).exists() {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            match RootOwner::open(path, &namespaces) {
                Ok(owner) => break owner,
                Err(error)
                    if expected_root.is_some()
                        && error.kind() == std::io::ErrorKind::WouldBlock
                        && tokio::time::Instant::now() < deadline =>
                {
                    // launchd can start the job while its registrar still
                    // holds Root. Admission happens only after acquisition.
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
    } else if expected_root.is_none() {
        let _launch = crate::deployment::acquire_launch_lock(path, &namespaces)?;
        if path.join(ROOT_MARKER).exists() {
            RootOwner::open(path, &namespaces)?
        } else {
            RootOwner::create(path, &namespaces)?
        }
    } else {
        return Err("service State Root must already be installed".into());
    };
    if expected_root.is_some_and(|expected| expected != owner.root_id()) {
        return Err("service State Root identity changed".into());
    }
    if expected_root.is_none() {
        let logs = maka_host_runtime::logs::Source::from_owner(&owner)?;
        eprintln!("Host diagnostics: {}", logs.path().display());
        crate::logging::capture(logs.open_capture()?)?;
    }
    let deployment = crate::deployment::admit(&owner, crate::deployment::Mode::Supervised).await?;
    if expected_root.is_some() && deployment.is_none() {
        return Err("service State Root must have a supervised deployment".into());
    }
    let websocket = match deployment
        .as_ref()
        .map(|deployment| deployment.websocket)
        .or(websocket)
    {
        Some(address) => Some(WebSocketListener::bind(address, Vec::new()).await?),
        None => None,
    };
    let host = crate::application::open_host(
        owner,
        Options {
            lifecycle_mode: LifecycleMode::Service,
            generation: deployment
                .as_ref()
                .map(|deployment| deployment.generation()),
            ..Default::default()
        },
        deployment
            .as_ref()
            .map(|deployment| {
                crate::application::Roots::Configured(deployment.project_directory_roots.clone())
            })
            .unwrap_or(crate::application::Roots::Saved),
        None,
    )
    .await?;
    serve_product(host, websocket, remote).await
}
async fn serve_product(
    mut product: crate::application::ProductHost,
    websocket: Option<WebSocketListener>,
    remote: Option<Remote>,
) -> Result<(), HostError> {
    let result = async {
        let host = &product.host;
        let endpoint = super::endpoint::LocalEndpoint::bind()?;
        let cancellation = CancellationToken::new();
        let _signals = super::signals::watch(cancellation.clone())?;
        let mut ready = json!({"kind":"ready","rootId":host.root_id(),"hostEpoch":host.epoch(),"socketPath":endpoint.path});
        let websocket_addr = websocket.as_ref().map(WebSocketListener::local_addr).transpose()?;
        if let Some(address) = websocket_addr {
            ready["websocketUrl"] = format!("ws://{address}/runtime-host").into();
        }
        let remote = if let Some(remote) = remote {
            host.remote_access_reset(true, true);
            let pairing_output = pairing_notices(remote.pairing_output)?;
            let transport = HostPeerTransport::bind(host, &remote.relays, remote.relay_only).await.map_err(|_| "could not start relay transport; check relay configuration and local networking")?;
            let registered = tokio::select! {
                () = cancellation.cancelled() => None,
                result = tokio::time::timeout(std::time::Duration::from_secs(30), transport.wait_for_relay()) => {
                    Some(result.unwrap_or_else(|_| Err("timed out waiting for a relay connection".into())))
                },
            };
            let relays = match registered {
                Some(Ok(relays)) => relays,
                Some(Err(error)) => {
                    transport.close().await;
                    return Err(error);
                }
                None => {
                    transport.close().await;
                    return Ok(());
                }
            };
            ready["peerId"] = host.device_identity().public_key().to_string().into();
            ready["relays"] = serde_json::to_value(relays)?;
            Some((transport, pairing_output))
        } else {
            None
        };

        let registration = host.publish_registration(&endpoint.path, websocket_addr)?;
        println!("{ready}");
        let result = if let Some((transport, pairing_output)) = remote {
            let (sender, ingress) = HostPeerTransport::ingress();
            let serve = host.serve_with_peers(endpoint.listener, websocket, Some(ingress), cancellation.clone());
            let peers = transport.serve(sender, cancellation.clone(), move |peer, sas| {
                let event = json!({"kind":"peerSas","peerId":peer.as_str(),"sas":sas});
                // Advisory, local-only output must not backpressure peer admission.
                let _ = pairing_output.try_send(format!("{event}\n"));
            });
            let peers = async {
                peers.await.map_err(|_| -> HostError { "relay transport stopped unexpectedly".into() })
            };
            tokio::pin!(serve, peers);
            tokio::select! {
                result = &mut serve => {
                    cancellation.cancel();
                    result.map_err(HostError::from).and(peers.await)
                }
                result = &mut peers => {
                    cancellation.cancel();
                    result.and(serve.await.map_err(Into::into))
                }
            }
        } else {
            listen(endpoint, websocket, host.clone(), cancellation).await
        };
        result.and(registration.remove().map_err(Into::into))
    }.await;
    let cleanup = product.shutdown().await;
    result.and(cleanup)
}

fn pairing_notices(
    mut output: std::fs::File,
) -> std::io::Result<std::sync::mpsc::SyncSender<String>> {
    use std::io::Write as _;
    // One pending notice behind the writer. A local pipe may never drain:
    // detach this thread instead of enlisting a Tokio worker shutdown must join.
    let (tx, rx) = std::sync::mpsc::sync_channel::<String>(1);
    std::thread::Builder::new()
        .name("maka-peer-sas".into())
        .spawn(move || {
            for line in rx {
                if let Err(error) = output.write_all(line.as_bytes()) {
                    eprintln!("could not report peer SAS to the local operator: {error}");
                    break;
                }
            }
        })?;
    Ok(tx)
}

pub(super) async fn listen(
    endpoint: super::endpoint::LocalEndpoint,
    websocket: Option<WebSocketListener>,
    host: Arc<Host>,
    cancellation: CancellationToken,
) -> Result<(), HostError> {
    let (sender, ingress) = HostPeerTransport::ingress();
    let updates = host.remote_access_updates()?;
    let serving = host.serve_with_peers(
        endpoint.listener,
        websocket,
        Some(ingress),
        cancellation.clone(),
    );
    let managing = remote_access::supervise(&host, sender, updates, cancellation.clone());
    tokio::pin!(serving, managing);
    tokio::select! {
        result = &mut serving => {
            cancellation.cancel();
            result.map_err(HostError::from).and(managing.await)
        }
        result = &mut managing => {
            cancellation.cancel();
            result.and(serving.await.map_err(Into::into))
        }
    }
}

pub(super) fn home_directory() -> Result<Option<std::path::PathBuf>, maka_host_runtime::HostError> {
    #[cfg(unix)]
    let instructions = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(std::path::PathBuf::from);
    #[cfg(windows)]
    let instructions = Some(maka_sandbox::account_home()?);
    Ok(instructions)
}
