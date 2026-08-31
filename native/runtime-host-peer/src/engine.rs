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

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, RwLock},
    thread,
    time::{Duration, Instant},
};

use futures::StreamExt;
use libp2p::{
    Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder, connection_limits,
    core::transport::ListenerId,
    dcutr, identify, identity,
    multiaddr::Protocol,
    noise, ping, relay,
    swarm::{
        ConnectionId, NetworkBehaviour, SwarmEvent,
        dial_opts::{DialOpts, PeerCondition},
    },
    tcp, yamux,
};
use tokio::sync::{mpsc, oneshot};

mod address;
mod application_stream;
mod identity_store;
mod peer_stream;
mod relay_discovery;

use address::{address_with_expected_peer, address_with_peer, is_relayed_address};
pub(crate) use address::{coordination_relay_peer_id, transit_relay_peer_id};
use identity_store::load_or_create_key;
use peer_stream::spawn_stream;
pub use peer_stream::{PeerStream, StreamCommand};

const APPLICATION_PROTOCOL: &str = "/maka/runtime-host/peer/1";
const MESH_CONTROL_PROTOCOL: &str = "/maka/runtime-host/mesh-control/1";
const IDENTIFY_PROTOCOL: &str = "/maka/runtime-host/peer-identify/1";
const COMMAND_CAPACITY: usize = 32;
const INCOMING_STREAM_CAPACITY: usize = 16;
const MESH_INCOMING_STREAM_CAPACITY: usize = 32;
const MAX_PENDING_INCOMING_CONNECTIONS: u32 = 32;
const MAX_PENDING_OUTGOING_CONNECTIONS: u32 = 1024;
const MAX_ESTABLISHED_INCOMING_CONNECTIONS: u32 = 32;
const MAX_ESTABLISHED_CONNECTIONS: u32 = 1024;
const MAX_CONNECTIONS_PER_PEER: u32 = 4;
const LISTENER_ADDRESS_QUIET_PERIOD: Duration = Duration::from_millis(250);
const COORDINATION_RETRY_INTERVAL: Duration = Duration::from_secs(1);
const TRANSIT_HOLE_PUNCH_RETRY_INTERVAL: Duration = Duration::from_secs(30);
const AUTOMATIC_RELAY_COOLDOWN: Duration = Duration::from_secs(30);
const IDLE_CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const TARGET_COORDINATION_RESERVATIONS: usize = 2;
const MAX_AUTOMATIC_RELAY_CANDIDATES: usize = 8;
const MAX_RELAY_ADDRESSES_PER_PEER: usize = 4;
const TRANSIT_FALLBACK_DELAY: Duration = Duration::from_secs(3);
const MAX_TRANSIT_RESERVATIONS: usize = 32;
const MAX_TRANSIT_CIRCUITS: usize = 8;
const MAX_TRANSIT_CIRCUITS_PER_PEER: usize = 2;
const MAX_TRANSIT_CIRCUIT_DURATION: Duration = Duration::from_secs(2 * 60 * 60);
const MAX_TRANSIT_CIRCUIT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone)]
pub struct StartOptions {
    pub key_path: PathBuf,
    pub expected_peer_id: Option<PeerId>,
    pub listen_addresses: Vec<Multiaddr>,
    pub coordination_relays: Vec<Multiaddr>,
    pub automatic_relay_discovery: bool,
}

pub struct StartedEndpoint {
    pub peer_id: PeerId,
    pub listen_addresses: Vec<Multiaddr>,
    pub active_coordination_relays: Arc<RwLock<Vec<Multiaddr>>>,
    pub transit_snapshot: Arc<RwLock<TransitSnapshot>>,
    pub commands: mpsc::Sender<EngineCommand>,
    pub incoming: mpsc::Receiver<PeerStream>,
    pub mesh_incoming: mpsc::Receiver<PeerStream>,
    pub terminal: mpsc::Receiver<PeerError>,
    pub thread: thread::JoinHandle<()>,
}

pub struct IdentitySignature {
    pub public_key: Vec<u8>,
    pub signature: Vec<u8>,
}

pub struct ConnectOptions {
    pub request_id: u32,
    pub peer_id: PeerId,
    pub route_hints: Vec<Multiaddr>,
    pub coordination_relays: Vec<Multiaddr>,
    pub transit_relay_peers: Vec<PeerId>,
    pub deadline: Duration,
}

pub enum EngineCommand {
    Connect {
        options: ConnectOptions,
        stream_kind: StreamKind,
        result: oneshot::Sender<Result<PeerStream, PeerError>>,
    },
    CancelConnect {
        request_id: u32,
        result: oneshot::Sender<bool>,
    },
    ConfigureTransit {
        policy: TransitPolicy,
        result: oneshot::Sender<()>,
    },
    Stop {
        result: oneshot::Sender<()>,
    },
}

pub struct TransitPolicy {
    pub allowed_peers: HashSet<PeerId>,
    pub approved_relays: HashSet<PeerId>,
    pub relays: Vec<TransitRelayCandidate>,
}

pub struct TransitRelayCandidate {
    pub peer_id: PeerId,
    pub addresses: Vec<Multiaddr>,
    pub coordination_relays: Vec<Multiaddr>,
}

#[derive(Clone)]
pub struct TransitSnapshot {
    pub allowed_peer_count: usize,
    pub active_reservation_count: usize,
    pub active_circuit_count: usize,
    pub max_reservation_count: usize,
    pub max_circuit_count: usize,
    pub max_circuits_per_peer: usize,
    pub max_circuit_duration_seconds: u64,
    pub max_circuit_bytes: u64,
}

impl Default for TransitSnapshot {
    fn default() -> Self {
        Self {
            allowed_peer_count: 0,
            active_reservation_count: 0,
            active_circuit_count: 0,
            max_reservation_count: MAX_TRANSIT_RESERVATIONS,
            max_circuit_count: MAX_TRANSIT_CIRCUITS,
            max_circuits_per_peer: MAX_TRANSIT_CIRCUITS_PER_PEER,
            max_circuit_duration_seconds: MAX_TRANSIT_CIRCUIT_DURATION.as_secs(),
            max_circuit_bytes: MAX_TRANSIT_CIRCUIT_BYTES,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PeerError {
    pub code: &'static str,
    pub message: String,
}

impl PeerError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(NetworkBehaviour)]
struct Behaviour {
    connection_limits: connection_limits::Behaviour,
    relay_client: relay::client::Behaviour,
    relay_server: relay::Behaviour,
    dcutr: dcutr::Behaviour,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
    application_stream: application_stream::Behaviour,
    mesh_control: application_stream::Behaviour,
}

struct PendingConnect {
    peer_id: PeerId,
    result: oneshot::Sender<Result<PeerStream, PeerError>>,
    stream_kind: StreamKind,
    deadline: Instant,
    opening: Option<tokio::task::JoinHandle<()>>,
    dials: HashMap<ConnectionId, DialOrigin>,
    direct_routes: Vec<Multiaddr>,
    coordination_relays: Vec<Multiaddr>,
    coordination_relay_peers: Vec<PeerId>,
    transit_relay_peers: HashSet<PeerId>,
    transit_after: Instant,
    next_route_attempt: Instant,
    retry_coordination: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Application,
    MeshControl,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum DialOrigin {
    Direct,
    Coordination,
    Transit,
}

struct StartedConnect {
    direct_routes: Vec<Multiaddr>,
    coordination_relay_peers: Vec<PeerId>,
    transit_relay_peers: HashSet<PeerId>,
}

struct TransitRuntime {
    allowed_peers: Arc<RwLock<HashSet<PeerId>>>,
    approved_relays: HashSet<PeerId>,
    trusted_relays: Arc<RwLock<HashSet<PeerId>>>,
    reservations: HashSet<PeerId>,
    circuits: HashMap<(PeerId, PeerId), usize>,
    listen_addresses: Vec<Multiaddr>,
    published_addresses: Vec<Multiaddr>,
    snapshot: Arc<RwLock<TransitSnapshot>>,
}

struct RouteRuntime<'a> {
    active_coordination_relays: &'a Arc<RwLock<Vec<Multiaddr>>>,
    transit: &'a mut TransitRuntime,
}

struct AllowedPeerLimiter(Arc<RwLock<HashSet<PeerId>>>);

impl relay::RateLimiter for AllowedPeerLimiter {
    fn try_next(&mut self, peer: PeerId, _: &Multiaddr, _: Instant) -> bool {
        self.0
            .read()
            .map(|allowed| allowed.contains(&peer))
            .unwrap_or(false)
    }
}

#[derive(Default)]
struct DirectConnectState {
    pending: HashMap<u32, PendingConnect>,
    active: HashMap<ConnectionId, usize>,
    retiring_connections: HashSet<ConnectionId>,
}

struct CoordinationRelay {
    addresses: Vec<Multiaddr>,
    automatic_addresses: Vec<Multiaddr>,
    transit_addresses: Vec<Multiaddr>,
    transit_coordination_relays: Vec<Multiaddr>,
    transit_bootstrap_addresses: Vec<Multiaddr>,
    transit_bootstrap_references: usize,
    reservation_addresses: Vec<Multiaddr>,
    connections: HashSet<ConnectionId>,
    owned_connections: HashSet<ConnectionId>,
    relayed_connections: HashSet<ConnectionId>,
    direct_connection_addresses: HashMap<ConnectionId, Multiaddr>,
    pending_connection: Option<ConnectionId>,
    identify_received: bool,
    identify_sent: bool,
    reserve: bool,
    reservation_accepted: bool,
    client_references: usize,
    reservation_listener: Option<ListenerId>,
    next_connection_attempt: Instant,
    next_reservation_attempt: Instant,
    replace_relayed_at: Option<Instant>,
}

impl Default for CoordinationRelay {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            addresses: Vec::new(),
            automatic_addresses: Vec::new(),
            transit_addresses: Vec::new(),
            transit_coordination_relays: Vec::new(),
            transit_bootstrap_addresses: Vec::new(),
            transit_bootstrap_references: 0,
            reservation_addresses: Vec::new(),
            connections: HashSet::new(),
            owned_connections: HashSet::new(),
            relayed_connections: HashSet::new(),
            direct_connection_addresses: HashMap::new(),
            pending_connection: None,
            identify_received: false,
            identify_sent: false,
            reserve: false,
            reservation_accepted: false,
            client_references: 0,
            reservation_listener: None,
            next_connection_attempt: now,
            next_reservation_attempt: now,
            replace_relayed_at: None,
        }
    }
}

impl CoordinationRelay {
    fn is_automatic(&self) -> bool {
        !self.automatic_addresses.is_empty()
    }

    fn is_active(&self) -> bool {
        self.reserve
            || !self.transit_addresses.is_empty()
            || !self.transit_coordination_relays.is_empty()
            || self.transit_bootstrap_references > 0
            || self.client_references > 0
    }

    fn connection_lost(&mut self, now: Instant) -> Option<ListenerId> {
        self.identify_received = false;
        self.identify_sent = false;
        self.next_connection_attempt = now;
        self.replace_relayed_at = None;
        self.next_reservation_attempt = now
            + if self.is_automatic() {
                AUTOMATIC_RELAY_COOLDOWN
            } else {
                COORDINATION_RETRY_INTERVAL
            };
        self.reservation_accepted = false;
        self.reservation_addresses.clear();
        self.reservation_listener.take()
    }

    fn listener_closed(&mut self, listener_id: ListenerId, now: Instant) -> bool {
        if self.reservation_listener != Some(listener_id) {
            return false;
        }
        self.reservation_listener = None;
        self.reservation_accepted = false;
        self.reservation_addresses.clear();
        self.next_reservation_attempt = now
            + if self.is_automatic() {
                AUTOMATIC_RELAY_COOLDOWN
            } else {
                COORDINATION_RETRY_INTERVAL
            };
        true
    }
}

struct OpenedStream {
    request_id: u32,
    result: Result<application_stream::OpenedStream, String>,
}

pub(super) enum StreamCompletion {
    Application {
        connection_id: ConnectionId,
    },
    MeshControl {
        connection_id: ConnectionId,
        coordination_relay_peers: Vec<PeerId>,
    },
}

pub(super) struct CompletedStream {
    kind: StreamCompletion,
    acknowledged: oneshot::Sender<()>,
}

pub async fn ensure_identity(key_path: PathBuf) -> Result<PeerId, PeerError> {
    Ok(identity_store::load_or_create_key(&key_path)
        .await?
        .public()
        .to_peer_id())
}

pub async fn sign_identity(
    key_path: PathBuf,
    expected_peer_id: PeerId,
    payload: &[u8],
) -> Result<IdentitySignature, PeerError> {
    let key = identity_store::load_key(&key_path).await?;
    if PeerId::from(key.public()) != expected_peer_id {
        return Err(PeerError::new(
            "peer_identity_mismatch",
            "the persisted peer identity does not match the expected PeerId",
        ));
    }
    Ok(IdentitySignature {
        public_key: key.public().encode_protobuf(),
        signature: key
            .sign(payload)
            .map_err(|error| PeerError::new("peer_native_failed", error.to_string()))?,
    })
}

pub fn verify_identity(
    peer_id: PeerId,
    public_key: &[u8],
    payload: &[u8],
    signature: &[u8],
) -> Result<bool, PeerError> {
    let public_key = identity::PublicKey::try_decode_protobuf(public_key)
        .map_err(|error| PeerError::new("peer_native_failed", error.to_string()))?;
    Ok(PeerId::from(&public_key) == peer_id && public_key.verify(payload, signature))
}

pub fn start(options: StartOptions) -> Result<StartedEndpoint, PeerError> {
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (command_tx, command_rx) = mpsc::channel(COMMAND_CAPACITY);
    let (incoming_tx, incoming_rx) = mpsc::channel(INCOMING_STREAM_CAPACITY);
    let (mesh_incoming_tx, mesh_incoming_rx) = mpsc::channel(MESH_INCOMING_STREAM_CAPACITY);
    let (terminal_tx, terminal_rx) = mpsc::channel(1);
    let active_coordination_relays = Arc::new(RwLock::new(Vec::new()));
    let active_coordination_relays_for_thread = Arc::clone(&active_coordination_relays);
    let transit_snapshot = Arc::new(RwLock::new(TransitSnapshot::default()));
    let transit_snapshot_for_thread = Arc::clone(&transit_snapshot);
    let thread = thread::Builder::new()
        .name("maka-runtime-host-peer".to_owned())
        .spawn(move || {
            let result = run_endpoint(
                options,
                command_rx,
                incoming_tx,
                mesh_incoming_tx,
                ready_tx.clone(),
                active_coordination_relays_for_thread,
                transit_snapshot_for_thread,
            );
            if let Err(error) = result {
                let _ = ready_tx.send(Err(error.clone()));
                let _ = terminal_tx.blocking_send(error);
            }
        })
        .map_err(|error| PeerError::new("peer_native_failed", error.to_string()))?;
    let ready = ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|error| PeerError::new("peer_native_failed", error.to_string()))??;
    Ok(StartedEndpoint {
        peer_id: ready.0,
        listen_addresses: ready.1,
        active_coordination_relays,
        transit_snapshot,
        commands: command_tx,
        incoming: incoming_rx,
        mesh_incoming: mesh_incoming_rx,
        terminal: terminal_rx,
        thread,
    })
}

fn run_endpoint(
    options: StartOptions,
    commands: mpsc::Receiver<EngineCommand>,
    incoming_tx: mpsc::Sender<PeerStream>,
    mesh_incoming_tx: mpsc::Sender<PeerStream>,
    ready_tx: std::sync::mpsc::SyncSender<Result<(PeerId, Vec<Multiaddr>), PeerError>>,
    active_coordination_relays: Arc<RwLock<Vec<Multiaddr>>>,
    transit_snapshot: Arc<RwLock<TransitSnapshot>>,
) -> Result<(), PeerError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("maka-peer-io")
        .build()
        .map_err(|error| PeerError::new("peer_native_failed", error.to_string()))?;
    runtime.block_on(run_endpoint_async(
        options,
        commands,
        incoming_tx,
        mesh_incoming_tx,
        ready_tx,
        active_coordination_relays,
        transit_snapshot,
    ))
}

async fn run_endpoint_async(
    options: StartOptions,
    mut commands: mpsc::Receiver<EngineCommand>,
    incoming_tx: mpsc::Sender<PeerStream>,
    mesh_incoming_tx: mpsc::Sender<PeerStream>,
    ready_tx: std::sync::mpsc::SyncSender<Result<(PeerId, Vec<Multiaddr>), PeerError>>,
    active_coordination_relays: Arc<RwLock<Vec<Multiaddr>>>,
    transit_snapshot: Arc<RwLock<TransitSnapshot>>,
) -> Result<(), PeerError> {
    let key = match options.expected_peer_id {
        Some(expected) => {
            let key = identity_store::load_key(&options.key_path).await?;
            if PeerId::from(key.public()) != expected {
                return Err(PeerError::new(
                    "peer_identity_mismatch",
                    "the persisted peer identity does not match the expected PeerId",
                ));
            }
            key
        }
        None => load_or_create_key(&options.key_path).await?,
    };
    let local_peer_id = PeerId::from(key.public());
    let allowed_transit_peers = Arc::new(RwLock::new(HashSet::new()));
    let trusted_transit_relays = Arc::new(RwLock::new(HashSet::new()));
    let (mut swarm, stream_control, mut incoming_streams, mesh_control, mut mesh_incoming) =
        build_swarm(
            key,
            Arc::clone(&allowed_transit_peers),
            Arc::clone(&trusted_transit_relays),
        )?;
    let mut transit = TransitRuntime {
        allowed_peers: allowed_transit_peers,
        approved_relays: HashSet::new(),
        trusted_relays: trusted_transit_relays,
        reservations: HashSet::new(),
        circuits: HashMap::new(),
        listen_addresses: Vec::new(),
        published_addresses: Vec::new(),
        snapshot: transit_snapshot,
    };

    let listen_addresses = if options.listen_addresses.is_empty() {
        vec![
            "/ip4/0.0.0.0/udp/0/quic-v1"
                .parse()
                .expect("constant multiaddr"),
        ]
    } else {
        options.listen_addresses
    };
    let mut pending_listeners = HashSet::new();
    for address in &listen_addresses {
        pending_listeners.insert(
            swarm
                .listen_on(address.clone())
                .map_err(|error| PeerError::new("peer_native_failed", error.to_string()))?,
        );
    }
    let mut coordination_relays = HashMap::new();
    for relay in &options.coordination_relays {
        coordination_relay_peer_id(relay)?;
    }
    for relay in &options.coordination_relays {
        register_coordination_relay(&mut coordination_relays, relay, local_peer_id, true, false)?;
    }
    maintain_coordination_relays(
        &mut swarm,
        &mut coordination_relays,
        &HashMap::new(),
        false,
        Instant::now(),
    );

    let startup_deadline = Instant::now() + Duration::from_secs(10);
    let mut address_quiet_deadline = None;
    let mut bound_addresses = HashSet::new();
    let mut startup_external_candidate_ready = false;
    loop {
        let deadline = address_quiet_deadline
            .unwrap_or(startup_deadline)
            .min(startup_deadline);
        let wait = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(wait, swarm.select_next_some()).await {
            Ok(SwarmEvent::NewListenAddr {
                listener_id,
                address,
            }) if !is_relayed_address(&address) => {
                pending_listeners.remove(&listener_id);
                bound_addresses.insert(address_with_peer(address, local_peer_id));
                if pending_listeners.is_empty() {
                    address_quiet_deadline = Some(Instant::now() + LISTENER_ADDRESS_QUIET_PERIOD);
                }
            }
            Ok(event) => handle_startup_event(
                &mut swarm,
                event,
                &mut coordination_relays,
                &mut startup_external_candidate_ready,
                &mut transit,
            ),
            Err(_) if pending_listeners.is_empty() => break,
            Err(_) => {
                return Err(PeerError::new(
                    "peer_native_failed",
                    "timed out opening peer listener",
                ));
            }
        }
    }
    let mut bound_addresses = bound_addresses.into_iter().collect::<Vec<_>>();
    bound_addresses.sort_unstable_by_key(ToString::to_string);
    transit.listen_addresses.clone_from(&bound_addresses);
    let _ = ready_tx.send(Ok((local_peer_id, bound_addresses)));

    let (opened_tx, mut opened_rx) = mpsc::channel::<OpenedStream>(COMMAND_CAPACITY);
    let (stream_completed_tx, mut stream_completed_rx) =
        mpsc::channel::<CompletedStream>(MAX_ESTABLISHED_CONNECTIONS as usize);
    let mut direct = DirectConnectState::default();
    let mut external_candidate_ready = startup_external_candidate_ready;
    let mut deadline_tick = tokio::time::interval(Duration::from_millis(100));
    deadline_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut discovered_relays = options
        .automatic_relay_discovery
        .then(relay_discovery::spawn);

    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(EngineCommand::Connect { options, stream_kind, result }) => {
                    if direct.pending.contains_key(&options.request_id)
                        || direct.pending.values().any(|connect| connect.peer_id == options.peer_id)
                    {
                        let _ = result.send(Err(PeerError::new(
                            "peer_connect_in_progress",
                            "a connection request with this identity is already in progress",
                        )));
                        continue;
                    }
                    let started = match start_connect(
                        &mut swarm,
                        &mut coordination_relays,
                        &options,
                        local_peer_id,
                        stream_kind,
                        &direct.active,
                    ) {
                        Ok(peers) => peers,
                        Err(error) => {
                            let _ = result.send(Err(error));
                            continue;
                        }
                    };
                    let request_id = options.request_id;
                    let transit_after = if started.direct_routes.is_empty()
                        && options.coordination_relays.is_empty()
                    {
                        Instant::now()
                    } else {
                        Instant::now() + TRANSIT_FALLBACK_DELAY
                    };
                    let retry_coordination = stream_kind == StreamKind::Application
                        && stream_control.has_relayed_connection(options.peer_id);
                    direct.pending.insert(request_id, PendingConnect {
                        peer_id: options.peer_id,
                        result,
                        stream_kind,
                        deadline: Instant::now() + options.deadline,
                        opening: None,
                        dials: HashMap::new(),
                        direct_routes: started.direct_routes,
                        coordination_relays: options.coordination_relays,
                        coordination_relay_peers: started.coordination_relay_peers,
                        transit_relay_peers: started.transit_relay_peers,
                        transit_after,
                        next_route_attempt: Instant::now(),
                        retry_coordination,
                    });
                    retry_connect_routes(
                        &mut swarm,
                        &mut direct,
                        &coordination_relays,
                        &stream_control,
                        external_candidate_ready,
                        Instant::now(),
                    );
                    maybe_open_peer_stream(
                        request_id,
                        &mut direct.pending,
                        &direct.retiring_connections,
                        stream_control.clone(),
                        mesh_control.clone(),
                        opened_tx.clone(),
                    );
                }
                Some(EngineCommand::CancelConnect { request_id, result }) => {
                    let cancelled = if let Some(waiter) = direct.pending.remove(&request_id) {
                        fail_pending_connect(
                            &mut swarm,
                            &mut direct,
                            &mut coordination_relays,
                            waiter,
                            PeerError::new(
                                "peer_connect_cancelled",
                                "the peer connection request was cancelled",
                            ),
                        );
                        true
                    } else {
                        false
                    };
                    let _ = result.send(cancelled);
                }
                Some(EngineCommand::ConfigureTransit {
                    policy,
                    result,
                }) => {
                    let revoked_relays = configure_transit(
                        &mut swarm,
                        &stream_control,
                        &mut coordination_relays,
                        &mut transit,
                        &direct.active,
                        policy,
                        local_peer_id,
                    );
                    reconcile_pending_transit_connects(
                        &mut swarm,
                        &mut direct,
                        &mut coordination_relays,
                        &revoked_relays,
                    );
                    retry_connect_routes(
                        &mut swarm,
                        &mut direct,
                        &coordination_relays,
                        &stream_control,
                        external_candidate_ready,
                        Instant::now(),
                    );
                    let requests = direct.pending.keys().copied().collect::<Vec<_>>();
                    for request_id in requests {
                        maybe_open_peer_stream(
                            request_id,
                            &mut direct.pending,
                            &direct.retiring_connections,
                            stream_control.clone(),
                            mesh_control.clone(),
                            opened_tx.clone(),
                        );
                    }
                    let _ = result.send(());
                }
                Some(EngineCommand::Stop { result }) => {
                    let _ = result.send(());
                    return Ok(());
                }
                None => return Ok(()),
            },
            Some(stream) = incoming_streams.recv() => {
                *direct.active.entry(stream.connection_id).or_default() += 1;
                let peer_stream = spawn_stream(
                    stream.peer_id,
                    stream.stream,
                    Some((
                        StreamCompletion::Application {
                            connection_id: stream.connection_id,
                        },
                        stream_completed_tx.clone(),
                    )),
                );
                if incoming_tx.try_send(peer_stream).is_err() {
                    // Dropping the stream closes it. A slow Host cannot create an unbounded queue.
                }
            }
            Some(stream) = mesh_incoming.recv() => {
                *direct.active.entry(stream.connection_id).or_default() += 1;
                let peer_stream = spawn_stream(
                    stream.peer_id,
                    stream.stream,
                    Some((
                        StreamCompletion::MeshControl {
                            connection_id: stream.connection_id,
                            coordination_relay_peers: Vec::new(),
                        },
                        stream_completed_tx.clone(),
                    )),
                );
                if mesh_incoming_tx.try_send(peer_stream).is_err() {
                    // Dropping the stream applies bounded backpressure to Mesh control callers.
                }
            }
            Some(candidate) = async {
                match &mut discovered_relays {
                    Some(receiver) => receiver.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                discovery_debug(format_args!("candidate {}", candidate.peer_id));
                register_automatic_relay_candidate(
                    &mut coordination_relays,
                    candidate,
                    local_peer_id,
                );
                rebalance_automatic_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    &direct.active,
                    Instant::now(),
                );
                publish_active_coordination_relays(
                    &coordination_relays,
                    &active_coordination_relays,
                );
                maintain_coordination_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    &direct.active,
                    external_candidate_ready,
                    Instant::now(),
                );
            }
            Some(completed) = stream_completed_rx.recv() => {
                match completed.kind {
                    StreamCompletion::Application { connection_id } => {
                        release_active_stream(&mut direct.active, connection_id);
                        let candidates = retained_transit_candidates(&coordination_relays, &transit);
                        reconcile_transit_reservations(
                            &mut swarm,
                            &mut coordination_relays,
                            candidates,
                            &HashSet::new(),
                            local_peer_id,
                            &direct.active,
                            &stream_control,
                        );
                    }
                    StreamCompletion::MeshControl {
                        connection_id,
                        coordination_relay_peers,
                    } => {
                        release_active_stream(&mut direct.active, connection_id);
                        release_coordination_relays(
                            &mut swarm,
                            &mut coordination_relays,
                            &coordination_relay_peers,
                            &direct.active,
                        );
                    }
                }
                let _ = completed.acknowledged.send(());
            }
            Some(opened) = opened_rx.recv() => {
                let request_id = opened.request_id;
                if let Some(mut waiter) = direct.pending.remove(&opened.request_id) {
                    match opened.result {
                        Ok(opened) => {
                            if waiter.stream_kind == StreamKind::Application
                                && opened.relay_peer_id.is_some_and(|relay_peer| {
                                    !waiter.transit_relay_peers.contains(&relay_peer)
                                })
                            {
                                let connection_id = opened.connection_id;
                                direct.retiring_connections.insert(connection_id);
                                let _ = swarm.close_connection(connection_id);
                                waiter.opening.take();
                                waiter.dials.remove(&connection_id);
                                waiter.next_route_attempt = Instant::now();
                                direct.pending.insert(request_id, waiter);
                                retry_connect_routes(
                                    &mut swarm,
                                    &mut direct,
                                    &coordination_relays,
                                    &stream_control,
                                    external_candidate_ready,
                                    Instant::now(),
                                );
                                maybe_open_peer_stream(
                                    request_id,
                                    &mut direct.pending,
                                    &direct.retiring_connections,
                                    stream_control.clone(),
                                    mesh_control.clone(),
                                    opened_tx.clone(),
                                );
                                continue;
                            }
                            let result = match waiter.stream_kind {
                            StreamKind::Application => {
                                let connection_id = opened.connection_id;
                                retire_direct_dials(
                                    &mut swarm,
                                    &mut direct.retiring_connections,
                                    waiter.dials,
                                    Some(connection_id),
                                );
                                *direct.active.entry(connection_id).or_default() += 1;
                                release_coordination_relays(
                                    &mut swarm,
                                    &mut coordination_relays,
                                    &waiter.coordination_relay_peers,
                                    &direct.active,
                                );
                                Ok(spawn_stream(
                                    waiter.peer_id,
                                    opened.stream,
                                    Some((
                                        StreamCompletion::Application { connection_id },
                                        stream_completed_tx.clone(),
                                    )),
                                ))
                            }
                            StreamKind::MeshControl => {
                                let connection_id = opened.connection_id;
                                retire_direct_dials(
                                    &mut swarm,
                                    &mut direct.retiring_connections,
                                    waiter.dials,
                                    None,
                                );
                                *direct.active.entry(connection_id).or_default() += 1;
                                Ok(spawn_stream(
                                    waiter.peer_id,
                                    opened.stream,
                                    Some((
                                        StreamCompletion::MeshControl {
                                            connection_id,
                                            coordination_relay_peers: waiter
                                                .coordination_relay_peers,
                                        },
                                        stream_completed_tx.clone(),
                                    )),
                                ))
                            }
                            };
                            let _ = waiter.result.send(result);
                        }
                        Err(message) => {
                            let code = match waiter.stream_kind {
                                StreamKind::Application
                                    if !waiter.transit_relay_peers.is_empty() =>
                                {
                                    "transit_unavailable"
                                }
                                StreamKind::Application => "direct_path_unavailable",
                                StreamKind::MeshControl => "mesh_control_unavailable",
                            };
                            fail_pending_connect(
                                &mut swarm,
                                &mut direct,
                                &mut coordination_relays,
                                waiter,
                                PeerError::new(code, message),
                            );
                        }
                    }
                }
            }
            event = swarm.select_next_some() => {
                handle_swarm_event(
                    &mut swarm,
                    event,
                    &mut coordination_relays,
                    &mut direct,
                    &mut external_candidate_ready,
                    RouteRuntime {
                        active_coordination_relays: &active_coordination_relays,
                        transit: &mut transit,
                    },
                );
                rebalance_automatic_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    &direct.active,
                    Instant::now(),
                );
                publish_active_coordination_relays(
                    &coordination_relays,
                    &active_coordination_relays,
                );
                maintain_coordination_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    &direct.active,
                    external_candidate_ready,
                    Instant::now(),
                );
                let requests = direct.pending.keys().copied().collect::<Vec<_>>();
                for request_id in requests {
                    maybe_open_peer_stream(
                        request_id,
                        &mut direct.pending,
                        &direct.retiring_connections,
                        stream_control.clone(),
                        mesh_control.clone(),
                        opened_tx.clone(),
                    );
                }
            }
            _ = deadline_tick.tick() => {
                let now = Instant::now();
                rebalance_automatic_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    &direct.active,
                    now,
                );
                publish_active_coordination_relays(
                    &coordination_relays,
                    &active_coordination_relays,
                );
                maintain_coordination_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    &direct.active,
                    external_candidate_ready,
                    now,
                );
                retry_connect_routes(
                    &mut swarm,
                    &mut direct,
                    &coordination_relays,
                    &stream_control,
                    external_candidate_ready,
                    now,
                );
                let expired = direct.pending.iter()
                    .filter_map(|(request_id, item)| (item.deadline <= now).then_some(*request_id))
                    .collect::<Vec<_>>();
                for request_id in expired {
                    if let Some(waiter) = direct.pending.remove(&request_id) {
                        let (code, message) = match waiter.stream_kind {
                            StreamKind::Application
                                if !waiter.transit_relay_peers.is_empty() => (
                                "transit_unavailable",
                                "no direct or approved transit path was established before the deadline",
                            ),
                            StreamKind::Application => (
                                "direct_path_unavailable",
                                "no direct path was established before the deadline",
                            ),
                            StreamKind::MeshControl => (
                                "mesh_control_unavailable",
                                "no Mesh control path was established before the deadline",
                            ),
                        };
                        fail_pending_connect(
                            &mut swarm,
                            &mut direct,
                            &mut coordination_relays,
                            waiter,
                            PeerError::new(code, message),
                        );
                    }
                }
            }
        }
    }
}

type BuiltSwarm = (
    Swarm<Behaviour>,
    application_stream::Control,
    mpsc::Receiver<application_stream::InboundStream>,
    application_stream::Control,
    mpsc::Receiver<application_stream::InboundStream>,
);

fn build_swarm(
    key: identity::Keypair,
    allowed_transit_peers: Arc<RwLock<HashSet<PeerId>>>,
    trusted_transit_relays: Arc<RwLock<HashSet<PeerId>>>,
) -> Result<BuiltSwarm, PeerError> {
    let (application_stream, control, incoming) = application_stream::Behaviour::new(
        StreamProtocol::new(APPLICATION_PROTOCOL),
        INCOMING_STREAM_CAPACITY,
        Some(trusted_transit_relays),
    );
    let (mesh_stream, mesh_control, mesh_incoming) = application_stream::Behaviour::new(
        StreamProtocol::new(MESH_CONTROL_PROTOCOL),
        MESH_INCOMING_STREAM_CAPACITY,
        None,
    );
    let swarm = SwarmBuilder::with_existing_identity(key)
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )
        .map_err(native_error)?
        .with_quic()
        .with_dns()
        .map_err(native_error)?
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .map_err(native_error)?
        .with_behaviour(move |key, relay_client| Behaviour {
            connection_limits: connection_limits::Behaviour::new(
                connection_limits::ConnectionLimits::default()
                    .with_max_pending_incoming(Some(MAX_PENDING_INCOMING_CONNECTIONS))
                    .with_max_pending_outgoing(Some(MAX_PENDING_OUTGOING_CONNECTIONS))
                    .with_max_established_incoming(Some(MAX_ESTABLISHED_INCOMING_CONNECTIONS))
                    .with_max_established_outgoing(Some(MAX_ESTABLISHED_CONNECTIONS))
                    .with_max_established(Some(MAX_ESTABLISHED_CONNECTIONS))
                    .with_max_established_per_peer(Some(MAX_CONNECTIONS_PER_PEER)),
            ),
            relay_client,
            relay_server: relay::Behaviour::new(
                key.public().to_peer_id(),
                transit_relay_config(allowed_transit_peers),
            ),
            dcutr: dcutr::Behaviour::new(key.public().to_peer_id()),
            identify: identify::Behaviour::new(identify::Config::new(
                IDENTIFY_PROTOCOL.to_owned(),
                key.public(),
            )),
            ping: ping::Behaviour::new(ping::Config::new()),
            application_stream,
            mesh_control: mesh_stream,
        })
        .map_err(native_error)
        .map(|builder| {
            builder.with_swarm_config(|config| {
                config.with_idle_connection_timeout(IDLE_CONNECTION_TIMEOUT)
            })
        })
        .map(|builder| builder.build())?;
    Ok((swarm, control, incoming, mesh_control, mesh_incoming))
}

fn transit_relay_config(allowed_peers: Arc<RwLock<HashSet<PeerId>>>) -> relay::Config {
    let mut config = relay::Config {
        max_reservations: MAX_TRANSIT_RESERVATIONS,
        max_reservations_per_peer: relay_excess_limit(1),
        reservation_duration: MAX_TRANSIT_CIRCUIT_DURATION,
        max_circuits: MAX_TRANSIT_CIRCUITS,
        max_circuits_per_peer: relay_excess_limit(MAX_TRANSIT_CIRCUITS_PER_PEER),
        max_circuit_duration: MAX_TRANSIT_CIRCUIT_DURATION,
        max_circuit_bytes: MAX_TRANSIT_CIRCUIT_BYTES,
        ..relay::Config::default()
    };
    let reservation_peers = Arc::clone(&allowed_peers);
    config
        .reservation_rate_limiters
        .push(Box::new(AllowedPeerLimiter(reservation_peers)));
    config
        .circuit_src_rate_limiters
        .push(Box::new(AllowedPeerLimiter(allowed_peers)));
    config
}

fn relay_excess_limit(maximum: usize) -> usize {
    // libp2p-relay 0.21 rejects the next request only when the current count is
    // greater than this value, so its configured boundary is one below the
    // inclusive maximum exposed by Maka.
    maximum
        .checked_sub(1)
        .expect("transit relay limits must be positive")
}

fn start_connect(
    swarm: &mut Swarm<Behaviour>,
    coordination_relays: &mut HashMap<PeerId, CoordinationRelay>,
    options: &ConnectOptions,
    local_peer_id: PeerId,
    stream_kind: StreamKind,
    active_streams: &HashMap<ConnectionId, usize>,
) -> Result<StartedConnect, PeerError> {
    if options.route_hints.is_empty()
        && options.coordination_relays.is_empty()
        && options.transit_relay_peers.is_empty()
    {
        let code = match stream_kind {
            StreamKind::Application => "direct_path_unavailable",
            StreamKind::MeshControl => "mesh_control_unavailable",
        };
        return Err(PeerError::new(
            code,
            "the peer profile has no direct, coordination, or transit route",
        ));
    }
    let mut relay_peers = Vec::new();
    for relay_address in &options.coordination_relays {
        let relay_peer = coordination_relay_peer_id(relay_address)?;
        validate_relay_target(
            relay_peer,
            options.peer_id,
            local_peer_id,
            "coordination_unavailable",
            "coordination relay",
        )?;
        if !relay_peers.contains(&relay_peer) {
            relay_peers.push(relay_peer);
        }
    }
    for relay_peer in &options.transit_relay_peers {
        validate_relay_target(
            *relay_peer,
            options.peer_id,
            local_peer_id,
            "transit_unavailable",
            "transit relay",
        )?;
    }
    let direct_targets = options
        .route_hints
        .iter()
        .map(|address| address_with_expected_peer(address, options.peer_id))
        .collect::<Result<Vec<_>, _>>()?;
    let mut referenced = HashSet::new();
    for relay_address in &options.coordination_relays {
        let relay_peer = coordination_relay_peer_id(relay_address)
            .expect("coordination relay was validated before registration");
        register_coordination_relay(
            coordination_relays,
            relay_address,
            local_peer_id,
            false,
            referenced.insert(relay_peer),
        )?;
    }
    maintain_coordination_relays(
        swarm,
        coordination_relays,
        active_streams,
        false,
        Instant::now(),
    );
    Ok(StartedConnect {
        direct_routes: direct_targets,
        coordination_relay_peers: relay_peers,
        transit_relay_peers: options.transit_relay_peers.iter().copied().collect(),
    })
}

fn validate_relay_target(
    relay_peer: PeerId,
    target_peer: PeerId,
    local_peer: PeerId,
    error_code: &'static str,
    label: &str,
) -> Result<(), PeerError> {
    if relay_peer == target_peer {
        return Err(PeerError::new(
            error_code,
            format!("{label} cannot be the target peer"),
        ));
    }
    if relay_peer == local_peer {
        return Err(PeerError::new(
            error_code,
            format!("peer endpoint cannot use itself as a {label}"),
        ));
    }
    Ok(())
}

fn release_active_stream(active: &mut HashMap<ConnectionId, usize>, connection_id: ConnectionId) {
    let Some(streams) = active.get_mut(&connection_id) else {
        return;
    };
    *streams -= 1;
    if *streams == 0 {
        active.remove(&connection_id);
    }
}

fn maybe_open_peer_stream(
    request_id: u32,
    pending: &mut HashMap<u32, PendingConnect>,
    retiring_connections: &HashSet<ConnectionId>,
    mut application_control: application_stream::Control,
    mut mesh_control: application_stream::Control,
    opened_tx: mpsc::Sender<OpenedStream>,
) {
    let Some(waiter) = pending.get_mut(&request_id) else {
        return;
    };
    let peer_id = waiter.peer_id;
    let eligible_relay_peers = match waiter.stream_kind {
        StreamKind::Application => waiter.transit_relay_peers.clone(),
        StreamKind::MeshControl => waiter
            .coordination_relay_peers
            .iter()
            .copied()
            .chain(waiter.transit_relay_peers.iter().copied())
            .collect(),
    };
    let available = match waiter.stream_kind {
        StreamKind::Application => {
            application_control.has_connection(peer_id, retiring_connections, &eligible_relay_peers)
        }
        StreamKind::MeshControl => {
            mesh_control.has_connection(peer_id, retiring_connections, &eligible_relay_peers)
        }
    };
    if waiter.opening.is_some() || !available {
        return;
    }
    let stream_kind = waiter.stream_kind;
    let retiring_connections = retiring_connections.clone();
    waiter.opening = Some(tokio::spawn(async move {
        let control = match stream_kind {
            StreamKind::Application => &mut application_control,
            StreamKind::MeshControl => &mut mesh_control,
        };
        let result = control
            .open_stream(peer_id, &retiring_connections, &eligible_relay_peers)
            .await
            .map_err(|error| error.to_string());
        let _ = opened_tx.send(OpenedStream { request_id, result }).await;
    }));
}

fn handle_swarm_event(
    swarm: &mut Swarm<Behaviour>,
    event: SwarmEvent<BehaviourEvent>,
    coordination_relays: &mut HashMap<PeerId, CoordinationRelay>,
    direct: &mut DirectConnectState,
    external_candidate_ready: &mut bool,
    route_runtime: RouteRuntime<'_>,
) {
    match event {
        SwarmEvent::ConnectionEstablished {
            peer_id,
            connection_id,
            endpoint,
            ..
        } => {
            discovery_debug(format_args!(
                "connection established peer={peer_id} relayed={}",
                endpoint.is_relayed()
            ));
            if direct.retiring_connections.contains(&connection_id) {
                let _ = swarm.close_connection(connection_id);
                return;
            }
            if let Some(relay) = coordination_relays.get_mut(&peer_id) {
                let lifecycle_owned = relay.pending_connection == Some(connection_id);
                if lifecycle_owned {
                    relay.pending_connection = None;
                }
                if relay.is_active() {
                    relay.connections.insert(connection_id);
                    if lifecycle_owned {
                        relay.owned_connections.insert(connection_id);
                    }
                    if endpoint.is_relayed() {
                        relay.relayed_connections.insert(connection_id);
                    } else {
                        relay.replace_relayed_at = None;
                        relay.direct_connection_addresses.insert(
                            connection_id,
                            address_with_peer(endpoint.get_remote_address().clone(), peer_id),
                        );
                    }
                }
            }
            for connect in direct.pending.values_mut() {
                connect.dials.remove(&connection_id);
            }
        }
        SwarmEvent::ConnectionClosed {
            peer_id,
            connection_id,
            ..
        } => {
            direct.retiring_connections.remove(&connection_id);
            for connect in direct.pending.values_mut() {
                connect.dials.remove(&connection_id);
            }
            direct.active.remove(&connection_id);
            if let Some(relay) = coordination_relays.get_mut(&peer_id) {
                relay.connections.remove(&connection_id);
                relay.owned_connections.remove(&connection_id);
                relay.relayed_connections.remove(&connection_id);
                relay.direct_connection_addresses.remove(&connection_id);
            }
            let mut reservation_changed = false;
            let mut discard_automatic = false;
            if !swarm.is_connected(&peer_id)
                && let Some(relay) = coordination_relays.get_mut(&peer_id)
                && relay.is_active()
            {
                let was_accepted = relay.reservation_accepted;
                discovery_debug(format_args!(
                    "connection to {peer_id} closed; reservation accepted={was_accepted}"
                ));
                if let Some(listener) = relay.connection_lost(Instant::now()) {
                    swarm.remove_listener(listener);
                }
                reservation_changed = true;
                discard_automatic = relay.is_automatic() && !was_accepted;
            }
            if discard_automatic {
                discard_automatic_relay_candidate(
                    swarm,
                    coordination_relays,
                    peer_id,
                    &direct.active,
                );
            }
            if reservation_changed {
                publish_active_coordination_relays(
                    coordination_relays,
                    route_runtime.active_coordination_relays,
                );
            }
        }
        SwarmEvent::OutgoingConnectionError {
            connection_id,
            error,
            ..
        } => {
            discovery_debug(format_args!("outgoing connection failed: {error}"));
            direct.retiring_connections.remove(&connection_id);
            for connect in direct.pending.values_mut() {
                connect.dials.remove(&connection_id);
            }
            let mut failed_automatic = None;
            for (peer_id, relay) in coordination_relays.iter_mut() {
                if relay.pending_connection == Some(connection_id) {
                    relay.pending_connection = None;
                    if relay.is_automatic() && !relay.reservation_accepted {
                        failed_automatic = Some(*peer_id);
                    }
                    break;
                }
            }
            if let Some(peer_id) = failed_automatic {
                discard_automatic_relay_candidate(
                    swarm,
                    coordination_relays,
                    peer_id,
                    &direct.active,
                );
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Dcutr(dcutr::Event {
            remote_peer_id,
            result: Err(_),
        })) => {
            if let Some(relay) = coordination_relays.get_mut(&remote_peer_id)
                && (!relay.transit_addresses.is_empty()
                    || !relay.transit_coordination_relays.is_empty())
            {
                relay.replace_relayed_at = Some(Instant::now() + TRANSIT_HOLE_PUNCH_RETRY_INTERVAL);
            }
            for connect in direct.pending.values_mut().filter(|connect| {
                connect.peer_id == remote_peer_id && connect.stream_kind == StreamKind::Application
            }) {
                connect.retry_coordination = true;
                connect.next_route_attempt = Instant::now();
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Dcutr(dcutr::Event {
            remote_peer_id,
            result: Ok(_),
        })) => {
            if let Some(relay) = coordination_relays.get_mut(&remote_peer_id) {
                relay.replace_relayed_at = None;
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::RelayClient(
            relay::client::Event::ReservationReqAccepted { relay_peer_id, .. },
        )) => {
            discovery_debug(format_args!("reservation accepted by {relay_peer_id}"));
            if let Some(relay) = coordination_relays.get_mut(&relay_peer_id) {
                relay.reservation_accepted = true;
            }
            publish_active_coordination_relays(
                coordination_relays,
                route_runtime.active_coordination_relays,
            );
        }
        SwarmEvent::Behaviour(BehaviourEvent::RelayServer(event)) => {
            handle_transit_event(route_runtime.transit, event);
        }
        SwarmEvent::NewListenAddr {
            listener_id,
            address,
        } if is_relayed_address(&address) => {
            let relay_peer = coordination_relays.iter().find_map(|(peer_id, relay)| {
                (relay.reservation_listener == Some(listener_id)).then_some(*peer_id)
            });
            if let Some(relay_peer) = relay_peer {
                let automatic = coordination_relays
                    .get(&relay_peer)
                    .is_some_and(CoordinationRelay::is_automatic);
                if let Some(base_address) = reservation_base_address(address, relay_peer, automatic)
                {
                    if let Some(relay) = coordination_relays.get_mut(&relay_peer) {
                        remember_reservation_address(relay, base_address);
                    }
                } else if automatic {
                    if let Some(relay) = coordination_relays.get_mut(&relay_peer) {
                        relay.reservation_accepted = false;
                    }
                    discard_automatic_relay_candidate(
                        swarm,
                        coordination_relays,
                        relay_peer,
                        &direct.active,
                    );
                }
                publish_active_coordination_relays(
                    coordination_relays,
                    route_runtime.active_coordination_relays,
                );
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received {
            peer_id,
            ..
        })) => {
            if let Some(relay) = coordination_relays.get_mut(&peer_id) {
                relay.identify_received = true;
            }
            request_coordination_reservation(
                swarm,
                coordination_relays,
                peer_id,
                *external_candidate_ready,
                Instant::now(),
            );
        }
        SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Sent {
            peer_id, ..
        })) => {
            if let Some(relay) = coordination_relays.get_mut(&peer_id) {
                relay.identify_sent = true;
            }
            request_coordination_reservation(
                swarm,
                coordination_relays,
                peer_id,
                *external_candidate_ready,
                Instant::now(),
            );
        }
        SwarmEvent::NewExternalAddrCandidate { .. } => {
            *external_candidate_ready = true;
            for peer_id in coordination_relays.keys().copied().collect::<Vec<_>>() {
                request_coordination_reservation(
                    swarm,
                    coordination_relays,
                    peer_id,
                    true,
                    Instant::now(),
                );
            }
        }
        SwarmEvent::ListenerClosed {
            listener_id,
            reason,
            ..
        } => {
            discovery_debug(format_args!(
                "reservation listener {listener_id:?} closed: {reason:?}"
            ));
            let mut changed = false;
            let mut rejected_automatic = None;
            for (peer_id, relay) in coordination_relays.iter_mut() {
                let was_accepted = relay.reservation_accepted;
                if relay.listener_closed(listener_id, Instant::now()) {
                    if relay.is_automatic() && !was_accepted {
                        rejected_automatic = Some(*peer_id);
                    }
                    changed = true;
                    break;
                }
            }
            if let Some(peer_id) = rejected_automatic {
                discard_automatic_relay_candidate(
                    swarm,
                    coordination_relays,
                    peer_id,
                    &direct.active,
                );
            }
            if changed {
                publish_active_coordination_relays(
                    coordination_relays,
                    route_runtime.active_coordination_relays,
                );
            }
        }
        _ => {}
    }
}

fn handle_startup_event(
    swarm: &mut Swarm<Behaviour>,
    event: SwarmEvent<BehaviourEvent>,
    coordination_relays: &mut HashMap<PeerId, CoordinationRelay>,
    external_candidate_ready: &mut bool,
    transit: &mut TransitRuntime,
) {
    handle_swarm_event(
        swarm,
        event,
        coordination_relays,
        &mut DirectConnectState::default(),
        external_candidate_ready,
        RouteRuntime {
            active_coordination_relays: &Arc::new(RwLock::new(Vec::new())),
            transit,
        },
    );
}

fn configure_transit(
    swarm: &mut Swarm<Behaviour>,
    application_stream: &application_stream::Control,
    coordination_relays: &mut HashMap<PeerId, CoordinationRelay>,
    transit: &mut TransitRuntime,
    active_streams: &HashMap<ConnectionId, usize>,
    policy: TransitPolicy,
    local_peer_id: PeerId,
) -> HashSet<PeerId> {
    let TransitPolicy {
        allowed_peers,
        approved_relays,
        relays,
    } = policy;
    let trusted_relays = relays
        .iter()
        .map(|candidate| candidate.peer_id)
        .collect::<HashSet<_>>();
    let was_enabled = transit
        .allowed_peers
        .read()
        .map(|current| !current.is_empty())
        .unwrap_or(false);
    let enabled = !allowed_peers.is_empty();
    let removed_allowed_peers = transit
        .allowed_peers
        .read()
        .map(|current| {
            current
                .difference(&allowed_peers)
                .copied()
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let removed_trusted_relays = transit
        .trusted_relays
        .read()
        .map(|current| {
            current
                .difference(&trusted_relays)
                .copied()
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let revoked_relays = transit
        .approved_relays
        .difference(&approved_relays)
        .copied()
        .collect::<HashSet<_>>();
    if let Ok(mut current) = transit.allowed_peers.write() {
        *current = allowed_peers;
    }
    if let Ok(mut current) = transit.trusted_relays.write() {
        *current = trusted_relays;
    }
    transit.approved_relays = approved_relays;
    if enabled && !was_enabled {
        let existing = swarm.external_addresses().cloned().collect::<HashSet<_>>();
        transit.published_addresses = transit
            .listen_addresses
            .iter()
            .filter(|address| !existing.contains(*address))
            .cloned()
            .collect();
        for address in &transit.published_addresses {
            swarm.add_external_address(address.clone());
        }
    } else if !enabled && was_enabled {
        for address in transit.published_addresses.drain(..) {
            swarm.remove_external_address(&address);
        }
    }
    for peer_id in removed_allowed_peers.iter().copied().filter(|peer_id| {
        transit.reservations.contains(peer_id)
            || transit
                .circuits
                .keys()
                .any(|(source, destination)| source == peer_id || destination == peer_id)
    }) {
        let _ = swarm.disconnect_peer_id(peer_id);
    }
    for connection_id in application_stream.connections_via(&revoked_relays) {
        let _ = swarm.close_connection(connection_id);
    }
    reconcile_transit_reservations(
        swarm,
        coordination_relays,
        relays,
        &revoked_relays,
        local_peer_id,
        active_streams,
        application_stream,
    );
    publish_transit_snapshot(transit);
    removed_trusted_relays
        .union(&revoked_relays)
        .copied()
        .collect()
}

fn reconcile_pending_transit_connects(
    swarm: &mut Swarm<Behaviour>,
    direct: &mut DirectConnectState,
    coordination_relays: &mut HashMap<PeerId, CoordinationRelay>,
    revoked_relays: &HashSet<PeerId>,
) {
    if revoked_relays.is_empty() {
        return;
    }
    let now = Instant::now();
    let mut unavailable = Vec::new();
    for (request_id, waiter) in &mut direct.pending {
        if waiter.stream_kind != StreamKind::Application
            || waiter.transit_relay_peers.is_disjoint(revoked_relays)
        {
            continue;
        }
        waiter
            .transit_relay_peers
            .retain(|peer| !revoked_relays.contains(peer));
        if let Some(opening) = waiter.opening.take() {
            opening.abort();
        }
        retire_pending_dials_by_origin(
            swarm,
            &mut direct.retiring_connections,
            waiter,
            DialOrigin::Transit,
        );
        waiter.next_route_attempt = now;
        waiter.transit_after = now;
        if waiter.direct_routes.is_empty()
            && waiter.coordination_relays.is_empty()
            && waiter.transit_relay_peers.is_empty()
        {
            unavailable.push(*request_id);
        }
    }
    for request_id in unavailable {
        let Some(waiter) = direct.pending.remove(&request_id) else {
            continue;
        };
        fail_pending_connect(
            swarm,
            direct,
            coordination_relays,
            waiter,
            PeerError::new(
                "transit_unavailable",
                "transit policy changed while the peer connection was pending",
            ),
        );
    }
}

fn retire_pending_dials_by_origin(
    swarm: &mut Swarm<Behaviour>,
    retiring: &mut HashSet<ConnectionId>,
    waiter: &mut PendingConnect,
    origin: DialOrigin,
) {
    let connections = waiter
        .dials
        .iter()
        .filter_map(|(connection_id, current)| (*current == origin).then_some(*connection_id))
        .collect::<Vec<_>>();
    for connection_id in connections {
        waiter.dials.remove(&connection_id);
        retiring.insert(connection_id);
        let _ = swarm.close_connection(connection_id);
    }
}

fn fail_pending_connect(
    swarm: &mut Swarm<Behaviour>,
    direct: &mut DirectConnectState,
    coordination_relays: &mut HashMap<PeerId, CoordinationRelay>,
    mut waiter: PendingConnect,
    error: PeerError,
) {
    if let Some(opening) = waiter.opening.take() {
        opening.abort();
    }
    retire_direct_dials(swarm, &mut direct.retiring_connections, waiter.dials, None);
    release_coordination_relays(
        swarm,
        coordination_relays,
        &waiter.coordination_relay_peers,
        &direct.active,
    );
    let _ = waiter.result.send(Err(error));
}

fn reconcile_transit_reservations(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    candidates: Vec<TransitRelayCandidate>,
    revoked_relays: &HashSet<PeerId>,
    local_peer_id: PeerId,
    active_streams: &HashMap<ConnectionId, usize>,
    application_stream: &application_stream::Control,
) {
    let active_relays = application_stream.relays_with_active_streams(active_streams);
    let desired = candidates
        .into_iter()
        .filter(|candidate| candidate.peer_id != local_peer_id)
        .map(|candidate| (candidate.peer_id, candidate))
        .collect::<HashMap<_, _>>();
    let mut bootstrap = HashMap::<PeerId, (Vec<Multiaddr>, usize)>::new();
    for candidate in desired.values() {
        for address in &candidate.coordination_relays {
            let peer_id = coordination_relay_peer_id(address)
                .expect("transit bootstrap relay was validated before reconciliation");
            if peer_id == local_peer_id || peer_id == candidate.peer_id {
                continue;
            }
            let entry = bootstrap.entry(peer_id).or_default();
            remember_relay_address(&mut entry.0, address.clone());
            entry.1 += 1;
        }
    }

    let mut peer_ids = relays.keys().copied().collect::<HashSet<_>>();
    peer_ids.extend(desired.keys().copied());
    peer_ids.extend(bootstrap.keys().copied());
    for peer_id in peer_ids {
        let relay = relays.entry(peer_id).or_default();
        let retain_live_route =
            active_relays.contains(&peer_id) && !revoked_relays.contains(&peer_id);
        let next_transit_addresses = if let Some(candidate) = desired.get(&peer_id) {
            candidate.addresses.clone()
        } else if retain_live_route {
            relay.transit_addresses.clone()
        } else {
            Vec::new()
        };
        let next_transit_coordination_relays = if let Some(candidate) = desired.get(&peer_id) {
            candidate.coordination_relays.clone()
        } else if retain_live_route {
            relay.transit_coordination_relays.clone()
        } else {
            Vec::new()
        };
        let (next_bootstrap_addresses, next_bootstrap_references) =
            bootstrap.get(&peer_id).cloned().unwrap_or_default();
        let reachability_changed = relay.transit_addresses != next_transit_addresses
            || relay.transit_coordination_relays != next_transit_coordination_relays
            || relay.transit_bootstrap_addresses != next_bootstrap_addresses
            || relay.transit_bootstrap_references != next_bootstrap_references;
        relay.transit_addresses = next_transit_addresses;
        relay.transit_coordination_relays = next_transit_coordination_relays;
        relay.transit_bootstrap_addresses = next_bootstrap_addresses;
        relay.transit_bootstrap_references = next_bootstrap_references;
        if reachability_changed {
            let now = Instant::now();
            relay.next_connection_attempt = now;
            relay.next_reservation_attempt = now;
            let has_direct_connection = relay
                .connections
                .iter()
                .any(|connection| !relay.relayed_connections.contains(connection));
            let has_owned_relayed_connection = relay
                .owned_connections
                .iter()
                .any(|connection| relay.relayed_connections.contains(connection));
            if !has_direct_connection && has_owned_relayed_connection {
                relay.replace_relayed_at = Some(now + TRANSIT_HOLE_PUNCH_RETRY_INTERVAL);
            }
        }
    }

    for peer_id in relays
        .iter()
        .filter_map(|(peer_id, relay)| (!relay.is_active()).then_some(*peer_id))
        .collect::<Vec<_>>()
    {
        let mut relay = relays
            .remove(&peer_id)
            .expect("inactive relay was just observed");
        relay.reservation_accepted = false;
        relay.reservation_addresses.clear();
        if let Some(listener) = relay.reservation_listener.take() {
            swarm.remove_listener(listener);
        }
        for connection_id in relay.owned_connections.drain() {
            if !active_streams.contains_key(&connection_id) {
                let _ = swarm.close_connection(connection_id);
            }
        }
        relay.direct_connection_addresses.clear();
    }
    maintain_coordination_relays(swarm, relays, active_streams, true, Instant::now());
}

fn retained_transit_candidates(
    relays: &HashMap<PeerId, CoordinationRelay>,
    transit: &TransitRuntime,
) -> Vec<TransitRelayCandidate> {
    transit
        .trusted_relays
        .read()
        .map(|trusted| {
            trusted
                .iter()
                .filter_map(|peer_id| {
                    let relay = relays.get(peer_id)?;
                    Some(TransitRelayCandidate {
                        peer_id: *peer_id,
                        addresses: relay.transit_addresses.clone(),
                        coordination_relays: relay.transit_coordination_relays.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn handle_transit_event(transit: &mut TransitRuntime, event: relay::Event) {
    match event {
        relay::Event::ReservationReqAccepted { src_peer_id, .. } => {
            transit.reservations.insert(src_peer_id);
        }
        relay::Event::ReservationClosed { src_peer_id }
        | relay::Event::ReservationTimedOut { src_peer_id } => {
            transit.reservations.remove(&src_peer_id);
        }
        relay::Event::CircuitReqAccepted {
            src_peer_id,
            dst_peer_id,
        } => {
            *transit
                .circuits
                .entry((src_peer_id, dst_peer_id))
                .or_insert(0) += 1;
        }
        relay::Event::CircuitClosed {
            src_peer_id,
            dst_peer_id,
            ..
        } => {
            if let Some(count) = transit.circuits.get_mut(&(src_peer_id, dst_peer_id)) {
                *count -= 1;
                if *count == 0 {
                    transit.circuits.remove(&(src_peer_id, dst_peer_id));
                }
            }
        }
        _ => {}
    }
    publish_transit_snapshot(transit);
}

fn publish_transit_snapshot(transit: &TransitRuntime) {
    let allowed_peer_count = transit
        .allowed_peers
        .read()
        .map(|peers| peers.len())
        .unwrap_or_default();
    if let Ok(mut snapshot) = transit.snapshot.write() {
        *snapshot = TransitSnapshot {
            allowed_peer_count,
            active_reservation_count: transit.reservations.len(),
            active_circuit_count: transit.circuits.values().sum(),
            ..TransitSnapshot::default()
        };
    }
}

fn register_coordination_relay(
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    address: &Multiaddr,
    local_peer_id: PeerId,
    reserve: bool,
    add_client_reference: bool,
) -> Result<(), PeerError> {
    let relay_peer = coordination_relay_peer_id(address)?;
    if relay_peer == local_peer_id {
        return Err(PeerError::new(
            "coordination_unavailable",
            "peer endpoint cannot use itself as a coordination relay",
        ));
    }
    let relay = relays.entry(relay_peer).or_default();
    if reserve {
        relay.automatic_addresses.clear();
    }
    relay.reserve |= reserve;
    if add_client_reference {
        relay.client_references += 1;
    }
    remember_relay_address(&mut relay.addresses, address.clone());
    Ok(())
}

fn register_automatic_relay_candidate(
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    candidate: relay_discovery::RelayCandidate,
    local_peer_id: PeerId,
) {
    if candidate.peer_id == local_peer_id {
        return;
    }
    if !relays
        .get(&candidate.peer_id)
        .is_some_and(CoordinationRelay::is_automatic)
        && relays.values().filter(|relay| relay.is_automatic()).count()
            >= MAX_AUTOMATIC_RELAY_CANDIDATES
    {
        return;
    }
    let addresses = bounded_relay_addresses(candidate.addresses);
    if addresses.is_empty() {
        return;
    }
    let relay = relays.entry(candidate.peer_id).or_default();
    if (relay.reserve || !relay.transit_addresses.is_empty()) && !relay.is_automatic() {
        return;
    }
    relay.automatic_addresses = addresses;
}

fn rebalance_automatic_relays(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    active_streams: &HashMap<ConnectionId, usize>,
    now: Instant,
) {
    let manual_reservations = relays
        .values()
        .filter(|relay| {
            !relay.is_automatic()
                && relay.reserve
                && relay.reservation_accepted
                && !relay.reservation_addresses.is_empty()
        })
        .count();
    let desired = TARGET_COORDINATION_RESERVATIONS.saturating_sub(manual_reservations);
    let mut automatic = relays
        .iter()
        .filter(|(_, relay)| relay.is_automatic())
        .map(|(peer_id, relay)| (*peer_id, relay.reservation_accepted, relay.reserve))
        .collect::<Vec<_>>();
    automatic.sort_unstable_by_key(|(peer_id, accepted, reserved)| {
        (!*accepted, !*reserved, peer_id.to_string())
    });

    let mut selected = 0;
    for (peer_id, accepted, _) in automatic {
        let relay = relays
            .get_mut(&peer_id)
            .expect("automatic relay was collected from the same map");
        let should_reserve = selected < desired
            && (accepted
                || relay.reservation_listener.is_some()
                || relay.next_reservation_attempt <= now);
        if should_reserve {
            relay.reserve = true;
            selected += 1;
            continue;
        }
        relay.reserve = false;
        if !relay.transit_addresses.is_empty() {
            continue;
        }
        relay.reservation_accepted = false;
        relay.reservation_addresses.clear();
        if let Some(listener) = relay.reservation_listener.take() {
            discovery_debug(format_args!(
                "removing reservation listener for deselected candidate {peer_id}"
            ));
            swarm.remove_listener(listener);
        }
        if relay.client_references == 0 {
            for connection_id in relay.owned_connections.iter().copied() {
                if !active_streams.contains_key(&connection_id) {
                    let _ = swarm.close_connection(connection_id);
                }
            }
        }
    }
}

fn publish_active_coordination_relays(
    relays: &HashMap<PeerId, CoordinationRelay>,
    snapshot: &Arc<RwLock<Vec<Multiaddr>>>,
) {
    let mut addresses = relays
        .values()
        .filter(|relay| relay.reserve && relay.reservation_accepted)
        .flat_map(|relay| relay.reservation_addresses.iter().cloned())
        .collect::<Vec<_>>();
    addresses.sort_unstable_by_key(ToString::to_string);
    addresses.dedup();
    if let Ok(mut current) = snapshot.write() {
        *current = addresses;
    }
}

fn bounded_relay_addresses(mut addresses: Vec<Multiaddr>) -> Vec<Multiaddr> {
    addresses.sort_unstable_by_key(|address| (relay_route_class(address), address.to_string()));
    let mut classes = HashSet::new();
    addresses
        .into_iter()
        .filter(|address| classes.insert(relay_route_class(address)))
        .take(MAX_RELAY_ADDRESSES_PER_PEER)
        .collect()
}

fn relay_route_class(address: &Multiaddr) -> (u8, u8) {
    let mut protocols = address.iter();
    let host = match protocols.next() {
        Some(Protocol::Ip4(_)) => 0,
        Some(Protocol::Ip6(_)) => 1,
        Some(Protocol::Dns(_) | Protocol::Dns4(_) | Protocol::Dns6(_)) => 2,
        _ => 3,
    };
    let transport = match protocols.next() {
        Some(Protocol::Udp(_)) => 0,
        Some(Protocol::Tcp(_)) => 1,
        _ => 2,
    };
    (host, transport)
}

fn reservation_base_address(
    mut address: Multiaddr,
    expected_peer: PeerId,
    require_public: bool,
) -> Option<Multiaddr> {
    if !matches!(address.pop(), Some(Protocol::P2p(_)))
        || !matches!(address.pop(), Some(Protocol::P2pCircuit))
        || coordination_relay_peer_id(&address).ok()? != expected_peer
        || !supported_relay_address(&address, require_public)
    {
        return None;
    }
    Some(address)
}

fn remember_reservation_address(relay: &mut CoordinationRelay, address: Multiaddr) {
    remember_relay_address(&mut relay.reservation_addresses, address);
}

fn remember_relay_address(addresses: &mut Vec<Multiaddr>, address: Multiaddr) {
    let class = relay_route_class(&address);
    if let Some(existing) = addresses
        .iter_mut()
        .find(|existing| relay_route_class(existing) == class)
    {
        *existing = address;
    } else if addresses.len() < MAX_RELAY_ADDRESSES_PER_PEER {
        addresses.push(address);
    }
}

fn supported_public_relay_address(address: &Multiaddr) -> bool {
    supported_relay_address(address, true)
}

fn supported_relay_address(address: &Multiaddr, require_public: bool) -> bool {
    let mut protocols = address.iter();
    let host_supported = match protocols.next() {
        Some(Protocol::Ip4(address)) => !require_public || public_ipv4(address),
        Some(Protocol::Ip6(address)) => !require_public || public_ipv6(address),
        Some(Protocol::Dns(_) | Protocol::Dns4(_) | Protocol::Dns6(_)) => !require_public,
        _ => false,
    };
    if !host_supported {
        return false;
    }
    match protocols.next() {
        Some(Protocol::Tcp(_)) => {
            matches!(protocols.next(), Some(Protocol::P2p(_))) && protocols.next().is_none()
        }
        Some(Protocol::Udp(_)) => {
            matches!(protocols.next(), Some(Protocol::QuicV1))
                && matches!(protocols.next(), Some(Protocol::P2p(_)))
                && protocols.next().is_none()
        }
        _ => false,
    }
}

fn public_ipv4(address: std::net::Ipv4Addr) -> bool {
    let [first, second, third, _] = address.octets();
    !(first == 0
        || first == 10
        || first == 127
        || first >= 224
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 0 && third == 0)
        || (first == 192 && second == 0 && third == 2)
        || (first == 192 && second == 168)
        || (first == 198 && (second == 18 || second == 19))
        || (first == 198 && second == 51 && third == 100)
        || (first == 203 && second == 0 && third == 113))
}

fn public_ipv6(address: std::net::Ipv6Addr) -> bool {
    if let Some(address) = address.to_ipv4() {
        return public_ipv4(address);
    }
    let segments = address.segments();
    segments[0] & 0xe000 == 0x2000
        && !(segments[0] == 0x2001 && segments[1] < 0x0200)
        && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        && segments[0] != 0x2002
        && segments[0] & 0xfff0 != 0x3ff0
}

fn discard_automatic_relay_candidate(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    peer_id: PeerId,
    active_streams: &HashMap<ConnectionId, usize>,
) {
    let Some(relay) = relays.get_mut(&peer_id) else {
        return;
    };
    if !relay.is_automatic() || relay.reservation_accepted {
        return;
    }
    relay.automatic_addresses.clear();
    relay.reserve = false;
    if !relay.transit_addresses.is_empty() {
        relay.next_connection_attempt = Instant::now();
        relay.next_reservation_attempt = Instant::now();
        return;
    }
    relay.reservation_addresses.clear();
    if let Some(listener) = relay.reservation_listener.take() {
        swarm.remove_listener(listener);
    }
    if relay.client_references > 0 {
        return;
    }
    let mut relay = relays
        .remove(&peer_id)
        .expect("automatic relay candidate was read from the same map");
    for connection_id in relay.owned_connections.drain() {
        if !active_streams.contains_key(&connection_id) {
            let _ = swarm.close_connection(connection_id);
        }
    }
}

fn release_coordination_relays(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    peers: &[PeerId],
    active_outbound: &HashMap<ConnectionId, usize>,
) {
    for peer_id in peers {
        let Some(relay) = relays.get_mut(peer_id) else {
            continue;
        };
        debug_assert!(relay.client_references > 0);
        relay.client_references -= 1;
        if relay.is_active() {
            continue;
        }
        relay.addresses.clear();
        if let Some(listener) = relay.reservation_listener.take() {
            swarm.remove_listener(listener);
        }
        for connection_id in relay.owned_connections.iter().copied() {
            if !active_outbound.contains_key(&connection_id) {
                let _ = swarm.close_connection(connection_id);
            }
        }
    }
}

fn dial_coordination_relay(
    swarm: &mut Swarm<Behaviour>,
    peer_id: PeerId,
    relay: &mut CoordinationRelay,
    addresses: Vec<Multiaddr>,
    now: Instant,
) {
    if addresses.is_empty()
        || relay.pending_connection.is_some()
        || relay.next_connection_attempt > now
    {
        return;
    }
    relay.next_connection_attempt = now + COORDINATION_RETRY_INTERVAL;
    let options = DialOpts::peer_id(peer_id)
        .condition(PeerCondition::Always)
        .addresses(addresses)
        .build();
    let connection_id = options.connection_id();
    if swarm.dial(options).is_ok() {
        relay.pending_connection = Some(connection_id);
    }
}

fn maintain_coordination_relays(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    active_streams: &HashMap<ConnectionId, usize>,
    external_candidate_ready: bool,
    now: Instant,
) {
    for peer_id in relays.keys().copied().collect::<Vec<_>>() {
        let Some(relay) = relays.get(&peer_id) else {
            continue;
        };
        if !relay.is_active() {
            continue;
        }
        let transit_provider =
            !relay.transit_addresses.is_empty() || !relay.transit_coordination_relays.is_empty();
        let has_direct_connection = relay
            .connections
            .iter()
            .any(|connection| !relay.relayed_connections.contains(connection));
        let owned_relayed_connections = relay
            .owned_connections
            .intersection(&relay.relayed_connections)
            .copied()
            .collect::<Vec<_>>();
        if transit_provider && !has_direct_connection && !owned_relayed_connections.is_empty() {
            if relay.replace_relayed_at.is_some_and(|retry| retry <= now) {
                let stale = owned_relayed_connections
                    .iter()
                    .copied()
                    .filter(|connection| !active_streams.contains_key(connection))
                    .collect::<Vec<_>>();
                if let Some(relay) = relays.get_mut(&peer_id) {
                    if stale.is_empty() {
                        relay.replace_relayed_at = Some(now + TRANSIT_HOLE_PUNCH_RETRY_INTERVAL);
                    } else {
                        relay.replace_relayed_at = None;
                        relay.next_connection_attempt = now + COORDINATION_RETRY_INTERVAL;
                    }
                }
                for connection_id in stale {
                    let _ = swarm.close_connection(connection_id);
                }
            }
            continue;
        }
        // A connection may have been established before this peer became a
        // coordination or transit relay. Establish one lifecycle-owned
        // connection when no observed direct path can carry the reservation;
        // unrelated application streams remain outside lifecycle cleanup.
        if !has_direct_connection {
            let addresses = relay_dial_addresses(peer_id, relay, relays);
            if let Some(relay) = relays.get_mut(&peer_id) {
                dial_coordination_relay(swarm, peer_id, relay, addresses, now);
            }
            continue;
        }
        request_coordination_reservation(swarm, relays, peer_id, external_candidate_ready, now);
    }
}

fn request_coordination_reservation(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    peer_id: PeerId,
    external_candidate_ready: bool,
    now: Instant,
) {
    let Some(relay) = relays.get_mut(&peer_id) else {
        return;
    };
    // Transit policy can be installed after Identify has already completed on an
    // existing connection. The reservation request still negotiates Relay v2.
    let identified =
        !relay.transit_addresses.is_empty() || (relay.identify_received && relay.identify_sent);
    let transit_provider =
        !relay.transit_addresses.is_empty() || !relay.transit_coordination_relays.is_empty();
    let directly_connected = relay
        .connections
        .iter()
        .any(|connection| !relay.relayed_connections.contains(connection));
    if !(relay.reserve || transit_provider)
        || relay.reservation_listener.is_some()
        || !identified
        || (transit_provider && !directly_connected)
        || !external_candidate_ready
        || relay.next_reservation_attempt > now
    {
        return;
    }
    relay.next_reservation_attempt = now + COORDINATION_RETRY_INTERVAL;
    for address in relay_reservation_addresses(relay) {
        match swarm.listen_on(address.with(Protocol::P2pCircuit)) {
            Ok(listener) => {
                discovery_debug(format_args!("requesting reservation from {peer_id}"));
                relay.reservation_listener = Some(listener);
                break;
            }
            Err(error) => {
                discovery_debug(format_args!(
                    "reservation request for {peer_id} failed: {error}"
                ));
            }
        }
    }
}

fn relay_dial_addresses(
    peer_id: PeerId,
    relay: &CoordinationRelay,
    relays: &HashMap<PeerId, CoordinationRelay>,
) -> Vec<Multiaddr> {
    let mut addresses = relay.addresses.clone();
    addresses.extend(relay.automatic_addresses.iter().cloned());
    addresses.extend(relay.transit_addresses.iter().cloned());
    addresses.extend(relay.transit_bootstrap_addresses.iter().cloned());
    addresses.extend(
        relay
            .transit_coordination_relays
            .iter()
            .filter_map(|address| {
                let bootstrap_peer = coordination_relay_peer_id(address).ok()?;
                let bootstrap = relays.get(&bootstrap_peer)?;
                (bootstrap.identify_received && bootstrap.identify_sent).then(|| {
                    address
                        .clone()
                        .with(Protocol::P2pCircuit)
                        .with(Protocol::P2p(peer_id))
                })
            }),
    );
    addresses.sort_unstable_by_key(ToString::to_string);
    addresses.dedup();
    addresses
}

fn relay_reservation_addresses(relay: &CoordinationRelay) -> Vec<Multiaddr> {
    if relay.is_automatic() {
        relay.automatic_addresses.clone()
    } else {
        let mut addresses = relay.addresses.clone();
        addresses.extend(relay.transit_addresses.iter().cloned());
        addresses.extend(relay.direct_connection_addresses.values().cloned());
        addresses.sort_unstable_by_key(ToString::to_string);
        addresses.dedup();
        addresses
    }
}

fn discovery_debug(message: std::fmt::Arguments<'_>) {
    if std::env::var_os("MAKA_PEER_DISCOVERY_DEBUG").is_some() {
        eprintln!("[peer-relay-pool] {message}");
    }
}

fn retry_connect_routes(
    swarm: &mut Swarm<Behaviour>,
    direct: &mut DirectConnectState,
    coordination_relays: &HashMap<PeerId, CoordinationRelay>,
    stream_control: &application_stream::Control,
    external_candidate_ready: bool,
    now: Instant,
) {
    for connect in direct.pending.values_mut() {
        let peer_id = connect.peer_id;
        if connect.next_route_attempt > now {
            continue;
        }
        if stream_control.has_connection(
            peer_id,
            &direct.retiring_connections,
            &connect.transit_relay_peers,
        ) {
            continue;
        }
        connect.next_route_attempt = now + COORDINATION_RETRY_INTERVAL;
        if !connect
            .dials
            .values()
            .any(|origin| *origin == DialOrigin::Direct)
            && let Some(connection_id) =
                dial_direct_targets(swarm, peer_id, connect.direct_routes.clone())
        {
            connect.dials.insert(connection_id, DialOrigin::Direct);
        }
        if !connect
            .dials
            .values()
            .any(|origin| *origin == DialOrigin::Coordination)
            && (connect.retry_coordination || !stream_control.has_relayed_connection(peer_id))
        {
            let mut targets = Vec::new();
            for relay in &connect.coordination_relays {
                let relay_peer = coordination_relay_peer_id(relay)
                    .expect("coordination relay was validated before connecting");
                if !external_candidate_ready
                    || coordination_relays
                        .get(&relay_peer)
                        .is_none_or(|relay| !relay.identify_received || !relay.identify_sent)
                {
                    continue;
                }
                targets.push(
                    relay
                        .clone()
                        .with(Protocol::P2pCircuit)
                        .with(Protocol::P2p(peer_id)),
                );
            }
            if let Some(connection_id) = dial_direct_targets(swarm, peer_id, targets) {
                connect
                    .dials
                    .insert(connection_id, DialOrigin::Coordination);
                connect.retry_coordination = false;
            }
        }

        if now >= connect.transit_after
            && !connect
                .dials
                .values()
                .any(|origin| *origin == DialOrigin::Transit)
            && let Some(connection_id) = dial_direct_targets(
                swarm,
                peer_id,
                connect
                    .transit_relay_peers
                    .iter()
                    .filter_map(|relay_peer| coordination_relays.get(relay_peer))
                    .flat_map(|relay| {
                        relay
                            .transit_addresses
                            .iter()
                            .chain(relay.direct_connection_addresses.values())
                    })
                    .map(|address| {
                        address
                            .clone()
                            .with(Protocol::P2pCircuit)
                            .with(Protocol::P2p(peer_id))
                    })
                    .collect(),
            )
        {
            connect.dials.insert(connection_id, DialOrigin::Transit);
        }
    }
}

fn dial_direct_targets(
    swarm: &mut Swarm<Behaviour>,
    peer_id: PeerId,
    addresses: Vec<Multiaddr>,
) -> Option<ConnectionId> {
    if addresses.is_empty() {
        return None;
    }
    let options = DialOpts::peer_id(peer_id)
        .condition(PeerCondition::Always)
        .addresses(addresses)
        .build();
    let connection_id = options.connection_id();
    swarm.dial(options).is_ok().then_some(connection_id)
}

fn retire_direct_dials(
    swarm: &mut Swarm<Behaviour>,
    retiring: &mut HashSet<ConnectionId>,
    dials: HashMap<ConnectionId, DialOrigin>,
    retained: Option<ConnectionId>,
) {
    for connection_id in dials.into_keys() {
        if retained == Some(connection_id) {
            continue;
        }
        retiring.insert(connection_id);
        let _ = swarm.close_connection(connection_id);
    }
}

fn native_error(error: impl std::fmt::Display) -> PeerError {
    PeerError::new("peer_native_failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn identity_signature_is_bound_to_peer_and_payload() {
        let root = std::env::temp_dir().join(format!("maka-peer-signature-{}", PeerId::random()));
        std::fs::create_dir_all(&root).expect("create test root");
        let key_path = root.join("peer.key");
        let peer_id = ensure_identity(key_path.clone())
            .await
            .expect("create identity");
        let proof = sign_identity(key_path, peer_id, b"route")
            .await
            .expect("sign payload");

        assert!(
            verify_identity(peer_id, &proof.public_key, b"route", &proof.signature)
                .expect("verify signature")
        );
        assert!(
            !verify_identity(peer_id, &proof.public_key, b"other", &proof.signature)
                .expect("reject changed payload")
        );
        assert!(
            !verify_identity(
                PeerId::random(),
                &proof.public_key,
                b"route",
                &proof.signature,
            )
            .expect("reject changed peer")
        );
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mesh_control_survives_repeated_application_streams_on_one_endpoint() {
        let root = std::env::temp_dir().join(format!("maka-peer-test-{}", PeerId::random()));
        std::fs::create_dir_all(&root).expect("create test root");
        let left = start(test_endpoint_options(root.join("left.key"))).expect("start left");
        let mut right = start(test_endpoint_options(root.join("right.key"))).expect("start right");
        let route = right
            .listen_addresses
            .first()
            .expect("right listen address")
            .clone();

        let mesh_left = connect_test_stream(
            &left,
            right.peer_id,
            route.clone(),
            1,
            StreamKind::MeshControl,
        )
        .await;
        let mut mesh_right =
            tokio::time::timeout(Duration::from_secs(5), right.mesh_incoming.recv())
                .await
                .expect("Mesh inbound timeout")
                .expect("Mesh inbound stream");

        let first_left = connect_test_stream(
            &left,
            right.peer_id,
            route.clone(),
            2,
            StreamKind::Application,
        )
        .await;
        let first_right = tokio::time::timeout(Duration::from_secs(5), right.incoming.recv())
            .await
            .expect("first application inbound timeout")
            .expect("first application inbound stream");
        let second_left =
            connect_test_stream(&left, right.peer_id, route, 3, StreamKind::Application).await;
        let mut second_right = tokio::time::timeout(Duration::from_secs(5), right.incoming.recv())
            .await
            .expect("second application inbound timeout")
            .expect("second application inbound stream");

        close_test_stream(first_left).await;
        close_test_stream(first_right).await;
        write_test_stream(&second_left, b"second-still-open").await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), second_right.incoming.recv())
                .await
                .expect("second application read timeout")
                .expect("second application stream ended")
                .expect("second application read failed"),
            b"second-still-open",
        );
        close_test_stream(second_left).await;
        close_test_stream(second_right).await;

        write_test_stream(&mesh_left, b"still-open").await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), mesh_right.incoming.recv())
                .await
                .expect("Mesh read timeout")
                .expect("Mesh stream ended")
                .expect("Mesh read failed"),
            b"still-open",
        );
        close_test_stream(mesh_left).await;
        close_test_stream(mesh_right).await;
        stop_test_endpoint(left).await;
        stop_test_endpoint(right).await;
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn approved_peers_can_exchange_an_application_stream_through_transit() {
        let root = std::env::temp_dir().join(format!("maka-peer-transit-{}", PeerId::random()));
        std::fs::create_dir_all(&root).expect("create test root");
        let mut relay = start(test_endpoint_options(root.join("relay.key"))).expect("start relay");
        let source = start(test_endpoint_options(root.join("source.key"))).expect("start source");
        let target_key = root.join("target.key");
        let target_peer_id = ensure_identity(target_key.clone())
            .await
            .expect("create target identity");
        configure_test_transit(&relay, HashSet::from([source.peer_id, target_peer_id])).await;
        let relay_address = relay
            .listen_addresses
            .first()
            .expect("relay listen address")
            .clone();
        let mut target = start(test_endpoint_options(target_key)).expect("start target");
        let target_relay_stream = connect_test_stream(
            &target,
            relay.peer_id,
            relay_address.clone(),
            1,
            StreamKind::Application,
        )
        .await;
        let relay_target_stream =
            tokio::time::timeout(Duration::from_secs(5), relay.incoming.recv())
                .await
                .expect("relay bootstrap inbound timeout")
                .expect("relay bootstrap inbound stream");
        configure_test_transit_with_reservations(
            &target,
            HashSet::new(),
            vec![relay_address.clone()],
        )
        .await;
        configure_test_transit_with_reservations(
            &source,
            HashSet::new(),
            vec![relay_address.clone()],
        )
        .await;
        wait_for_test_snapshot(&relay, |snapshot| snapshot.active_reservation_count == 2).await;

        let mesh_source = connect_test_stream_through_transit(
            &source,
            target.peer_id,
            relay.peer_id,
            10,
            StreamKind::MeshControl,
        )
        .await;
        let mut mesh_target =
            tokio::time::timeout(Duration::from_secs(5), target.mesh_incoming.recv())
                .await
                .expect("transit Mesh inbound timeout")
                .expect("transit Mesh inbound stream");
        write_test_stream(&mesh_source, b"mesh-through-transit").await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), mesh_target.incoming.recv())
                .await
                .expect("transit Mesh read timeout")
                .expect("transit Mesh stream ended")
                .expect("transit Mesh read failed"),
            b"mesh-through-transit",
        );
        close_test_stream(mesh_source).await;
        close_test_stream(mesh_target).await;

        let response = begin_test_connect(
            &source,
            ConnectOptions {
                request_id: 1,
                peer_id: target.peer_id,
                route_hints: Vec::new(),
                coordination_relays: Vec::new(),
                transit_relay_peers: vec![relay.peer_id],
                deadline: Duration::from_secs(10),
            },
        )
        .await;
        let source_stream = tokio::time::timeout(Duration::from_secs(10), response)
            .await
            .expect("transit connect timeout")
            .expect("transit connect response")
            .expect("transit connect failed");
        let mut target_stream =
            tokio::time::timeout(Duration::from_secs(5), target.incoming.recv())
                .await
                .expect("transit inbound timeout")
                .expect("transit inbound stream");

        write_test_stream(&source_stream, b"through-transit").await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), target_stream.incoming.recv())
                .await
                .expect("transit read timeout")
                .expect("transit stream ended")
                .expect("transit read failed"),
            b"through-transit",
        );
        assert_eq!(
            relay
                .transit_snapshot
                .read()
                .expect("read transit snapshot")
                .active_circuit_count,
            1,
        );

        configure_test_transit_policy(
            &source,
            HashSet::new(),
            HashSet::from([relay.peer_id]),
            Vec::new(),
        )
        .await;
        write_test_stream(&source_stream, b"after-route-expiry").await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), target_stream.incoming.recv())
                .await
                .expect("expired route read timeout")
                .expect("expired route stream ended")
                .expect("expired route read failed"),
            b"after-route-expiry",
        );
        configure_test_transit_with_reservations(
            &source,
            HashSet::new(),
            vec![relay_address.clone()],
        )
        .await;

        configure_test_transit(&source, HashSet::new()).await;
        wait_for_test_snapshot(&relay, |snapshot| snapshot.active_circuit_count == 0).await;
        let (result, response) = oneshot::channel();
        if source_stream
            .commands
            .send(StreamCommand::Write {
                bytes: b"after-revocation".to_vec(),
                result,
            })
            .await
            .is_ok()
        {
            let write = tokio::time::timeout(Duration::from_secs(2), response)
                .await
                .expect("revoked stream write timeout");
            assert!(
                matches!(write, Err(_) | Ok(Err(_))),
                "revoked transit stream remained writable",
            );
        }
        configure_test_transit_with_reservations(
            &source,
            HashSet::new(),
            vec![relay_address.clone()],
        )
        .await;

        let response = begin_test_connect(
            &source,
            ConnectOptions {
                request_id: 2,
                peer_id: PeerId::random(),
                route_hints: Vec::new(),
                coordination_relays: Vec::new(),
                transit_relay_peers: vec![relay.peer_id],
                deadline: Duration::from_secs(10),
            },
        )
        .await;
        configure_test_transit(&source, HashSet::new()).await;
        let result = tokio::time::timeout(Duration::from_secs(2), response)
            .await
            .expect("revoked pending connect timeout")
            .expect("revoked pending connect response");
        let Err(error) = result else {
            panic!("revoked pending transit connect succeeded");
        };
        assert_eq!(error.code, "transit_unavailable");
        configure_test_transit(&relay, HashSet::from([target.peer_id])).await;

        close_test_stream(source_stream).await;
        close_test_stream(target_stream).await;
        close_test_stream(target_relay_stream).await;
        close_test_stream(relay_target_stream).await;

        configure_test_transit(&relay, HashSet::from([source.peer_id, target.peer_id])).await;
        let response = begin_test_connect(
            &source,
            ConnectOptions {
                request_id: 3,
                peer_id: target.peer_id,
                route_hints: Vec::new(),
                coordination_relays: Vec::new(),
                transit_relay_peers: vec![relay.peer_id],
                deadline: Duration::from_secs(10),
            },
        )
        .await;
        configure_test_transit_with_reservations(&source, HashSet::new(), vec![relay_address])
            .await;
        let source_stream = tokio::time::timeout(Duration::from_secs(10), response)
            .await
            .expect("late transit policy connect timeout")
            .expect("late transit policy connect response")
            .expect("late transit policy connect failed");
        let target_stream = tokio::time::timeout(Duration::from_secs(5), target.incoming.recv())
            .await
            .expect("late transit policy inbound timeout")
            .expect("late transit policy inbound stream");
        close_test_stream(source_stream).await;
        close_test_stream(target_stream).await;

        let unreachable_peer = PeerId::random();
        let unreachable_route = format!("/ip4/127.0.0.1/udp/1/quic-v1/p2p/{unreachable_peer}")
            .parse()
            .expect("unreachable direct route");
        let response = begin_test_connect(
            &source,
            ConnectOptions {
                request_id: 4,
                peer_id: unreachable_peer,
                route_hints: vec![unreachable_route],
                coordination_relays: Vec::new(),
                transit_relay_peers: vec![relay.peer_id],
                deadline: Duration::from_secs(10),
            },
        )
        .await;
        configure_test_transit(&source, HashSet::new()).await;
        let (result, cancelled) = oneshot::channel();
        source
            .commands
            .send(EngineCommand::CancelConnect {
                request_id: 4,
                result,
            })
            .await
            .expect("cancel multi-path connect");
        assert!(cancelled.await.expect("cancel response"));
        let result = response.await.expect("cancelled connect response");
        let Err(error) = result else {
            panic!("cancelled connect unexpectedly succeeded");
        };
        assert_eq!(error.code, "peer_connect_cancelled");

        stop_test_endpoint(source).await;
        stop_test_endpoint(target).await;
        stop_test_endpoint(relay).await;
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn transit_provider_can_be_bootstrapped_through_its_coordination_relay() {
        let root =
            std::env::temp_dir().join(format!("maka-peer-transit-bootstrap-{}", PeerId::random()));
        std::fs::create_dir_all(&root).expect("create test root");
        let coordination = start(test_endpoint_options(root.join("coordination.key")))
            .expect("start coordination");
        let coordination_address = coordination
            .listen_addresses
            .first()
            .expect("coordination listen address")
            .clone();

        let provider_key = root.join("provider.key");
        let source_key = root.join("source.key");
        let provider_peer_id = ensure_identity(provider_key.clone())
            .await
            .expect("create provider identity");
        let source_peer_id = ensure_identity(source_key.clone())
            .await
            .expect("create source identity");
        configure_test_transit(
            &coordination,
            HashSet::from([provider_peer_id, source_peer_id]),
        )
        .await;

        let mut provider_options = test_endpoint_options(provider_key);
        provider_options.coordination_relays = vec![coordination_address.clone()];
        let provider = start(provider_options).expect("start transit provider");
        wait_for_test_coordination_route(&provider).await;

        let source = start(test_endpoint_options(source_key)).expect("start source");
        let mut target =
            start(test_endpoint_options(root.join("target.key"))).expect("start target");
        configure_test_transit(&provider, HashSet::from([source.peer_id, target.peer_id])).await;
        let provider_address = provider
            .listen_addresses
            .first()
            .expect("provider listen address")
            .clone();
        configure_test_transit_with_reservations(&target, HashSet::new(), vec![provider_address])
            .await;
        configure_test_transit_with_candidates(
            &source,
            HashSet::new(),
            vec![TransitRelayCandidate {
                peer_id: provider.peer_id,
                addresses: Vec::new(),
                coordination_relays: vec![coordination_address],
            }],
        )
        .await;
        wait_for_test_snapshot(&provider, |snapshot| snapshot.active_reservation_count == 2).await;

        let source_stream = tokio::time::timeout(
            Duration::from_secs(10),
            begin_test_connect(
                &source,
                ConnectOptions {
                    request_id: 1,
                    peer_id: target.peer_id,
                    route_hints: Vec::new(),
                    coordination_relays: Vec::new(),
                    transit_relay_peers: vec![provider.peer_id],
                    deadline: Duration::from_secs(10),
                },
            )
            .await,
        )
        .await
        .expect("transit connect timeout")
        .expect("transit connect response")
        .expect("transit connect failed");
        let mut target_stream =
            tokio::time::timeout(Duration::from_secs(5), target.incoming.recv())
                .await
                .expect("transit inbound timeout")
                .expect("transit inbound stream");
        write_test_stream(&source_stream, b"bootstrapped-transit").await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), target_stream.incoming.recv())
                .await
                .expect("transit read timeout")
                .expect("transit stream ended")
                .expect("transit read failed"),
            b"bootstrapped-transit",
        );

        close_test_stream(source_stream).await;
        close_test_stream(target_stream).await;
        stop_test_endpoint(source).await;
        stop_test_endpoint(target).await;
        stop_test_endpoint(provider).await;
        stop_test_endpoint(coordination).await;
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    fn test_endpoint_options(key_path: PathBuf) -> StartOptions {
        StartOptions {
            key_path,
            expected_peer_id: None,
            listen_addresses: vec![
                "/ip4/127.0.0.1/udp/0/quic-v1"
                    .parse()
                    .expect("test listen address"),
            ],
            coordination_relays: Vec::new(),
            automatic_relay_discovery: false,
        }
    }

    async fn begin_test_connect(
        endpoint: &StartedEndpoint,
        options: ConnectOptions,
    ) -> oneshot::Receiver<Result<PeerStream, PeerError>> {
        let (result, response) = oneshot::channel();
        endpoint
            .commands
            .send(EngineCommand::Connect {
                options,
                stream_kind: StreamKind::Application,
                result,
            })
            .await
            .expect("send application connect");
        response
    }

    async fn connect_test_stream(
        endpoint: &StartedEndpoint,
        peer_id: PeerId,
        route: Multiaddr,
        request_id: u32,
        stream_kind: StreamKind,
    ) -> PeerStream {
        let (result, response) = oneshot::channel();
        endpoint
            .commands
            .send(EngineCommand::Connect {
                options: ConnectOptions {
                    request_id,
                    peer_id,
                    route_hints: vec![route],
                    coordination_relays: Vec::new(),
                    transit_relay_peers: Vec::new(),
                    deadline: Duration::from_secs(5),
                },
                stream_kind,
                result,
            })
            .await
            .expect("send connect");
        tokio::time::timeout(Duration::from_secs(5), response)
            .await
            .expect("connect timeout")
            .expect("connect response")
            .expect("connect failed")
    }

    async fn connect_test_stream_through_transit(
        endpoint: &StartedEndpoint,
        peer_id: PeerId,
        relay_peer_id: PeerId,
        request_id: u32,
        stream_kind: StreamKind,
    ) -> PeerStream {
        let (result, response) = oneshot::channel();
        endpoint
            .commands
            .send(EngineCommand::Connect {
                options: ConnectOptions {
                    request_id,
                    peer_id,
                    route_hints: Vec::new(),
                    coordination_relays: Vec::new(),
                    transit_relay_peers: vec![relay_peer_id],
                    deadline: Duration::from_secs(10),
                },
                stream_kind,
                result,
            })
            .await
            .expect("send transit connect");
        tokio::time::timeout(Duration::from_secs(10), response)
            .await
            .expect("transit connect timeout")
            .expect("transit connect response")
            .expect("transit connect failed")
    }

    async fn write_test_stream(stream: &PeerStream, bytes: &[u8]) {
        let (result, response) = oneshot::channel();
        stream
            .commands
            .send(StreamCommand::Write {
                bytes: bytes.to_vec(),
                result,
            })
            .await
            .expect("send write");
        response
            .await
            .expect("write response")
            .expect("write failed");
    }

    async fn close_test_stream(stream: PeerStream) {
        let (result, response) = oneshot::channel();
        if stream
            .commands
            .send(StreamCommand::Close { result })
            .await
            .is_err()
        {
            return;
        }
        if let Ok(outcome) = response.await {
            outcome.expect("close failed");
        }
    }

    async fn stop_test_endpoint(endpoint: StartedEndpoint) {
        let (result, response) = oneshot::channel();
        endpoint
            .commands
            .send(EngineCommand::Stop { result })
            .await
            .expect("send stop");
        response.await.expect("stop response");
        endpoint.thread.join().expect("join endpoint thread");
    }

    async fn configure_test_transit(endpoint: &StartedEndpoint, allowed_peers: HashSet<PeerId>) {
        configure_test_transit_with_reservations(endpoint, allowed_peers, Vec::new()).await;
    }

    async fn configure_test_transit_with_reservations(
        endpoint: &StartedEndpoint,
        allowed_peers: HashSet<PeerId>,
        reservation_relays: Vec<Multiaddr>,
    ) {
        let reservation_relays = reservation_relays
            .into_iter()
            .map(|address| TransitRelayCandidate {
                peer_id: transit_relay_peer_id(&address).expect("test relay peer id"),
                addresses: vec![address],
                coordination_relays: Vec::new(),
            })
            .collect();
        configure_test_transit_with_candidates(endpoint, allowed_peers, reservation_relays).await;
    }

    async fn configure_test_transit_with_candidates(
        endpoint: &StartedEndpoint,
        allowed_peers: HashSet<PeerId>,
        reservation_relays: Vec<TransitRelayCandidate>,
    ) {
        let approved_relays = reservation_relays
            .iter()
            .map(|candidate| candidate.peer_id)
            .collect();
        configure_test_transit_policy(endpoint, allowed_peers, approved_relays, reservation_relays)
            .await;
    }

    async fn configure_test_transit_policy(
        endpoint: &StartedEndpoint,
        allowed_peers: HashSet<PeerId>,
        approved_relays: HashSet<PeerId>,
        reservation_relays: Vec<TransitRelayCandidate>,
    ) {
        let (result, response) = oneshot::channel();
        endpoint
            .commands
            .send(EngineCommand::ConfigureTransit {
                policy: TransitPolicy {
                    allowed_peers,
                    approved_relays,
                    relays: reservation_relays,
                },
                result,
            })
            .await
            .expect("send transit policy");
        response.await.expect("apply transit policy");
    }

    async fn wait_for_test_coordination_route(endpoint: &StartedEndpoint) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if endpoint
                    .active_coordination_relays
                    .read()
                    .map(|routes| !routes.is_empty())
                    .unwrap_or(false)
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("coordination route timeout");
    }

    async fn wait_for_test_snapshot(
        endpoint: &StartedEndpoint,
        ready: impl Fn(&TransitSnapshot) -> bool,
    ) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if endpoint
                    .transit_snapshot
                    .read()
                    .map(|snapshot| ready(&snapshot))
                    .unwrap_or(false)
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("transit snapshot timeout");
    }

    #[test]
    fn coordination_reservation_can_be_recreated_after_its_lifecycle_ends() {
        let now = Instant::now();
        let listener = ListenerId::next();
        let mut relay = CoordinationRelay {
            identify_received: true,
            identify_sent: true,
            reservation_accepted: true,
            reservation_addresses: vec![
                "/ip4/192.0.2.1/tcp/4001"
                    .parse()
                    .expect("valid reservation address"),
            ],
            reservation_listener: Some(listener),
            next_connection_attempt: now + Duration::from_secs(30),
            next_reservation_attempt: now + Duration::from_secs(30),
            ..CoordinationRelay::default()
        };

        assert!(relay.listener_closed(listener, now));
        assert!(relay.reservation_listener.is_none());
        assert!(!relay.reservation_accepted);
        assert!(relay.reservation_addresses.is_empty());

        relay.reservation_listener = Some(listener);
        assert_eq!(relay.connection_lost(now), Some(listener));
        assert!(!relay.identify_received);
        assert!(!relay.identify_sent);
        assert_eq!(relay.next_connection_attempt, now);
    }

    #[test]
    fn active_coordination_routes_only_publish_accepted_reservations() {
        let accepted_peer = PeerId::random();
        let pending_peer = PeerId::random();
        let accepted_address: Multiaddr = format!("/ip4/192.0.2.1/tcp/4001/p2p/{accepted_peer}")
            .parse()
            .expect("valid accepted relay address");
        let pending_address: Multiaddr = format!("/ip4/192.0.2.2/tcp/4001/p2p/{pending_peer}")
            .parse()
            .expect("valid pending relay address");
        let relays = HashMap::from([
            (
                accepted_peer,
                CoordinationRelay {
                    reserve: true,
                    reservation_accepted: true,
                    reservation_addresses: vec![accepted_address.clone()],
                    ..CoordinationRelay::default()
                },
            ),
            (
                pending_peer,
                CoordinationRelay {
                    reservation_addresses: vec![pending_address],
                    ..CoordinationRelay::default()
                },
            ),
        ]);
        let snapshot = Arc::new(RwLock::new(Vec::new()));

        publish_active_coordination_relays(&relays, &snapshot);

        assert_eq!(
            *snapshot.read().expect("read snapshot"),
            vec![accepted_address]
        );
    }

    #[test]
    fn coordination_relay_requires_one_terminal_peer_identity() {
        let relay = PeerId::random();
        let target = PeerId::random();
        let address: Multiaddr = format!("/ip4/127.0.0.1/udp/4001/quic-v1/p2p/{relay}")
            .parse()
            .expect("valid relay address");
        assert_eq!(
            coordination_relay_peer_id(&address).expect("base relay address is accepted"),
            relay,
        );

        let tunneled: Multiaddr = format!("{address}/p2p-circuit/p2p/{target}")
            .parse()
            .expect("valid relayed address");
        assert!(coordination_relay_peer_id(&tunneled).is_err());
    }

    #[test]
    fn relay_routes_enforce_origin_policy_identity_and_replacement() {
        let relay = PeerId::random();
        let local = PeerId::random();
        let other = PeerId::random();
        let public_quic: Multiaddr = format!("/ip4/1.1.1.1/udp/4001/quic-v1/p2p/{relay}")
            .parse()
            .expect("valid public QUIC address");
        let private_tcp: Multiaddr = format!("/ip4/192.168.1.2/tcp/4001/p2p/{relay}")
            .parse()
            .expect("valid private TCP address");
        let unsupported_websocket: Multiaddr = format!("/ip4/1.1.1.1/tcp/4001/ws/p2p/{relay}")
            .parse()
            .expect("valid WebSocket address");
        let mapped_private: Multiaddr = format!("/ip6/::ffff:127.0.0.1/tcp/4001/p2p/{relay}")
            .parse()
            .expect("valid IPv4-mapped private address");
        let compatible_private: Multiaddr = format!("/ip6/::127.0.0.1/tcp/4001/p2p/{relay}")
            .parse()
            .expect("valid IPv4-compatible private address");
        let former_site_local: Multiaddr = format!("/ip6/fec0::1/tcp/4001/p2p/{relay}")
            .parse()
            .expect("valid former site-local address");

        assert!(supported_public_relay_address(&public_quic));
        assert!(!supported_public_relay_address(&private_tcp));
        assert!(!supported_public_relay_address(&unsupported_websocket));
        assert!(!supported_public_relay_address(&mapped_private));
        assert!(!supported_public_relay_address(&compatible_private));
        assert!(!supported_public_relay_address(&former_site_local));

        let manual_route: Multiaddr = format!("{private_tcp}/p2p-circuit/p2p/{local}")
            .parse()
            .expect("valid manual reservation route");
        assert_eq!(
            reservation_base_address(manual_route.clone(), relay, false),
            Some(private_tcp),
        );
        assert!(reservation_base_address(manual_route, other, false).is_none());

        let dns_base: Multiaddr = format!("/dns4/relay.example/tcp/4001/p2p/{relay}")
            .parse()
            .expect("valid DNS relay address");
        let dns_route: Multiaddr = format!("{dns_base}/p2p-circuit/p2p/{local}")
            .parse()
            .expect("valid DNS reservation route");
        assert!(reservation_base_address(dns_route.clone(), relay, true).is_none());
        assert_eq!(
            reservation_base_address(dns_route, relay, false),
            Some(dns_base),
        );

        let mut state = CoordinationRelay::default();
        let first: Multiaddr = format!("/ip4/1.1.1.1/tcp/4001/p2p/{relay}")
            .parse()
            .expect("valid first relay route");
        let renewed: Multiaddr = format!("/ip4/1.0.0.1/tcp/4001/p2p/{relay}")
            .parse()
            .expect("valid renewed relay route");
        remember_reservation_address(&mut state, first);
        remember_reservation_address(&mut state, renewed.clone());
        assert_eq!(state.reservation_addresses, vec![renewed]);

        let automatic_peer = PeerId::random();
        let automatic_address: Multiaddr = format!("/ip4/1.1.1.1/tcp/4001/p2p/{automatic_peer}")
            .parse()
            .expect("valid automatic relay address");
        let replacement: Multiaddr = format!("/ip4/8.8.8.8/tcp/4001/p2p/{automatic_peer}")
            .parse()
            .expect("valid replacement relay address");
        let mut relays = HashMap::new();
        register_automatic_relay_candidate(
            &mut relays,
            relay_discovery::RelayCandidate {
                peer_id: automatic_peer,
                addresses: vec![automatic_address],
            },
            local,
        );
        register_automatic_relay_candidate(
            &mut relays,
            relay_discovery::RelayCandidate {
                peer_id: automatic_peer,
                addresses: vec![replacement.clone()],
            },
            local,
        );
        let automatic = relays
            .get_mut(&automatic_peer)
            .expect("automatic relay is registered");
        let private_client_address: Multiaddr =
            format!("/ip4/192.168.1.20/tcp/4001/p2p/{automatic_peer}")
                .parse()
                .expect("valid private client relay address");
        automatic.addresses.push(private_client_address);
        assert_eq!(relay_reservation_addresses(automatic), vec![replacement]);

        let mut bounded = HashMap::new();
        for _ in 0..MAX_AUTOMATIC_RELAY_CANDIDATES {
            let peer = PeerId::random();
            let address = format!("/ip4/1.1.1.1/tcp/4001/p2p/{peer}")
                .parse()
                .expect("valid bounded relay address");
            bounded.insert(
                peer,
                CoordinationRelay {
                    automatic_addresses: vec![address],
                    ..CoordinationRelay::default()
                },
            );
        }
        let client_peer = PeerId::random();
        let client_address = format!("/ip4/1.1.1.1/tcp/4001/p2p/{client_peer}")
            .parse()
            .expect("valid client relay address");
        register_coordination_relay(&mut bounded, &client_address, local, false, true)
            .expect("client relay is registered");
        let replacement_client_address = format!("/ip4/8.8.8.8/tcp/4001/p2p/{client_peer}")
            .parse()
            .expect("valid replacement client relay address");
        register_coordination_relay(
            &mut bounded,
            &replacement_client_address,
            local,
            false,
            false,
        )
        .expect("client relay address is refreshed");
        assert_eq!(
            bounded[&client_peer].addresses,
            vec![replacement_client_address]
        );
        register_automatic_relay_candidate(
            &mut bounded,
            relay_discovery::RelayCandidate {
                peer_id: client_peer,
                addresses: vec![client_address],
            },
            local,
        );
        assert!(!bounded[&client_peer].is_automatic());
    }
}
