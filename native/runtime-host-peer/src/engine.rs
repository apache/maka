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
    swarm::{ConnectionId, NetworkBehaviour, SwarmEvent},
    tcp, yamux,
};
use tokio::sync::{mpsc, oneshot};

mod address;
mod application_stream;
mod identity_store;
mod peer_stream;

use address::{
    address_with_expected_peer, address_with_peer, is_relayed_address, peer_id_from_address,
};
use identity_store::load_or_create_key;
use peer_stream::spawn_stream;
pub use peer_stream::{PeerStream, StreamCommand};

const APPLICATION_PROTOCOL: &str = "/maka/runtime-host/peer/1";
const IDENTIFY_PROTOCOL: &str = "/maka/runtime-host/peer-identify/1";
const COMMAND_CAPACITY: usize = 32;
const INCOMING_STREAM_CAPACITY: usize = 16;
const MAX_PENDING_CONNECTIONS: u32 = 32;
const MAX_ESTABLISHED_CONNECTIONS: u32 = 64;
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
    result: oneshot::Sender<Result<PeerStream, PeerError>>,
    deadline: Instant,
    opening: bool,
    coordination_relays: Vec<Multiaddr>,
    next_coordination_attempt: Instant,
}

struct CoordinationRelay {
    addresses: Vec<Multiaddr>,
    identify_received: bool,
    identify_sent: bool,
    reserve: bool,
    reservation_listener: Option<ListenerId>,
    next_connection_attempt: Instant,
    next_reservation_attempt: Instant,
}

impl Default for CoordinationRelay {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            addresses: Vec::new(),
            identify_received: false,
            identify_sent: false,
            reserve: false,
            reservation_listener: None,
            next_connection_attempt: now,
            next_reservation_attempt: now,
        }
    }
}

impl CoordinationRelay {
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
    peer_id: PeerId,
    result: Result<libp2p::swarm::Stream, String>,
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
        register_coordination_relay(
            &mut swarm,
            &mut coordination_relays,
            relay,
            local_peer_id,
            true,
        )?;
    }

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
    let mut pending = HashMap::<PeerId, PendingConnect>::new();
    let mut relayed = HashMap::<PeerId, HashSet<ConnectionId>>::new();
    let mut external_candidate_ready = startup_external_candidate_ready;
    let mut deadline_tick = tokio::time::interval(Duration::from_millis(100));
    deadline_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(EngineCommand::Connect { options, result }) => {
                    if pending.contains_key(&options.peer_id) {
                        let _ = result.send(Err(PeerError::new(
                            "peer_connect_in_progress",
                            "a connection to this peer is already in progress",
                        )));
                        continue;
                    }
                    if let Err(error) = start_connect(
                        &mut swarm,
                        &mut coordination_relays,
                        &options,
                        local_peer_id,
                    ) {
                        let _ = result.send(Err(error));
                        continue;
                    }
                    pending.insert(options.peer_id, PendingConnect {
                        result,
                        deadline: Instant::now() + options.deadline,
                        opening: false,
                        coordination_relays: options.coordination_relays,
                        next_coordination_attempt: Instant::now(),
                    });
                    maybe_open_direct_stream(
                        options.peer_id,
                        &mut pending,
                        stream_control.clone(),
                        opened_tx.clone(),
                    );
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
                let _ = swarm.close_connection(connection_id);
            }
            Some(opened) = opened_rx.recv() => {
                if let Some(waiter) = pending.remove(&opened.peer_id) {
                    let result = opened.result
                        .map(|stream| spawn_stream(stream, None))
                        .map_err(|message| PeerError::new("direct_path_unavailable", message));
                    let _ = waiter.result.send(result);
                }
            }
            event = swarm.select_next_some() => {
                handle_swarm_event(
                    &mut swarm,
                    event,
                    &mut relayed,
                    &mut coordination_relays,
                    &mut external_candidate_ready,
                );
                maintain_coordination_relays(
                    &mut swarm,
                    &mut coordination_relays,
                    external_candidate_ready,
                    Instant::now(),
                );
                let peers = pending.keys().copied().collect::<Vec<_>>();
                for peer_id in peers {
                    maybe_open_direct_stream(
                        peer_id,
                        &mut pending,
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
                retry_coordination_routes(
                    &mut swarm,
                    &mut pending,
                    &coordination_relays,
                    &stream_control,
                    &relayed,
                    external_candidate_ready,
                    now,
                );
                let expired = pending.iter()
                    .filter_map(|(peer_id, item)| (item.deadline <= now).then_some(*peer_id))
                    .collect::<Vec<_>>();
                for peer_id in expired {
                    if let Some(waiter) = pending.remove(&peer_id) {
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
                    .with_max_pending_incoming(Some(MAX_PENDING_CONNECTIONS))
                    .with_max_pending_outgoing(Some(MAX_PENDING_CONNECTIONS))
                    .with_max_established_incoming(Some(MAX_ESTABLISHED_CONNECTIONS))
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
) -> Result<(), PeerError> {
    if options.route_hints.is_empty() && options.coordination_relays.is_empty() {
        return Err(PeerError::new(
            "direct_path_unavailable",
            "the peer profile has no route hints or coordination relays",
        ));
    }
    for address in &options.route_hints {
        let target = address_with_expected_peer(address, options.peer_id)?;
        let _ = swarm.dial(target);
    }
    for relay_address in &options.coordination_relays {
        let relay_peer = peer_id_from_address(relay_address).ok_or_else(|| {
            PeerError::new(
                "coordination_unavailable",
                "coordination relay address has no peer identity",
            )
        })?;
        if relay_peer == options.peer_id {
            return Err(PeerError::new(
                "coordination_unavailable",
                "coordination relay cannot be the target peer",
            ));
        }
        register_coordination_relay(
            swarm,
            coordination_relays,
            relay_address,
            local_peer_id,
            false,
        )?;
    }
    Ok(())
}

fn maybe_open_direct_stream(
    peer_id: PeerId,
    pending: &mut HashMap<PeerId, PendingConnect>,
    mut control: application_stream::Control,
    opened_tx: mpsc::Sender<OpenedStream>,
) {
    let Some(waiter) = pending.get_mut(&peer_id) else {
        return;
    };
    if waiter.opening || !control.has_connection(peer_id) {
        return;
    }
    waiter.opening = true;
    tokio::spawn(async move {
        let result = control
            .open_stream(peer_id)
            .await
            .map_err(|error| error.to_string());
        let _ = opened_tx.send(OpenedStream { peer_id, result }).await;
    });
}

fn handle_swarm_event(
    swarm: &mut Swarm<Behaviour>,
    event: SwarmEvent<BehaviourEvent>,
    relayed: &mut HashMap<PeerId, HashSet<ConnectionId>>,
    coordination_relays: &mut HashMap<PeerId, CoordinationRelay>,
    external_candidate_ready: &mut bool,
) {
    match event {
        SwarmEvent::ConnectionEstablished {
            peer_id,
            connection_id,
            endpoint,
            ..
        } => {
            if endpoint.is_relayed() {
                relayed.entry(peer_id).or_default().insert(connection_id);
            } else {
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
            if !swarm.is_connected(&peer_id)
                && let Some(relay) = coordination_relays.get_mut(&peer_id)
                && let Some(listener) = relay.connection_lost(Instant::now())
            {
                swarm.remove_listener(listener);
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
        external_candidate_ready,
    );
}

fn register_coordination_relay(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    address: &Multiaddr,
    local_peer_id: PeerId,
    reserve: bool,
) -> Result<(), PeerError> {
    let relay_peer = peer_id_from_address(address).ok_or_else(|| {
        PeerError::new(
            "coordination_unavailable",
            "coordination relay address has no peer identity",
        )
    })?;
    if relay_peer == local_peer_id {
        return Err(PeerError::new(
            "coordination_unavailable",
            "peer endpoint cannot use itself as a coordination relay",
        ));
    }
    let connected = swarm.is_connected(&relay_peer);
    let relay = relays.entry(relay_peer).or_default();
    relay.reserve |= reserve;
    if !relay.addresses.contains(address) {
        relay.addresses.push(address.clone());
    }
    if !connected {
        dial_coordination_relay(swarm, relay, Instant::now());
    }
    Ok(())
}

fn dial_coordination_relay(
    swarm: &mut Swarm<Behaviour>,
    relay: &mut CoordinationRelay,
    now: Instant,
) {
    if relay.next_connection_attempt > now {
        return;
    }
    relay.next_connection_attempt = now + COORDINATION_RETRY_INTERVAL;
    for address in &relay.addresses {
        let _ = swarm.dial(address.clone());
    }
}

fn maintain_coordination_relays(
    swarm: &mut Swarm<Behaviour>,
    relays: &mut HashMap<PeerId, CoordinationRelay>,
    external_candidate_ready: bool,
    now: Instant,
) {
    for peer_id in relays.keys().copied().collect::<Vec<_>>() {
        if !swarm.is_connected(&peer_id) {
            if let Some(relay) = relays.get_mut(&peer_id) {
                dial_coordination_relay(swarm, relay, now);
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

fn retry_coordination_routes(
    swarm: &mut Swarm<Behaviour>,
    pending: &mut HashMap<PeerId, PendingConnect>,
    coordination_relays: &HashMap<PeerId, CoordinationRelay>,
    stream_control: &application_stream::Control,
    relayed: &HashMap<PeerId, HashSet<ConnectionId>>,
    external_candidate_ready: bool,
    now: Instant,
) {
    for (peer_id, connect) in pending {
        if connect.next_coordination_attempt > now {
            continue;
        }
        if stream_control.has_connection(*peer_id) {
            continue;
        }
        if relayed.get(peer_id).is_some_and(|ids| !ids.is_empty()) {
            continue;
        }
        connect.next_coordination_attempt = now + COORDINATION_RETRY_INTERVAL;
        for relay in &connect.coordination_relays {
            let Some(relay_peer) = peer_id_from_address(relay) else {
                continue;
            };
            if !external_candidate_ready
                || coordination_relays
                    .get(&relay_peer)
                    .is_none_or(|relay| !relay.identify_received || !relay.identify_sent)
            {
                continue;
            }
            let target = relay
                .clone()
                .with(Protocol::P2pCircuit)
                .with(Protocol::P2p(*peer_id));
            let _ = swarm.dial(target);
        }
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
}
