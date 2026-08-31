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

use std::{pin::Pin, time::Duration};

use anyhow::{Context as _, Result};
use futures::{AsyncReadExt as _, AsyncWriteExt as _, StreamExt as _, future::poll_fn};
use libp2p::{
    Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder,
    core::{ConnectedPoint, muxing::StreamMuxer},
    identity,
    multiaddr::Protocol,
    noise,
    swarm::{ConnectionId, SwarmEvent},
    tcp, yamux,
};
use libp2p_stream as stream;
use tokio::sync::mpsc;
use tokio_util::compat::TokioAsyncReadCompatExt as _;

use crate::{
    SIGNALING_PROTOCOL, UpgradeError, UpgradeOptions, UpgradeRole, WebRtcTransport,
    WebRtcTransportControl, upgrade_connection,
};

const ECHO_PROTOCOL: &str = "/maka/webrtc-phase-zero/echo/1";
const ECHO_PAYLOAD: &[u8] = b"maka-webrtc-phase-zero";

#[tokio::test]
async fn authenticated_standard_signaling_yields_a_libp2p_stream() {
    let peer_a = PeerId::random();
    let peer_b = PeerId::random();
    let (signaling_a, signaling_b) = tokio::io::duplex(256 * 1024);
    let options = UpgradeOptions::default();

    let (offer, answer) = tokio::join!(
        upgrade_connection(
            signaling_a.compat(),
            peer_b,
            peer_b,
            UpgradeRole::Offerer,
            options.clone(),
        ),
        upgrade_connection(
            signaling_b.compat(),
            peer_a,
            peer_a,
            UpgradeRole::Answerer,
            options,
        )
    );
    let (authenticated_b, mut connection_a) = offer.unwrap();
    let (authenticated_a, mut connection_b) = answer.unwrap();
    assert_eq!(authenticated_b, peer_b);
    assert_eq!(authenticated_a, peer_a);

    let (outbound, inbound) = tokio::join!(
        poll_fn(|cx| Pin::new(&mut connection_a).poll_outbound(cx)),
        poll_fn(|cx| Pin::new(&mut connection_b).poll_inbound(cx)),
    );
    let mut outbound = outbound.unwrap();
    let mut inbound = inbound.unwrap();

    let nonce = b"maka-webrtc-phase-zero";
    outbound.write_all(nonce).await.unwrap();
    outbound.flush().await.unwrap();
    let mut received = vec![0; nonce.len()];
    inbound.read_exact(&mut received).await.unwrap();
    assert_eq!(received, nonce);

    inbound.write_all(&received).await.unwrap();
    inbound.flush().await.unwrap();
    let mut echoed = vec![0; nonce.len()];
    outbound.read_exact(&mut echoed).await.unwrap();
    assert_eq!(echoed, nonce);

    outbound.close().await.unwrap();
    inbound.close().await.unwrap();
    poll_fn(|cx| Pin::new(&mut connection_a).poll_close(cx))
        .await
        .unwrap();
    poll_fn(|cx| Pin::new(&mut connection_b).poll_close(cx))
        .await
        .unwrap();
}

#[tokio::test]
async fn identity_mismatch_and_deadline_fail_closed() {
    let expected = PeerId::random();
    let authenticated = PeerId::random();
    let (signaling, _remote) = tokio::io::duplex(1024);
    let mismatch = match upgrade_connection(
        signaling.compat(),
        authenticated,
        expected,
        UpgradeRole::Offerer,
        UpgradeOptions::default(),
    )
    .await
    {
        Err(error) => error,
        Ok(_) => panic!("identity mismatch unexpectedly succeeded"),
    };
    assert!(matches!(mismatch, UpgradeError::IdentityMismatch { .. }));

    let (signaling, _remote) = tokio::io::duplex(1024);
    let peer = PeerId::random();
    let timeout = match upgrade_connection(
        signaling.compat(),
        peer,
        peer,
        UpgradeRole::Offerer,
        UpgradeOptions {
            deadline: Duration::from_millis(50),
            ..UpgradeOptions::default()
        },
    )
    .await
    {
        Err(error) => error,
        Ok(_) => panic!("unanswered signaling unexpectedly succeeded"),
    };
    assert!(matches!(timeout, UpgradeError::Deadline));
}

#[tokio::test]
async fn upgraded_connection_runs_an_existing_protocol_inside_the_same_swarm() -> Result<()> {
    let mut endpoint_a = TestEndpoint::start(UpgradeResponder::Answer).await?;
    let mut endpoint_b = TestEndpoint::start(UpgradeResponder::Answer).await?;
    let address_b = endpoint_b.wait_for_tcp_listener().await?;

    endpoint_a.dial(address_b.with(Protocol::P2p(endpoint_b.peer)))?;
    let tcp_a = endpoint_a.wait_for_connection(false).await?;
    let tcp_b = endpoint_b.wait_for_connection(false).await?;

    endpoint_a.upgrade_to(endpoint_b.peer).await?;
    endpoint_a.wait_for_connection(true).await?;
    endpoint_b.wait_for_connection(true).await?;

    endpoint_a.close(tcp_a)?;
    endpoint_b.close(tcp_b)?;
    endpoint_a.wait_for_close(tcp_a).await?;
    endpoint_b.wait_for_close(tcp_b).await?;

    endpoint_a.echo(endpoint_b.peer, ECHO_PAYLOAD).await?;
    endpoint_a.shutdown();
    endpoint_b.shutdown();
    Ok(())
}

#[tokio::test]
async fn failed_upgrade_leaves_the_existing_connection_usable() -> Result<()> {
    let mut endpoint_a = TestEndpoint::start(UpgradeResponder::Answer).await?;
    let mut endpoint_b = TestEndpoint::start(UpgradeResponder::Hold).await?;
    let address_b = endpoint_b.wait_for_tcp_listener().await?;

    endpoint_a.dial(address_b.with(Protocol::P2p(endpoint_b.peer)))?;
    endpoint_a.wait_for_connection(false).await?;
    endpoint_b.wait_for_connection(false).await?;

    let signaling = endpoint_a
        .streams
        .open_stream(endpoint_b.peer, StreamProtocol::new(SIGNALING_PROTOCOL))
        .await?;
    let options = UpgradeOptions {
        deadline: Duration::from_secs(1),
        ..UpgradeOptions::default()
    };
    let cancellation = options.cancellation.clone();
    let (failure, ()) = tokio::join!(
        upgrade_connection(
            signaling,
            endpoint_b.peer,
            endpoint_b.peer,
            UpgradeRole::Offerer,
            options,
        ),
        async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancellation.cancel();
        }
    );
    assert!(matches!(failure, Err(UpgradeError::Cancelled)));

    endpoint_a.echo(endpoint_b.peer, ECHO_PAYLOAD).await?;
    endpoint_a.shutdown();
    endpoint_b.shutdown();
    Ok(())
}

#[derive(Clone, Copy)]
enum UpgradeResponder {
    Answer,
    Hold,
}

struct TestEndpoint {
    peer: PeerId,
    streams: stream::Control,
    web_rtc: WebRtcTransportControl,
    commands: mpsc::UnboundedSender<SwarmCommand>,
    events: mpsc::UnboundedReceiver<EndpointEvent>,
}

impl TestEndpoint {
    async fn start(upgrade_responder: UpgradeResponder) -> Result<Self> {
        let key = identity::Keypair::generate_ed25519();
        let peer = key.public().to_peer_id();
        let (web_rtc_transport, web_rtc) = WebRtcTransport::new();
        let mut swarm = SwarmBuilder::with_existing_identity(key)
            .with_tokio()
            .with_tcp(
                tcp::Config::default().nodelay(true),
                noise::Config::new,
                yamux::Config::default,
            )?
            .with_other_transport(move |_| web_rtc_transport)?
            .with_behaviour(|_| stream::Behaviour::new())?
            .build();
        swarm.listen_on("/ip4/127.0.0.1/tcp/0".parse()?)?;
        swarm.listen_on("/webrtc".parse()?)?;

        let mut streams = swarm.behaviour().new_control();
        let signaling = streams.accept(StreamProtocol::new(SIGNALING_PROTOCOL))?;
        let echo = streams.accept(StreamProtocol::new(ECHO_PROTOCOL))?;
        let (commands, command_receiver) = mpsc::unbounded_channel();
        let (event_sender, events) = mpsc::unbounded_channel();

        tokio::spawn(run_swarm(swarm, command_receiver, event_sender.clone()));
        match upgrade_responder {
            UpgradeResponder::Answer => {
                tokio::spawn(answer_upgrades(
                    signaling,
                    web_rtc.clone(),
                    event_sender.clone(),
                ));
            }
            UpgradeResponder::Hold => {
                tokio::spawn(hold_upgrades(signaling));
            }
        }
        tokio::spawn(answer_echo(echo, event_sender));

        Ok(Self {
            peer,
            streams,
            web_rtc,
            commands,
            events,
        })
    }

    fn dial(&self, address: Multiaddr) -> Result<()> {
        self.commands
            .send(SwarmCommand::Dial(address))
            .map_err(|_| anyhow::anyhow!("swarm stopped"))
    }

    async fn upgrade_to(&mut self, peer: PeerId) -> Result<()> {
        let signaling = self
            .streams
            .open_stream(peer, StreamProtocol::new(SIGNALING_PROTOCOL))
            .await
            .context("open authenticated WebRTC signaling stream")?;
        let (_, connection) = upgrade_connection(
            signaling,
            peer,
            peer,
            UpgradeRole::Offerer,
            UpgradeOptions::default(),
        )
        .await
        .context("negotiate WebRTC direct upgrade")?;
        let address = self.web_rtc.register_outbound(peer, connection)?;
        self.dial(address)
    }

    async fn echo(&mut self, peer: PeerId, payload: &[u8]) -> Result<()> {
        let mut stream = self
            .streams
            .open_stream(peer, StreamProtocol::new(ECHO_PROTOCOL))
            .await
            .context("open existing protocol over WebRTC connection")?;
        stream.write_all(payload).await?;
        stream.flush().await?;
        let mut echoed = vec![0; payload.len()];
        stream.read_exact(&mut echoed).await?;
        anyhow::ensure!(echoed == payload, "existing protocol payload was corrupted");
        stream.close().await?;
        Ok(())
    }

    fn close(&self, connection: ConnectionId) -> Result<()> {
        self.commands
            .send(SwarmCommand::Close(connection))
            .map_err(|_| anyhow::anyhow!("swarm stopped"))
    }

    fn shutdown(&self) {
        let _ = self.commands.send(SwarmCommand::Shutdown);
    }

    async fn wait_for_tcp_listener(&mut self) -> Result<Multiaddr> {
        loop {
            match self.next_event().await? {
                EndpointEvent::Listening(address)
                    if address
                        .iter()
                        .any(|protocol| matches!(protocol, Protocol::Tcp(_))) =>
                {
                    return Ok(address);
                }
                _ => {}
            }
        }
    }

    async fn wait_for_connection(&mut self, web_rtc: bool) -> Result<ConnectionId> {
        loop {
            match self.next_event().await? {
                EndpointEvent::Connected {
                    connection,
                    web_rtc: actual,
                } if actual == web_rtc => return Ok(connection),
                _ => {}
            }
        }
    }

    async fn wait_for_close(&mut self, expected: ConnectionId) -> Result<()> {
        loop {
            match self.next_event().await? {
                EndpointEvent::Closed(connection) if connection == expected => return Ok(()),
                _ => {}
            }
        }
    }

    async fn next_event(&mut self) -> Result<EndpointEvent> {
        match tokio::time::timeout(Duration::from_secs(10), self.events.recv()).await {
            Ok(Some(EndpointEvent::Failure(error))) => Err(anyhow::anyhow!(error)),
            Ok(Some(event)) => Ok(event),
            Ok(None) => Err(anyhow::anyhow!("endpoint stopped")),
            Err(_) => Err(anyhow::anyhow!("endpoint event timed out")),
        }
    }
}

async fn hold_upgrades(mut incoming: stream::IncomingStreams) {
    while let Some((_peer, signaling)) = incoming.next().await {
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(signaling);
    }
}

enum SwarmCommand {
    Dial(Multiaddr),
    Close(ConnectionId),
    Shutdown,
}

enum EndpointEvent {
    Listening(Multiaddr),
    Connected {
        connection: ConnectionId,
        web_rtc: bool,
    },
    Closed(ConnectionId),
    Failure(String),
}

async fn run_swarm(
    mut swarm: Swarm<stream::Behaviour>,
    mut commands: mpsc::UnboundedReceiver<SwarmCommand>,
    events: mpsc::UnboundedSender<EndpointEvent>,
) {
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(SwarmCommand::Dial(address)) => {
                    if let Err(error) = swarm.dial(address) {
                        let _ = events.send(EndpointEvent::Failure(error.to_string()));
                    }
                }
                Some(SwarmCommand::Close(connection)) => {
                    if !swarm.close_connection(connection) {
                        let _ = events.send(EndpointEvent::Failure(
                            "connection was absent when closing".to_owned()
                        ));
                    }
                }
                Some(SwarmCommand::Shutdown) | None => return,
            },
            event = swarm.select_next_some() => match event {
                SwarmEvent::NewListenAddr { address, .. } => {
                    let _ = events.send(EndpointEvent::Listening(address));
                }
                SwarmEvent::ConnectionEstablished { connection_id, endpoint, .. } => {
                    let _ = events.send(EndpointEvent::Connected {
                        connection: connection_id,
                        web_rtc: connected_point_is_webrtc(&endpoint),
                    });
                }
                SwarmEvent::ConnectionClosed { connection_id, .. } => {
                    let _ = events.send(EndpointEvent::Closed(connection_id));
                }
                SwarmEvent::OutgoingConnectionError { error, .. } => {
                    let _ = events.send(EndpointEvent::Failure(error.to_string()));
                }
                SwarmEvent::IncomingConnectionError { error, .. } => {
                    let _ = events.send(EndpointEvent::Failure(error.to_string()));
                }
                _ => {}
            }
        }
    }
}

async fn answer_upgrades(
    mut incoming: stream::IncomingStreams,
    transport: WebRtcTransportControl,
    events: mpsc::UnboundedSender<EndpointEvent>,
) {
    while let Some((authenticated_peer, signaling)) = incoming.next().await {
        match upgrade_connection(
            signaling,
            authenticated_peer,
            authenticated_peer,
            UpgradeRole::Answerer,
            UpgradeOptions::default(),
        )
        .await
        {
            Ok((peer, connection)) => {
                if let Err(error) = transport.inject_inbound(peer, connection) {
                    let _ = events.send(EndpointEvent::Failure(error.to_string()));
                }
            }
            Err(error) => {
                let _ = events.send(EndpointEvent::Failure(error.to_string()));
            }
        }
    }
}

async fn answer_echo(
    mut incoming: stream::IncomingStreams,
    events: mpsc::UnboundedSender<EndpointEvent>,
) {
    while let Some((_peer, mut stream)) = incoming.next().await {
        let events = events.clone();
        tokio::spawn(async move {
            let result = async {
                let mut payload = vec![0; ECHO_PAYLOAD.len()];
                stream.read_exact(&mut payload).await?;
                stream.write_all(&payload).await?;
                stream.flush().await?;
                stream.close().await
            }
            .await;
            if let Err(error) = result {
                let _ = events.send(EndpointEvent::Failure(error.to_string()));
            }
        });
    }
}

fn connected_point_is_webrtc(endpoint: &ConnectedPoint) -> bool {
    endpoint
        .get_remote_address()
        .iter()
        .any(|protocol| matches!(protocol, Protocol::WebRTC))
}
