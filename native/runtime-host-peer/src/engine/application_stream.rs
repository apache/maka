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
    collections::{HashMap, VecDeque},
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
        CloseConnection, ConnectionDenied, ConnectionHandler, ConnectionId, FromSwarm,
        NetworkBehaviour, Stream, StreamProtocol, THandler, THandlerInEvent, THandlerOutEvent,
        ToSwarm,
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
    incoming: mpsc::Sender<InboundStream>,
    shared: Arc<Mutex<DirectConnections>>,
    closing: VecDeque<(PeerId, ConnectionId)>,
}

pub(super) struct InboundStream {
    pub(super) connection_id: ConnectionId,
    pub(super) stream: Stream,
}

impl Behaviour {
    pub(super) fn new(
        protocol: StreamProtocol,
        incoming_capacity: usize,
    ) -> (Self, Control, mpsc::Receiver<InboundStream>) {
        let (incoming, receiver) = mpsc::channel(incoming_capacity);
        let shared = Arc::new(Mutex::new(DirectConnections::default()));
        (
            Self {
                protocol,
                incoming,
                shared: shared.clone(),
                closing: VecDeque::new(),
            },
            Control { shared },
            receiver,
        )
    }

    fn handler(&mut self, connection_id: ConnectionId, peer_id: PeerId, relayed: bool) -> Handler {
        if relayed {
            return Handler::relayed();
        }
        let (sender, receiver) = mpsc::channel(OUTBOUND_COMMAND_CAPACITY);
        lock(&self.shared).insert(connection_id, peer_id, sender);
        Handler::direct(
            connection_id,
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
        peer_id: PeerId,
        connection_id: ConnectionId,
        _: THandlerOutEvent<Self>,
    ) {
        self.closing.push_back((peer_id, connection_id));
    }

    fn poll(&mut self, _: &mut Context<'_>) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
        let Some((peer_id, connection_id)) = self.closing.pop_front() else {
            return Poll::Pending;
        };
        Poll::Ready(ToSwarm::CloseConnection {
            peer_id,
            connection: CloseConnection::One(connection_id),
        })
    }
}

#[derive(Clone)]
pub(super) struct Control {
    shared: Arc<Mutex<DirectConnections>>,
}

impl Control {
    pub(super) fn has_connection(&self, peer_id: PeerId) -> bool {
        lock(&self.shared).sender(peer_id).is_some()
    }

    pub(super) async fn open_stream(&mut self, peer_id: PeerId) -> Result<Stream, OpenStreamError> {
        let sender = lock(&self.shared)
            .sender(peer_id)
            .ok_or(OpenStreamError::NoDirectConnection)?;
        let (result, receiver) = oneshot::channel();
        sender
            .send(NewStream { result })
            .await
            .map_err(|_| OpenStreamError::ConnectionClosed)?;
        receiver
            .await
            .map_err(|_| OpenStreamError::ConnectionClosed)?
    }
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

    fn sender(&self, peer_id: PeerId) -> Option<mpsc::Sender<NewStream>> {
        self.connections
            .values()
            .find(|connection| connection.peer_id == peer_id && !connection.sender.is_closed())
            .map(|connection| connection.sender.clone())
    }
}

fn lock(shared: &Arc<Mutex<DirectConnections>>) -> MutexGuard<'_, DirectConnections> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) struct Handler {
    connection_id: Option<ConnectionId>,
    protocol: Option<StreamProtocol>,
    incoming: Option<mpsc::Sender<InboundStream>>,
    commands: Option<mpsc::Receiver<NewStream>>,
    pending: Option<oneshot::Sender<Result<Stream, OpenStreamError>>>,
    accepted_inbound: bool,
    close: bool,
}

impl Handler {
    fn direct(
        connection_id: ConnectionId,
        protocol: StreamProtocol,
        incoming: mpsc::Sender<InboundStream>,
        commands: mpsc::Receiver<NewStream>,
    ) -> Self {
        Self {
            connection_id: Some(connection_id),
            protocol: Some(protocol),
            incoming: Some(incoming),
            commands: Some(commands),
            pending: None,
            accepted_inbound: false,
            close: false,
        }
    }

    fn relayed() -> Self {
        Self {
            connection_id: None,
            protocol: None,
            incoming: None,
            commands: None,
            pending: None,
            accepted_inbound: false,
            close: false,
        }
    }
}

impl ConnectionHandler for Handler {
    type FromBehaviour = Infallible;
    type ToBehaviour = ();
    type InboundProtocol = ProtocolUpgrade;
    type OutboundProtocol = ProtocolUpgrade;
    type InboundOpenInfo = ();
    type OutboundOpenInfo = ();

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
    ) -> Poll<libp2p::swarm::ConnectionHandlerEvent<Self::OutboundProtocol, (), Self::ToBehaviour>>
    {
        if std::mem::take(&mut self.close) {
            return Poll::Ready(libp2p::swarm::ConnectionHandlerEvent::NotifyBehaviour(()));
        }
        if self.pending.is_some() {
            return Poll::Pending;
        }
        let Some(commands) = self.commands.as_mut() else {
            return Poll::Pending;
        };
        match commands.poll_recv(context) {
            Poll::Ready(Some(command)) => {
                let protocol = self
                    .protocol
                    .clone()
                    .expect("only direct handlers receive stream commands");
                self.pending = Some(command.result);
                Poll::Ready(
                    libp2p::swarm::ConnectionHandlerEvent::OutboundSubstreamRequest {
                        protocol: libp2p::swarm::SubstreamProtocol::new(
                            ProtocolUpgrade(vec![protocol]),
                            (),
                        ),
                    },
                )
            }
            Poll::Ready(None) | Poll::Pending => Poll::Pending,
        }
    }

    fn on_connection_event(
        &mut self,
        event: ConnectionEvent<Self::InboundProtocol, Self::OutboundProtocol>,
    ) {
        match event {
            ConnectionEvent::FullyNegotiatedInbound(FullyNegotiatedInbound {
                protocol: (stream, _),
                ..
            }) => {
                if self.accepted_inbound {
                    self.close = true;
                    return;
                }
                self.accepted_inbound = true;
                if self.incoming.as_ref().is_none_or(|incoming| {
                    incoming
                        .try_send(InboundStream {
                            connection_id: self
                                .connection_id
                                .expect("direct handlers have a connection id"),
                            stream,
                        })
                        .is_err()
                }) {
                    self.close = true;
                }
            }
            ConnectionEvent::FullyNegotiatedOutbound(FullyNegotiatedOutbound {
                protocol: (stream, _),
                ..
            }) => {
                let Some(result) = self.pending.take() else {
                    return;
                };
                let _ = result.send(Ok(stream));
            }
            ConnectionEvent::DialUpgradeError(DialUpgradeError { error, .. }) => {
                let Some(result) = self.pending.take() else {
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
        let (mut behaviour, control, _) = Behaviour::new(protocol.clone(), 1);

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
        assert!(lock(&control.shared).sender(peer_id).is_none());
        assert!(!control.has_connection(peer_id));

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
        assert!(lock(&control.shared).sender(peer_id).is_some());
        assert!(control.has_connection(peer_id));
    }
}
