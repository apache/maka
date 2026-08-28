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

use super::address::is_relayed_address;

const OUTBOUND_COMMAND_CAPACITY: usize = 1;

pub(super) struct Behaviour {
    protocol: StreamProtocol,
    direct_only: bool,
    incoming: mpsc::Sender<InboundStream>,
    shared: Arc<Mutex<DirectConnections>>,
}

pub(super) struct InboundStream {
    pub(super) peer_id: PeerId,
    pub(super) stream: Stream,
}

impl Behaviour {
    pub(super) fn new(
        protocol: StreamProtocol,
        incoming_capacity: usize,
        direct_only: bool,
    ) -> (Self, Control, mpsc::Receiver<InboundStream>) {
        let (incoming, receiver) = mpsc::channel(incoming_capacity);
        let shared = Arc::new(Mutex::new(DirectConnections::default()));
        (
            Self {
                protocol,
                direct_only,
                incoming,
                shared: shared.clone(),
            },
            Control { shared },
            receiver,
        )
    }

    fn handler(&mut self, connection_id: ConnectionId, peer_id: PeerId, relayed: bool) -> Handler {
        if self.direct_only && relayed {
            return Handler::relayed();
        }
        let (sender, receiver) = mpsc::channel(OUTBOUND_COMMAND_CAPACITY);
        lock(&self.shared).insert(connection_id, peer_id, sender);
        Handler::direct(
            peer_id,
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
            is_relayed_address(local_addr) || is_relayed_address(remote_addr),
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
        Ok(self.handler(connection_id, peer_id, is_relayed_address(address)))
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
    pub(super) fn has_connection(&self, peer_id: PeerId, excluded: &HashSet<ConnectionId>) -> bool {
        lock(&self.shared).connection(peer_id, excluded).is_some()
    }

    pub(super) async fn open_stream(
        &mut self,
        peer_id: PeerId,
        excluded: &HashSet<ConnectionId>,
    ) -> Result<OpenedStream, OpenStreamError> {
        let (connection_id, sender) = lock(&self.shared)
            .connection(peer_id, excluded)
            .ok_or(OpenStreamError::NoDirectConnection)?;
        let (result, receiver) = oneshot::channel();
        sender
            .send(NewStream { result })
            .await
            .map_err(|_| OpenStreamError::ConnectionClosed)?;
        let stream = receiver
            .await
            .map_err(|_| OpenStreamError::ConnectionClosed)??;
        Ok(OpenedStream {
            connection_id,
            stream,
        })
    }
}

pub(super) struct OpenedStream {
    pub(super) connection_id: ConnectionId,
    pub(super) stream: Stream,
}

#[derive(Debug)]
pub(super) enum OpenStreamError {
    NoDirectConnection,
    ConnectionClosed,
    UnsupportedProtocol,
    Io(io::Error),
}

impl std::fmt::Display for OpenStreamError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoDirectConnection => write!(formatter, "peer has no verified direct connection"),
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
    sender: mpsc::Sender<NewStream>,
}

impl DirectConnections {
    fn insert(
        &mut self,
        connection_id: ConnectionId,
        peer_id: PeerId,
        sender: mpsc::Sender<NewStream>,
    ) {
        self.connections
            .insert(connection_id, DirectConnection { peer_id, sender });
    }

    fn remove(&mut self, connection_id: ConnectionId) {
        self.connections.remove(&connection_id);
    }

    fn connection(
        &self,
        peer_id: PeerId,
        excluded: &HashSet<ConnectionId>,
    ) -> Option<(ConnectionId, mpsc::Sender<NewStream>)> {
        self.connections
            .iter()
            .find(|(connection_id, connection)| {
                connection.peer_id == peer_id
                    && !excluded.contains(connection_id)
                    && !connection.sender.is_closed()
            })
            .map(|(connection_id, connection)| (*connection_id, connection.sender.clone()))
    }
}

fn lock(shared: &Arc<Mutex<DirectConnections>>) -> MutexGuard<'_, DirectConnections> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) struct Handler {
    peer_id: Option<PeerId>,
    protocol: Option<StreamProtocol>,
    incoming: Option<mpsc::Sender<InboundStream>>,
    commands: Option<mpsc::Receiver<NewStream>>,
    pending: HashMap<u64, oneshot::Sender<Result<Stream, OpenStreamError>>>,
    next_request_id: u64,
}

impl Handler {
    fn direct(
        peer_id: PeerId,
        protocol: StreamProtocol,
        incoming: mpsc::Sender<InboundStream>,
        commands: mpsc::Receiver<NewStream>,
    ) -> Self {
        Self {
            peer_id: Some(peer_id),
            protocol: Some(protocol),
            incoming: Some(incoming),
            commands: Some(commands),
            pending: HashMap::new(),
            next_request_id: 0,
        }
    }

    fn relayed() -> Self {
        Self {
            peer_id: None,
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
                            ),
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
                        peer_id: self.peer_id.expect("direct handlers have a peer id"),
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
    fn application_protocol_is_registered_only_on_direct_connections() {
        let protocol = StreamProtocol::new("/maka/test/1");
        let peer_id = PeerId::random();
        let (mut behaviour, control, _) = Behaviour::new(protocol.clone(), 1, true);

        let relayed = behaviour
            .handle_established_outbound_connection(
                ConnectionId::new_unchecked(1),
                peer_id,
                &"/memory/1/p2p-circuit".parse().expect("relay address"),
                Endpoint::Dialer,
                PortUse::Reuse,
            )
            .expect("relayed handler");
        assert_eq!(
            relayed.listen_protocol().upgrade().protocol_info().count(),
            0
        );
        assert!(
            lock(&control.shared)
                .connection(peer_id, &HashSet::new())
                .is_none()
        );
        assert!(!control.has_connection(peer_id, &HashSet::new()));

        let direct = behaviour
            .handle_established_outbound_connection(
                ConnectionId::new_unchecked(2),
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
                .connection(peer_id, &HashSet::new())
                .is_some()
        );
        assert!(control.has_connection(peer_id, &HashSet::new()));
        assert!(
            !control.has_connection(peer_id, &HashSet::from([ConnectionId::new_unchecked(2)]),)
        );
    }
}
