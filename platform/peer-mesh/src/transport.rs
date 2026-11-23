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

//! Mutual-Ed25519 QUIC mesh transport supporting direct `A -> B` streams,
//! fail-closed `A -> C -> B` transit relay circuits with end-to-end TLS 1.3
//! encryption, live RTT probing, and 250ms hedged dialing.

use crate::{
    dialer::{DialError, DialWinner, hedged_dial},
    roster::{PeerRouteResolution, SignedPeerMeshRosterV1},
    transit::{TransitPolicy, bridge_transit_streams},
};
use maka_peer::{
    NodeIdentity, PeerId,
    tls::{
        PEER_TLS_SERVER_NAME, PeerTlsError, accept_e2e_tls, build_peer_client_config,
        build_peer_server_config, connect_e2e_tls, peer_id_from_raw_public_key,
    },
};
use quinn::{
    ClientConfig as QuinnClientConfig, Connection, Endpoint, IdleTimeout, RecvStream, SendStream,
    ServerConfig as QuinnServerConfig, TransportConfig,
    crypto::rustls::{QuicClientConfig, QuicServerConfig},
};
use rustls_pki_types::CertificateDer;
use std::{
    collections::BTreeMap,
    io,
    net::SocketAddr,
    num::NonZeroUsize,
    pin::Pin,
    sync::{Arc, RwLock},
    task::{Context, Poll},
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

/// ALPN identifier negotiated on all Maka QUIC mesh connections.
pub const MESH_QUIC_ALPN: &[u8] = b"maka-mesh/1";

const STREAM_MAGIC: [u8; 4] = *b"MKM1";
const INTENT_DIRECT_APP: u8 = 0x01;
const INTENT_TRANSIT_REQUEST: u8 = 0x02;
const INTENT_TRANSIT_FORWARDED: u8 = 0x03;
const INTENT_PING: u8 = 0x04;

const RELAY_STATUS_DENIED: u8 = 0x00;
const RELAY_STATUS_OK: u8 = 0x01;

const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_DIAL_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_KEEP_ALIVE: Duration = Duration::from_secs(5);
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TARGET_PEER_ID_BYTES: usize = 128;
const MAX_RELAY_REASON_BYTES: usize = 512;
const INCOMING_CHANNEL_CAPACITY: usize = 256;

/// Type-erased authenticated peer byte stream (either direct QUIC or
/// end-to-end encrypted TLS 1.3 over an `A -> C -> B` mesh relay circuit).
pub trait PeerIo: AsyncRead + AsyncWrite + Send + Sync + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Sync + Unpin> PeerIo for T {}
pub type PeerStream = Box<dyn PeerIo>;

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("TLS configuration or handshake error: {0}")]
    Tls(#[from] PeerTlsError),
    #[error("QUIC crypto configuration error: {0}")]
    QuicCrypto(String),
    #[error("invalid QUIC socket endpoint `{endpoint}`: {reason}")]
    InvalidEndpoint { endpoint: String, reason: String },
    #[error("QUIC connect error: {0}")]
    Connect(String),
    #[error("QUIC connection error: {0}")]
    Connection(String),
    #[error("stream I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("QUIC stream write error: {0}")]
    Write(#[from] quinn::WriteError),
    #[error("QUIC stream read error: {0}")]
    ReadExact(#[from] quinn::ReadExactError),
    #[error("peer did not present a valid Ed25519 raw public key")]
    InvalidPeerIdentity,
    #[error("operation timed out after {0:?}")]
    Timeout(Duration),
    #[error("mesh relay rejected transit circuit: {0}")]
    RelayRejected(String),
    #[error("protocol error: {0}")]
    Protocol(String),
}

/// An accepted remote application stream delivered to the local node (for
/// example, to feed directly into `Host::serve_remote`).
pub struct IncomingPeerStream {
    pub remote_peer_id: PeerId,
    pub via_relay: Option<PeerId>,
    pub stream: PeerStream,
}

impl std::fmt::Debug for IncomingPeerStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IncomingPeerStream")
            .field("remote_peer_id", &self.remote_peer_id)
            .field("via_relay", &self.via_relay)
            .finish_non_exhaustive()
    }
}

/// Bidirectional QUIC stream that retains its parent `Connection` handle so
/// the QUIC transport stays alive for the stream's exact lifetime.
pub struct QuicBiStream {
    send: SendStream,
    recv: RecvStream,
    _connection: Connection,
}

impl AsyncRead for QuicBiStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.recv).poll_read(cx, buf)
    }
}

impl AsyncWrite for QuicBiStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        AsyncWrite::poll_write(Pin::new(&mut self.send), cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.send).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.send).poll_shutdown(cx)
    }
}

/// Parses a direct/relay endpoint string such as `127.0.0.1:4301` or
/// `quic://192.168.1.17:4301` into a `SocketAddr`.
pub fn parse_quic_socket_addr(endpoint: &str) -> Result<SocketAddr, TransportError> {
    let trimmed = endpoint.strip_prefix("quic://").unwrap_or(endpoint);
    trimmed
        .parse::<SocketAddr>()
        .map_err(|err| TransportError::InvalidEndpoint {
            endpoint: endpoint.to_owned(),
            reason: err.to_string(),
        })
}

fn quic_transport_config() -> Arc<TransportConfig> {
    let mut cfg = TransportConfig::default();
    cfg.keep_alive_interval(Some(DEFAULT_KEEP_ALIVE));
    if let Ok(idle) = IdleTimeout::try_from(DEFAULT_IDLE_TIMEOUT) {
        cfg.max_idle_timeout(Some(idle));
    }
    Arc::new(cfg)
}

fn build_quic_server_config(identity: &NodeIdentity) -> Result<QuinnServerConfig, TransportError> {
    let tls = build_peer_server_config(identity, None, vec![MESH_QUIC_ALPN.to_vec()])?;
    let quic_crypto = QuicServerConfig::try_from(tls)
        .map_err(|err| TransportError::QuicCrypto(err.to_string()))?;
    let mut server = QuinnServerConfig::with_crypto(Arc::new(quic_crypto));
    server.transport_config(quic_transport_config());
    Ok(server)
}

fn build_quic_client_config(
    identity: &NodeIdentity,
    expected_peer: PeerId,
) -> Result<QuinnClientConfig, TransportError> {
    let tls = build_peer_client_config(identity, expected_peer, vec![MESH_QUIC_ALPN.to_vec()])?;
    let quic_crypto = QuicClientConfig::try_from(tls)
        .map_err(|err| TransportError::QuicCrypto(err.to_string()))?;
    let mut client = QuinnClientConfig::new(Arc::new(quic_crypto));
    client.transport_config(quic_transport_config());
    Ok(client)
}

fn authenticated_remote_peer(connection: &Connection) -> Result<PeerId, TransportError> {
    let raw_identity = connection
        .peer_identity()
        .ok_or(TransportError::InvalidPeerIdentity)?;
    let certs = raw_identity
        .downcast::<Vec<CertificateDer<'static>>>()
        .map_err(|_| TransportError::InvalidPeerIdentity)?;
    let [end_entity] = certs.as_slice() else {
        return Err(TransportError::InvalidPeerIdentity);
    };
    peer_id_from_raw_public_key(end_entity).map_err(|_| TransportError::InvalidPeerIdentity)
}

/// Outbound QUIC transport for a client that does not accept mesh connections.
#[derive(Clone)]
pub struct MeshTransportDialer {
    endpoint: Endpoint,
    identity: NodeIdentity,
}

impl MeshTransportDialer {
    pub fn bind(bind_addr: SocketAddr, identity: NodeIdentity) -> Result<Self, TransportError> {
        Ok(Self {
            endpoint: Endpoint::client(bind_addr)?,
            identity,
        })
    }

    /// Opens a direct mutual-Ed25519 QUIC application stream to `target_peer`.
    pub async fn dial_direct(
        &self,
        target_peer: &PeerId,
        addr: SocketAddr,
    ) -> Result<PeerStream, TransportError> {
        let mut header = [0u8; 5];
        header[..4].copy_from_slice(&STREAM_MAGIC);
        header[4] = INTENT_DIRECT_APP;
        Ok(Box::new(
            self.open_stream_with_header(target_peer, addr, &header)
                .await?,
        ))
    }

    async fn connect_quic(
        &self,
        expected_peer: &PeerId,
        addr: SocketAddr,
    ) -> Result<Connection, TransportError> {
        let client_config = build_quic_client_config(&self.identity, expected_peer.clone())?;
        let connecting = self
            .endpoint
            .connect_with(client_config, addr, PEER_TLS_SERVER_NAME)
            .map_err(|err| TransportError::Connect(err.to_string()))?;
        let conn = tokio::time::timeout(DEFAULT_DIAL_TIMEOUT, connecting)
            .await
            .map_err(|_| TransportError::Timeout(DEFAULT_DIAL_TIMEOUT))?
            .map_err(|err| TransportError::Connection(err.to_string()))?;
        let verified = authenticated_remote_peer(&conn)?;
        if &verified != expected_peer {
            conn.close(1u32.into(), b"peer id mismatch");
            return Err(TransportError::InvalidPeerIdentity);
        }
        Ok(conn)
    }

    async fn open_stream_with_header(
        &self,
        expected_peer: &PeerId,
        addr: SocketAddr,
        header: &[u8],
    ) -> Result<QuicBiStream, TransportError> {
        let conn = self.connect_quic(expected_peer, addr).await?;
        let (mut send, recv) = tokio::time::timeout(DEFAULT_DIAL_TIMEOUT, conn.open_bi())
            .await
            .map_err(|_| TransportError::Timeout(DEFAULT_DIAL_TIMEOUT))?
            .map_err(|err| TransportError::Connection(err.to_string()))?;
        send.write_all(header).await?;
        send.flush().await?;
        Ok(QuicBiStream {
            send,
            recv,
            _connection: conn,
        })
    }
}

#[derive(Clone)]
struct NodeState {
    dialer: MeshTransportDialer,
    transit_policy: TransitPolicy,
    transit_roster: Arc<RwLock<Option<SignedPeerMeshRosterV1>>>,
    peer_addresses: Arc<RwLock<BTreeMap<PeerId, SocketAddr>>>,
    incoming_tx: mpsc::Sender<IncomingPeerStream>,
    cancel: CancellationToken,
}

impl NodeState {
    fn resolve_peer_addr(&self, peer_id: &PeerId) -> Option<SocketAddr> {
        self.peer_addresses
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_id)
            .copied()
    }

    fn current_roster(&self) -> Option<SignedPeerMeshRosterV1> {
        self.transit_roster
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

/// Live QUIC mesh peer node capable of serving direct application streams,
/// acting as an owner-authorized `A -> C -> B` transit relay, and dialing
/// remote peers via direct or 250ms hedged mesh transit paths.
pub struct MeshTransportNode {
    state: NodeState,
    local_addr: SocketAddr,
}

impl Drop for MeshTransportNode {
    fn drop(&mut self) {
        self.state.cancel.cancel();
    }
}

impl MeshTransportNode {
    /// Binds a single bidirectional UDP QUIC endpoint and spawns its background
    /// accept loop. Transit relaying starts fail-closed until an owner-signed
    /// roster is installed via `set_transit_roster`.
    pub fn bind(
        bind_addr: SocketAddr,
        identity: NodeIdentity,
        max_transit_circuits: Option<NonZeroUsize>,
    ) -> Result<(Self, mpsc::Receiver<IncomingPeerStream>), TransportError> {
        let server_config = build_quic_server_config(&identity)?;
        let endpoint = Endpoint::server(server_config, bind_addr)?;
        let local_addr = endpoint.local_addr()?;
        let (incoming_tx, incoming_rx) = mpsc::channel(INCOMING_CHANNEL_CAPACITY);
        let cancel = CancellationToken::new();
        let transit_policy = TransitPolicy::new(identity.peer_id().clone(), max_transit_circuits);
        let state = NodeState {
            dialer: MeshTransportDialer { endpoint, identity },
            transit_policy,
            transit_roster: Arc::new(RwLock::new(None)),
            peer_addresses: Arc::new(RwLock::new(BTreeMap::new())),
            incoming_tx,
            cancel,
        };
        let loop_state = state.clone();
        tokio::spawn(async move {
            run_accept_loop(loop_state).await;
        });
        Ok((Self { state, local_addr }, incoming_rx))
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn peer_id(&self) -> &PeerId {
        self.state.dialer.identity.peer_id()
    }

    pub fn active_transit_circuits(&self) -> usize {
        self.state.transit_policy.active_circuits()
    }

    /// Installs or replaces the verified owner-signed mesh roster governing
    /// fail-closed `A -> C -> B` transit authorization on this node.
    pub fn set_transit_roster(&self, roster: SignedPeerMeshRosterV1) {
        *self
            .state
            .transit_roster
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(roster);
    }

    /// Disables transit relaying for new circuits.
    pub fn clear_transit_roster(&self) {
        *self
            .state
            .transit_roster
            .write()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Registers or refreshes the current direct QUIC address for a peer (used
    /// by relay nodes to forward authorized `A -> C -> B` circuits to B).
    pub fn set_peer_address(&self, peer_id: PeerId, addr: SocketAddr) {
        self.state
            .peer_addresses
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(peer_id, addr);
    }

    pub fn remove_peer_address(&self, peer_id: &PeerId) {
        self.state
            .peer_addresses
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_id);
    }

    /// Opens a direct mutual-Ed25519 QUIC application stream to `target_peer`.
    pub async fn dial_direct(
        &self,
        target_peer: &PeerId,
        addr: SocketAddr,
    ) -> Result<PeerStream, TransportError> {
        self.state.dialer.dial_direct(target_peer, addr).await
    }

    /// Opens an `A -> C -> B` mesh transit stream via `relay_peer` and runs an
    /// end-to-end mutual-Ed25519 TLS 1.3 handshake directly with `target_peer`
    /// inside the relayed pipe so the relay cannot inspect or impersonate traffic.
    pub async fn dial_via_relay(
        &self,
        relay_peer: &PeerId,
        relay_addr: SocketAddr,
        target_peer: &PeerId,
    ) -> Result<PeerStream, TransportError> {
        let target_bytes = target_peer.as_str().as_bytes();
        let target_len = u16::try_from(target_bytes.len())
            .map_err(|_| TransportError::Protocol("target peer id too long".into()))?;
        let mut header = Vec::with_capacity(7 + target_bytes.len());
        header.extend_from_slice(&STREAM_MAGIC);
        header.push(INTENT_TRANSIT_REQUEST);
        header.extend_from_slice(&target_len.to_be_bytes());
        header.extend_from_slice(target_bytes);

        let mut relayed = self
            .state
            .dialer
            .open_stream_with_header(relay_peer, relay_addr, &header)
            .await?;
        let mut status = [0u8; 1];
        tokio::time::timeout(HEADER_TIMEOUT, relayed.read_exact(&mut status))
            .await
            .map_err(|_| TransportError::Timeout(HEADER_TIMEOUT))??;
        match status[0] {
            RELAY_STATUS_OK => {
                let e2e = tokio::time::timeout(
                    DEFAULT_DIAL_TIMEOUT,
                    connect_e2e_tls(relayed, &self.state.dialer.identity, target_peer.clone()),
                )
                .await
                .map_err(|_| TransportError::Timeout(DEFAULT_DIAL_TIMEOUT))??;
                Ok(Box::new(e2e))
            }
            RELAY_STATUS_DENIED => {
                let mut len_buf = [0u8; 2];
                tokio::time::timeout(HEADER_TIMEOUT, relayed.read_exact(&mut len_buf))
                    .await
                    .map_err(|_| TransportError::Timeout(HEADER_TIMEOUT))??;
                let reason_len = usize::from(u16::from_be_bytes(len_buf));
                if reason_len > MAX_RELAY_REASON_BYTES {
                    return Err(TransportError::Protocol(
                        "relay rejection message exceeded protocol bound".into(),
                    ));
                }
                let mut reason = vec![0u8; reason_len];
                tokio::time::timeout(HEADER_TIMEOUT, relayed.read_exact(&mut reason))
                    .await
                    .map_err(|_| TransportError::Timeout(HEADER_TIMEOUT))??;
                Err(TransportError::RelayRejected(
                    String::from_utf8_lossy(&reason).into_owned(),
                ))
            }
            other => Err(TransportError::Protocol(format!(
                "unexpected relay status byte 0x{other:02x}"
            ))),
        }
    }

    /// Dials `resolution.target_peer_id` using the 250ms hedged strategy from
    /// `MeshStateStore::resolve_routes`.
    pub async fn dial_resolved(
        &self,
        resolution: &PeerRouteResolution,
    ) -> Result<DialWinner<PeerStream>, DialError> {
        let target = resolution.target_peer_id.clone();
        hedged_dial(
            resolution,
            |direct_candidate| {
                let target = target.clone();
                async move {
                    let addr = parse_quic_socket_addr(&direct_candidate.endpoint)
                        .map_err(|err| err.to_string())?;
                    self.dial_direct(&target, addr)
                        .await
                        .map_err(|err| err.to_string())
                }
            },
            |transit_candidate, relay_endpoint| {
                let target = target.clone();
                async move {
                    let relay_addr =
                        parse_quic_socket_addr(&relay_endpoint).map_err(|err| err.to_string())?;
                    self.dial_via_relay(&transit_candidate.relay_peer_id, relay_addr, &target)
                        .await
                        .map_err(|err| err.to_string())
                }
            },
        )
        .await
    }

    /// Measures live mutual-Ed25519 QUIC round-trip latency to `peer_id` at `addr`.
    pub async fn measure_rtt(
        &self,
        peer_id: &PeerId,
        addr: SocketAddr,
    ) -> Result<Duration, TransportError> {
        let conn = self.state.dialer.connect_quic(peer_id, addr).await?;
        let (mut send, mut recv) = tokio::time::timeout(DEFAULT_DIAL_TIMEOUT, conn.open_bi())
            .await
            .map_err(|_| TransportError::Timeout(DEFAULT_DIAL_TIMEOUT))?
            .map_err(|err| TransportError::Connection(err.to_string()))?;
        let mut ping = [0u8; 5];
        ping[..4].copy_from_slice(&STREAM_MAGIC);
        ping[4] = INTENT_PING;
        let started = Instant::now();
        send.write_all(&ping).await?;
        send.flush().await?;
        let mut pong = [0u8; 1];
        tokio::time::timeout(HEADER_TIMEOUT, recv.read_exact(&mut pong))
            .await
            .map_err(|_| TransportError::Timeout(HEADER_TIMEOUT))??;
        let elapsed = started.elapsed();
        if pong[0] != INTENT_PING {
            return Err(TransportError::Protocol(format!(
                "unexpected ping response byte 0x{:02x}",
                pong[0]
            )));
        }
        let _ = send.finish();
        Ok(elapsed)
    }

    /// Stops accepting new connections and closes the underlying QUIC endpoint.
    pub fn shutdown(&self) {
        self.state.cancel.cancel();
        self.state.dialer.endpoint.close(0u32.into(), b"shutdown");
    }
}

async fn run_accept_loop(state: NodeState) {
    loop {
        let incoming = tokio::select! {
            biased;
            () = state.cancel.cancelled() => break,
            next = state.dialer.endpoint.accept() => match next {
                Some(incoming) => incoming,
                None => break,
            },
        };
        let conn_state = state.clone();
        tokio::spawn(async move {
            let conn = match tokio::time::timeout(DEFAULT_DIAL_TIMEOUT, incoming).await {
                Ok(Ok(conn)) => conn,
                _ => return,
            };
            let remote_peer = match authenticated_remote_peer(&conn) {
                Ok(peer) => peer,
                Err(_) => {
                    conn.close(1u32.into(), b"invalid peer identity");
                    return;
                }
            };
            handle_connection(conn_state, conn, remote_peer).await;
        });
    }
}

async fn handle_connection(state: NodeState, conn: Connection, remote_peer: PeerId) {
    loop {
        let (send, recv) = tokio::select! {
            biased;
            () = state.cancel.cancelled() => break,
            accepted = conn.accept_bi() => match accepted {
                Ok(pair) => pair,
                Err(_) => break,
            },
        };
        let stream_state = state.clone();
        let stream_conn = conn.clone();
        let stream_peer = remote_peer.clone();
        tokio::spawn(async move {
            if let Err(err) =
                handle_stream(stream_state, stream_conn, stream_peer.clone(), send, recv).await
            {
                if matches!(err, TransportError::Io(ref io_err) if io_err.kind() == io::ErrorKind::UnexpectedEof)
                {
                    tracing::debug!(peer = %stream_peer, error = %err, "peer mesh stream closed");
                } else {
                    tracing::warn!(peer = %stream_peer, error = %err, "peer mesh stream failed");
                }
            }
        });
    }
}

async fn write_relay_rejection(send: &mut SendStream, reason: &str) {
    let bytes = reason.as_bytes();
    let truncated = &bytes[..bytes.len().min(MAX_RELAY_REASON_BYTES)];
    let mut frame = Vec::with_capacity(3 + truncated.len());
    frame.push(RELAY_STATUS_DENIED);
    frame.extend_from_slice(&(truncated.len() as u16).to_be_bytes());
    frame.extend_from_slice(truncated);
    let _ = send.write_all(&frame).await;
    let _ = send.finish();
}

async fn handle_stream(
    state: NodeState,
    conn: Connection,
    remote_peer: PeerId,
    mut send: SendStream,
    mut recv: RecvStream,
) -> Result<(), TransportError> {
    let mut prefix = [0u8; 5];
    tokio::time::timeout(HEADER_TIMEOUT, recv.read_exact(&mut prefix))
        .await
        .map_err(|_| TransportError::Timeout(HEADER_TIMEOUT))??;
    if prefix[..4] != STREAM_MAGIC {
        return Err(TransportError::Protocol("invalid stream magic".into()));
    }

    match prefix[4] {
        INTENT_DIRECT_APP => {
            let bi = QuicBiStream {
                send,
                recv,
                _connection: conn,
            };
            deliver_incoming(
                &state,
                IncomingPeerStream {
                    remote_peer_id: remote_peer,
                    via_relay: None,
                    stream: Box::new(bi),
                },
            )
            .await
        }
        INTENT_TRANSIT_REQUEST => {
            let mut len_buf = [0u8; 2];
            tokio::time::timeout(HEADER_TIMEOUT, recv.read_exact(&mut len_buf))
                .await
                .map_err(|_| TransportError::Timeout(HEADER_TIMEOUT))??;
            let len = usize::from(u16::from_be_bytes(len_buf));
            if len == 0 || len > MAX_TARGET_PEER_ID_BYTES {
                write_relay_rejection(&mut send, "invalid target peer id length").await;
                return Ok(());
            }
            let mut target_bytes = vec![0u8; len];
            tokio::time::timeout(HEADER_TIMEOUT, recv.read_exact(&mut target_bytes))
                .await
                .map_err(|_| TransportError::Timeout(HEADER_TIMEOUT))??;
            let Ok(target_str) = String::from_utf8(target_bytes) else {
                write_relay_rejection(&mut send, "target peer id is not UTF-8").await;
                return Ok(());
            };
            let target_peer = match PeerId::parse(target_str) {
                Ok(peer) => peer,
                Err(err) => {
                    write_relay_rejection(&mut send, &err.to_string()).await;
                    return Ok(());
                }
            };
            let Some(roster) = state.current_roster() else {
                write_relay_rejection(&mut send, "transit relay is not enabled on this node").await;
                return Ok(());
            };
            let guard =
                match state
                    .transit_policy
                    .admit_circuit(&roster, &remote_peer, &target_peer)
                {
                    Ok(guard) => guard,
                    Err(err) => {
                        write_relay_rejection(&mut send, &err.to_string()).await;
                        return Ok(());
                    }
                };
            let Some(target_addr) = state.resolve_peer_addr(&target_peer) else {
                drop(guard);
                write_relay_rejection(&mut send, "target peer address is not registered on relay")
                    .await;
                return Ok(());
            };
            let mut fwd_header = [0u8; 5];
            fwd_header[..4].copy_from_slice(&STREAM_MAGIC);
            fwd_header[4] = INTENT_TRANSIT_FORWARDED;
            let outbound = match state
                .dialer
                .open_stream_with_header(&target_peer, target_addr, &fwd_header)
                .await
            {
                Ok(stream) => stream,
                Err(err) => {
                    drop(guard);
                    write_relay_rejection(&mut send, &format!("failed to dial target: {err}"))
                        .await;
                    return Ok(());
                }
            };
            send.write_all(&[RELAY_STATUS_OK]).await?;
            send.flush().await?;
            let inbound = QuicBiStream {
                send,
                recv,
                _connection: conn,
            };
            if let Err(err) = bridge_transit_streams(inbound, outbound, guard).await {
                if matches!(
                    err.kind(),
                    io::ErrorKind::UnexpectedEof
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::BrokenPipe
                ) {
                    tracing::debug!(source = %remote_peer, target = %target_peer, error = %err, "transit circuit closed");
                } else {
                    tracing::warn!(source = %remote_peer, target = %target_peer, error = %err, "transit circuit bridge error");
                }
            }
            Ok(())
        }
        INTENT_TRANSIT_FORWARDED => {
            let bi = QuicBiStream {
                send,
                recv,
                _connection: conn,
            };
            let (origin_peer, e2e_stream) =
                tokio::time::timeout(HEADER_TIMEOUT, accept_e2e_tls(bi, &state.dialer.identity))
                    .await
                    .map_err(|_| TransportError::Timeout(HEADER_TIMEOUT))??;
            deliver_incoming(
                &state,
                IncomingPeerStream {
                    remote_peer_id: origin_peer,
                    via_relay: Some(remote_peer),
                    stream: Box::new(e2e_stream),
                },
            )
            .await
        }
        INTENT_PING => {
            send.write_all(&[INTENT_PING]).await?;
            send.flush().await?;
            let _ = send.finish();
            Ok(())
        }
        other => Err(TransportError::Protocol(format!(
            "unknown stream intent 0x{other:02x}"
        ))),
    }
}

async fn deliver_incoming(
    state: &NodeState,
    incoming: IncomingPeerStream,
) -> Result<(), TransportError> {
    tokio::select! {
        biased;
        () = state.cancel.cancelled() => Ok(()),
        res = state.incoming_tx.send(incoming) => {
            res.map_err(|_| TransportError::Protocol("incoming peer stream consumer closed".into()))
        }
    }
}
