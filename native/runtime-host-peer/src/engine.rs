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

use address::{
    address_with_expected_peer, address_with_peer, coordination_relay_peer_id, is_relayed_address,
};
use identity_store::load_or_create_key;
use peer_stream::spawn_stream;
pub use peer_stream::{PeerStream, StreamCommand};

const APPLICATION_PROTOCOL: &str = "/maka/runtime-host/peer/1";
const IDENTIFY_PROTOCOL: &str = "/maka/runtime-host/peer-identify/1";
const COMMAND_CAPACITY: usize = 32;
const INCOMING_STREAM_CAPACITY: usize = 16;
const MAX_PENDING_INCOMING_CONNECTIONS: u32 = 32;
const MAX_PENDING_OUTGOING_CONNECTIONS: u32 = 1024;
const MAX_ESTABLISHED_INCOMING_CONNECTIONS: u32 = 32;
const MAX_ESTABLISHED_CONNECTIONS: u32 = 1024;
const MAX_CONNECTIONS_PER_PEER: u32 = 4;
const LISTENER_ADDRESS_QUIET_PERIOD: Duration = Duration::from_millis(250);
const COORDINATION_RETRY_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct StartOptions {
    pub key_path: PathBuf,
    pub expected_peer_id: Option<PeerId>,
    pub listen_addresses: Vec<Multiaddr>,
    pub coordination_relays: Vec<Multiaddr>,
}

pub struct StartedEndpoint {
    pub peer_id: PeerId,
    pub listen_addresses: Vec<Multiaddr>,
    pub commands: mpsc::Sender<EngineCommand>,
    pub incoming: mpsc::Receiver<PeerStream>,
    pub terminal: mpsc::Receiver<PeerError>,
    pub thread: thread::JoinHandle<()>,
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
}

struct PendingConnect {
    peer_id: PeerId,
    result: oneshot::Sender<Result<PeerStream, PeerError>>,
    deadline: Instant,
    opening: Option<tokio::task::JoinHandle<()>>,
    dials: HashMap<ConnectionId, DialOrigin>,
    direct_routes: Vec<Multiaddr>,
    coordination_relays: Vec<Multiaddr>,
    coordination_relay_peers: Vec<PeerId>,
    next_route_attempt: Instant,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DialOrigin {
    DirectRoute,
    CoordinationRoute,
    DirectConnection,
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
    outbound_hole_punch_peers: HashSet<PeerId>,
}

struct CoordinationRelay {
    addresses: Vec<Multiaddr>,
    connections: HashSet<ConnectionId>,
    pending_connection: Option<ConnectionId>,
    identify_received: bool,
    identify_sent: bool,
    reserve: bool,
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
            connections: HashSet::new(),
            pending_connection: None,
            identify_received: false,
            identify_sent: false,
            reserve: false,
            client_references: 0,
            reservation_listener: None,
            next_connection_attempt: now,
            next_reservation_attempt: now,
        }
    }
}

impl CoordinationRelay {
    fn is_active(&self) -> bool {
        self.reserve || self.client_references > 0
    }

    fn connection_lost(&mut self, now: Instant) -> Option<ListenerId> {
        self.identify_received = false;
        self.identify_sent = false;
        self.next_connection_attempt = now;
        self.next_reservation_attempt = now + COORDINATION_RETRY_INTERVAL;
        self.reservation_listener.take()
    }

    fn listener_closed(&mut self, listener_id: ListenerId, now: Instant) -> bool {
        if self.reservation_listener != Some(listener_id) {
            return false;
        }
        self.reservation_listener = None;
        self.next_reservation_attempt = now + COORDINATION_RETRY_INTERVAL;
        true
    }
}

struct OpenedStream {
    request_id: u32,
    result: Result<application_stream::OpenedApplicationStream, String>,
}

pub async fn ensure_identity(key_path: PathBuf) -> Result<PeerId, PeerError> {
    Ok(identity_store::load_or_create_key(&key_path)
        .await?
        .public()
        .to_peer_id())
}

pub fn start(options: StartOptions) -> Result<StartedEndpoint, PeerError> {
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (command_tx, command_rx) = mpsc::channel(COMMAND_CAPACITY);
    let (incoming_tx, incoming_rx) = mpsc::channel(INCOMING_STREAM_CAPACITY);
    let (terminal_tx, terminal_rx) = mpsc::channel(1);
    let thread = thread::Builder::new()
        .name("maka-runtime-host-peer".to_owned())
        .spawn(move || {
            let result = run_endpoint(options, command_rx, incoming_tx, ready_tx.clone());
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
        commands: command_tx,
        incoming: incoming_rx,
        terminal: terminal_rx,
        thread,
    })
}

fn run_endpoint(
    options: StartOptions,
    commands: mpsc::Receiver<EngineCommand>,
    incoming_tx: mpsc::Sender<PeerStream>,
    ready_tx: std::sync::mpsc::SyncSender<Result<(PeerId, Vec<Multiaddr>), PeerError>>,
) -> Result<(), PeerError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("maka-peer-io")
        .build()
        .map_err(|error| PeerError::new("peer_native_failed", error.to_string()))?;
    runtime.block_on(run_endpoint_async(options, commands, incoming_tx, ready_tx))
}

async fn run_endpoint_async(
    options: StartOptions,
    mut commands: mpsc::Receiver<EngineCommand>,
    incoming_tx: mpsc::Sender<PeerStream>,
    ready_tx: std::sync::mpsc::SyncSender<Result<(PeerId, Vec<Multiaddr>), PeerError>>,
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
    let (mut swarm, stream_control, mut incoming_streams) = build_swarm(key)?;

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
    let (close_connection_tx, mut close_connection_rx) =
        mpsc::channel::<ConnectionId>(MAX_ESTABLISHED_CONNECTIONS as usize);
    let mut direct = DirectConnectState::default();
    let mut relayed = HashMap::<PeerId, HashSet<ConnectionId>>::new();
    let mut external_candidate_ready = startup_external_candidate_ready;
    let mut deadline_tick = tokio::time::interval(Duration::from_millis(100));
    deadline_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(EngineCommand::Connect { options, result }) => {
                    if direct.pending.contains_key(&options.request_id)
                        || direct.pending.values().any(|connect| connect.peer_id == options.peer_id)
                        || direct.active.contains_key(&options.peer_id)
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
                    ) {
                        Ok(peers) => peers,
                        Err(error) => {
                            let _ = result.send(Err(error));
                            continue;
                        }
                    };
                    let request_id = options.request_id;
                    let can_hole_punch = !options.coordination_relays.is_empty()
                        || options.route_hints.iter().any(is_relayed_address);
                    if can_hole_punch {
                        direct.outbound_hole_punch_peers.insert(options.peer_id);
                    }
                    direct.pending.insert(request_id, PendingConnect {
                        peer_id: options.peer_id,
                        result,
                        deadline: Instant::now() + options.deadline,
                        opening: None,
                        dials: HashMap::new(),
                        direct_routes: started.direct_routes,
                        coordination_relays: options.coordination_relays,
                        coordination_relay_peers: started.coordination_relay_peers,
                        next_route_attempt: Instant::now(),
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
                    maybe_open_direct_stream(
                        request_id,
                        &mut direct.pending,
                        &direct.retiring_connections,
                        stream_control.clone(),
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
                let peer_stream = spawn_stream(
                    stream.stream,
                    Some((stream.connection_id, close_connection_tx.clone())),
                );
                if incoming_tx.try_send(peer_stream).is_err() {
                    // Dropping the stream closes it. A slow Host cannot create an unbounded queue.
                }
            }
            Some(connection_id) = close_connection_rx.recv() => {
                direct.active.retain(|_, active| *active != connection_id);
                retire_established_connection(
                    &mut swarm,
                    &mut direct.retiring_connections,
                    connection_id,
                );
            }
            Some(opened) = opened_rx.recv() => {
                if let Some(waiter) = direct.pending.remove(&opened.request_id) {
                    let result = match opened.result {
                        Ok(opened) => {
                            retire_direct_dials(
                                &mut swarm,
                                &mut direct.retiring_connections,
                                waiter.dials,
                                Some(opened.connection_id),
                            );
                            direct.active.insert(waiter.peer_id, opened.connection_id);
                            Ok(spawn_stream(
                                opened.stream,
                                Some((opened.connection_id, close_connection_tx.clone())),
                            ))
                        }
                        Err(message) => {
                            retire_direct_dials(
                                &mut swarm,
                                &mut direct.retiring_connections,
                                waiter.dials,
                                None,
                            );
                            Err(PeerError::new("direct_path_unavailable", message))
                        }
                    };
                    release_coordination_relays(
                        &mut swarm,
                        &mut coordination_relays,
                        &waiter.coordination_relay_peers,
                        &direct.active,
                    );
                    let _ = waiter.result.send(result);
                } else if let Ok(opened) = opened.result {
                    retire_established_connection(
                        &mut swarm,
                        &mut direct.retiring_connections,
                        opened.connection_id,
                    );
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
                );
                maintain_coordination_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    external_candidate_ready,
                    Instant::now(),
                );
                let requests = direct.pending.keys().copied().collect::<Vec<_>>();
                for request_id in requests {
                    maybe_open_direct_stream(
                        request_id,
                        &mut direct.pending,
                        &direct.retiring_connections,
                        stream_control.clone(),
                        opened_tx.clone(),
                    );
                }
            }
            _ = deadline_tick.tick() => {
                let now = Instant::now();
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
                        let _ = waiter.result.send(Err(PeerError::new(
                            "direct_path_unavailable",
                            "no direct path was established before the deadline",
                        )));
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
);

fn build_swarm(key: identity::Keypair) -> Result<BuiltSwarm, PeerError> {
    let (application_stream, control, incoming) = application_stream::Behaviour::new(
        StreamProtocol::new(APPLICATION_PROTOCOL),
        INCOMING_STREAM_CAPACITY,
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
        })
        .map_err(native_error)
        .map(|builder| builder.build())?;
    Ok((swarm, control, incoming))
}

fn start_connect(
    swarm: &mut Swarm<Behaviour>,
    coordination_relays: &mut HashMap<PeerId, CoordinationRelay>,
    options: &ConnectOptions,
    local_peer_id: PeerId,
) -> Result<StartedConnect, PeerError> {
    if options.route_hints.is_empty() && options.coordination_relays.is_empty() {
        return Err(PeerError::new(
            "direct_path_unavailable",
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

fn maybe_open_direct_stream(
    request_id: u32,
    pending: &mut HashMap<u32, PendingConnect>,
    retiring_connections: &HashSet<ConnectionId>,
    mut control: application_stream::Control,
    opened_tx: mpsc::Sender<OpenedStream>,
) {
    let Some(waiter) = pending.get_mut(&request_id) else {
        return;
    };
    let peer_id = waiter.peer_id;
    if waiter.opening.is_some() || !control.has_connection(peer_id, retiring_connections) {
        return;
    }
    let retiring_connections = retiring_connections.clone();
    waiter.opening = Some(tokio::spawn(async move {
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
            if endpoint.is_relayed() {
                relayed.entry(peer_id).or_default().insert(connection_id);
            } else {
                if let Some(connect) = direct
                    .pending
                    .values_mut()
                    .find(|connect| connect.peer_id == peer_id)
                {
                    connect
                        .dials
                        .entry(connection_id)
                        .or_insert(DialOrigin::DirectConnection);
                }
                if let Some(ids) = relayed.get(&peer_id) {
                    for id in ids.iter().copied().collect::<Vec<_>>() {
                        swarm.close_connection(id);
                    }
                }
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
            if !swarm.is_connected(&peer_id)
                && let Some(relay) = coordination_relays.get_mut(&peer_id)
                && relay.is_active()
                && let Some(listener) = relay.connection_lost(Instant::now())
            {
                swarm.remove_listener(listener);
            }
        }
        SwarmEvent::OutgoingConnectionError { connection_id, .. } => {
            direct.retiring_connections.remove(&connection_id);
            for connect in direct.pending.values_mut() {
                connect.dials.remove(&connection_id);
            }
            for relay in coordination_relays.values_mut() {
                if relay.pending_connection == Some(connection_id) {
                    relay.pending_connection = None;
                    break;
                }
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Dcutr(dcutr::Event {
            remote_peer_id,
            result: Ok(connection_id),
        })) => {
            if let Some(connect) = direct
                .pending
                .values_mut()
                .find(|connect| connect.peer_id == remote_peer_id)
            {
                connect
                    .dials
                    .entry(connection_id)
                    .or_insert(DialOrigin::DirectConnection);
            } else if direct.active.get(&remote_peer_id) != Some(&connection_id)
                && (direct.active.contains_key(&remote_peer_id)
                    || direct.outbound_hole_punch_peers.contains(&remote_peer_id))
            {
                retire_established_connection(
                    swarm,
                    &mut direct.retiring_connections,
                    connection_id,
                );
            }
        }
        SwarmEvent::Behaviour(BehaviourEvent::Dcutr(dcutr::Event {
            remote_peer_id,
            result: Err(_),
        })) => {
            if direct
                .pending
                .values()
                .any(|connect| connect.peer_id == remote_peer_id)
                && let Some(connection_ids) = relayed.remove(&remote_peer_id)
            {
                for connection_id in connection_ids {
                    let _ = swarm.close_connection(connection_id);
                }
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
        SwarmEvent::ListenerClosed { listener_id, .. } => {
            for relay in coordination_relays.values_mut() {
                if relay.listener_closed(listener_id, Instant::now()) {
                    break;
                }
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
    relay.reserve |= reserve;
    if add_client_reference {
        relay.client_references += 1;
    }
    if !relay.addresses.contains(address) {
        relay.addresses.push(address.clone());
    }
    Ok(())
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
        .addresses(relay.addresses.clone())
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
    for address in &relay.addresses {
        if let Ok(listener) = swarm.listen_on(address.clone().with(Protocol::P2pCircuit)) {
            relay.reservation_listener = Some(listener);
            break;
        }
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
            || relayed.get(&peer_id).is_some_and(|ids| !ids.is_empty())
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

fn retire_established_connection(
    swarm: &mut Swarm<Behaviour>,
    retiring: &mut HashSet<ConnectionId>,
    connection_id: ConnectionId,
) {
    if swarm.close_connection(connection_id) {
        retiring.insert(connection_id);
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

    #[test]
    fn coordination_reservation_can_be_recreated_after_its_lifecycle_ends() {
        let now = Instant::now();
        let listener = ListenerId::next();
        let mut relay = CoordinationRelay {
            identify_received: true,
            identify_sent: true,
            reservation_listener: Some(listener),
            next_connection_attempt: now + Duration::from_secs(30),
            next_reservation_attempt: now + Duration::from_secs(30),
            ..CoordinationRelay::default()
        };

        assert!(relay.listener_closed(listener, now));
        assert!(relay.reservation_listener.is_none());

        relay.reservation_listener = Some(listener);
        assert_eq!(relay.connection_lost(now), Some(listener));
        assert!(!relay.identify_received);
        assert!(!relay.identify_sent);
        assert_eq!(relay.next_connection_attempt, now);
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
}
