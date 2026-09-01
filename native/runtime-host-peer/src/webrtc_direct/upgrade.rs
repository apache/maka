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
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use futures::{
    AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, SinkExt as _, StreamExt as _,
    channel::mpsc,
};
use libp2p::PeerId;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use webrtc::{
    data_channel::DataChannel,
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
        RTCIceCandidateInit, RTCIceServer, RTCPeerConnectionIceEvent, RTCPeerConnectionState,
        RTCSessionDescription,
    },
};

use super::{
    Signal, SignalingError, WebRtcConnection,
    muxer::{ReadySubstream, data_channel_diagnostic, keep_init_channel, ready_substream},
    read_signal, write_signal,
};

const EVENT_CAPACITY: usize = 64;
const MAX_CANDIDATES: usize = 64;
const DATA_CHANNEL_SEND_BUFFER_BYTES: usize = 1024 * 1024;
pub(super) const MAX_INBOUND_SUBSTREAMS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpgradeRole {
    Offerer,
    Answerer,
}

#[derive(Clone, Debug)]
pub struct UpgradeOptions {
    pub stun_urls: Vec<String>,
    pub udp_bind_addresses: Vec<String>,
    pub deadline: Duration,
    pub cancellation: CancellationToken,
}

impl Default for UpgradeOptions {
    fn default() -> Self {
        Self {
            stun_urls: Vec::new(),
            udp_bind_addresses: vec!["127.0.0.1:0".to_owned()],
            deadline: Duration::from_secs(10),
            cancellation: CancellationToken::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum UpgradeError {
    #[error("authenticated signaling peer {authenticated} did not match expected peer {expected}")]
    IdentityMismatch {
        authenticated: String,
        expected: String,
    },
    #[error("WebRTC signaling failed: {0}")]
    Signaling(#[from] SignalingError),
    #[error("WebRTC operation failed: {0}")]
    WebRtc(String),
    #[error("WebRTC signaling stream ended before the direct connection was ready")]
    SignalingEnded,
    #[error("WebRTC signaling message arrived in the wrong phase")]
    UnexpectedSignal,
    #[error("WebRTC signaling exceeded the candidate limit")]
    TooManyCandidates,
    #[error("WebRTC event delivery failed: {0}")]
    EventDelivery(&'static str),
    #[error("WebRTC direct upgrade reached its deadline")]
    Deadline,
    #[error("WebRTC direct upgrade was cancelled")]
    Cancelled,
}

struct PeerConnectionGuard(Option<Arc<dyn PeerConnection>>);

impl PeerConnectionGuard {
    fn new(peer_connection: Arc<dyn PeerConnection>) -> Self {
        Self(Some(peer_connection))
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for PeerConnectionGuard {
    fn drop(&mut self) {
        let Some(peer_connection) = self.0.take() else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = peer_connection.close().await;
            });
        }
    }
}

pub async fn upgrade_connection<S>(
    signaling: S,
    authenticated_peer: PeerId,
    expected_peer: PeerId,
    role: UpgradeRole,
    options: UpgradeOptions,
) -> Result<(PeerId, WebRtcConnection), UpgradeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if authenticated_peer != expected_peer {
        return Err(UpgradeError::IdentityMismatch {
            authenticated: authenticated_peer.to_string(),
            expected: expected_peer.to_string(),
        });
    }

    let channels = EventChannels::new();
    let peer_connection = build_peer_connection(&options, channels.handler()).await?;
    let mut peer_connection_guard = PeerConnectionGuard::new(Arc::clone(&peer_connection));
    let negotiation = negotiate(signaling, role, Arc::clone(&peer_connection), channels);
    tokio::pin!(negotiation);
    let deadline = tokio::time::sleep(options.deadline);
    tokio::pin!(deadline);

    let result = tokio::select! {
        biased;
        _ = options.cancellation.cancelled() => Err(UpgradeError::Cancelled),
        result = &mut negotiation => result,
        _ = &mut deadline => Err(UpgradeError::Deadline),
    };

    match result {
        Ok(connection) => {
            peer_connection_guard.disarm();
            Ok((authenticated_peer, connection))
        }
        Err(error) => {
            let _ = peer_connection.close().await;
            peer_connection_guard.disarm();
            Err(error)
        }
    }
}

async fn build_peer_connection(
    options: &UpgradeOptions,
    handler: Arc<EventHandler>,
) -> Result<Arc<dyn PeerConnection>, UpgradeError> {
    let configuration = RTCConfigurationBuilder::new()
        .with_ice_servers(if options.stun_urls.is_empty() {
            Vec::new()
        } else {
            vec![RTCIceServer {
                urls: options.stun_urls.clone(),
                ..Default::default()
            }]
        })
        .build();
    let connection = PeerConnectionBuilder::new()
        .with_configuration(configuration)
        .with_handler(handler)
        .with_udp_addrs(options.udp_bind_addresses.clone())
        .with_data_channel_send_buffer_limit(DATA_CHANNEL_SEND_BUFFER_BYTES)
        .build()
        .await
        .map_err(webrtc_upgrade_error)?;
    Ok(Arc::new(connection))
}

async fn negotiate<S>(
    signaling: S,
    role: UpgradeRole,
    peer_connection: Arc<dyn PeerConnection>,
    channels: EventChannels,
) -> Result<WebRtcConnection, UpgradeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut reader, mut writer) = signaling.split();
    let EventChannels {
        mut candidates,
        mut states,
        incoming,
        init_sender,
        mut init_opened,
        mut failures,
        init_claimed,
        ..
    } = channels;
    let mut remote_description_set = false;
    let mut pending_candidates = Vec::new();
    let mut local_candidate_count = 0;
    let mut remote_candidate_count = 0;
    let mut local_signaling_open = true;
    let mut remote_signaling_open = true;
    let mut peer_connection_connected = false;
    let mut init_channel_opened = false;

    match role {
        UpgradeRole::Offerer => {
            init_claimed.store(true, Ordering::Release);
            let init = peer_connection
                .create_data_channel("init", None)
                .await
                .map_err(webrtc_upgrade_error)?;
            keep_init_channel(init, init_sender);
            let offer = peer_connection
                .create_offer(None)
                .await
                .map_err(webrtc_upgrade_error)?;
            peer_connection
                .set_local_description(offer.clone())
                .await
                .map_err(webrtc_upgrade_error)?;
            write_signal(&mut writer, Signal::Offer(offer.sdp)).await?;
            diagnostic(role, "offer-sent", None);
        }
        UpgradeRole::Answerer => {
            let offer = match read_signal(&mut reader).await? {
                Some(Signal::Offer(sdp)) => RTCSessionDescription::offer(sdp),
                Some(_) => return Err(UpgradeError::UnexpectedSignal),
                None => return Err(UpgradeError::SignalingEnded),
            }
            .map_err(webrtc_upgrade_error)?;
            peer_connection
                .set_remote_description(offer)
                .await
                .map_err(webrtc_upgrade_error)?;
            remote_description_set = true;
            let answer = peer_connection
                .create_answer(None)
                .await
                .map_err(webrtc_upgrade_error)?;
            peer_connection
                .set_local_description(answer.clone())
                .await
                .map_err(webrtc_upgrade_error)?;
            write_signal(&mut writer, Signal::Answer(answer.sdp)).await?;
            diagnostic(role, "answer-sent", None);
        }
    }

    loop {
        let direct_connection_ready = peer_connection_connected && init_channel_opened;
        if direct_connection_ready && local_signaling_open {
            writer.close().await.map_err(SignalingError::Io)?;
            local_signaling_open = false;
            diagnostic(role, "signaling-write-closed", None);
        }
        if direct_connection_ready && !remote_signaling_open {
            return Ok(WebRtcConnection::new(peer_connection, incoming, states));
        }
        tokio::select! {
            signal = read_signal(&mut reader), if remote_signaling_open => {
                match signal? {
                    Some(Signal::Answer(sdp)) if role == UpgradeRole::Offerer && !remote_description_set => {
                        let answer = RTCSessionDescription::answer(sdp).map_err(webrtc_upgrade_error)?;
                        peer_connection.set_remote_description(answer).await.map_err(webrtc_upgrade_error)?;
                        remote_description_set = true;
                        for candidate in pending_candidates.drain(..) {
                            peer_connection.add_ice_candidate(candidate).await.map_err(webrtc_upgrade_error)?;
                        }
                    }
                    Some(Signal::IceCandidate(candidate)) => {
                        remote_candidate_count += 1;
                        if remote_candidate_count > MAX_CANDIDATES {
                            return Err(UpgradeError::TooManyCandidates);
                        }
                        let candidate = serde_json::from_str::<RTCIceCandidateInit>(&candidate)
                            .map_err(|error| UpgradeError::WebRtc(error.to_string()))?;
                        diagnostic(role, "remote-candidate", candidate_kind(&candidate));
                        if remote_description_set {
                            peer_connection.add_ice_candidate(candidate).await.map_err(webrtc_upgrade_error)?;
                        } else {
                            pending_candidates.push(candidate);
                        }
                    }
                    Some(_) => return Err(UpgradeError::UnexpectedSignal),
                    None if remote_description_set => {
                        remote_signaling_open = false;
                        diagnostic(role, "signaling-read-closed", None);
                    }
                    None => return Err(UpgradeError::SignalingEnded),
                }
            }
            candidate = candidates.next() => {
                let candidate = candidate.ok_or(UpgradeError::EventDelivery("candidate channel closed"))?;
                local_candidate_count += 1;
                if local_candidate_count > MAX_CANDIDATES {
                    return Err(UpgradeError::TooManyCandidates);
                }
                diagnostic(role, "local-candidate", candidate_kind(&candidate));
                let candidate = serde_json::to_string(&candidate)
                    .map_err(|error| UpgradeError::WebRtc(error.to_string()))?;
                if local_signaling_open {
                    write_signal(&mut writer, Signal::IceCandidate(candidate)).await?;
                }
            }
            state = states.next() => {
                let state = state.ok_or(UpgradeError::EventDelivery("connection state channel closed"))?;
                diagnostic(role, "connection-state", Some(&format!("{state:?}")));
                match state {
                    RTCPeerConnectionState::Connected => {
                        peer_connection_connected = true;
                    }
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                        return Err(UpgradeError::WebRtc("peer connection failed".to_owned()));
                    }
                    _ => {}
                }
            }
            opened = init_opened.next() => {
                opened
                    .ok_or(UpgradeError::EventDelivery("init data channel event channel closed"))?
                    .map_err(|error| UpgradeError::WebRtc(error.to_string()))?;
                init_channel_opened = true;
                diagnostic(role, "init-channel-open", None);
            }
            failure = failures.next() => {
                return Err(UpgradeError::WebRtc(
                    failure.unwrap_or_else(|| "event handler stopped".to_owned())
                ));
            }
        }
    }
}

fn candidate_kind(candidate: &RTCIceCandidateInit) -> Option<&str> {
    let mut parts = candidate.candidate.split_whitespace();
    while let Some(part) = parts.next() {
        if part == "typ" {
            return parts.next();
        }
    }
    None
}

fn diagnostic(role: UpgradeRole, event: &str, detail: Option<&str>) {
    if std::env::var_os("MAKA_WEBRTC_DIAGNOSTICS").is_none() {
        return;
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "webrtc": event,
            "role": match role {
                UpgradeRole::Offerer => "offerer",
                UpgradeRole::Answerer => "answerer",
            },
            "detail": detail,
        })
    );
}

struct EventChannels {
    candidate_sender: mpsc::Sender<RTCIceCandidateInit>,
    candidates: mpsc::Receiver<RTCIceCandidateInit>,
    state_sender: mpsc::Sender<RTCPeerConnectionState>,
    states: mpsc::Receiver<RTCPeerConnectionState>,
    incoming_sender: mpsc::Sender<Result<ReadySubstream, io::Error>>,
    incoming: mpsc::Receiver<Result<ReadySubstream, io::Error>>,
    init_sender: mpsc::Sender<Result<(), io::Error>>,
    init_opened: mpsc::Receiver<Result<(), io::Error>>,
    failure_sender: mpsc::Sender<String>,
    failures: mpsc::Receiver<String>,
    init_claimed: Arc<AtomicBool>,
    inbound_substreams: Arc<Semaphore>,
}

impl EventChannels {
    fn new() -> Self {
        let (candidate_sender, candidates) = mpsc::channel(EVENT_CAPACITY);
        let (state_sender, states) = mpsc::channel(EVENT_CAPACITY);
        let (incoming_sender, incoming) = mpsc::channel(EVENT_CAPACITY);
        let (init_sender, init_opened) = mpsc::channel(1);
        let (failure_sender, failures) = mpsc::channel(EVENT_CAPACITY);
        Self {
            candidate_sender,
            candidates,
            state_sender,
            states,
            incoming_sender,
            incoming,
            init_sender,
            init_opened,
            failure_sender,
            failures,
            init_claimed: Arc::new(AtomicBool::new(false)),
            inbound_substreams: Arc::new(Semaphore::new(MAX_INBOUND_SUBSTREAMS)),
        }
    }

    fn handler(&self) -> Arc<EventHandler> {
        Arc::new(EventHandler {
            candidates: self.candidate_sender.clone(),
            states: self.state_sender.clone(),
            incoming: self.incoming_sender.clone(),
            init_opened: self.init_sender.clone(),
            failures: self.failure_sender.clone(),
            init_claimed: Arc::clone(&self.init_claimed),
            inbound_substreams: Arc::clone(&self.inbound_substreams),
        })
    }
}

#[derive(Clone)]
struct EventHandler {
    candidates: mpsc::Sender<RTCIceCandidateInit>,
    states: mpsc::Sender<RTCPeerConnectionState>,
    incoming: mpsc::Sender<Result<ReadySubstream, io::Error>>,
    init_opened: mpsc::Sender<Result<(), io::Error>>,
    failures: mpsc::Sender<String>,
    init_claimed: Arc<AtomicBool>,
    inbound_substreams: Arc<Semaphore>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for EventHandler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        match event.candidate.to_json() {
            Ok(candidate) => {
                let mut candidates = self.candidates.clone();
                if candidates.try_send(candidate).is_err() {
                    self.report_failure("local ICE candidate limit exceeded");
                }
            }
            Err(error) => self.report_failure(&format!("could not encode ICE candidate: {error}")),
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let mut states = self.states.clone();
        if states.try_send(state).is_err() {
            self.report_failure("connection state delivery overflowed");
        }
    }

    async fn on_data_channel(&self, data_channel: Arc<dyn DataChannel>) {
        data_channel_diagnostic("received", data_channel.id(), Some("incoming"));
        match data_channel.label().await {
            Ok(label) if label == "init" => {
                if self
                    .init_claimed
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    keep_init_channel(data_channel, self.init_opened.clone());
                } else {
                    data_channel_diagnostic("rejected", data_channel.id(), Some("duplicate-init"));
                    let _ = data_channel.close().await;
                }
            }
            Ok(_) => {
                let permit = match Arc::clone(&self.inbound_substreams).try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        data_channel_diagnostic(
                            "rejected",
                            data_channel.id(),
                            Some("inbound-limit"),
                        );
                        let _ = data_channel.close().await;
                        return;
                    }
                };
                let mut incoming = self.incoming.clone();
                tokio::spawn(async move {
                    let stream = ready_substream(data_channel, "incoming", Some(permit)).await;
                    let _ = incoming.send(stream).await;
                });
            }
            Err(error) => {
                self.report_failure(&format!("could not read data channel label: {error}"))
            }
        }
    }
}

impl EventHandler {
    fn report_failure(&self, message: &str) {
        let mut failures = self.failures.clone();
        let _ = failures.try_send(message.to_owned());
    }
}

fn webrtc_upgrade_error(error: impl std::fmt::Display) -> UpgradeError {
    UpgradeError::WebRtc(error.to_string())
}
