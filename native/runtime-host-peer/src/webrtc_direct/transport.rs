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
    io,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard},
    task::{Context, Poll},
};

use futures::{Stream as _, channel::mpsc, future};
use libp2p::{
    Multiaddr, PeerId,
    core::transport::{DialOpts, ListenerId, Transport, TransportError, TransportEvent},
    multiaddr::Protocol,
};

use super::muxer::WebRtcConnection;

const INCOMING_CONNECTION_CAPACITY: usize = 4;
const OUTGOING_CONNECTION_CAPACITY: usize = 32;

type TransportOutput = (PeerId, WebRtcConnection);

pub struct WebRtcTransport {
    incoming: mpsc::Receiver<TransportOutput>,
    listeners: HashMap<ListenerId, Multiaddr>,
    pending_events:
        VecDeque<TransportEvent<future::Ready<Result<TransportOutput, io::Error>>, io::Error>>,
    pending_incoming: VecDeque<TransportOutput>,
    outgoing: Arc<Mutex<HashMap<PeerId, WebRtcConnection>>>,
}

#[derive(Clone)]
pub struct WebRtcTransportControl {
    incoming: mpsc::Sender<TransportOutput>,
    outgoing: Arc<Mutex<HashMap<PeerId, WebRtcConnection>>>,
}

impl WebRtcTransport {
    pub fn new() -> (Self, WebRtcTransportControl) {
        let (incoming_sender, incoming) = mpsc::channel(INCOMING_CONNECTION_CAPACITY);
        let outgoing = Arc::new(Mutex::new(HashMap::new()));
        (
            Self {
                incoming,
                listeners: HashMap::new(),
                pending_events: VecDeque::new(),
                pending_incoming: VecDeque::new(),
                outgoing: Arc::clone(&outgoing),
            },
            WebRtcTransportControl {
                incoming: incoming_sender,
                outgoing,
            },
        )
    }
}

impl WebRtcTransportControl {
    pub fn inject_inbound(
        &self,
        peer: PeerId,
        connection: WebRtcConnection,
    ) -> Result<(), io::Error> {
        let mut incoming = self.incoming.clone();
        incoming.try_send((peer, connection)).map_err(|error| {
            let full = error.is_full();
            let (_, connection) = error.into_inner();
            connection.close_in_background();
            io::Error::new(
                if full {
                    io::ErrorKind::WouldBlock
                } else {
                    io::ErrorKind::BrokenPipe
                },
                if full {
                    "WebRTC transport input is full"
                } else {
                    "WebRTC transport stopped"
                },
            )
        })
    }

    pub fn register_outbound(
        &self,
        peer: PeerId,
        connection: WebRtcConnection,
    ) -> Result<Multiaddr, io::Error> {
        let mut outgoing = lock(&self.outgoing);
        if outgoing.contains_key(&peer) {
            connection.close_in_background();
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "WebRTC transport already has a pending connection for this peer",
            ));
        }
        if outgoing.len() >= OUTGOING_CONNECTION_CAPACITY {
            connection.close_in_background();
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "WebRTC transport outbound queue is full",
            ));
        }
        outgoing.insert(peer, connection);
        Ok(webrtc_peer_address(peer))
    }

    pub fn discard_outbound(&self, peer: PeerId) {
        if let Some(connection) = lock(&self.outgoing).remove(&peer) {
            connection.close_in_background();
        }
    }
}

impl Transport for WebRtcTransport {
    type Output = TransportOutput;
    type Error = io::Error;
    type ListenerUpgrade = future::Ready<Result<Self::Output, Self::Error>>;
    type Dial = future::Ready<Result<Self::Output, Self::Error>>;

    fn listen_on(
        &mut self,
        id: ListenerId,
        address: Multiaddr,
    ) -> Result<(), TransportError<Self::Error>> {
        if !is_webrtc_listener_address(&address) {
            return Err(TransportError::MultiaddrNotSupported(address));
        }
        if self.listeners.insert(id, address.clone()).is_some() {
            return Err(TransportError::Other(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "WebRTC listener ID is already registered",
            )));
        }
        self.pending_events.push_back(TransportEvent::NewAddress {
            listener_id: id,
            listen_addr: address,
        });
        Ok(())
    }

    fn remove_listener(&mut self, id: ListenerId) -> bool {
        let Some(address) = self.listeners.remove(&id) else {
            return false;
        };
        self.pending_events
            .push_back(TransportEvent::AddressExpired {
                listener_id: id,
                listen_addr: address,
            });
        true
    }

    fn dial(
        &mut self,
        address: Multiaddr,
        _options: DialOpts,
    ) -> Result<Self::Dial, TransportError<Self::Error>> {
        let Some(peer) = webrtc_peer_id(&address) else {
            return Err(TransportError::MultiaddrNotSupported(address));
        };
        let Some(connection) = lock(&self.outgoing).remove(&peer) else {
            return Err(TransportError::Other(io::Error::new(
                io::ErrorKind::NotFound,
                "WebRTC transport has no prepared connection for this peer",
            )));
        };
        Ok(future::ready(Ok((peer, connection))))
    }

    fn poll(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<TransportEvent<Self::ListenerUpgrade, Self::Error>> {
        if let Some(event) = self.pending_events.pop_front() {
            return Poll::Ready(event);
        }
        while let Poll::Ready(Some(incoming)) = Pin::new(&mut self.incoming).poll_next(context) {
            self.pending_incoming.push_back(incoming);
        }
        let Some((listener_id, local_address)) = self
            .listeners
            .iter()
            .next()
            .map(|(id, address)| (*id, address.clone()))
        else {
            return Poll::Pending;
        };
        let Some((peer, connection)) = self.pending_incoming.pop_front() else {
            return Poll::Pending;
        };
        Poll::Ready(TransportEvent::Incoming {
            listener_id,
            upgrade: future::ready(Ok((peer, connection))),
            local_addr: local_address,
            send_back_addr: webrtc_peer_address(peer),
        })
    }
}

pub fn webrtc_peer_address(peer: PeerId) -> Multiaddr {
    Multiaddr::empty()
        .with(Protocol::WebRTC)
        .with(Protocol::P2p(peer))
}

fn webrtc_peer_id(address: &Multiaddr) -> Option<PeerId> {
    let mut protocols = address.iter();
    match (protocols.next(), protocols.next(), protocols.next()) {
        (Some(Protocol::WebRTC), Some(Protocol::P2p(peer)), None) => Some(peer),
        _ => None,
    }
}

fn is_webrtc_listener_address(address: &Multiaddr) -> bool {
    let mut protocols = address.iter();
    matches!(protocols.next(), Some(Protocol::WebRTC)) && protocols.next().is_none()
}

fn lock(
    shared: &Arc<Mutex<HashMap<PeerId, WebRtcConnection>>>,
) -> MutexGuard<'_, HashMap<PeerId, WebRtcConnection>> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_webrtc_address_is_closed_and_unambiguous() {
        let peer = PeerId::random();
        assert_eq!(
            webrtc_peer_address(peer).to_string(),
            format!("/webrtc/p2p/{peer}"),
        );
    }
}
