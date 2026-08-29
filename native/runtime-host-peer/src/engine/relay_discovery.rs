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
    collections::{HashMap, HashSet, VecDeque, hash_map::Entry},
    ops::{Deref, DerefMut},
    task::{Context, Poll},
    time::{Duration, Instant},
};

use futures::StreamExt;
use libp2p::{
    Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder, connection_limits,
    core::{Endpoint, transport::PortUse},
    identify, identity,
    kad::{self, store::MemoryStore},
    noise, ping,
    swarm::{
        ConnectionDenied, ConnectionId, FromSwarm, NetworkBehaviour, SwarmEvent, THandler,
        THandlerInEvent, THandlerOutEvent, ToSwarm, dial_opts::DialOpts,
    },
    tcp, yamux,
};
use tokio::sync::mpsc;

use super::{address::address_with_peer, supported_public_relay_address};

const AMINO_PROTOCOL: &str = "/ipfs/kad/1.0.0";
const IDENTIFY_PROTOCOL: &str = "/maka/runtime-host/relay-discovery/1";
const RELAY_HOP_PROTOCOL: &str = "/libp2p/circuit/relay/0.2.0/hop";
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PENDING_PROBES: usize = 8;
const MAX_KNOWN_PEERS: usize = 256;
const MAX_ADDRESSES_PER_PEER: usize = 8;
const PROBE_REVISIT_INTERVAL: Duration = Duration::from_secs(10 * 60);

const AMINO_BOOTSTRAPS: &[&str] = &[
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
    "/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8",
    "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
    "/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
];

struct KnownPeer {
    addresses: Vec<Multiaddr>,
    first_seen: Instant,
}

#[derive(Debug)]
pub(super) struct RelayCandidate {
    pub peer_id: PeerId,
    pub addresses: Vec<Multiaddr>,
}

#[derive(NetworkBehaviour)]
struct Behaviour {
    connection_limits: connection_limits::Behaviour,
    kad: PublicKad,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
}

struct PublicKad(kad::Behaviour<MemoryStore>);

impl Deref for PublicKad {
    type Target = kad::Behaviour<MemoryStore>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for PublicKad {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl NetworkBehaviour for PublicKad {
    type ConnectionHandler = <kad::Behaviour<MemoryStore> as NetworkBehaviour>::ConnectionHandler;
    type ToSwarm = <kad::Behaviour<MemoryStore> as NetworkBehaviour>::ToSwarm;

    fn handle_pending_inbound_connection(
        &mut self,
        connection_id: ConnectionId,
        local_addr: &Multiaddr,
        remote_addr: &Multiaddr,
    ) -> Result<(), ConnectionDenied> {
        self.0
            .handle_pending_inbound_connection(connection_id, local_addr, remote_addr)
    }

    fn handle_established_inbound_connection(
        &mut self,
        connection_id: ConnectionId,
        peer: PeerId,
        local_addr: &Multiaddr,
        remote_addr: &Multiaddr,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        self.0
            .handle_established_inbound_connection(connection_id, peer, local_addr, remote_addr)
    }

    fn handle_pending_outbound_connection(
        &mut self,
        connection_id: ConnectionId,
        maybe_peer: Option<PeerId>,
        addresses: &[Multiaddr],
        effective_role: Endpoint,
    ) -> Result<Vec<Multiaddr>, ConnectionDenied> {
        let addresses = self.0.handle_pending_outbound_connection(
            connection_id,
            maybe_peer,
            addresses,
            effective_role,
        )?;
        Ok(addresses
            .into_iter()
            .filter(|address| allowed_kad_dial_address(maybe_peer, address))
            .collect())
    }

    fn handle_established_outbound_connection(
        &mut self,
        connection_id: ConnectionId,
        peer: PeerId,
        address: &Multiaddr,
        role_override: Endpoint,
        port_use: PortUse,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        self.0.handle_established_outbound_connection(
            connection_id,
            peer,
            address,
            role_override,
            port_use,
        )
    }

    fn on_swarm_event(&mut self, event: FromSwarm) {
        self.0.on_swarm_event(event);
    }

    fn on_connection_handler_event(
        &mut self,
        peer_id: PeerId,
        connection_id: ConnectionId,
        event: THandlerOutEvent<Self>,
    ) {
        self.0
            .on_connection_handler_event(peer_id, connection_id, event);
    }

    fn poll(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
        self.0.poll(cx)
    }
}

pub(super) fn spawn() -> mpsc::Receiver<RelayCandidate> {
    let (sender, receiver) = mpsc::channel(32);
    tokio::spawn(async move {
        match build_swarm() {
            Ok(mut swarm) => run(&mut swarm, sender).await,
            Err(error) => eprintln!("[peer-relay-discovery] unavailable: {error}"),
        }
    });
    receiver
}

fn build_swarm() -> Result<Swarm<Behaviour>, Box<dyn std::error::Error + Send + Sync>> {
    let key = identity::Keypair::generate_ed25519();
    let local_peer_id = key.public().to_peer_id();
    let swarm = SwarmBuilder::with_existing_identity(key)
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_quic()
        .with_dns()?
        .with_behaviour(move |key| {
            let mut config = kad::Config::new(StreamProtocol::new(AMINO_PROTOCOL));
            config.set_query_timeout(Duration::from_secs(15));
            let mut kad =
                kad::Behaviour::with_config(local_peer_id, MemoryStore::new(local_peer_id), config);
            kad.set_mode(Some(kad::Mode::Client));
            Behaviour {
                connection_limits: connection_limits::Behaviour::new(
                    connection_limits::ConnectionLimits::default()
                        .with_max_pending_outgoing(Some(MAX_PENDING_PROBES as u32))
                        .with_max_established_outgoing(Some(32))
                        .with_max_established(Some(32))
                        .with_max_established_per_peer(Some(1)),
                ),
                kad: PublicKad(kad),
                identify: identify::Behaviour::new(discovery_identify_config(key.public())),
                ping: ping::Behaviour::new(ping::Config::new()),
            }
        })?
        .with_swarm_config(|config| config.with_idle_connection_timeout(IDLE_CONNECTION_TIMEOUT))
        .build();
    Ok(swarm)
}

fn discovery_identify_config(public_key: identity::PublicKey) -> identify::Config {
    identify::Config::new(IDENTIFY_PROTOCOL.to_owned(), public_key).with_cache_size(0)
}

async fn run(swarm: &mut Swarm<Behaviour>, sender: mpsc::Sender<RelayCandidate>) {
    let mut known = HashMap::<PeerId, KnownPeer>::new();
    let mut pending = HashSet::<PeerId>::new();
    let mut queue = VecDeque::<PeerId>::new();

    for value in AMINO_BOOTSTRAPS {
        let Ok(address) = value.parse::<Multiaddr>() else {
            continue;
        };
        let Some(peer_id) = terminal_peer_id(&address) else {
            continue;
        };
        remember_canonical(
            peer_id,
            vec![address_with_peer(address, peer_id)],
            &mut known,
            &mut queue,
            Instant::now(),
        );
        for address in known
            .get(&peer_id)
            .into_iter()
            .flat_map(|peer| &peer.addresses)
        {
            swarm
                .behaviour_mut()
                .kad
                .add_address(&peer_id, address.clone());
        }
    }
    let _ = swarm.behaviour_mut().kad.bootstrap();

    let mut walk = tokio::time::interval(DISCOVERY_INTERVAL);
    walk.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        start_probes(swarm, &known, &mut queue, &mut pending);
        tokio::select! {
            _ = walk.tick() => {
                expire_known_peers(&mut known, &pending, Instant::now());
                swarm.behaviour_mut().kad.get_closest_peers(PeerId::random().to_bytes());
            }
            event = swarm.select_next_some() => match event {
                SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::OutboundQueryProgressed {
                    result: kad::QueryResult::GetClosestPeers(result),
                    ..
                })) => {
                    let peers = match result {
                        Ok(result) => result.peers,
                        Err(kad::GetClosestPeersError::Timeout { peers, .. }) => peers,
                    };
                    debug(format_args!("DHT walk returned {} peers", peers.len()));
                    for peer in peers {
                        remember(
                            peer.peer_id,
                            peer.addrs,
                            &mut known,
                            &mut queue,
                            Instant::now(),
                        );
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Kad(kad::Event::RoutingUpdated {
                    peer,
                    addresses: discovered,
                    ..
                })) => {
                    remember(
                        peer,
                        discovered.into_vec(),
                        &mut known,
                        &mut queue,
                        Instant::now(),
                    );
                }
                SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received {
                    peer_id,
                    info,
                    ..
                })) => {
                    pending.remove(&peer_id);
                    let mut candidate_addresses = info.listen_addrs;
                    if let Some(discovered) = known.get(&peer_id) {
                        candidate_addresses.extend(discovered.addresses.iter().cloned());
                    }
                    candidate_addresses = canonical_addresses(peer_id, candidate_addresses);
                    debug(format_args!(
                        "identified {peer_id}; relay={} addresses={}",
                        info.protocols.iter().any(|protocol| protocol.as_ref() == RELAY_HOP_PROTOCOL),
                        candidate_addresses.len(),
                    ));
                    if info.protocols.iter().any(|protocol| protocol.as_ref() == RELAY_HOP_PROTOCOL)
                        && !candidate_addresses.is_empty()
                        && sender.send(RelayCandidate {
                            peer_id,
                            addresses: candidate_addresses,
                        }).await.is_err()
                    {
                        return;
                    }
                }
                SwarmEvent::OutgoingConnectionError { peer_id: Some(peer_id), error, .. } => {
                    debug(format_args!("dial to {peer_id} failed: {error}"));
                    pending.remove(&peer_id);
                }
                SwarmEvent::ConnectionClosed { peer_id, .. } => {
                    pending.remove(&peer_id);
                }
                _ => {}
            }
        }
    }
}

fn debug(message: std::fmt::Arguments<'_>) {
    if std::env::var_os("MAKA_PEER_DISCOVERY_DEBUG").is_some() {
        eprintln!("[peer-relay-discovery] {message}");
    }
}

fn remember(
    peer_id: PeerId,
    discovered: Vec<Multiaddr>,
    known: &mut HashMap<PeerId, KnownPeer>,
    queue: &mut VecDeque<PeerId>,
    now: Instant,
) {
    let discovered = canonical_addresses(peer_id, discovered);
    remember_canonical(peer_id, discovered, known, queue, now);
}

fn remember_canonical(
    peer_id: PeerId,
    mut discovered: Vec<Multiaddr>,
    known: &mut HashMap<PeerId, KnownPeer>,
    queue: &mut VecDeque<PeerId>,
    now: Instant,
) {
    discovered.truncate(MAX_ADDRESSES_PER_PEER);
    if discovered.is_empty() || !known.contains_key(&peer_id) && known.len() >= MAX_KNOWN_PEERS {
        return;
    }
    match known.entry(peer_id) {
        Entry::Occupied(mut entry) => {
            for address in discovered {
                if entry.get().addresses.len() >= MAX_ADDRESSES_PER_PEER {
                    break;
                }
                if !entry.get().addresses.contains(&address) {
                    entry.get_mut().addresses.push(address);
                }
            }
        }
        Entry::Vacant(entry) => {
            entry.insert(KnownPeer {
                addresses: discovered,
                first_seen: now,
            });
            queue.push_back(peer_id);
        }
    }
}

fn expire_known_peers(
    known: &mut HashMap<PeerId, KnownPeer>,
    pending: &HashSet<PeerId>,
    now: Instant,
) {
    known.retain(|peer_id, peer| {
        pending.contains(peer_id) || now.duration_since(peer.first_seen) < PROBE_REVISIT_INTERVAL
    });
}

fn start_probes(
    swarm: &mut Swarm<Behaviour>,
    known: &HashMap<PeerId, KnownPeer>,
    queue: &mut VecDeque<PeerId>,
    pending: &mut HashSet<PeerId>,
) {
    while pending.len() < MAX_PENDING_PROBES {
        let Some(peer_id) = queue.pop_front() else {
            break;
        };
        let Some(peer) = known.get(&peer_id) else {
            continue;
        };
        let options = DialOpts::peer_id(peer_id)
            .addresses(peer.addresses.clone())
            .build();
        if swarm.dial(options).is_ok() {
            pending.insert(peer_id);
        }
    }
}

fn canonical_addresses(peer_id: PeerId, addresses: Vec<Multiaddr>) -> Vec<Multiaddr> {
    let mut result = Vec::new();
    for address in addresses {
        if address
            .iter()
            .any(|protocol| matches!(protocol, libp2p::multiaddr::Protocol::P2pCircuit))
        {
            continue;
        }
        let address = address_with_peer(address, peer_id);
        if has_literal_ip_host(&address)
            && supported_public_relay_address(&address)
            && !result.contains(&address)
        {
            result.push(address);
        }
    }
    result
}

fn allowed_kad_dial_address(peer_id: Option<PeerId>, address: &Multiaddr) -> bool {
    let Some(peer_id) = peer_id else {
        return false;
    };
    let canonical = address_with_peer(address.clone(), peer_id);
    if supported_public_relay_address(&canonical) {
        return true;
    }
    AMINO_BOOTSTRAPS.iter().any(|value| {
        value
            .parse::<Multiaddr>()
            .is_ok_and(|bootstrap| bootstrap == canonical)
    })
}

fn terminal_peer_id(address: &Multiaddr) -> Option<PeerId> {
    match address.iter().last()? {
        libp2p::multiaddr::Protocol::P2p(peer_id) => Some(peer_id),
        _ => None,
    }
}

fn has_literal_ip_host(address: &Multiaddr) -> bool {
    matches!(
        address.iter().next(),
        Some(libp2p::multiaddr::Protocol::Ip4(_) | libp2p::multiaddr::Protocol::Ip6(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kad_dials_only_public_addresses_or_exact_bootstraps() {
        let peer = PeerId::random();
        let public: Multiaddr = "/ip4/1.1.1.1/tcp/4001".parse().expect("public address");
        let private: Multiaddr = "/ip4/127.0.0.1/tcp/4001".parse().expect("private address");
        let dns: Multiaddr = "/dns4/attacker.example/tcp/4001"
            .parse()
            .expect("DNS address");

        assert!(allowed_kad_dial_address(Some(peer), &public));
        assert!(!allowed_kad_dial_address(Some(peer), &private));
        assert!(!allowed_kad_dial_address(Some(peer), &dns));

        let bootstrap: Multiaddr = AMINO_BOOTSTRAPS[0]
            .parse()
            .expect("constant bootstrap address");
        let bootstrap_peer = terminal_peer_id(&bootstrap).expect("bootstrap peer identity");
        assert!(allowed_kad_dial_address(Some(bootstrap_peer), &bootstrap,));
        assert!(!allowed_kad_dial_address(Some(peer), &bootstrap));
        assert_eq!(
            discovery_identify_config(identity::Keypair::generate_ed25519().public()).cache_size(),
            0,
        );
    }
}
