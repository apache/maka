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

use std::{str::FromStr, time::Duration};

use anyhow::{Context as _, Result, bail};
use futures::{AsyncReadExt as _, AsyncWriteExt as _, StreamExt as _};
use libp2p::{
    Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder,
    core::ConnectedPoint,
    dcutr, identify, identity,
    multiaddr::Protocol,
    noise, ping, relay,
    swarm::{ConnectionId, NetworkBehaviour, SwarmEvent, behaviour::toggle::Toggle},
    tcp, yamux,
};
use libp2p_stream as stream;
use maka_runtime_host_webrtc_experiment::{
    SIGNALING_PROTOCOL, UpgradeOptions, UpgradeRole, WebRtcTransport, WebRtcTransportControl,
    upgrade_connection,
};
use serde_json::json;
use tokio::sync::mpsc;

const ECHO_PROTOCOL: &str = "/maka/webrtc-phase-zero/echo/1";
const ECHO_PAYLOAD: &[u8] = b"maka-runtime-host-webrtc-phase-zero";
const OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DirectMode {
    Dcutr,
    WebRtc,
}

impl DirectMode {
    fn label(self) -> &'static str {
        match self {
            Self::Dcutr => "dcutr",
            Self::WebRtc => "webrtc",
        }
    }
}

impl FromStr for DirectMode {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "dcutr" => Ok(Self::Dcutr),
            "webrtc" => Ok(Self::WebRtc),
            _ => bail!("mode must be dcutr or webrtc"),
        }
    }
}

enum Command {
    Relay {
        listen: Multiaddr,
    },
    Answer {
        mode: DirectMode,
        relay: Multiaddr,
        stun_urls: Vec<String>,
    },
    Dial {
        mode: DirectMode,
        relay: Multiaddr,
        target: PeerId,
        stun_urls: Vec<String>,
    },
}

#[derive(NetworkBehaviour)]
struct Behaviour {
    relay_client: relay::client::Behaviour,
    relay_server: relay::Behaviour,
    dcutr: Toggle<dcutr::Behaviour>,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
    streams: stream::Behaviour,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectionPath {
    Direct,
    Relayed,
    WebRtc,
}

enum SwarmCommand {
    Dial(Multiaddr),
    Listen(Multiaddr),
    Close(ConnectionId),
    Shutdown,
}

enum EndpointEvent {
    Listening,
    ReservationAccepted,
    Connected {
        peer: PeerId,
        connection: ConnectionId,
        path: ConnectionPath,
        transport: &'static str,
    },
    Closed(ConnectionId),
    Dcutr {
        peer: PeerId,
        succeeded: bool,
    },
    EchoHandled,
    Failure(String),
}

struct Endpoint {
    peer: PeerId,
    stun_urls: Vec<String>,
    streams: stream::Control,
    web_rtc: WebRtcTransportControl,
    commands: mpsc::UnboundedSender<SwarmCommand>,
    events: mpsc::UnboundedReceiver<EndpointEvent>,
}

#[tokio::main]
async fn main() {
    let result = match parse_command() {
        Ok(Command::Relay { listen }) => run_relay(listen).await,
        Ok(Command::Answer {
            mode,
            relay,
            stun_urls,
        }) => run_answer(mode, relay, stun_urls).await,
        Ok(Command::Dial {
            mode,
            relay,
            target,
            stun_urls,
        }) => run_dial(mode, relay, target, stun_urls).await,
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        emit(json!({
            "event": "failure",
            "reason": format!("{error:#}"),
        }));
        std::process::exit(1);
    }
}

fn parse_command() -> Result<Command> {
    let mut args = std::env::args().skip(1);
    let role = args
        .next()
        .context("missing role: relay, answer, or dial")?;
    match role.as_str() {
        "relay" => {
            let listen = parse_multiaddr(args.next(), "relay listen address")?;
            ensure_no_extra_args(args)?;
            Ok(Command::Relay { listen })
        }
        "answer" => {
            let mode = parse_mode(args.next())?;
            let relay = parse_multiaddr(args.next(), "relay address")?;
            Ok(Command::Answer {
                mode,
                relay,
                stun_urls: args.collect(),
            })
        }
        "dial" => {
            let mode = parse_mode(args.next())?;
            let relay = parse_multiaddr(args.next(), "relay address")?;
            let target = args
                .next()
                .context("missing target peer ID")?
                .parse()
                .context("invalid target peer ID")?;
            Ok(Command::Dial {
                mode,
                relay,
                target,
                stun_urls: args.collect(),
            })
        }
        _ => bail!("role must be relay, answer, or dial"),
    }
}

fn parse_mode(value: Option<String>) -> Result<DirectMode> {
    value.context("missing direct mode")?.parse()
}

fn parse_multiaddr(value: Option<String>, label: &str) -> Result<Multiaddr> {
    value
        .with_context(|| format!("missing {label}"))?
        .parse()
        .with_context(|| format!("invalid {label}"))
}

fn ensure_no_extra_args(mut args: impl Iterator<Item = String>) -> Result<()> {
    if args.next().is_some() {
        bail!("unexpected extra arguments");
    }
    Ok(())
}

async fn run_relay(listen: Multiaddr) -> Result<()> {
    let (mut swarm, _, _) = build_swarm(false)?;
    let peer = *swarm.local_peer_id();
    swarm.add_external_address(listen.clone());
    swarm.listen_on(listen)?;
    loop {
        if let SwarmEvent::NewListenAddr { .. } = swarm.select_next_some().await {
            emit(json!({
                "event": "ready",
                "role": "relay",
                "peerId": peer.to_string(),
            }));
            break;
        }
    }
    while let Some(event) = swarm.next().await {
        if let SwarmEvent::Behaviour(BehaviourEvent::RelayServer(
            relay::Event::ReservationReqAccepted { src_peer_id, .. },
        )) = event
        {
            emit(json!({
                "event": "reservation",
                "peerId": src_peer_id.to_string(),
            }));
        }
    }
    Ok(())
}

async fn run_answer(
    mode: DirectMode,
    relay_address: Multiaddr,
    stun_urls: Vec<String>,
) -> Result<()> {
    let mut endpoint = Endpoint::start(mode == DirectMode::Dcutr, stun_urls).await?;
    endpoint.listen(relay_address.with(Protocol::P2pCircuit))?;
    endpoint.wait_for_reservation().await?;
    emit(json!({
        "event": "ready",
        "role": "answer",
        "mode": mode.label(),
        "peerId": endpoint.peer.to_string(),
    }));
    endpoint.wait_for_echo().await?;
    emit(json!({
        "event": "success",
        "role": "answer",
        "mode": mode.label(),
    }));
    endpoint.shutdown();
    Ok(())
}

async fn run_dial(
    mode: DirectMode,
    relay_address: Multiaddr,
    target: PeerId,
    stun_urls: Vec<String>,
) -> Result<()> {
    let started = std::time::Instant::now();
    let mut endpoint = Endpoint::start(mode == DirectMode::Dcutr, stun_urls).await?;
    let circuit = relay_address
        .with(Protocol::P2pCircuit)
        .with(Protocol::P2p(target));
    endpoint.dial(circuit)?;
    let (relayed, _) = endpoint
        .wait_for_connection(target, ConnectionPath::Relayed)
        .await?;

    let (direct, direct_transport) = match mode {
        DirectMode::Dcutr => {
            endpoint
                .wait_for_connection(target, ConnectionPath::Direct)
                .await?
        }
        DirectMode::WebRtc => {
            endpoint.upgrade_to(target).await?;
            endpoint
                .wait_for_connection(target, ConnectionPath::WebRtc)
                .await?
        }
    };

    endpoint.close(relayed)?;
    endpoint.wait_for_close(relayed).await?;
    endpoint.echo(target, ECHO_PAYLOAD).await?;
    emit(json!({
        "event": "success",
        "role": "dial",
        "mode": mode.label(),
        "path": format!("direct-{direct_transport}"),
        "elapsedMs": started.elapsed().as_millis(),
        "connection": direct.to_string(),
    }));
    endpoint.shutdown();
    Ok(())
}

impl Endpoint {
    async fn start(enable_dcutr: bool, stun_urls: Vec<String>) -> Result<Self> {
        let (mut swarm, web_rtc, mut streams) = build_swarm(enable_dcutr)?;
        let peer = *swarm.local_peer_id();
        swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse()?)?;
        swarm.listen_on("/ip4/0.0.0.0/udp/0/quic-v1".parse()?)?;
        swarm.listen_on("/webrtc".parse()?)?;

        let signaling = streams.accept(StreamProtocol::new(SIGNALING_PROTOCOL))?;
        let echo = streams.accept(StreamProtocol::new(ECHO_PROTOCOL))?;
        let (commands, command_receiver) = mpsc::unbounded_channel();
        let (event_sender, events) = mpsc::unbounded_channel();

        tokio::spawn(run_swarm(swarm, command_receiver, event_sender.clone()));
        tokio::spawn(answer_upgrades(
            signaling,
            web_rtc.clone(),
            stun_urls.clone(),
            event_sender.clone(),
        ));
        tokio::spawn(answer_echo(echo, event_sender));

        Ok(Self {
            peer,
            stun_urls,
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

    fn listen(&self, address: Multiaddr) -> Result<()> {
        self.commands
            .send(SwarmCommand::Listen(address))
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
            UpgradeOptions {
                stun_urls: self.stun_urls(),
                udp_bind_addresses: vec!["0.0.0.0:0".to_owned()],
                deadline: OPERATION_TIMEOUT,
                ..UpgradeOptions::default()
            },
        )
        .await
        .context("negotiate WebRTC direct upgrade")?;
        let address = self.web_rtc.register_outbound(peer, connection)?;
        self.dial(address)
    }

    fn stun_urls(&self) -> Vec<String> {
        self.stun_urls.clone()
    }

    async fn echo(&mut self, peer: PeerId, payload: &[u8]) -> Result<()> {
        let mut stream = tokio::time::timeout(
            OPERATION_TIMEOUT,
            self.streams
                .open_stream(peer, StreamProtocol::new(ECHO_PROTOCOL)),
        )
        .await
        .context("opening echo stream reached its deadline")??;
        stream.write_all(payload).await?;
        stream.flush().await?;
        let mut echoed = vec![0; payload.len()];
        tokio::time::timeout(OPERATION_TIMEOUT, stream.read_exact(&mut echoed))
            .await
            .context("echo reached its deadline")??;
        anyhow::ensure!(echoed == payload, "echo payload was corrupted");
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

    async fn wait_for_reservation(&mut self) -> Result<()> {
        loop {
            if matches!(self.next_event().await?, EndpointEvent::ReservationAccepted) {
                return Ok(());
            }
        }
    }

    async fn wait_for_connection(
        &mut self,
        expected_peer: PeerId,
        expected_path: ConnectionPath,
    ) -> Result<(ConnectionId, &'static str)> {
        loop {
            match self.next_event().await? {
                EndpointEvent::Connected {
                    peer,
                    connection,
                    path,
                    transport,
                } if peer == expected_peer && path == expected_path => {
                    return Ok((connection, transport));
                }
                EndpointEvent::Dcutr {
                    peer,
                    succeeded: false,
                } if peer == expected_peer && expected_path == ConnectionPath::Direct => {
                    bail!("DCUtR failed")
                }
                _ => {}
            }
        }
    }

    async fn wait_for_close(&mut self, expected: ConnectionId) -> Result<()> {
        loop {
            if matches!(self.next_event().await?, EndpointEvent::Closed(id) if id == expected) {
                return Ok(());
            }
        }
    }

    async fn wait_for_echo(&mut self) -> Result<()> {
        loop {
            if matches!(self.next_event().await?, EndpointEvent::EchoHandled) {
                return Ok(());
            }
        }
    }

    async fn next_event(&mut self) -> Result<EndpointEvent> {
        match tokio::time::timeout(OPERATION_TIMEOUT, self.events.recv()).await {
            Ok(Some(EndpointEvent::Failure(error))) => Err(anyhow::anyhow!(error)),
            Ok(Some(event)) => Ok(event),
            Ok(None) => bail!("endpoint stopped"),
            Err(_) => bail!("endpoint operation reached its deadline"),
        }
    }
}

fn build_swarm(
    enable_dcutr: bool,
) -> Result<(Swarm<Behaviour>, WebRtcTransportControl, stream::Control)> {
    let key = identity::Keypair::generate_ed25519();
    let peer = key.public().to_peer_id();
    let (web_rtc_transport, web_rtc) = WebRtcTransport::new();
    let swarm = SwarmBuilder::with_existing_identity(key)
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_quic()
        .with_other_transport(move |_| web_rtc_transport)?
        .with_relay_client(noise::Config::new, yamux::Config::default)?
        .with_behaviour(move |key, relay_client| Behaviour {
            relay_client,
            relay_server: relay::Behaviour::new(peer, relay::Config::default()),
            dcutr: Toggle::from(
                enable_dcutr.then(|| dcutr::Behaviour::new(key.public().to_peer_id())),
            ),
            identify: identify::Behaviour::new(identify::Config::new(
                "/maka/webrtc-phase-zero/identify/1".to_owned(),
                key.public(),
            )),
            ping: ping::Behaviour::new(ping::Config::new()),
            streams: stream::Behaviour::new(),
        })?
        .with_swarm_config(|config| config.with_idle_connection_timeout(Duration::from_secs(120)))
        .build();
    let streams = swarm.behaviour().streams.new_control();
    Ok((swarm, web_rtc, streams))
}

async fn run_swarm(
    mut swarm: Swarm<Behaviour>,
    mut commands: mpsc::UnboundedReceiver<SwarmCommand>,
    events: mpsc::UnboundedSender<EndpointEvent>,
) {
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(SwarmCommand::Dial(address)) => {
                    if let Err(error) = swarm.dial(address) {
                        let _ = events.send(EndpointEvent::Failure(format!("dial command: {error}")));
                    }
                }
                Some(SwarmCommand::Listen(address)) => {
                    if let Err(error) = swarm.listen_on(address) {
                        let _ = events.send(EndpointEvent::Failure(format!("listen command: {error}")));
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
                    let _ = address;
                    let _ = events.send(EndpointEvent::Listening);
                }
                SwarmEvent::ConnectionEstablished {
                    peer_id,
                    connection_id,
                    endpoint,
                    ..
                } => {
                    let _ = events.send(EndpointEvent::Connected {
                        peer: peer_id,
                        connection: connection_id,
                        path: connection_path(&endpoint),
                        transport: connection_transport(&endpoint),
                    });
                }
                SwarmEvent::ConnectionClosed { connection_id, .. } => {
                    let _ = events.send(EndpointEvent::Closed(connection_id));
                }
                SwarmEvent::OutgoingConnectionError { error, .. } => {
                    let _ = events.send(EndpointEvent::Failure(format!("outgoing connection: {error}")));
                }
                SwarmEvent::IncomingConnectionError { error, .. } => {
                    let _ = events.send(EndpointEvent::Failure(format!("incoming connection: {error}")));
                }
                SwarmEvent::ListenerError { error, .. } => {
                    let _ = events.send(EndpointEvent::Failure(format!("listener: {error}")));
                }
                SwarmEvent::Behaviour(BehaviourEvent::RelayClient(
                    relay::client::Event::ReservationReqAccepted { relay_peer_id, .. }
                )) => {
                    let _ = relay_peer_id;
                    let _ = events.send(EndpointEvent::ReservationAccepted);
                }
                SwarmEvent::Behaviour(BehaviourEvent::Dcutr(dcutr::Event {
                    remote_peer_id,
                    result,
                })) => {
                    let _ = events.send(EndpointEvent::Dcutr {
                        peer: remote_peer_id,
                        succeeded: result.is_ok(),
                    });
                }
                _ => {}
            }
        }
    }
}

async fn answer_upgrades(
    mut incoming: stream::IncomingStreams,
    transport: WebRtcTransportControl,
    stun_urls: Vec<String>,
    events: mpsc::UnboundedSender<EndpointEvent>,
) {
    while let Some((authenticated_peer, signaling)) = incoming.next().await {
        let options = UpgradeOptions {
            stun_urls: stun_urls.clone(),
            udp_bind_addresses: vec!["0.0.0.0:0".to_owned()],
            deadline: OPERATION_TIMEOUT,
            ..UpgradeOptions::default()
        };
        match upgrade_connection(
            signaling,
            authenticated_peer,
            authenticated_peer,
            UpgradeRole::Answerer,
            options,
        )
        .await
        {
            Ok((peer, connection)) => {
                if let Err(error) = transport.inject_inbound(peer, connection) {
                    let _ = events.send(EndpointEvent::Failure(format!(
                        "inject inbound WebRTC transport: {error}"
                    )));
                }
            }
            Err(error) => {
                let _ = events.send(EndpointEvent::Failure(format!(
                    "answer WebRTC upgrade: {error}"
                )));
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
                stream
                    .read_exact(&mut payload)
                    .await
                    .context("read echo request")?;
                stream
                    .write_all(&payload)
                    .await
                    .context("write echo response")?;
                stream.flush().await.context("flush echo response")?;
                stream.close().await.context("close echo response")?;
                let mut unexpected = [0_u8; 1];
                anyhow::ensure!(
                    stream
                        .read(&mut unexpected)
                        .await
                        .context("await echo request EOF")?
                        == 0,
                    "dialer sent data after the echo request"
                );
                Ok(())
            }
            .await;
            match result {
                Ok(()) => {
                    let _ = events.send(EndpointEvent::EchoHandled);
                }
                Err(error) => {
                    let _ = events.send(EndpointEvent::Failure(format!(
                        "answer echo stream: {error}"
                    )));
                }
            }
        });
    }
}

fn connection_path(endpoint: &ConnectedPoint) -> ConnectionPath {
    if endpoint
        .get_remote_address()
        .iter()
        .any(|protocol| matches!(protocol, Protocol::WebRTC))
    {
        ConnectionPath::WebRtc
    } else if endpoint.is_relayed() {
        ConnectionPath::Relayed
    } else {
        ConnectionPath::Direct
    }
}

fn connection_transport(endpoint: &ConnectedPoint) -> &'static str {
    if endpoint
        .get_remote_address()
        .iter()
        .any(|protocol| matches!(protocol, Protocol::WebRTC))
    {
        "webrtc"
    } else if endpoint
        .get_remote_address()
        .iter()
        .any(|protocol| matches!(protocol, Protocol::QuicV1))
    {
        "quic"
    } else if endpoint
        .get_remote_address()
        .iter()
        .any(|protocol| matches!(protocol, Protocol::Tcp(_)))
    {
        "tcp"
    } else {
        "unknown"
    }
}

fn emit(value: serde_json::Value) {
    println!("{value}");
}
