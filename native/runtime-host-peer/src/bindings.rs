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
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use libp2p::{Multiaddr, PeerId};
use napi::bindgen_prelude::{Buffer, Error, Result, Status};
use napi_derive::napi;
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot, watch};

use crate::engine::{
    self, DirectTransport, EngineCommand, PeerConnectionPath, PeerError, StreamCommand,
};

type IncomingStreamReceiver = mpsc::Receiver<std::result::Result<Vec<u8>, PeerError>>;
const IDENTITY_PAYLOAD_MAX_BYTES: usize = 8 * 1024;
const MAX_TRANSIT_PEERS: usize = 64;
const MAX_TRANSIT_RELAY_ADDRESSES: usize = 256;
const MAX_WEBRTC_STUN_URLS: usize = 8;
const MAX_WEBRTC_STUN_URL_BYTES: usize = 512;

#[napi(object)]
pub struct StartPeerEndpointOptions {
    pub key_path: String,
    pub expected_peer_id: Option<String>,
    pub listen_addresses: Option<Vec<String>>,
    pub coordination_relays: Option<Vec<String>>,
    pub automatic_relay_discovery: Option<bool>,
    pub web_rtc_stun_urls: Option<Vec<String>>,
}

#[napi(object)]
pub struct ConnectPeerOptions {
    pub request_id: u32,
    pub peer_id: String,
    pub route_hints: Vec<String>,
    pub coordination_relays: Option<Vec<String>>,
    pub transit_relay_peer_ids: Option<Vec<String>>,
    pub direct_deadline_ms: u32,
}

#[napi(object)]
pub struct ConfigurePeerTransitOptions {
    pub allowed_peer_ids: Vec<String>,
    pub approved_relay_peer_ids: Vec<String>,
    pub relay_candidates: Vec<PeerTransitRelayCandidate>,
}

#[napi(object)]
pub struct PeerTransitRelayCandidate {
    pub peer_id: String,
    pub addresses: Vec<String>,
    pub coordination_relays: Vec<String>,
}

#[napi(object)]
pub struct PeerTransitSnapshot {
    pub allowed_peer_count: u32,
    pub active_reservation_count: u32,
    pub active_circuit_count: u32,
    pub max_reservation_count: u32,
    pub max_circuit_count: u32,
    pub max_circuits_per_peer: u32,
    pub max_circuit_duration_seconds: u32,
    pub max_circuit_bytes: u32,
}

#[napi(object)]
pub struct PeerIdentitySignature {
    pub public_key: Buffer,
    pub signature: Buffer,
}

#[napi]
pub struct PeerEndpoint {
    peer_id: String,
    listen_addresses: Vec<String>,
    active_coordination_relays: Arc<RwLock<Vec<Multiaddr>>>,
    transit_snapshot: Arc<RwLock<engine::TransitSnapshot>>,
    commands: mpsc::Sender<EngineCommand>,
    incoming: Arc<AsyncMutex<mpsc::Receiver<engine::PeerStream>>>,
    mesh_incoming: Arc<AsyncMutex<mpsc::Receiver<engine::PeerStream>>>,
    terminal: Arc<AsyncMutex<mpsc::Receiver<PeerError>>>,
    thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
}

#[napi]
impl PeerEndpoint {
    #[napi(getter)]
    pub fn peer_id(&self) -> String {
        self.peer_id.clone()
    }

    #[napi(getter)]
    pub fn listen_addresses(&self) -> Vec<String> {
        self.listen_addresses.clone()
    }

    #[napi(getter)]
    pub fn active_coordination_relays(&self) -> Vec<String> {
        self.active_coordination_relays
            .read()
            .map(|addresses| addresses.iter().map(ToString::to_string).collect())
            .unwrap_or_default()
    }

    #[napi(getter)]
    pub fn transit_snapshot(&self) -> PeerTransitSnapshot {
        let snapshot = self
            .transit_snapshot
            .read()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_default();
        PeerTransitSnapshot {
            allowed_peer_count: snapshot.allowed_peer_count as u32,
            active_reservation_count: snapshot.active_reservation_count as u32,
            active_circuit_count: snapshot.active_circuit_count as u32,
            max_reservation_count: snapshot.max_reservation_count as u32,
            max_circuit_count: snapshot.max_circuit_count as u32,
            max_circuits_per_peer: snapshot.max_circuits_per_peer as u32,
            max_circuit_duration_seconds: snapshot.max_circuit_duration_seconds as u32,
            max_circuit_bytes: snapshot.max_circuit_bytes as u32,
        }
    }

    #[napi]
    pub async fn configure_transit(&self, options: ConfigurePeerTransitOptions) -> Result<()> {
        let allowed_peers = parse_peer_ids(options.allowed_peer_ids)?;
        let approved_relays = parse_peer_ids(options.approved_relay_peer_ids)?;
        let relays = parse_transit_relay_candidates(options.relay_candidates)?;
        let trusted_relays = relays
            .iter()
            .map(|candidate| candidate.peer_id)
            .collect::<HashSet<_>>();
        let local_peer_id = parse_peer_id(&self.peer_id)?;
        if allowed_peers.contains(&local_peer_id)
            || approved_relays.contains(&local_peer_id)
            || trusted_relays.contains(&local_peer_id)
        {
            return Err(Error::new(
                Status::InvalidArg,
                "peer endpoint cannot configure itself as a transit peer",
            ));
        }
        let (result_tx, result_rx) = oneshot::channel();
        self.commands
            .send(EngineCommand::ConfigureTransit {
                policy: engine::TransitPolicy {
                    allowed_peers,
                    approved_relays,
                    relays,
                },
                result: result_tx,
            })
            .await
            .map_err(|_| native_closed_error())?;
        result_rx.await.map_err(|_| native_closed_error())
    }

    #[napi]
    pub async fn connect(&self, options: ConnectPeerOptions) -> Result<PeerStream> {
        connect_peer(self, options, engine::StreamKind::Application).await
    }

    #[napi]
    pub async fn connect_mesh_control(&self, options: ConnectPeerOptions) -> Result<PeerStream> {
        connect_peer(self, options, engine::StreamKind::MeshControl).await
    }

    #[napi]
    pub async fn accept_mesh_control(&self) -> Result<Option<PeerStream>> {
        self.mesh_incoming
            .lock()
            .await
            .recv()
            .await
            .map(wrap_stream)
            .transpose()
    }

    #[napi]
    pub async fn cancel_connect(&self, request_id: u32) -> Result<bool> {
        let (result_tx, result_rx) = oneshot::channel();
        self.commands
            .send(EngineCommand::CancelConnect {
                request_id,
                result: result_tx,
            })
            .await
            .map_err(|_| native_closed_error())?;
        result_rx.await.map_err(|_| native_closed_error())
    }

    #[napi]
    pub async fn accept(&self) -> Result<Option<PeerStream>> {
        let mut incoming = self.incoming.lock().await;
        let mut terminal = self.terminal.lock().await;
        tokio::select! {
            error = terminal.recv() => match error {
                Some(error) => Err(peer_error(error)),
                None => Ok(None),
            },
            stream = incoming.recv() => stream.map(wrap_stream).transpose(),
        }
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        let (result_tx, result_rx) = oneshot::channel();
        if self
            .commands
            .send(EngineCommand::Stop { result: result_tx })
            .await
            .is_ok()
        {
            let _ = result_rx.await;
        }
        let thread = self
            .thread
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "peer endpoint lock poisoned"))?
            .take();
        if let Some(thread) = thread {
            tokio::task::spawn_blocking(move || thread.join())
                .await
                .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
                .map_err(|_| Error::new(Status::GenericFailure, "peer endpoint thread panicked"))?;
        }
        Ok(())
    }
}

async fn connect_peer(
    endpoint: &PeerEndpoint,
    options: ConnectPeerOptions,
    stream_kind: engine::StreamKind,
) -> Result<PeerStream> {
    let peer_id = parse_peer_id(&options.peer_id)?;
    let route_hints = parse_addresses(options.route_hints, "route hint")?;
    let coordination_relays = parse_addresses(
        options.coordination_relays.unwrap_or_default(),
        "coordination relay",
    )?;
    let transit_relay_peers =
        parse_peer_id_list(options.transit_relay_peer_ids.unwrap_or_default())?;
    if !(1..=120_000).contains(&options.direct_deadline_ms) {
        return Err(Error::new(
            Status::InvalidArg,
            "direct deadline must be between 1 and 120000 milliseconds",
        ));
    }
    let (result_tx, result_rx) = oneshot::channel();
    endpoint
        .commands
        .send(EngineCommand::Connect {
            options: engine::ConnectOptions {
                request_id: options.request_id,
                peer_id,
                route_hints,
                coordination_relays,
                transit_relay_peers,
                deadline: Duration::from_millis(u64::from(options.direct_deadline_ms)),
            },
            stream_kind,
            result: result_tx,
        })
        .await
        .map_err(|_| {
            peer_error(PeerError {
                code: "peer_native_failed",
                message: "peer endpoint is closed".to_owned(),
            })
        })?;
    wrap_stream(
        result_rx
            .await
            .map_err(|_| native_closed_error())?
            .map_err(peer_error)?,
    )
}

impl Drop for PeerEndpoint {
    fn drop(&mut self) {
        if Arc::strong_count(&self.thread) == 1 {
            let (result, _) = oneshot::channel();
            let _ = self.commands.try_send(EngineCommand::Stop { result });
        }
    }
}

#[napi]
pub struct PeerStream {
    peer_id: String,
    path: PeerStreamPath,
    incoming: Arc<AsyncMutex<IncomingStreamReceiver>>,
    commands: mpsc::Sender<StreamCommand>,
    abort: watch::Sender<bool>,
}

#[napi(object)]
#[derive(Clone)]
pub struct PeerStreamPath {
    pub kind: String,
    pub transport: Option<String>,
    pub relay_peer_id: Option<String>,
}

#[napi]
impl PeerStream {
    #[napi(getter)]
    pub fn peer_id(&self) -> String {
        self.peer_id.clone()
    }

    #[napi(getter)]
    pub fn path(&self) -> PeerStreamPath {
        self.path.clone()
    }

    #[napi]
    pub async fn read(&self) -> Result<Option<Buffer>> {
        match self.incoming.lock().await.recv().await {
            Some(Ok(bytes)) => Ok(Some(bytes.into())),
            Some(Err(error)) => Err(peer_error(error)),
            None => Ok(None),
        }
    }

    #[napi]
    pub async fn write(&self, bytes: Buffer) -> Result<()> {
        let (result_tx, result_rx) = oneshot::channel();
        self.commands
            .send(StreamCommand::Write {
                bytes: bytes.to_vec(),
                result: result_tx,
            })
            .await
            .map_err(|_| native_closed_error())?;
        result_rx
            .await
            .map_err(|_| native_closed_error())?
            .map_err(peer_error)
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        let (result_tx, result_rx) = oneshot::channel();
        if self
            .commands
            .send(StreamCommand::Close { result: result_tx })
            .await
            .is_err()
        {
            return Ok(());
        }
        match result_rx.await {
            Ok(result) => result.map_err(peer_error),
            Err(_) => Ok(()),
        }
    }

    #[napi]
    pub fn abort(&self) {
        self.abort.send_replace(true);
    }
}

#[napi]
pub fn start_peer_endpoint(options: StartPeerEndpointOptions) -> Result<PeerEndpoint> {
    let started = engine::start(engine::StartOptions {
        key_path: PathBuf::from(options.key_path),
        expected_peer_id: options
            .expected_peer_id
            .map(|value| parse_peer_id(&value))
            .transpose()?,
        listen_addresses: parse_addresses(options.listen_addresses.unwrap_or_default(), "listen")?,
        coordination_relays: parse_addresses(
            options.coordination_relays.unwrap_or_default(),
            "coordination relay",
        )?,
        automatic_relay_discovery: options.automatic_relay_discovery.unwrap_or(false),
        web_rtc_stun_urls: options
            .web_rtc_stun_urls
            .map(parse_webrtc_stun_urls)
            .transpose()?,
    })
    .map_err(peer_error)?;
    Ok(PeerEndpoint {
        peer_id: started.peer_id.to_string(),
        listen_addresses: started
            .listen_addresses
            .into_iter()
            .map(|address| address.to_string())
            .collect(),
        active_coordination_relays: started.active_coordination_relays,
        transit_snapshot: started.transit_snapshot,
        commands: started.commands,
        incoming: Arc::new(AsyncMutex::new(started.incoming)),
        mesh_incoming: Arc::new(AsyncMutex::new(started.mesh_incoming)),
        terminal: Arc::new(AsyncMutex::new(started.terminal)),
        thread: Arc::new(Mutex::new(Some(started.thread))),
    })
}

#[napi]
pub async fn ensure_peer_identity(key_path: String) -> Result<String> {
    engine::ensure_identity(PathBuf::from(key_path))
        .await
        .map(|peer_id| peer_id.to_string())
        .map_err(peer_error)
}

#[napi]
pub async fn sign_peer_identity(
    key_path: String,
    expected_peer_id: String,
    payload: Buffer,
) -> Result<PeerIdentitySignature> {
    validate_identity_payload(&payload)?;
    let signed = engine::sign_identity(
        PathBuf::from(key_path),
        parse_peer_id(&expected_peer_id)?,
        &payload,
    )
    .await
    .map_err(peer_error)?;
    Ok(PeerIdentitySignature {
        public_key: signed.public_key.into(),
        signature: signed.signature.into(),
    })
}

#[napi]
pub fn verify_peer_identity(
    peer_id: String,
    public_key: Buffer,
    payload: Buffer,
    signature: Buffer,
) -> Result<bool> {
    validate_identity_payload(&payload)?;
    engine::verify_identity(parse_peer_id(&peer_id)?, &public_key, &payload, &signature)
        .map_err(peer_error)
}

fn wrap_stream(stream: engine::PeerStream) -> Result<PeerStream> {
    Ok(PeerStream {
        peer_id: stream.peer_id.to_string(),
        path: peer_stream_path(stream.path),
        incoming: Arc::new(AsyncMutex::new(stream.incoming)),
        commands: stream.commands,
        abort: stream.abort,
    })
}

fn peer_stream_path(path: PeerConnectionPath) -> PeerStreamPath {
    match path {
        PeerConnectionPath::Direct(transport) => PeerStreamPath {
            kind: "direct".to_owned(),
            transport: Some(
                match transport {
                    DirectTransport::Quic => "quic",
                    DirectTransport::Tcp => "tcp",
                    DirectTransport::WebRtc => "webrtc",
                    DirectTransport::Other => "other",
                }
                .to_owned(),
            ),
            relay_peer_id: None,
        },
        PeerConnectionPath::Transit { relay_peer_id } => PeerStreamPath {
            kind: "transit".to_owned(),
            transport: None,
            relay_peer_id: Some(relay_peer_id.to_string()),
        },
    }
}

fn parse_peer_id(value: &str) -> Result<PeerId> {
    value
        .parse()
        .map_err(|_| Error::new(Status::InvalidArg, "peer id is invalid"))
}

fn parse_addresses(values: Vec<String>, label: &str) -> Result<Vec<Multiaddr>> {
    values
        .into_iter()
        .map(|value| {
            value.parse().map_err(|_| {
                Error::new(Status::InvalidArg, format!("{label} multiaddr is invalid"))
            })
        })
        .collect()
}

fn parse_webrtc_stun_urls(values: Vec<String>) -> Result<Vec<String>> {
    if values.len() > MAX_WEBRTC_STUN_URLS {
        return Err(Error::new(
            Status::InvalidArg,
            "WebRTC cannot use more than 8 STUN URLs",
        ));
    }
    for value in &values {
        if value.len() > MAX_WEBRTC_STUN_URL_BYTES
            || !value.starts_with("stun:")
            || value.chars().any(char::is_whitespace)
        {
            return Err(Error::new(
                Status::InvalidArg,
                "WebRTC STUN URL must use the stun: scheme and contain no whitespace",
            ));
        }
    }
    Ok(values)
}

fn parse_transit_relay_candidates(
    candidates: Vec<PeerTransitRelayCandidate>,
) -> Result<Vec<engine::TransitRelayCandidate>> {
    let address_count = candidates.iter().try_fold(0usize, |count, candidate| {
        count
            .checked_add(candidate.addresses.len())?
            .checked_add(candidate.coordination_relays.len())
    });
    if address_count.is_none_or(|count| count > MAX_TRANSIT_RELAY_ADDRESSES) {
        return Err(Error::new(
            Status::InvalidArg,
            "transit policy cannot contain more than 256 relay addresses",
        ));
    }
    let mut relays = Vec::new();
    for candidate in candidates {
        let Ok(expected_peer) = candidate.peer_id.parse::<PeerId>() else {
            continue;
        };
        let mut addresses = Vec::new();
        for value in candidate.addresses {
            let Ok(address) = value.parse::<Multiaddr>() else {
                continue;
            };
            if engine::transit_relay_peer_id(&address).ok() == Some(expected_peer) {
                addresses.push(address);
            }
        }
        let mut coordination_relays = candidate
            .coordination_relays
            .into_iter()
            .filter_map(|value| value.parse::<Multiaddr>().ok())
            .filter(|address| {
                engine::coordination_relay_peer_id(address)
                    .is_ok_and(|peer_id| peer_id != expected_peer)
            })
            .collect::<Vec<_>>();
        addresses.sort_unstable_by_key(ToString::to_string);
        addresses.dedup();
        coordination_relays.sort_unstable_by_key(ToString::to_string);
        coordination_relays.dedup();
        if !addresses.is_empty() || !coordination_relays.is_empty() {
            relays.push(engine::TransitRelayCandidate {
                peer_id: expected_peer,
                addresses,
                coordination_relays,
            });
        }
    }
    relays.sort_unstable_by_key(|candidate| candidate.peer_id.to_string());
    relays.dedup_by_key(|candidate| candidate.peer_id);
    Ok(relays)
}

fn parse_peer_ids(values: Vec<String>) -> Result<HashSet<PeerId>> {
    Ok(parse_peer_id_list(values)?.into_iter().collect())
}

fn parse_peer_id_list(values: Vec<String>) -> Result<Vec<PeerId>> {
    if values.len() > MAX_TRANSIT_PEERS {
        return Err(Error::new(
            Status::InvalidArg,
            "transit policy cannot contain more than 64 peers",
        ));
    }
    let mut peers = Vec::new();
    for value in values {
        let peer = parse_peer_id(&value)?;
        if !peers.contains(&peer) {
            peers.push(peer);
        }
    }
    Ok(peers)
}

fn validate_identity_payload(payload: &[u8]) -> Result<()> {
    if payload.is_empty() || payload.len() > IDENTITY_PAYLOAD_MAX_BYTES {
        return Err(Error::new(
            Status::InvalidArg,
            "identity payload must be between 1 and 8192 bytes",
        ));
    }
    Ok(())
}

fn peer_error(error: PeerError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("{}: {}", error.code, error.message),
    )
}

fn native_closed_error() -> Error {
    peer_error(PeerError {
        code: "peer_native_failed",
        message: "peer stream is closed".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transit_relay_addresses_are_bound_to_the_declared_peer() {
        let expected = PeerId::random();
        let other = PeerId::random();
        let accepted = format!("/ip4/192.0.2.1/tcp/4001/p2p/{expected}");
        let coordination = format!("/ip4/198.51.100.1/tcp/4001/p2p/{other}");
        let relays = parse_transit_relay_candidates(vec![PeerTransitRelayCandidate {
            peer_id: expected.to_string(),
            addresses: vec![
                accepted.clone(),
                format!("/ip4/192.0.2.2/tcp/4001/p2p/{other}"),
                "not-a-multiaddr".to_owned(),
            ],
            coordination_relays: vec![
                coordination.clone(),
                format!("/ip4/198.51.100.2/tcp/4001/p2p/{expected}"),
            ],
        }])
        .expect("candidate policy");

        assert_eq!(relays.len(), 1);
        assert_eq!(
            relays[0].addresses,
            vec![accepted.parse().expect("accepted multiaddr")],
        );
        assert_eq!(
            relays[0].coordination_relays,
            vec![coordination.parse().expect("coordination multiaddr")],
        );
    }

    #[test]
    fn webrtc_configuration_accepts_explicit_host_only_ice_and_rejects_turn() {
        assert_eq!(
            parse_webrtc_stun_urls(Vec::new()).expect("host-only ICE"),
            Vec::<String>::new()
        );
        assert!(parse_webrtc_stun_urls(vec!["turn:relay.example:3478".to_owned()]).is_err());
    }
}
