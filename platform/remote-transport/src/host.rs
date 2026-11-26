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

use crate::{HOST_ALPN, PeerEndpoint, Relay, Result, peer::export_sas};
use iroh::{Watcher, endpoint::Connection};
use maka_host_runtime::application::host::{AuthenticatedPeerStream, Host, PeerId};
use maka_remote_pairing::parse_peer_id;
use std::{
    collections::{BTreeMap, HashMap},
    num::NonZeroUsize,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::join,
    sync::{broadcast, mpsc},
    task::{Id, JoinSet},
    time::{Instant, sleep_until, timeout_at},
};
use tokio_util::sync::CancellationToken;

pub type PeerStreamIngress = mpsc::Receiver<AuthenticatedPeerStream>;

pub struct HostPeerTransport {
    peer: PeerEndpoint,
    host: Arc<Host>,
    revoked: broadcast::Receiver<PeerId>,
    max_connections: NonZeroUsize,
    pairing_timeout: Duration,
}

impl HostPeerTransport {
    pub async fn bind(host: &Arc<Host>, relays: &[Relay], relay_only: bool) -> Result<Self> {
        let revoked = host.subscribe_revoked_peers();
        let peer = PeerEndpoint::bind_alpn(
            host.device_identity(),
            relays,
            relay_only,
            vec![HOST_ALPN.to_vec()],
        )
        .await?;
        Ok(Self {
            peer,
            host: host.clone(),
            revoked,
            max_connections: NonZeroUsize::new(64).unwrap(),
            pairing_timeout: Duration::from_secs(120),
        })
    }

    pub fn with_connection_limits(mut self, max: NonZeroUsize, pairing_timeout: Duration) -> Self {
        self.max_connections = max;
        self.pairing_timeout = pairing_timeout;
        self
    }

    pub async fn wait_for_relay(&self) -> Result<Vec<maka_remote_pairing::RelayEndpoint>> {
        let routes = self.peer.wait_for_relay().await?;
        self.host.set_native_relays(routes.clone())?;
        Ok(routes)
    }

    pub async fn close(&self) {
        self.peer.close().await;
    }

    /// Hand off one stream at a time to Host admission. QUIC owns buffering
    /// and flow control for streams that have not been handed off yet.
    pub fn ingress() -> (mpsc::Sender<AuthenticatedPeerStream>, PeerStreamIngress) {
        mpsc::channel(1)
    }

    /// Observe new authenticated connections (e.g. to display their pairing
    /// SAS). The observer must enqueue without blocking. Host owns admission.
    pub async fn serve(
        mut self,
        ingress: mpsc::Sender<AuthenticatedPeerStream>,
        cancel: CancellationToken,
        mut on_connection: impl FnMut(&PeerId, String),
    ) -> Result<()> {
        let mut pending = JoinSet::new();
        let mut streams = JoinSet::new();
        let (observe, observations) = mpsc::channel(16);
        let observe_stop = CancellationToken::new();
        let mut observer = JoinSet::new();
        observer.spawn({
            let host = self.host.clone();
            let stop = observe_stop.clone();
            async move {
                if let Err(error) = host.observe_peer_handshakes(observations, stop).await {
                    tracing::warn!(%error, "peer handshake observations unavailable");
                }
            }
        });
        let mut active: BTreeMap<PeerId, HashMap<Id, Connection>> = BTreeMap::new();
        let mut home = self.peer.endpoint.home_relay_status();
        let result: Result<()> = async {
            self.host.set_native_relays(self.peer.connected_relays(&home.get()))?;
            loop {
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => return Ok(()),
                    () = ingress.closed() => return Ok(()),
                    statuses = home.updated() => {
                        self.host.set_native_relays(self.peer.connected_relays(&statuses?))?;
                    }
                    revoked = self.revoked.recv() => match revoked {
                        Ok(peer) => {
                            if let Some(connections) = active.remove(&peer) {
                                for conn in connections.into_values() {
                                    conn.close(0u32.into(), b"peer access revoked");
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(count)) => {
                            tracing::warn!(count, "missed peer revocations; closing all peer connections");
                            for conn in std::mem::take(&mut active).into_values().flat_map(HashMap::into_values) {
                                conn.close(0u32.into(), b"peer revocation receiver lagged");
                            }
                            // This drops both in-flight handshakes and connections
                            // completed by handshake tasks but not yet registered.
                            pending = JoinSet::new();
                        }
                        Err(broadcast::error::RecvError::Closed) => return Ok(()),
                    },
                    Some(outcome) = pending.join_next() => {
                        let (handshake, mut during_handshake, deadline) = outcome?;
                        let conn: Connection = match handshake {
                            Ok(conn) => conn,
                            Err(error) => {
                                tracing::debug!(%error, "peer handshake rejected");
                                continue;
                            }
                        };
                        let canonical = hex::encode(conn.remote_id().as_bytes());
                        let client_key = match parse_peer_id(&canonical) {
                            Ok(key) => key,
                            Err(error) => {
                                tracing::debug!(%error, "invalid authenticated peer key");
                                conn.close(0u32.into(), b"invalid peer key");
                                continue;
                            }
                        };
                        let peer_id = PeerId::new(canonical)?;
                        let sas = export_sas(&conn, &self.peer.local_key, &client_key)?;
                        let observation = self.host.peer_handshake_observation(peer_id.clone(), sas.clone());
                        if revoked_while_handshaking(&mut during_handshake, &peer_id) {
                            conn.close(0u32.into(), b"peer access revoked during handshake");
                            continue;
                        }
                        let ingress = ingress.clone();
                        let peer = peer_id.clone();
                        let transport = conn.clone();
                        let host = self.host.clone();
                        // Advisory only; neither SQLite nor a full queue may stall ingress.
                        let _ = observe.try_send(observation);
                        let task = streams.spawn(async move {
                            serve_connection(transport, &peer, ingress, &host, deadline).await;
                            peer
                        });
                        on_connection(&peer_id, sas);
                        active.entry(peer_id).or_default().insert(task.id(), conn);
                    }
                    Some(outcome) = streams.join_next_with_id() => {
                        let (id, peer) = outcome?;
                        if let Some(connections) = active.get_mut(&peer) {
                            connections.remove(&id);
                            if connections.is_empty() {
                                active.remove(&peer);
                            }
                        }
                    }
                    incoming = self.peer.endpoint.accept() => match incoming {
                        Some(incoming) if pending.len() + streams.len() >= self.max_connections.get() => {
                            incoming.refuse();
                        }
                        Some(incoming) => {
                            let during_handshake = self.revoked.resubscribe();
                            let deadline = Instant::now() + self.pairing_timeout;
                            pending.spawn(async move {
                                let handshake: Result<Connection> = async {
                                    Ok(timeout_at(deadline, incoming).await??)
                                }.await;
                                (handshake, during_handshake, deadline)
                            });
                        }
                        None => return Ok(()),
                    },
                }
            }
        }.await;
        observe_stop.cancel();
        let withdraw = self.host.set_native_relays(Vec::new());
        self.peer.close().await;
        pending.shutdown().await;
        let drained: Result<()> = async {
            while let Some(outcome) = streams.join_next().await {
                outcome?;
            }
            Ok(())
        }
        .await;
        let observed = observer
            .join_next()
            .await
            .expect("one observation worker")
            .map_err(Into::into);
        result
            .and(withdraw.map_err(Into::into))
            .and(drained)
            .and(observed)
    }
}

fn revoked_while_handshaking(revoked: &mut broadcast::Receiver<PeerId>, peer: &PeerId) -> bool {
    loop {
        match revoked.try_recv() {
            Ok(revoked) if revoked == *peer => return true,
            Ok(_) => {}
            Err(broadcast::error::TryRecvError::Empty) => return false,
            Err(
                broadcast::error::TryRecvError::Closed | broadcast::error::TryRecvError::Lagged(_),
            ) => return true,
        }
    }
}

async fn serve_connection(
    conn: Connection,
    peer_id: &PeerId,
    ingress: mpsc::Sender<AuthenticatedPeerStream>,
    host: &Host,
    deadline: Instant,
) {
    let streams = serve_streams(&conn, peer_id, ingress);
    tokio::pin!(streams);
    let granted = tokio::select! {
        () = &mut streams => return,
        granted = async {
            sleep_until(deadline).await;
            host.has_peer_access(peer_id).await
        } => granted,
    };
    match granted {
        Ok(true) => streams.await,
        Ok(false) => conn.close(0u32.into(), b"peer pairing window expired"),
        Err(error) => {
            tracing::warn!(%error, "could not check peer access at the pairing deadline");
            conn.close(0u32.into(), b"could not check peer access");
        }
    }
}

async fn serve_streams(
    conn: &Connection,
    peer_id: &PeerId,
    ingress: mpsc::Sender<AuthenticatedPeerStream>,
) {
    while let Ok((send, recv)) = conn.accept_bi().await {
        let stream = AuthenticatedPeerStream {
            peer_id: peer_id.clone(),
            stream: Box::new(join(recv, send)),
        };
        tokio::select! {
            biased;
            _ = conn.closed() => break,
            result = ingress.send(stream) => if result.is_err() { break; },
        }
    }
}
