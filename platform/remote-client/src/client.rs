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

//! Lightweight Maka Host protocol client. QUIC streams and binary WebSocket
//! channels carry the same length-prefixed Host frames.

use crate::link::Link;
use bytes::Bytes;
use futures_util::{Sink, Stream};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll, ready},
    time::Duration,
};
use thiserror::Error;
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf,
};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};
use uuid::Uuid;

const HOST_PROTOCOL_VERSION: u32 = 1;
const RESOURCE_CHUNK_LIMIT: usize = 64 * 1024;
// Local memory bound for untrusted replies, not a Host wire limit.
const MAX_CONTROL_FRAME_BYTES: usize = 16 * 1024 * 1024;

pub(crate) trait StreamIo: AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static {}
impl<S: AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static> StreamIo for S {}

pub(crate) type BoxedStream = Box<dyn StreamIo>;

#[derive(Debug, Error)]
pub enum RemoteClientError {
    #[error("empty field '{0}'")]
    EmptyField(&'static str),
    #[error("transport I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("remote transport failed: {0}")]
    Transport(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error(transparent)]
    Pairing(#[from] maka_remote_pairing::PairingError),
    #[error("Host Root ID mismatch: expected '{expected}', Host advertised '{actual}'")]
    RootIdMismatch { expected: String, actual: String },
    #[error("Host protocol violation: {0}")]
    Protocol(String),
    #[error("Host rejected call or control request: {0}")]
    HostRejected(String),
    #[error("unknown Host endpoint '{0}'")]
    UnknownEndpoint(String),
    #[error("serialization error: {0}")]
    Codec(#[from] serde_json::Error),
    #[error("Host mutation completed with cleanup error: {0}")]
    MutationCleanup(String),
    #[error("Host mutation result was not acknowledged: {cause}")]
    MutationUncertain {
        reference: Value,
        #[source]
        cause: Box<RemoteClientError>,
    },
    #[error(
        "signed invitations require a native peer route; WebSocket requires a separately provisioned Bearer"
    )]
    NoNativeRoute,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeploymentRef {
    pub state_domain: String,
    pub deployment: Uuid,
    pub revision: u64,
}

#[derive(Serialize)]
struct Opening {
    version: u32,
    epoch: Option<Uuid>,
    client_instance: Option<String>,
    request: WireRequest,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WireRequest {
    Connect,
    Call {
        session: Uuid,
    },
    RedeemPeerPairing {
        invite_secret: String,
        device_label: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SessionControl {
    Close,
}

#[derive(Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
enum WireResponse {
    Connected(WireConnected),
    Accepted,
    Closed,
    PeerPairingReceipt(Result<PeerPairingReceipt, String>),
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeerPairingReceipt {
    pub root_id: String,
    pub peer_id: String,
}

#[derive(Deserialize)]
struct WireConnected {
    version: u32,
    epoch: Uuid,
    session: Uuid,
    source: RemoteDeploymentRef,
    consumers: BTreeMap<String, Vec<Uuid>>,
    catalogue: WireCatalogue,
}

#[derive(Deserialize)]
struct WireCatalogue {
    endpoints: BTreeMap<String, WireEndpoint>,
}

#[derive(Clone, Deserialize)]
struct WireEndpoint {
    registration_epoch: Option<Uuid>,
}

#[derive(Serialize)]
struct WireCallSource {
    deployment: RemoteDeploymentRef,
    consumer: Vec<Uuid>,
    mount: Uuid,
    request: Uuid,
}

#[derive(Serialize)]
struct WireCallOpen {
    endpoint: String,
    registration_epoch: Uuid,
    source: WireCallSource,
    method: String,
    input: Value,
}

/// Named, immutable request-local resources. The mobile client only needs the
/// Host's UTF-8 resource contract, without linking its native capability stack.
pub type Attachments = BTreeMap<String, ReadResource>;

/// An in-memory Host UTF-8 resource. Its contents are never serialized or formatted.
pub struct ReadResource(String);

impl ReadResource {
    pub fn utf8(text: String) -> Self {
        Self(text)
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WireControl {
    Pull,
    Cancel,
    Confirm { recovery: Value },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WireReply {
    Ready,
    Subscribed,
    Prepared {
        reference: Value,
    },
    Item {
        value: Value,
    },
    Progress {
        value: Value,
    },
    Finished {
        result: Result<Value, String>,
        cleanup: Result<(), String>,
    },
    Mutation {
        reply: Value,
        cleanup: Result<(), String>,
    },
    Aborted {
        reason: String,
    },
    BindingRetired {
        reason: String,
    },
    #[serde(other)]
    Other,
}

pub(crate) struct WsByteChannel<S> {
    socket: WebSocketStream<S>,
    pending: Bytes,
    flush: bool,
}

impl<S> WsByteChannel<S> {
    pub(crate) fn new(socket: WebSocketStream<S>) -> Self {
        Self {
            socket,
            pending: Bytes::new(),
            flush: false,
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for WsByteChannel<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        loop {
            if !self.pending.is_empty() {
                let count = self.pending.len().min(output.remaining());
                output.put_slice(&self.pending.split_to(count));
                return Poll::Ready(Ok(()));
            }
            if self.flush {
                ready!(Pin::new(&mut self.socket).poll_flush(cx)).map_err(io::Error::other)?;
                self.flush = false;
            }
            match ready!(Pin::new(&mut self.socket).poll_next(cx)) {
                Some(Ok(Message::Binary(bytes))) => self.pending = bytes,
                Some(Ok(Message::Ping(_))) => self.flush = true,
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | None => return Poll::Ready(Ok(())),
                Some(Ok(_)) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Host WebSocket requires binary messages",
                    )));
                }
                Some(Err(err)) => return Poll::Ready(Err(io::Error::other(err))),
            }
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for WsByteChannel<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        ready!(Pin::new(&mut self.socket).poll_ready(cx)).map_err(io::Error::other)?;
        let len = bytes.len().min(RESOURCE_CHUNK_LIMIT);
        Pin::new(&mut self.socket)
            .start_send(Message::Binary(Bytes::copy_from_slice(&bytes[..len])))
            .map_err(io::Error::other)?;
        Poll::Ready(Ok(len))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket)
            .poll_flush(cx)
            .map_err(io::Error::other)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket)
            .poll_close(cx)
            .map_err(io::Error::other)
    }
}

async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), RemoteClientError> {
    let encoded = serde_json::to_vec(value)?;
    let length = u32::try_from(encoded.len())
        .map_err(|_| RemoteClientError::Protocol("frame exceeds u32 length".into()))?;
    writer.write_u32(length).await?;
    writer.write_all(&encoded).await?;
    writer.flush().await?;
    Ok(())
}

async fn read_frame<R: AsyncRead + Unpin, T: DeserializeOwned>(
    reader: &mut BufReader<R>,
) -> Result<T, RemoteClientError> {
    let mut prefix = [0u8; 4];
    reader.read_exact(&mut prefix).await?;
    let length = u32::from_be_bytes(prefix) as usize;
    if !(1..=MAX_CONTROL_FRAME_BYTES).contains(&length) {
        return Err(RemoteClientError::Protocol(format!(
            "invalid Host frame length {length}"
        )));
    }
    let mut body = Vec::with_capacity(length.min(64 * 1024));
    while body.len() < length {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return Err(RemoteClientError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Host closed channel mid-frame",
            )));
        }
        let take = chunk.len().min(length - body.len());
        body.extend_from_slice(&chunk[..take]);
        reader.consume(take);
    }
    Ok(serde_json::from_slice(&body)?)
}

pub(crate) async fn redeem_pairing_invite(
    link: &Link,
    invite_secret: String,
    device_label: Option<String>,
) -> Result<PeerPairingReceipt, RemoteClientError> {
    let mut stream = link.open().await?;
    write_frame(
        &mut stream,
        &Opening {
            version: HOST_PROTOCOL_VERSION,
            epoch: None,
            client_instance: None,
            request: WireRequest::RedeemPeerPairing {
                invite_secret,
                device_label,
            },
        },
    )
    .await?;
    match read_frame(&mut BufReader::new(stream)).await? {
        WireResponse::PeerPairingReceipt(result) => result.map_err(RemoteClientError::HostRejected),
        _ => Err(RemoteClientError::Protocol(
            "Host did not return a pairing receipt".into(),
        )),
    }
}

/// Connect and admit a remote Maka Host, enforcing that the advertised
/// state_domain matches expected_root_id fail-closed.
impl RemoteHostConnection {
    pub(crate) async fn connect(
        link: Link,
        expected_root_id: &str,
        client_instance: Arc<str>,
    ) -> Result<RemoteHostConnection, RemoteClientError> {
        if expected_root_id.trim().is_empty() {
            return Err(RemoteClientError::EmptyField("expected_root_id"));
        }
        if client_instance.trim().is_empty() {
            return Err(RemoteClientError::EmptyField("client_instance"));
        }
        let mut channel = link.open().await?;
        write_frame(
            &mut channel,
            &Opening {
                version: HOST_PROTOCOL_VERSION,
                epoch: None,
                client_instance: Some(client_instance.to_string()),
                request: WireRequest::Connect,
            },
        )
        .await?;
        let mut anchor = BufReader::new(channel);
        let WireResponse::Connected(connected) = read_frame::<_, WireResponse>(&mut anchor).await?
        else {
            return Err(RemoteClientError::Protocol(
                "Host did not return Connected handshake".into(),
            ));
        };
        if connected.version != HOST_PROTOCOL_VERSION
            || connected.epoch.is_nil()
            || connected.session.is_nil()
        {
            return Err(RemoteClientError::Protocol(
                "Host returned invalid protocol version, epoch, or session id".into(),
            ));
        }
        if connected.source.state_domain != expected_root_id {
            return Err(RemoteClientError::RootIdMismatch {
                expected: expected_root_id.to_owned(),
                actual: connected.source.state_domain,
            });
        }
        Ok(RemoteHostConnection {
            handle: RemoteCallHandle {
                link,
                client_instance,
                epoch: connected.epoch,
                session: connected.session,
                source: connected.source,
                consumers: Arc::new(connected.consumers),
                endpoints: Arc::new(connected.catalogue.endpoints),
            },
            anchor,
        })
    }
}

/// Lock-free, cloneable handle for opening independent authenticated RPC call
/// channels against an already admitted Host session.
#[derive(Clone)]
pub struct RemoteCallHandle {
    link: Link,
    client_instance: Arc<str>,
    epoch: Uuid,
    session: Uuid,
    source: RemoteDeploymentRef,
    consumers: Arc<BTreeMap<String, Vec<Uuid>>>,
    endpoints: Arc<BTreeMap<String, WireEndpoint>>,
}

impl RemoteCallHandle {
    async fn open_call_channel(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
        attachments: &Attachments,
    ) -> Result<BufReader<BoxedStream>, RemoteClientError> {
        let Some(ep) = self.endpoints.get(endpoint) else {
            return Err(RemoteClientError::UnknownEndpoint(endpoint.to_owned()));
        };
        let Some(registration_epoch) = ep.registration_epoch else {
            return Err(RemoteClientError::Protocol(format!(
                "endpoint '{endpoint}' is not registered on Host"
            )));
        };
        let Some(consumer) = self.consumers.get(endpoint) else {
            return Err(RemoteClientError::UnknownEndpoint(endpoint.to_owned()));
        };

        let mut channel = self.link.open().await?;
        write_frame(
            &mut channel,
            &Opening {
                version: HOST_PROTOCOL_VERSION,
                epoch: Some(self.epoch),
                client_instance: Some(self.client_instance.to_string()),
                request: WireRequest::Call {
                    session: self.session,
                },
            },
        )
        .await?;
        let mut reader = BufReader::new(channel);
        if !matches!(
            read_frame::<_, WireResponse>(&mut reader).await?,
            WireResponse::Accepted
        ) {
            return Err(RemoteClientError::Protocol(
                "Host did not accept Call channel".into(),
            ));
        }

        let open_msg = WireCallOpen {
            endpoint: endpoint.to_owned(),
            registration_epoch,
            source: WireCallSource {
                deployment: self.source.clone(),
                consumer: consumer.clone(),
                mount: self.session,
                request: Uuid::new_v4(),
            },
            method: method.to_owned(),
            input,
        };
        let descriptors: BTreeMap<_, _> = attachments
            .iter()
            .map(|(slot, resource)| {
                (
                    slot,
                    json!({
                        "encoding": "utf8",
                        "resource": {"name": "maka.text.utf8", "version": 1},
                        "length": resource.0.len(),
                        "metadata": {},
                    }),
                )
            })
            .collect();
        write_frame(reader.get_mut(), &open_msg).await?;
        write_frame(reader.get_mut(), &descriptors).await?;

        match read_frame::<_, WireReply>(&mut reader).await? {
            WireReply::Ready => {}
            WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                return Err(RemoteClientError::HostRejected(reason));
            }
            _ => {
                return Err(RemoteClientError::Protocol(
                    "Host did not reply Ready to call open".into(),
                ));
            }
        }

        // The Host reserves the descriptors before accepting any payload bytes.
        for resource in attachments.values() {
            let mut remaining = resource.0.as_str();
            while !remaining.is_empty() {
                let end = remaining.floor_char_boundary(remaining.len().min(RESOURCE_CHUNK_LIMIT));
                let (chunk, rest) = remaining.split_at(end);
                reader.get_mut().write_u32(chunk.len() as u32).await?;
                reader.get_mut().write_all(chunk.as_bytes()).await?;
                remaining = rest;
            }
        }
        reader.get_mut().flush().await?;
        Ok(reader)
    }

    /// Invoke a query and return its terminal result without retaining progress frames.
    pub async fn query(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Value, RemoteClientError> {
        let mut reader = self
            .open_call_channel(endpoint, method, input, &Attachments::new())
            .await?;
        loop {
            match read_frame::<_, WireReply>(&mut reader).await? {
                WireReply::Progress { .. } => {}
                WireReply::Finished { result, cleanup } => {
                    cleanup.map_err(RemoteClientError::HostRejected)?;
                    return result.map_err(RemoteClientError::HostRejected);
                }
                WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                    return Err(RemoteClientError::HostRejected(reason));
                }
                _ => {
                    return Err(RemoteClientError::Protocol(
                        "unexpected Reply frame during Host query".into(),
                    ));
                }
            }
        }
    }

    /// Invoke a mutation method over the authenticated public Host gateway
    /// (Open -> Ready -> Prepared -> Confirm -> Mutation) and return the
    /// recorded handler output value. Transport failure after Confirm does
    /// not imply rejection; the caller must reconcile before retrying.
    pub async fn mutate(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Value, RemoteClientError> {
        self.mutate_with(endpoint, method, input, Attachments::new(), |_| {})
            .await
    }

    /// Send request-local attachments out of band, and observe progress in
    /// wire order. The terminal return still includes receipt/cleanup errors.
    pub async fn mutate_with(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
        attachments: Attachments,
        on_progress: impl FnMut(Value),
    ) -> Result<Value, RemoteClientError> {
        let mut reader = self
            .open_call_channel(endpoint, method, input, &attachments)
            .await?;
        drop(attachments);
        let reference = match read_frame::<_, WireReply>(&mut reader).await? {
            WireReply::Prepared { reference } => reference,
            WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                return Err(RemoteClientError::HostRejected(reason));
            }
            WireReply::Finished { .. } | WireReply::Subscribed => {
                return Err(RemoteClientError::Protocol(format!(
                    "endpoint method '{endpoint}.{method}' is not a mutation"
                )));
            }
            _ => {
                return Err(RemoteClientError::Protocol(
                    "Host did not reply Prepared for remote mutation".into(),
                ));
            }
        };

        confirm_mutation(&mut reader, endpoint, method, reference, on_progress).await
    }

    /// Open a demand-driven streaming subscription on an admitted Host endpoint
    /// (Open -> Ready -> Subscribed -> pull/cancel loop).
    pub async fn subscribe(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<RemoteSubscription, RemoteClientError> {
        let mut reader = self
            .open_call_channel(endpoint, method, input, &Attachments::new())
            .await?;
        match read_frame::<_, WireReply>(&mut reader).await? {
            WireReply::Subscribed => {}
            WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                return Err(RemoteClientError::HostRejected(reason));
            }
            WireReply::Finished { .. } | WireReply::Prepared { .. } => {
                return Err(RemoteClientError::Protocol(format!(
                    "endpoint method '{endpoint}.{method}' is not a subscription"
                )));
            }
            _ => {
                return Err(RemoteClientError::Protocol(
                    "Host did not reply Subscribed for remote subscription".into(),
                ));
            }
        }
        Ok(RemoteSubscription {
            channel: Some(reader),
        })
    }
}

async fn confirm_mutation<S: AsyncRead + AsyncWrite + Unpin>(
    reader: &mut BufReader<S>,
    endpoint: &str,
    method: &str,
    reference: Value,
    mut on_progress: impl FnMut(Value),
) -> Result<Value, RemoteClientError> {
    let recovery = json!({
        "kind": "maka_remote_mutation",
        "version": 1,
        "endpoint": endpoint,
        "method": method,
        "reference": reference,
    });
    let result = async {
        write_frame(reader.get_mut(), &WireControl::Confirm { recovery }).await?;
        loop {
            match read_frame::<_, WireReply>(reader).await? {
                WireReply::Progress { value } => on_progress(value),
                reply @ (WireReply::Mutation { .. }
                | WireReply::Aborted { .. }
                | WireReply::BindingRetired { .. }) => {
                    if let WireReply::Mutation { reply, .. } = &reply
                        && reply.get("reference") != Some(&reference)
                    {
                        return Err(RemoteClientError::Protocol(
                            "Host returned a different operation reference".into(),
                        ));
                    }
                    return Ok(reply);
                }
                _ => {
                    return Err(RemoteClientError::Protocol(
                        "unexpected Reply frame while awaiting mutation completion".into(),
                    ));
                }
            }
        }
    }
    .await;
    let (reply, cleanup) = match result.map_err(|cause| RemoteClientError::MutationUncertain {
        reference,
        cause: Box::new(cause),
    })? {
        WireReply::Mutation { reply, cleanup } => (reply, cleanup),
        WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
            return Err(RemoteClientError::HostRejected(reason));
        }
        _ => unreachable!("only terminal replies exit the mutation wait"),
    };
    let receipt = &reply["receipt"];
    let unknown = match receipt["kind"].as_str() {
        Some("unknown" | "unavailable" | "not_recorded") => Some(receipt),
        Some("recorded")
            if matches!(
                receipt["outcome"]["kind"].as_str(),
                Some("unknown" | "unresolved")
            ) =>
        {
            Some(&receipt["outcome"])
        }
        _ => None,
    };
    if let Some(unknown) = unknown {
        return Err(RemoteClientError::MutationUncertain {
            reference: reply["reference"].clone(),
            cause: Box::new(RemoteClientError::Protocol(format!(
                "Host receipt is non-terminal: {}",
                unknown["diagnostic"]
                    .as_str()
                    .or_else(|| unknown["kind"].as_str())
                    .unwrap_or("unknown")
            ))),
        });
    }
    cleanup.map_err(RemoteClientError::MutationCleanup)?;
    extract_mutation_value(reply)
}

fn extract_mutation_value(reply: Value) -> Result<Value, RemoteClientError> {
    let receipt = reply.get("receipt").ok_or_else(|| {
        RemoteClientError::Protocol("Host mutation reply missing receipt field".into())
    })?;
    match receipt.get("kind").and_then(Value::as_str) {
        Some("recorded") => {
            if let Some(cleanup) = receipt.get("cleanup")
                && cleanup.get("kind").and_then(Value::as_str) == Some("failed")
            {
                let diagnostic = cleanup
                    .get("diagnostic")
                    .and_then(Value::as_str)
                    .unwrap_or("mutation cleanup failed");
                return Err(RemoteClientError::MutationCleanup(diagnostic.to_owned()));
            }
            let outcome = receipt.get("outcome").ok_or_else(|| {
                RemoteClientError::Protocol("recorded mutation receipt missing outcome".into())
            })?;
            match outcome.get("kind").and_then(Value::as_str) {
                Some("returned") => {
                    let result = outcome.get("result").ok_or_else(|| {
                        RemoteClientError::Protocol("returned outcome missing result".into())
                    })?;
                    match result.get("kind").and_then(Value::as_str) {
                        Some("success") => Ok(result.get("value").cloned().unwrap_or(Value::Null)),
                        Some("failure") => {
                            let diagnostic = result
                                .get("diagnostic")
                                .and_then(Value::as_str)
                                .unwrap_or("remote mutation failed");
                            Err(RemoteClientError::HostRejected(diagnostic.to_owned()))
                        }
                        other => Err(RemoteClientError::Protocol(format!(
                            "unexpected mutation result kind: {other:?}"
                        ))),
                    }
                }
                Some("not_executed") => Err(RemoteClientError::HostRejected(
                    "remote mutation was prevented before start".into(),
                )),
                Some("unknown") => {
                    let diagnostic = outcome
                        .get("diagnostic")
                        .and_then(Value::as_str)
                        .unwrap_or("remote mutation outcome unknown");
                    Err(RemoteClientError::HostRejected(diagnostic.to_owned()))
                }
                Some("unresolved") => Err(RemoteClientError::HostRejected(
                    "remote mutation outcome remains unresolved".into(),
                )),
                other => Err(RemoteClientError::Protocol(format!(
                    "unexpected mutation outcome kind: {other:?}"
                ))),
            }
        }
        Some("unavailable") => {
            let diagnostic = receipt
                .get("diagnostic")
                .and_then(Value::as_str)
                .unwrap_or("remote mutation unavailable");
            Err(RemoteClientError::HostRejected(diagnostic.to_owned()))
        }
        Some("not_recorded") => Err(RemoteClientError::HostRejected(
            "remote mutation was not recorded".into(),
        )),
        other => Err(RemoteClientError::Protocol(format!(
            "unexpected mutation receipt kind: {other:?}"
        ))),
    }
}

/// Demand-driven remote Host subscription. Dropping the stream requests
/// cancellation; only a terminal Host reply acknowledges cleanup.
pub struct RemoteSubscription {
    channel: Option<BufReader<BoxedStream>>,
}

impl RemoteSubscription {
    /// Pull one item. If the caller cancels this future, the subscription is closed.
    pub async fn next(&mut self) -> Result<Option<Value>, RemoteClientError> {
        let Some(mut channel) = self.channel.take() else {
            return Ok(None);
        };
        write_frame(channel.get_mut(), &WireControl::Pull).await?;
        loop {
            match read_frame::<_, WireReply>(&mut channel).await? {
                WireReply::Item { value } => {
                    self.channel = Some(channel);
                    return Ok(Some(value));
                }
                WireReply::Progress { .. } => {}
                WireReply::Finished { result, cleanup } => {
                    cleanup.map_err(RemoteClientError::HostRejected)?;
                    result.map_err(RemoteClientError::HostRejected)?;
                    return Ok(None);
                }
                WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                    return Err(RemoteClientError::HostRejected(reason));
                }
                _ => {
                    return Err(RemoteClientError::Protocol(
                        "unexpected Reply frame during remote subscription".into(),
                    ));
                }
            }
        }
    }

    /// Request cancellation and wait for the Host's cleanup acknowledgement.
    pub async fn cancel(self) -> Result<(), RemoteClientError> {
        let Some(mut channel) = self.channel else {
            return Ok(());
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            write_frame(channel.get_mut(), &WireControl::Cancel).await?;
            loop {
                match read_frame::<_, WireReply>(&mut channel).await? {
                    WireReply::Item { .. } | WireReply::Progress { .. } => {}
                    WireReply::Finished { cleanup, .. } => {
                        return cleanup.map_err(RemoteClientError::HostRejected);
                    }
                    WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                        return Err(RemoteClientError::HostRejected(reason));
                    }
                    _ => {
                        return Err(RemoteClientError::Protocol(
                            "unexpected Reply frame during subscription cancellation".into(),
                        ));
                    }
                }
            }
        })
        .await
        .map_err(|error| io::Error::new(io::ErrorKind::TimedOut, error))?
    }
}

/// Active admitted remote Host session holding the anchor control stream.
pub struct RemoteHostConnection {
    handle: RemoteCallHandle,
    anchor: BufReader<BoxedStream>,
}

impl RemoteHostConnection {
    pub fn epoch(&self) -> Uuid {
        self.handle.epoch
    }

    pub fn session(&self) -> Uuid {
        self.handle.session
    }

    pub fn root_id(&self) -> &str {
        &self.handle.source.state_domain
    }

    pub fn source(&self) -> &RemoteDeploymentRef {
        &self.handle.source
    }

    pub fn endpoint_names(&self) -> Vec<String> {
        self.handle.endpoints.keys().cloned().collect()
    }

    /// Obtain a cloneable call handle that can run concurrent RPC calls without
    /// locking the anchor session.
    pub fn call_handle(&self) -> RemoteCallHandle {
        self.handle.clone()
    }

    /// Invoke a query method on an admitted Host endpoint and return its JSON output.
    pub async fn query(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Value, RemoteClientError> {
        self.handle.query(endpoint, method, input).await
    }

    /// Invoke a mutation method on an admitted Host endpoint and return its recorded output.
    pub async fn mutate(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Value, RemoteClientError> {
        self.handle.mutate(endpoint, method, input).await
    }

    /// Invoke a mutation with out-of-band resources and a progress observer.
    pub async fn mutate_with(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
        attachments: Attachments,
        on_progress: impl FnMut(Value),
    ) -> Result<Value, RemoteClientError> {
        self.handle
            .mutate_with(endpoint, method, input, attachments, on_progress)
            .await
    }

    /// Open a demand-driven streaming subscription on an admitted Host endpoint.
    pub async fn subscribe(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<RemoteSubscription, RemoteClientError> {
        self.handle.subscribe(endpoint, method, input).await
    }

    /// Inspect the currently selected QUIC route. WebSocket has no QUIC path.
    pub fn path_summary(&self) -> Option<maka_remote_transport::PathSummary> {
        self.handle.link.path_summary()
    }

    /// Wait for anchor disconnection, including Host-side grant revocation.
    pub async fn disconnected(&mut self) -> Result<(), RemoteClientError> {
        if let Link::Peer(peer) = &self.handle.link {
            return Err(peer.wait_for_disconnect().await);
        }
        match read_frame::<_, WireResponse>(&mut self.anchor).await {
            Err(RemoteClientError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
                Ok(())
            }
            Err(error) => Err(error),
            Ok(WireResponse::Closed) => Ok(()),
            Ok(_) => Err(RemoteClientError::Protocol(
                "unexpected anchor response".into(),
            )),
        }
    }

    /// Gracefully detach this remote session without stopping the Host.
    pub async fn close(mut self) -> Result<(), RemoteClientError> {
        write_frame(self.anchor.get_mut(), &SessionControl::Close).await?;
        loop {
            match read_frame::<_, WireResponse>(&mut self.anchor).await? {
                WireResponse::Closed => {
                    return Ok(());
                }
                WireResponse::Other => continue,
                _ => {
                    return Err(RemoteClientError::Protocol(
                        "unexpected Host response while closing session".into(),
                    ));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lost_mutation_reply_preserves_the_reference_instead_of_asserting_failure() {
        let (client, host) = tokio::io::duplex(2048);
        let mut channel = BufReader::new(client);
        let reference = json!({"operation":Uuid::new_v4()});
        let (result, ()) = tokio::join!(
            confirm_mutation(&mut channel, "agent", "send", reference.clone(), |_| {}),
            async {
                let confirm: Value = read_frame(&mut BufReader::new(host)).await.unwrap();
                assert_eq!(confirm["kind"], "confirm");
                assert_eq!(confirm["recovery"]["reference"], reference);
                // The Host received Confirm, but the connection lost the receipt.
            },
        );
        assert!(
            matches!(result, Err(RemoteClientError::MutationUncertain { reference: saved, .. }) if saved == reference)
        );
    }

    #[tokio::test]
    async fn progress_does_not_hide_a_terminal_cleanup_error() {
        let (client, host) = tokio::io::duplex(2048);
        let mut channel = BufReader::new(client);
        let reference = json!({"operation":Uuid::new_v4()});
        let mut progress = Vec::new();
        let (result, ()) =
            tokio::join!(
                confirm_mutation(
                    &mut channel,
                    "setup",
                    "discoverModels",
                    reference.clone(),
                    |value| progress.push(value)
                ),
                async {
                    let mut host = BufReader::new(host);
                    let _: Value = read_frame(&mut host).await.unwrap();
                    write_frame(
                        host.get_mut(),
                        &json!({"kind":"progress","value":{"step":"discovering"}}),
                    )
                    .await
                    .unwrap();
                    write_frame(
                    host.get_mut(),
                    &json!({
                        "kind":"mutation",
                        "reply":{"reference": reference, "receipt":{"kind":"recorded","outcome":{
                            "kind":"returned","result":{"kind":"success","value":{}}
                        }}},
                        "cleanup":{"Err":"fixture cleanup failed"},
                    }),
                ).await.unwrap();
                },
            );
        assert_eq!(progress, [json!({"step":"discovering"})]);
        assert!(
            matches!(result, Err(RemoteClientError::MutationCleanup(error)) if error == "fixture cleanup failed")
        );
    }

    #[tokio::test]
    async fn nonterminal_host_receipts_preserve_the_original_reference() {
        for receipt in [
            json!({"kind":"not_recorded"}),
            json!({"kind":"unavailable", "diagnostic":"busy"}),
            json!({"kind":"recorded", "outcome":{"kind":"unknown"}, "cleanup":{"kind":"failed"}}),
            json!({"kind":"recorded", "outcome":{"kind":"unresolved"}}),
        ] {
            let (client, host) = tokio::io::duplex(2048);
            let mut channel = BufReader::new(client);
            let reference = json!({"operation":Uuid::new_v4()});
            let (result, ()) = tokio::join!(
                confirm_mutation(&mut channel, "agent", "send", reference.clone(), |_| {}),
                async {
                    let mut host = BufReader::new(host);
                    let _: Value = read_frame(&mut host).await.unwrap();
                    write_frame(
                        host.get_mut(),
                        &json!({
                            "kind":"mutation",
                            "reply":{"reference": reference, "receipt": receipt},
                            "cleanup":{"Ok":null},
                        }),
                    )
                    .await
                    .unwrap();
                },
            );
            assert!(
                matches!(result, Err(RemoteClientError::MutationUncertain { reference: saved, .. }) if saved == reference)
            );
        }
    }
}
