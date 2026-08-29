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

use address::{
    address_with_expected_peer, address_with_peer, coordination_relay_peer_id, is_relayed_address,
};
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
const AUTOMATIC_RELAY_COOLDOWN: Duration = Duration::from_secs(30);
const IDLE_CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const TARGET_COORDINATION_RESERVATIONS: usize = 2;
const MAX_AUTOMATIC_RELAY_CANDIDATES: usize = 8;
const MAX_RELAY_ADDRESSES_PER_PEER: usize = 4;

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
    Stop {
        result: oneshot::Sender<()>,
    },
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
    DirectRoute,
    CoordinationRoute,
}

struct StartedConnect {
    direct_routes: Vec<Multiaddr>,
    coordination_relay_peers: Vec<PeerId>,
}

#[derive(Default)]
struct DirectConnectState {
    pending: HashMap<u32, PendingConnect>,
    active: HashMap<PeerId, ConnectionId>,
    retiring_connections: HashSet<ConnectionId>,
}

struct CoordinationRelay {
    addresses: Vec<Multiaddr>,
    automatic_addresses: Vec<Multiaddr>,
    reservation_addresses: Vec<Multiaddr>,
    connections: HashSet<ConnectionId>,
    pending_connection: Option<ConnectionId>,
    identify_received: bool,
    identify_sent: bool,
    reserve: bool,
    reservation_accepted: bool,
    client_references: usize,
    reservation_listener: Option<ListenerId>,
    next_connection_attempt: Instant,
    next_reservation_attempt: Instant,
}

impl Default for CoordinationRelay {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            addresses: Vec::new(),
            automatic_addresses: Vec::new(),
            reservation_addresses: Vec::new(),
            connections: HashSet::new(),
            pending_connection: None,
            identify_received: false,
            identify_sent: false,
            reserve: false,
            reservation_accepted: false,
            client_references: 0,
            reservation_listener: None,
            next_connection_attempt: now,
            next_reservation_attempt: now,
        }
    }
}

impl CoordinationRelay {
    fn is_automatic(&self) -> bool {
        !self.automatic_addresses.is_empty()
    }

    fn is_active(&self) -> bool {
        self.reserve || self.client_references > 0
    }

    fn connection_lost(&mut self, now: Instant) -> Option<ListenerId> {
        self.identify_received = false;
        self.identify_sent = false;
        self.next_connection_attempt = now;
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
    Application(ConnectionId),
    MeshControl {
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
    ))
}

async fn run_endpoint_async(
    options: StartOptions,
    mut commands: mpsc::Receiver<EngineCommand>,
    incoming_tx: mpsc::Sender<PeerStream>,
    mesh_incoming_tx: mpsc::Sender<PeerStream>,
    ready_tx: std::sync::mpsc::SyncSender<Result<(PeerId, Vec<Multiaddr>), PeerError>>,
    active_coordination_relays: Arc<RwLock<Vec<Multiaddr>>>,
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
    let (mut swarm, stream_control, mut incoming_streams, mesh_control, mut mesh_incoming) =
        build_swarm(key)?;

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
    maintain_coordination_relays(&mut swarm, &mut coordination_relays, false, Instant::now());

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
    let _ = ready_tx.send(Ok((local_peer_id, bound_addresses)));

    let (opened_tx, mut opened_rx) = mpsc::channel::<OpenedStream>(COMMAND_CAPACITY);
    let (stream_completed_tx, mut stream_completed_rx) =
        mpsc::channel::<CompletedStream>(MAX_ESTABLISHED_CONNECTIONS as usize);
    let mut direct = DirectConnectState::default();
    let mut relayed = HashMap::<PeerId, HashSet<ConnectionId>>::new();
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
                        || (stream_kind == StreamKind::Application
                            && direct.active.contains_key(&options.peer_id))
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
                    ) {
                        Ok(peers) => peers,
                        Err(error) => {
                            let _ = result.send(Err(error));
                            continue;
                        }
                    };
                    let request_id = options.request_id;
                    let retry_coordination = stream_kind == StreamKind::Application
                        && relayed
                            .get(&options.peer_id)
                            .is_some_and(|connections| !connections.is_empty());
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
                        next_route_attempt: Instant::now(),
                        retry_coordination,
                    });
                    retry_connect_routes(
                        &mut swarm,
                        &mut direct,
                        &coordination_relays,
                        &stream_control,
                        &relayed,
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
                    let cancelled = if let Some(mut waiter) = direct.pending.remove(&request_id) {
                        if let Some(opening) = waiter.opening.take() {
                            opening.abort();
                        }
                        retire_direct_dials(
                            &mut swarm,
                            &mut direct.retiring_connections,
                            waiter.dials,
                            None,
                        );
                        release_coordination_relays(
                            &mut swarm,
                            &mut coordination_relays,
                            &waiter.coordination_relay_peers,
                            &direct.active,
                        );
                        let _ = waiter.result.send(Err(PeerError::new(
                            "peer_connect_cancelled",
                            "the peer connection request was cancelled",
                        )));
                        true
                    } else {
                        false
                    };
                    let _ = result.send(cancelled);
                }
                Some(EngineCommand::Stop { result }) => {
                    let _ = result.send(());
                    return Ok(());
                }
                None => return Ok(()),
            },
            Some(stream) = incoming_streams.recv() => {
                let peer_stream = spawn_stream(stream.peer_id, stream.stream, None);
                if incoming_tx.try_send(peer_stream).is_err() {
                    // Dropping the stream closes it. A slow Host cannot create an unbounded queue.
                }
            }
            Some(stream) = mesh_incoming.recv() => {
                let peer_stream = spawn_stream(stream.peer_id, stream.stream, None);
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
                    Instant::now(),
                );
                publish_active_coordination_relays(
                    &coordination_relays,
                    &active_coordination_relays,
                );
                maintain_coordination_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    external_candidate_ready,
                    Instant::now(),
                );
            }
            Some(completed) = stream_completed_rx.recv() => {
                match completed.kind {
                    StreamCompletion::Application(connection_id) => {
                        direct.active.retain(|_, active| *active != connection_id);
                    }
                    StreamCompletion::MeshControl { coordination_relay_peers } => {
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
                if let Some(waiter) = direct.pending.remove(&opened.request_id) {
                    let result = match opened.result {
                        Ok(opened) => match waiter.stream_kind {
                            StreamKind::Application => {
                                let connection_id = opened.connection_id;
                                retire_direct_dials(
                                    &mut swarm,
                                    &mut direct.retiring_connections,
                                    waiter.dials,
                                    Some(connection_id),
                                );
                                direct.active.insert(waiter.peer_id, connection_id);
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
                                        StreamCompletion::Application(connection_id),
                                        stream_completed_tx.clone(),
                                    )),
                                ))
                            }
                            StreamKind::MeshControl => {
                                retire_direct_dials(
                                    &mut swarm,
                                    &mut direct.retiring_connections,
                                    waiter.dials,
                                    None,
                                );
                                Ok(spawn_stream(
                                    waiter.peer_id,
                                    opened.stream,
                                    Some((
                                        StreamCompletion::MeshControl {
                                            coordination_relay_peers: waiter
                                                .coordination_relay_peers,
                                        },
                                        stream_completed_tx.clone(),
                                    )),
                                ))
                            }
                        },
                        Err(message) => {
                            retire_direct_dials(
                                &mut swarm,
                                &mut direct.retiring_connections,
                                waiter.dials,
                                None,
                            );
                            release_coordination_relays(
                                &mut swarm,
                                &mut coordination_relays,
                                &waiter.coordination_relay_peers,
                                &direct.active,
                            );
                            let code = match waiter.stream_kind {
                                StreamKind::Application => "direct_path_unavailable",
                                StreamKind::MeshControl => "mesh_control_unavailable",
                            };
                            Err(PeerError::new(code, message))
                        }
                    };
                    let _ = waiter.result.send(result);
                }
            }
            event = swarm.select_next_some() => {
                handle_swarm_event(
                    &mut swarm,
                    event,
                    &mut relayed,
                    &mut coordination_relays,
                    &mut direct,
                    &mut external_candidate_ready,
                    &active_coordination_relays,
                );
                rebalance_automatic_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    Instant::now(),
                );
                publish_active_coordination_relays(
                    &coordination_relays,
                    &active_coordination_relays,
                );
                maintain_coordination_relays(
                    &mut swarm,
                    &mut coordination_relays,
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
                rebalance_automatic_relays(&mut swarm, &mut coordination_relays, now);
                publish_active_coordination_relays(
                    &coordination_relays,
                    &active_coordination_relays,
                );
                maintain_coordination_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    external_candidate_ready,
                    now,
                );
                retry_connect_routes(
                    &mut swarm,
                    &mut direct,
                    &coordination_relays,
                    &stream_control,
                    &relayed,
                    external_candidate_ready,
                    now,
                );
                let expired = direct.pending.iter()
                    .filter_map(|(request_id, item)| (item.deadline <= now).then_some(*request_id))
                    .collect::<Vec<_>>();
                for request_id in expired {
                    if let Some(mut waiter) = direct.pending.remove(&request_id) {
                        if let Some(opening) = waiter.opening.take() {
                            opening.abort();
                        }
                        retire_direct_dials(
                            &mut swarm,
                            &mut direct.retiring_connections,
                            waiter.dials,
                            None,
                        );
                        release_coordination_relays(
                            &mut swarm,
                            &mut coordination_relays,
                            &waiter.coordination_relay_peers,
                            &direct.active,
                        );
                        let (code, message) = match waiter.stream_kind {
                            StreamKind::Application => (
                                "direct_path_unavailable",
                                "no direct path was established before the deadline",
                            ),
                            StreamKind::MeshControl => (
                                "mesh_control_unavailable",
                                "no Mesh control path was established before the deadline",
                            ),
                        };
                        let _ = waiter.result.send(Err(PeerError::new(code, message)));
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

fn build_swarm(key: identity::Keypair) -> Result<BuiltSwarm, PeerError> {
    let (application_stream, control, incoming) = application_stream::Behaviour::new(
        StreamProtocol::new(APPLICATION_PROTOCOL),
        INCOMING_STREAM_CAPACITY,
        true,
    );
    let (mesh_stream, mesh_control, mesh_incoming) = application_stream::Behaviour::new(
        StreamProtocol::new(MESH_CONTROL_PROTOCOL),
        MESH_INCOMING_STREAM_CAPACITY,
        false,
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

fn start_connect(
    swarm: &mut Swarm<Behaviour>,
    coordination_relays: &mut HashMap<PeerId, CoordinationRelay>,
    options: &ConnectOptions,
    local_peer_id: PeerId,
    stream_kind: StreamKind,
) -> Result<StartedConnect, PeerError> {
    if options.route_hints.is_empty() && options.coordination_relays.is_empty() {
        let code = match stream_kind {
            StreamKind::Application => "direct_path_unavailable",
            StreamKind::MeshControl => "mesh_control_unavailable",
        };
        return Err(PeerError::new(
            code,
            "the peer profile has no route hints or coordination relays",
        ));
    }
    let mut relay_peers = Vec::new();
    for relay_address in &options.coordination_relays {
        let relay_peer = coordination_relay_peer_id(relay_address)?;
        if relay_peer == options.peer_id {
            return Err(PeerError::new(
                "coordination_unavailable",
                "coordination relay cannot be the target peer",
            ));
        }
        if relay_peer == local_peer_id {
            return Err(PeerError::new(
                "coordination_unavailable",
                "peer endpoint cannot use itself as a coordination relay",
            ));
        }
        if !relay_peers.contains(&relay_peer) {
            relay_peers.push(relay_peer);
        }
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
    maintain_coordination_relays(swarm, coordination_relays, false, Instant::now());
    Ok(StartedConnect {
        direct_routes: direct_targets,
        coordination_relay_peers: relay_peers,
    })
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
    let available = match waiter.stream_kind {
        StreamKind::Application => {
            application_control.has_connection(peer_id, retiring_connections)
        }
        StreamKind::MeshControl => mesh_control.has_connection(peer_id, retiring_connections),
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
            .open_stream(peer_id, &retiring_connections)
            .await
            .map_err(|error| error.to_string());
        let _ = opened_tx.send(OpenedStream { request_id, result }).await;
    }));
}

fn handle_swarm_event(
    swarm: &mut Swarm<Behaviour>,
    event: SwarmEvent<BehaviourEvent>,
    relayed: &mut HashMap<PeerId, HashSet<ConnectionId>>,
    coordination_relays: &mut HashMap<PeerId, CoordinationRelay>,
    direct: &mut DirectConnectState,
    external_candidate_ready: &mut bool,
    active_coordination_relays: &Arc<RwLock<Vec<Multiaddr>>>,
) {
    match event {
        SwarmEvent::ConnectionEstablished {
            peer_id,
            connection_id,
            endpoint,
            ..
        } => {
            if direct.retiring_connections.contains(&connection_id) {
                let _ = swarm.close_connection(connection_id);
                return;
            }
            if let Some(relay) = coordination_relays.get_mut(&peer_id) {
                if relay.pending_connection == Some(connection_id) {
                    relay.pending_connection = None;
                }
                if relay.is_active() {
                    relay.connections.insert(connection_id);
                } else {
                    let _ = swarm.close_connection(connection_id);
                }
            }
            for connect in direct.pending.values_mut() {
                connect.dials.remove(&connection_id);
            }
            if endpoint.is_relayed() {
                relayed.entry(peer_id).or_default().insert(connection_id);
            }
        }
        SwarmEvent::ConnectionClosed {
            peer_id,
            connection_id,
            ..
        } => {
            remove_connection(relayed, peer_id, connection_id);
            direct.retiring_connections.remove(&connection_id);
            for connect in direct.pending.values_mut() {
                connect.dials.remove(&connection_id);
            }
            direct.active.retain(|_, active| *active != connection_id);
            if let Some(relay) = coordination_relays.get_mut(&peer_id) {
                relay.connections.remove(&connection_id);
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
                discard_automatic_relay_candidate(swarm, coordination_relays, peer_id);
            }
            if reservation_changed {
                publish_active_coordination_relays(coordination_relays, active_coordination_relays);
            }
        }
        SwarmEvent::OutgoingConnectionError { connection_id, .. } => {
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
                discard_automatic_relay_candidate(swarm, coordination_relays, peer_id);
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Dcutr(dcutr::Event {
            remote_peer_id,
            result: Err(_),
        })) => {
            for connect in direct.pending.values_mut().filter(|connect| {
                connect.peer_id == remote_peer_id && connect.stream_kind == StreamKind::Application
            }) {
                connect.retry_coordination = true;
                connect.next_route_attempt = Instant::now();
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Dcutr(_)) => {}
        SwarmEvent::Behaviour(BehaviourEvent::RelayClient(
            relay::client::Event::ReservationReqAccepted { relay_peer_id, .. },
        )) => {
            discovery_debug(format_args!("reservation accepted by {relay_peer_id}"));
            if let Some(relay) = coordination_relays.get_mut(&relay_peer_id) {
                relay.reservation_accepted = true;
            }
            publish_active_coordination_relays(coordination_relays, active_coordination_relays);
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
                    discard_automatic_relay_candidate(swarm, coordination_relays, relay_peer);
                }
                publish_active_coordination_relays(coordination_relays, active_coordination_relays);
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
                discard_automatic_relay_candidate(swarm, coordination_relays, peer_id);
            }
            if changed {
                publish_active_coordination_relays(coordination_relays, active_coordination_relays);
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
) {
    handle_swarm_event(
        swarm,
        event,
        &mut HashMap::new(),
        coordination_relays,
        &mut DirectConnectState::default(),
        external_candidate_ready,
        &Arc::new(RwLock::new(Vec::new())),
    );
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
    if relay.reserve && !relay.is_automatic() {
        return;
    }
    relay.automatic_addresses = addresses;
}

fn rebalance_automatic_relays(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    now: Instant,
) {
    let manual_reservations = relays
        .values()
        .filter(|relay| {
            !relay.is_automatic()
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
        relay.reservation_accepted = false;
        relay.reservation_addresses.clear();
        if let Some(listener) = relay.reservation_listener.take() {
            discovery_debug(format_args!(
                "removing reservation listener for deselected candidate {peer_id}"
            ));
            swarm.remove_listener(listener);
        }
        if relay.client_references == 0 {
            for connection_id in relay.connections.drain() {
                let _ = swarm.close_connection(connection_id);
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
        .filter(|relay| relay.reservation_accepted)
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
) {
    let Some(relay) = relays.get_mut(&peer_id) else {
        return;
    };
    if !relay.is_automatic() || relay.reservation_accepted {
        return;
    }
    relay.automatic_addresses.clear();
    relay.reserve = false;
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
    for connection_id in relay.connections.drain() {
        let _ = swarm.close_connection(connection_id);
    }
}

fn release_coordination_relays(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    peers: &[PeerId],
    active_outbound: &HashMap<PeerId, ConnectionId>,
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
        for connection_id in relay.connections.drain() {
            if !active_outbound
                .values()
                .any(|active| *active == connection_id)
            {
                let _ = swarm.close_connection(connection_id);
            }
        }
    }
}

fn dial_coordination_relay(
    swarm: &mut Swarm<Behaviour>,
    peer_id: PeerId,
    relay: &mut CoordinationRelay,
    now: Instant,
) {
    if relay.pending_connection.is_some() || relay.next_connection_attempt > now {
        return;
    }
    relay.next_connection_attempt = now + COORDINATION_RETRY_INTERVAL;
    let options = DialOpts::peer_id(peer_id)
        .addresses(relay_dial_addresses(relay))
        .build();
    let connection_id = options.connection_id();
    if swarm.dial(options).is_ok() {
        relay.pending_connection = Some(connection_id);
    }
}

fn maintain_coordination_relays(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    external_candidate_ready: bool,
    now: Instant,
) {
    for peer_id in relays.keys().copied().collect::<Vec<_>>() {
        if relays.get(&peer_id).is_none_or(|relay| !relay.is_active()) {
            continue;
        }
        if !swarm.is_connected(&peer_id) {
            if let Some(relay) = relays.get_mut(&peer_id) {
                dial_coordination_relay(swarm, peer_id, relay, now);
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
    if !relay.reserve
        || relay.reservation_listener.is_some()
        || !relay.identify_received
        || !relay.identify_sent
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

fn relay_dial_addresses(relay: &CoordinationRelay) -> Vec<Multiaddr> {
    let mut addresses = relay.addresses.clone();
    addresses.extend(relay.automatic_addresses.iter().cloned());
    addresses.sort_unstable_by_key(ToString::to_string);
    addresses.dedup();
    addresses
}

fn relay_reservation_addresses(relay: &CoordinationRelay) -> Vec<Multiaddr> {
    if relay.is_automatic() {
        relay.automatic_addresses.clone()
    } else {
        relay.addresses.clone()
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
    relayed: &HashMap<PeerId, HashSet<ConnectionId>>,
    external_candidate_ready: bool,
    now: Instant,
) {
    for connect in direct.pending.values_mut() {
        let peer_id = connect.peer_id;
        if connect.next_route_attempt > now {
            continue;
        }
        if stream_control.has_connection(peer_id, &direct.retiring_connections) {
            continue;
        }
        connect.next_route_attempt = now + COORDINATION_RETRY_INTERVAL;
        if !connect
            .dials
            .values()
            .any(|origin| *origin == DialOrigin::DirectRoute)
            && let Some(connection_id) =
                dial_direct_targets(swarm, peer_id, connect.direct_routes.clone())
        {
            connect.dials.insert(connection_id, DialOrigin::DirectRoute);
        }
        if connect
            .dials
            .values()
            .any(|origin| *origin == DialOrigin::CoordinationRoute)
            || (!connect.retry_coordination
                && relayed.get(&peer_id).is_some_and(|ids| !ids.is_empty()))
        {
            continue;
        }
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
                .insert(connection_id, DialOrigin::CoordinationRoute);
            connect.retry_coordination = false;
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

fn remove_connection(
    connections: &mut HashMap<PeerId, HashSet<ConnectionId>>,
    peer_id: PeerId,
    connection_id: ConnectionId,
) {
    let Some(ids) = connections.get_mut(&peer_id) else {
        return;
    };
    ids.remove(&connection_id);
    if ids.is_empty() {
        connections.remove(&peer_id);
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

        for request_id in 2..=3 {
            let application_left = connect_test_stream(
                &left,
                right.peer_id,
                route.clone(),
                request_id,
                StreamKind::Application,
            )
            .await;
            let application_right =
                tokio::time::timeout(Duration::from_secs(5), right.incoming.recv())
                    .await
                    .expect("application inbound timeout")
                    .expect("application inbound stream");
            close_test_stream(application_left).await;
            close_test_stream(application_right).await;
        }

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
