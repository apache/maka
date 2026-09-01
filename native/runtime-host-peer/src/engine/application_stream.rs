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
    convert::Infallible,
    future::{Ready, ready},
    io,
    sync::{Arc, Mutex, MutexGuard},
    task::{Context, Poll},
};

use libp2p::{
    Multiaddr, PeerId,
    core::{
        Endpoint,
        transport::PortUse,
        upgrade::{InboundUpgrade, OutboundUpgrade, UpgradeInfo},
    },
    swarm::{
        ConnectionDenied, ConnectionHandler, ConnectionId, FromSwarm, NetworkBehaviour, Stream,
        StreamProtocol, THandler, THandlerInEvent, THandlerOutEvent, ToSwarm,
        behaviour::ConnectionClosed,
        handler::{
            ConnectionEvent, DialUpgradeError, FullyNegotiatedInbound, FullyNegotiatedOutbound,
        },
    },
};
use tokio::sync::{mpsc, oneshot};

use super::{
    address::relay_peer_id_from_circuit_address,
    peer_stream::{DirectTransport, PeerConnectionPath},
};

const OUTBOUND_COMMAND_CAPACITY: usize = 1;
const OUTBOUND_STREAM_OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub(super) struct Behaviour {
    protocol: StreamProtocol,
    trusted_transit_relays: Option<Arc<std::sync::RwLock<HashSet<PeerId>>>>,
    incoming: mpsc::Sender<InboundStream>,
    shared: Arc<Mutex<DirectConnections>>,
}

pub(super) struct InboundStream {
    pub(super) peer_id: PeerId,
    pub(super) connection_id: ConnectionId,
    pub(super) path: PeerConnectionPath,
    pub(super) stream: Stream,
}

impl Behaviour {
    pub(super) fn new(
        protocol: StreamProtocol,
        incoming_capacity: usize,
        trusted_transit_relays: Option<Arc<std::sync::RwLock<HashSet<PeerId>>>>,
    ) -> (Self, Control, mpsc::Receiver<InboundStream>) {
        let (incoming, receiver) = mpsc::channel(incoming_capacity);
        let shared = Arc::new(Mutex::new(DirectConnections::default()));
        (
            Self {
                protocol,
                trusted_transit_relays,
                incoming,
                shared: shared.clone(),
            },
            Control { shared },
            receiver,
        )
    }

    fn handler(
        &mut self,
        connection_id: ConnectionId,
        peer_id: PeerId,
        path: PeerConnectionPath,
        allow_relayed: bool,
    ) -> Handler {
        let relay_peer_id = path.relay_peer_id();
        if relay_peer_id.is_some()
            && !allow_relayed
            && self.trusted_transit_relays.as_ref().is_some_and(|trusted| {
                !trusted
                    .read()
                    .map(|peers| relay_peer_id.is_some_and(|peer| peers.contains(&peer)))
                    .unwrap_or(false)
            })
        {
            lock(&self.shared).insert(connection_id, peer_id, path, None);
            return Handler::relayed();
        }
        let (sender, receiver) = mpsc::channel(OUTBOUND_COMMAND_CAPACITY);
        lock(&self.shared).insert(connection_id, peer_id, path.clone(), Some(sender));
        Handler::direct(
            connection_id,
            peer_id,
            path,
            self.protocol.clone(),
            self.incoming.clone(),
            receiver,
        )
    }
}

impl NetworkBehaviour for Behaviour {
    type ConnectionHandler = Handler;
    type ToSwarm = Infallible;

    fn handle_established_inbound_connection(
        &mut self,
        connection_id: ConnectionId,
        peer_id: PeerId,
        local_addr: &Multiaddr,
        remote_addr: &Multiaddr,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(self.handler(
            connection_id,
            peer_id,
            connection_path(local_addr, remote_addr),
            false,
        ))
    }

    fn handle_established_outbound_connection(
        &mut self,
        connection_id: ConnectionId,
        peer_id: PeerId,
        address: &Multiaddr,
        _: Endpoint,
        _: PortUse,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(self.handler(
            connection_id,
            peer_id,
            connection_path(address, address),
            true,
        ))
    }

    fn on_swarm_event(&mut self, event: FromSwarm) {
        if let FromSwarm::ConnectionClosed(ConnectionClosed { connection_id, .. }) = event {
            lock(&self.shared).remove(connection_id);
        }
    }

    fn on_connection_handler_event(
        &mut self,
        _: PeerId,
        _: ConnectionId,
        event: THandlerOutEvent<Self>,
    ) {
        libp2p::core::util::unreachable(event);
    }

    fn poll(&mut self, _: &mut Context<'_>) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
        Poll::Pending
    }
}

#[derive(Clone)]
pub(super) struct Control {
    shared: Arc<Mutex<DirectConnections>>,
}

impl Control {
    pub(super) fn relays_with_active_streams(
        &self,
        active_streams: &HashMap<ConnectionId, usize>,
    ) -> HashSet<PeerId> {
        lock(&self.shared)
            .connections
            .iter()
            .filter_map(|(connection_id, connection)| {
                active_streams
                    .contains_key(connection_id)
                    .then_some(connection.path.relay_peer_id())
                    .flatten()
            })
            .collect()
    }

    pub(super) fn connections_via(&self, relays: &HashSet<PeerId>) -> Vec<ConnectionId> {
        lock(&self.shared)
            .connections
            .iter()
            .filter_map(|(connection_id, connection)| {
                connection
                    .path
                    .relay_peer_id()
                    .is_some_and(|relay| relays.contains(&relay))
                    .then_some(*connection_id)
            })
            .collect()
    }

    pub(super) fn has_connection(
        &self,
        peer_id: PeerId,
        excluded: &HashSet<ConnectionId>,
        allowed_relays: &HashSet<PeerId>,
    ) -> bool {
        !self
            .eligible_connections(peer_id, excluded, allowed_relays)
            .is_empty()
    }

    pub(super) fn eligible_connections(
        &self,
        peer_id: PeerId,
        excluded: &HashSet<ConnectionId>,
        allowed_relays: &HashSet<PeerId>,
    ) -> Vec<(ConnectionId, PeerConnectionPath)> {
        lock(&self.shared).eligible_connections(peer_id, excluded, allowed_relays)
    }

    pub(super) fn has_relayed_connection(&self, peer_id: PeerId) -> bool {
        lock(&self.shared).connections.values().any(|connection| {
            connection.peer_id == peer_id && connection.path.relay_peer_id().is_some()
        })
    }

    pub(super) fn has_relayed_connection_via(
        &self,
        peer_id: PeerId,
        excluded: &HashSet<ConnectionId>,
        allowed_relays: &HashSet<PeerId>,
    ) -> bool {
        lock(&self.shared)
            .relayed_connection(peer_id, excluded, allowed_relays)
            .is_some()
    }

    pub(super) async fn open_stream_on(
        &mut self,
        connection_id: ConnectionId,
        peer_id: PeerId,
        allowed_relays: &HashSet<PeerId>,
    ) -> Result<OpenedStream, OpenStreamError> {
        let (path, sender) = lock(&self.shared)
            .connection_by_id(connection_id, peer_id, allowed_relays)
            .ok_or(OpenStreamError::NoEligibleConnection)?;
        let (result, receiver) = oneshot::channel();
        sender
            .send(NewStream { result })
            .await
            .map_err(|_| OpenStreamError::ConnectionClosed)?;
        let stream = receiver
            .await
            .map_err(|_| OpenStreamError::ConnectionClosed)??;
        Ok(OpenedStream { path, stream })
    }

    pub(super) async fn open_relayed_stream(
        &mut self,
        peer_id: PeerId,
        excluded: &HashSet<ConnectionId>,
        allowed_relays: &HashSet<PeerId>,
    ) -> Result<OpenedStream, OpenStreamError> {
        let (relay_peer_id, sender) = lock(&self.shared)
            .relayed_connection(peer_id, excluded, allowed_relays)
            .ok_or(OpenStreamError::NoEligibleConnection)?;
        let (result, receiver) = oneshot::channel();
        sender
            .send(NewStream { result })
            .await
            .map_err(|_| OpenStreamError::ConnectionClosed)?;
        let stream = receiver
            .await
            .map_err(|_| OpenStreamError::ConnectionClosed)??;
        Ok(OpenedStream {
            path: PeerConnectionPath::Transit { relay_peer_id },
            stream,
        })
    }
}

pub(super) struct OpenedStream {
    pub(super) path: PeerConnectionPath,
    pub(super) stream: Stream,
}

#[derive(Debug)]
pub(super) enum OpenStreamError {
    NoEligibleConnection,
    ConnectionClosed,
    UnsupportedProtocol,
    Io(io::Error),
}

impl std::fmt::Display for OpenStreamError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoEligibleConnection => {
                write!(
                    formatter,
                    "peer has no verified direct or approved transit connection"
                )
            }
            Self::ConnectionClosed => write!(formatter, "direct connection closed"),
            Self::UnsupportedProtocol => {
                write!(formatter, "peer does not support the application protocol")
            }
            Self::Io(error) => error.fmt(formatter),
        }
    }
}

#[derive(Default)]
struct DirectConnections {
    connections: HashMap<ConnectionId, DirectConnection>,
}

struct DirectConnection {
    peer_id: PeerId,
    path: PeerConnectionPath,
    sender: Option<mpsc::Sender<NewStream>>,
}

impl DirectConnections {
    fn insert(
        &mut self,
        connection_id: ConnectionId,
        peer_id: PeerId,
        path: PeerConnectionPath,
        sender: Option<mpsc::Sender<NewStream>>,
    ) {
        self.connections.insert(
            connection_id,
            DirectConnection {
                peer_id,
                path,
                sender,
            },
        );
    }

    fn remove(&mut self, connection_id: ConnectionId) {
        self.connections.remove(&connection_id);
    }

    fn eligible_connections(
        &self,
        peer_id: PeerId,
        excluded: &HashSet<ConnectionId>,
        allowed_relays: &HashSet<PeerId>,
    ) -> Vec<(ConnectionId, PeerConnectionPath)> {
        self.connections
            .iter()
            .filter_map(|(connection_id, connection)| {
                let sender = connection.sender.as_ref()?;
                (connection.peer_id == peer_id
                    && !excluded.contains(connection_id)
                    && connection
                        .path
                        .relay_peer_id()
                        .is_none_or(|relay| allowed_relays.contains(&relay))
                    && !sender.is_closed())
                .then(|| (*connection_id, connection.path.clone()))
            })
            .collect()
    }

    fn connection_by_id(
        &self,
        connection_id: ConnectionId,
        peer_id: PeerId,
        allowed_relays: &HashSet<PeerId>,
    ) -> Option<(PeerConnectionPath, mpsc::Sender<NewStream>)> {
        let connection = self.connections.get(&connection_id)?;
        let sender = connection.sender.as_ref()?;
        (connection.peer_id == peer_id
            && connection
                .path
                .relay_peer_id()
                .is_none_or(|relay| allowed_relays.contains(&relay))
            && !sender.is_closed())
        .then(|| (connection.path.clone(), sender.clone()))
    }

    fn relayed_connection(
        &self,
        peer_id: PeerId,
        excluded: &HashSet<ConnectionId>,
        allowed_relays: &HashSet<PeerId>,
    ) -> Option<(PeerId, mpsc::Sender<NewStream>)> {
        self.connections
            .iter()
            .find_map(|(connection_id, connection)| {
                let sender = connection.sender.as_ref()?;
                let relay = connection.path.relay_peer_id()?;
                (connection.peer_id == peer_id
                    && !excluded.contains(connection_id)
                    && allowed_relays.contains(&relay)
                    && !sender.is_closed())
                .then(|| (relay, sender.clone()))
            })
    }
}

fn lock(shared: &Arc<Mutex<DirectConnections>>) -> MutexGuard<'_, DirectConnections> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn connection_path(local_addr: &Multiaddr, remote_addr: &Multiaddr) -> PeerConnectionPath {
    if let Some(relay_peer_id) = relay_peer_id_from_circuit_address(local_addr)
        .or_else(|| relay_peer_id_from_circuit_address(remote_addr))
    {
        return PeerConnectionPath::Transit { relay_peer_id };
    }
    let transport = local_addr
        .iter()
        .chain(remote_addr.iter())
        .find_map(|protocol| match protocol {
            libp2p::multiaddr::Protocol::WebRTC => Some(DirectTransport::WebRtc),
            libp2p::multiaddr::Protocol::QuicV1 => Some(DirectTransport::Quic),
            libp2p::multiaddr::Protocol::Tcp(_) => Some(DirectTransport::Tcp),
            _ => None,
        })
        .unwrap_or(DirectTransport::Other);
    PeerConnectionPath::Direct(transport)
}

pub(super) struct Handler {
    connection_id: Option<ConnectionId>,
    peer_id: Option<PeerId>,
    path: Option<PeerConnectionPath>,
    protocol: Option<StreamProtocol>,
    incoming: Option<mpsc::Sender<InboundStream>>,
    commands: Option<mpsc::Receiver<NewStream>>,
    pending: HashMap<u64, oneshot::Sender<Result<Stream, OpenStreamError>>>,
    next_request_id: u64,
}

impl Handler {
    fn direct(
        connection_id: ConnectionId,
        peer_id: PeerId,
        path: PeerConnectionPath,
        protocol: StreamProtocol,
        incoming: mpsc::Sender<InboundStream>,
        commands: mpsc::Receiver<NewStream>,
    ) -> Self {
        Self {
            connection_id: Some(connection_id),
            peer_id: Some(peer_id),
            path: Some(path),
            protocol: Some(protocol),
            incoming: Some(incoming),
            commands: Some(commands),
            pending: HashMap::new(),
            next_request_id: 0,
        }
    }

    fn relayed() -> Self {
        Self {
            connection_id: None,
            peer_id: None,
            path: None,
            protocol: None,
            incoming: None,
            commands: None,
            pending: HashMap::new(),
            next_request_id: 0,
        }
    }
}

impl ConnectionHandler for Handler {
    type FromBehaviour = Infallible;
    type ToBehaviour = Infallible;
    type InboundProtocol = ProtocolUpgrade;
    type OutboundProtocol = ProtocolUpgrade;
    type InboundOpenInfo = ();
    type OutboundOpenInfo = u64;

    fn listen_protocol(
        &self,
    ) -> libp2p::swarm::SubstreamProtocol<Self::InboundProtocol, Self::InboundOpenInfo> {
        libp2p::swarm::SubstreamProtocol::new(
            ProtocolUpgrade(self.protocol.iter().cloned().collect()),
            (),
        )
    }

    fn on_behaviour_event(&mut self, event: Self::FromBehaviour) {
        libp2p::core::util::unreachable(event);
    }

    fn poll(
        &mut self,
        context: &mut Context<'_>,
    ) -> Poll<libp2p::swarm::ConnectionHandlerEvent<Self::OutboundProtocol, u64, Self::ToBehaviour>>
    {
        let Some(commands) = self.commands.as_mut() else {
            return Poll::Pending;
        };
        loop {
            match commands.poll_recv(context) {
                Poll::Ready(Some(command)) if command.result.is_closed() => continue,
                Poll::Ready(Some(command)) => {
                    let protocol = self
                        .protocol
                        .clone()
                        .expect("only direct handlers receive stream commands");
                    let request_id = self.next_request_id;
                    self.next_request_id = self.next_request_id.wrapping_add(1);
                    self.pending.insert(request_id, command.result);
                    return Poll::Ready(
                        libp2p::swarm::ConnectionHandlerEvent::OutboundSubstreamRequest {
                            protocol: libp2p::swarm::SubstreamProtocol::new(
                                ProtocolUpgrade(vec![protocol]),
                                request_id,
                            )
                            .with_timeout(OUTBOUND_STREAM_OPEN_TIMEOUT),
                        },
                    );
                }
                Poll::Ready(None) | Poll::Pending => return Poll::Pending,
            }
        }
    }

    fn on_connection_event(
        &mut self,
        event: ConnectionEvent<
            Self::InboundProtocol,
            Self::OutboundProtocol,
            Self::InboundOpenInfo,
            Self::OutboundOpenInfo,
        >,
    ) {
        match event {
            ConnectionEvent::FullyNegotiatedInbound(FullyNegotiatedInbound {
                protocol: (stream, _),
                ..
            }) => {
                if let Some(incoming) = self.incoming.as_ref() {
                    let _ = incoming.try_send(InboundStream {
                        connection_id: self
                            .connection_id
                            .expect("direct handlers have a connection id"),
                        peer_id: self.peer_id.expect("direct handlers have a peer id"),
                        path: self.path.clone().expect("direct handlers have a path"),
                        stream,
                    });
                }
            }
            ConnectionEvent::FullyNegotiatedOutbound(FullyNegotiatedOutbound {
                protocol: (stream, _),
                info,
            }) => {
                let Some(result) = self.pending.remove(&info) else {
                    return;
                };
                let _ = result.send(Ok(stream));
            }
            ConnectionEvent::DialUpgradeError(DialUpgradeError { info, error }) => {
                let Some(result) = self.pending.remove(&info) else {
                    return;
                };
                let error = match error {
                    libp2p::swarm::StreamUpgradeError::Timeout => {
                        OpenStreamError::Io(io::Error::from(io::ErrorKind::TimedOut))
                    }
                    libp2p::swarm::StreamUpgradeError::Apply(value) => {
                        libp2p::core::util::unreachable(value)
                    }
                    libp2p::swarm::StreamUpgradeError::NegotiationFailed => {
                        OpenStreamError::UnsupportedProtocol
                    }
                    libp2p::swarm::StreamUpgradeError::Io(error) => OpenStreamError::Io(error),
                };
                let _ = result.send(Err(error));
            }
            _ => {}
        }
    }
}

struct NewStream {
    result: oneshot::Sender<Result<Stream, OpenStreamError>>,
}

#[derive(Clone)]
pub(super) struct ProtocolUpgrade(Vec<StreamProtocol>);

impl UpgradeInfo for ProtocolUpgrade {
    type Info = StreamProtocol;
    type InfoIter = std::vec::IntoIter<StreamProtocol>;

    fn protocol_info(&self) -> Self::InfoIter {
        self.0.clone().into_iter()
    }
}

impl InboundUpgrade<Stream> for ProtocolUpgrade {
    type Output = (Stream, StreamProtocol);
    type Error = Infallible;
    type Future = Ready<Result<Self::Output, Self::Error>>;

    fn upgrade_inbound(self, stream: Stream, protocol: StreamProtocol) -> Self::Future {
        ready(Ok((stream, protocol)))
    }
}

impl OutboundUpgrade<Stream> for ProtocolUpgrade {
    type Output = (Stream, StreamProtocol);
    type Error = Infallible;
    type Future = Ready<Result<Self::Output, Self::Error>>;

    fn upgrade_outbound(self, stream: Stream, protocol: StreamProtocol) -> Self::Future {
        ready(Ok((stream, protocol)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_protocol_is_registered_only_on_direct_or_trusted_transit_connections() {
        let protocol = StreamProtocol::new("/maka/test/1");
        let peer_id = PeerId::random();
        let relay_peer_id = PeerId::random();
        let trusted = Arc::new(std::sync::RwLock::new(HashSet::new()));
        let (mut behaviour, control, _) =
            Behaviour::new(protocol.clone(), 1, Some(Arc::clone(&trusted)));
        let relay_address: Multiaddr =
            format!("/ip4/127.0.0.1/udp/1/quic-v1/p2p/{relay_peer_id}/p2p-circuit")
                .parse()
                .expect("relay address");

        let relayed = behaviour
            .handle_established_inbound_connection(
                ConnectionId::new_unchecked(1),
                peer_id,
                &relay_address,
                &relay_address,
            )
            .expect("relayed handler");
        assert_eq!(
            relayed.listen_protocol().upgrade().protocol_info().count(),
            0
        );
        assert!(
            lock(&control.shared)
                .connection_by_id(ConnectionId::new_unchecked(1), peer_id, &HashSet::new(),)
                .is_none()
        );
        assert!(!control.has_connection(peer_id, &HashSet::new(), &HashSet::new()));
        assert!(control.has_relayed_connection(peer_id));

        trusted
            .write()
            .expect("trusted relays")
            .insert(relay_peer_id);
        let trusted_relay = behaviour
            .handle_established_inbound_connection(
                ConnectionId::new_unchecked(2),
                peer_id,
                &relay_address,
                &relay_address,
            )
            .expect("trusted relayed handler");
        assert_eq!(
            trusted_relay
                .listen_protocol()
                .upgrade()
                .protocol_info()
                .collect::<Vec<_>>(),
            vec![protocol.clone()]
        );
        let (relay_path, _) = lock(&control.shared)
            .connection_by_id(
                ConnectionId::new_unchecked(2),
                peer_id,
                &HashSet::from([relay_peer_id]),
            )
            .expect("trusted relay connection");
        assert_eq!(relay_path, PeerConnectionPath::Transit { relay_peer_id });
        let relay_connections = control.connections_via(&HashSet::from([relay_peer_id]));
        assert_eq!(relay_connections.len(), 2);
        assert!(relay_connections.contains(&ConnectionId::new_unchecked(1)));
        assert!(relay_connections.contains(&ConnectionId::new_unchecked(2)));

        let direct = behaviour
            .handle_established_outbound_connection(
                ConnectionId::new_unchecked(3),
                peer_id,
                &"/ip4/127.0.0.1/udp/1/quic-v1"
                    .parse()
                    .expect("direct address"),
                Endpoint::Dialer,
                PortUse::Reuse,
            )
            .expect("direct handler");
        assert_eq!(
            direct
                .listen_protocol()
                .upgrade()
                .protocol_info()
                .collect::<Vec<_>>(),
            vec![protocol]
        );
        assert!(
            lock(&control.shared)
                .connection_by_id(ConnectionId::new_unchecked(3), peer_id, &HashSet::new(),)
                .is_some()
        );
        let (direct_path, _) = lock(&control.shared)
            .connection_by_id(ConnectionId::new_unchecked(3), peer_id, &HashSet::new())
            .expect("direct connection");
        assert_eq!(
            direct_path,
            PeerConnectionPath::Direct(DirectTransport::Quic)
        );
        assert!(control.has_connection(peer_id, &HashSet::new(), &HashSet::new()));
        assert!(!control.has_connection(
            peer_id,
            &HashSet::from([
                ConnectionId::new_unchecked(2),
                ConnectionId::new_unchecked(3),
            ]),
            &HashSet::new(),
        ));
    }
}
