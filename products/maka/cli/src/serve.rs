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
    application::host::{Channel, Host, LifecycleMode, Options, websocket::WebSocketListener},
};
use maka_peer::NodeIdentity;
use maka_peer_mesh::{IncomingPeerStream, MeshTransportNode};
use serde_json::json;
use std::{net::SocketAddr, path::Path, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub(super) async fn run(
    path: &Path,
    websocket: Option<SocketAddr>,
    peer_listen: Option<SocketAddr>,
    expected_root: Option<&str>,
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
    let mut websocket = match deployment
        .as_ref()
        .map(|deployment| deployment.websocket)
        .or(websocket)
    {
        Some(address) => Some(WebSocketListener::bind(address, Vec::new()).await?),
        None => None,
    };
    let peer_ingress = match peer_listen {
        Some(address) => {
            let identity = NodeIdentity::load_or_create_async(crate::peer::identity_file_path(
                owner.canonical_path(),
            ))
            .await
            .map_err(|err| err.to_string())?;
            let (peer_node, peer_rx) =
                MeshTransportNode::bind(address, identity, None).map_err(|err| err.to_string())?;
            let (channel_tx, channel_rx) = mpsc::channel::<Channel>(256);
            match &mut websocket {
                Some(listener) => listener.attach_streams(channel_rx),
                None => {
                    websocket = Some(WebSocketListener::from_streams(channel_rx, Vec::new())?);
                }
            }
            Some((peer_node, peer_rx, channel_tx))
        }
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
    serve_product(host, websocket, peer_ingress).await
}
async fn serve_product(
    mut product: crate::application::ProductHost,
    websocket: Option<WebSocketListener>,
    peer_ingress: Option<(
        MeshTransportNode,
        mpsc::Receiver<IncomingPeerStream>,
        mpsc::Sender<Channel>,
    )>,
) -> Result<(), HostError> {
    let result = async {
    let host = &product.host;
    let endpoint = super::endpoint::LocalEndpoint::bind()?;
    let cancellation = CancellationToken::new();
    let _signals = super::signals::watch(cancellation.clone())?;
    let tcp_ws_addr = websocket
        .as_ref()
        .and_then(|listener| listener.local_addr().ok());
    let registration = host.publish_registration(&endpoint.path, tcp_ws_addr)?;
    let mut ready = json!({"kind":"ready","rootId":host.root_id(),"hostEpoch":host.epoch(),"socketPath":endpoint.path});
    if let Some(addr) = tcp_ws_addr {
        ready["websocketUrl"] = format!("ws://{addr}/runtime-host").into();
    }
    let peer_guard = if let Some((peer_node, mut peer_rx, channel_tx)) = peer_ingress {
        ready["peerId"] = peer_node.peer_id().as_str().into();
        ready["peerListen"] = peer_node.local_addr().to_string().into();
        let forward_cancel = cancellation.clone();
        let forward_task = tokio::spawn(async move {
            loop {
                let incoming = tokio::select! {
                    biased;
                    () = forward_cancel.cancelled() => break,
                    next = peer_rx.recv() => match next {
                        Some(incoming) => incoming,
                        None => break,
                    },
                };
                if channel_tx.send(Box::new(incoming.stream)).await.is_err() {
                    break;
                }
            }
        });
        Some((peer_node, forward_task))
    } else {
        None
    };
    println!("{ready}");
    let result = listen(endpoint, websocket, host.clone(), cancellation).await;
    if let Some((peer_node, forward_task)) = peer_guard {
        peer_node.shutdown();
        let _ = forward_task.await;
    }
    result.and(registration.remove().map_err(Into::into))
    }.await;
    let cleanup = product.shutdown().await;
    result.and(cleanup)
}

pub(super) async fn listen(
    endpoint: super::endpoint::LocalEndpoint,
    websocket: Option<WebSocketListener>,
    host: Arc<Host>,
    cancellation: CancellationToken,
) -> Result<(), HostError> {
    host.serve(endpoint.listener, websocket, cancellation)
        .await
        .map_err(Into::into)
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
