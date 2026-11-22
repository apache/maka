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

//! Lightweight remote Maka Host WebSocket protocol client.
//!
//! Speaks the exact binary WebSocket + 4-byte big-endian length-prefixed JSON
//! wire protocol implemented by maka-host-runtime, without linking any Host
//! server, sandbox, or desktop crates so it builds cleanly on iOS.

use bytes::Bytes;
use futures_util::{
    Sink, Stream,
    future::{BoxFuture, Either, select},
};
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
use tokio::{
    io::{
        AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf,
        ReadHalf, WriteHalf,
    },
    net::TcpStream,
    sync::watch,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        Error as WsError, Message, client::IntoClientRequest, error::ProtocolError, http::header,
        protocol::WebSocketConfig,
    },
};
use url::Url;
use uuid::Uuid;

const HOST_PROTOCOL_VERSION: u32 = 1;
const RESOURCE_CHUNK_LIMIT: usize = 64 * 1024;
pub const MAX_CONTROL_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_WS_MESSAGE_BYTES: usize = MAX_CONTROL_FRAME_BYTES + 4;
const WS_UPGRADE_TIMEOUT: Duration = Duration::from_secs(5);
const WS_WRITE_BUFFER_BYTES: usize = 2 * 1024 * 1024;

pub trait StreamIo: AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static {}
impl<S: AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static> StreamIo for S {}

pub type BoxedStream = Box<dyn StreamIo>;
pub type OpenStream = Arc<dyn Fn() -> BoxFuture<'static, io::Result<BoxedStream>> + Send + Sync>;

#[derive(Debug, Error)]
pub enum RemoteClientError {
    #[error("invalid remote endpoint '{endpoint}': {reason}")]
    InvalidEndpoint { endpoint: String, reason: String },
    #[error("empty field '{0}'")]
    EmptyField(&'static str),
    #[error("transport I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("Host rejected WebSocket authentication or upgrade: {0}")]
    AuthRejected(String),
    #[error("Host Root ID mismatch: expected '{expected}', Host advertised '{actual}'")]
    RootIdMismatch { expected: String, actual: String },
    #[error("Host protocol violation: {0}")]
    Protocol(String),
    #[error("Host rejected call or control request: {0}")]
    HostRejected(String),
    #[error("unknown Host endpoint '{0}'")]
    UnknownEndpoint(String),
    #[error("serialization error: {0}")]
    Codec(String),
}

/// Parse a ws://host:port endpoint into a stream opener usable by
/// [RemoteHostClient]. Rejects invalid or unsupported schemes at the boundary.
pub fn tcp_endpoint_opener(endpoint: &str) -> Result<OpenStream, RemoteClientError> {
    let trimmed = endpoint.trim();
    let parsed = Url::parse(trimmed).map_err(|err| RemoteClientError::InvalidEndpoint {
        endpoint: trimmed.to_owned(),
        reason: err.to_string(),
    })?;
    if parsed.scheme() != "ws" {
        return Err(RemoteClientError::InvalidEndpoint {
            endpoint: trimmed.to_owned(),
            reason: format!(
                "direct TCP opener only accepts ws:// endpoints (got '{}://')",
                parsed.scheme()
            ),
        });
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| RemoteClientError::InvalidEndpoint {
            endpoint: trimmed.to_owned(),
            reason: "missing host".into(),
        })?
        .to_owned();
    let port =
        parsed
            .port_or_known_default()
            .ok_or_else(|| RemoteClientError::InvalidEndpoint {
                endpoint: trimmed.to_owned(),
                reason: "missing port".into(),
            })?;
    let addr = format!("{host}:{port}");
    Ok(Arc::new(move || {
        let addr = addr.clone();
        Box::pin(async move {
            let stream = TcpStream::connect(&addr).await?;
            let _ = stream.set_nodelay(true);
            Ok(Box::new(stream) as BoxedStream)
        })
    }))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeploymentRef {
    pub state_domain: String,
    pub deployment: Uuid,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum RemoteCallEvent {
    Subscribed,
    Progress(Value),
    Item(Value),
    Finished(Value),
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
    Call { session: Uuid },
    FinalizeAccess,
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
    Finalized(Result<(), String>),
    #[serde(other)]
    Other,
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

fn ws_config() -> WebSocketConfig {
    let mut cfg = WebSocketConfig::default();
    cfg.max_message_size = Some(MAX_WS_MESSAGE_BYTES);
    cfg.max_frame_size = Some(MAX_WS_MESSAGE_BYTES);
    cfg.max_write_buffer_size = WS_WRITE_BUFFER_BYTES;
    cfg
}

struct WsByteChannel<S> {
    socket: WebSocketStream<S>,
    pending: Bytes,
    flush: bool,
}

impl<S> WsByteChannel<S> {
    fn new(socket: WebSocketStream<S>) -> Self {
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

async fn upgrade_ws(
    open: &OpenStream,
    bearer: &str,
) -> Result<WsByteChannel<BoxedStream>, RemoteClientError> {
    if bearer.trim().is_empty() {
        return Err(RemoteClientError::EmptyField("bearer"));
    }
    let stream = open().await?;
    let mut request = "ws://localhost/runtime-host"
        .into_client_request()
        .map_err(|err| RemoteClientError::Protocol(err.to_string()))?;
    let mut authorization = header::HeaderValue::from_str(&format!("Bearer {bearer}"))
        .map_err(|_| RemoteClientError::Protocol("invalid Bearer header value".into()))?;
    authorization.set_sensitive(true);
    request
        .headers_mut()
        .insert(header::AUTHORIZATION, authorization);

    let (socket, _) = tokio::time::timeout(
        WS_UPGRADE_TIMEOUT,
        tokio_tungstenite::client_async_with_config(request, stream, Some(ws_config())),
    )
    .await
    .map_err(|_| {
        RemoteClientError::Io(io::Error::new(
            io::ErrorKind::TimedOut,
            "WS upgrade timed out",
        ))
    })?
    .map_err(|err| match err {
        WsError::Http(resp) => RemoteClientError::AuthRejected(format!("HTTP {}", resp.status())),
        WsError::Io(io_err) => RemoteClientError::Io(io_err),
        WsError::ConnectionClosed
        | WsError::AlreadyClosed
        | WsError::Protocol(ProtocolError::HandshakeIncomplete) => {
            RemoteClientError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Host closed connection during WebSocket upgrade",
            ))
        }
        other => RemoteClientError::Protocol(other.to_string()),
    })?;
    Ok(WsByteChannel::new(socket))
}

async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), RemoteClientError> {
    let encoded =
        serde_json::to_vec(value).map_err(|err| RemoteClientError::Codec(err.to_string()))?;
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
    serde_json::from_slice(&body).map_err(|err| RemoteClientError::Codec(err.to_string()))
}

/// Entrypoint for pairing and connecting to a remote Maka Host.
pub struct RemoteHostClient;

impl RemoteHostClient {
    /// Finalize a one-time pairing credential so it becomes an active remote
    /// Bearer token on the target Host.
    pub async fn finalize_access(
        open: OpenStream,
        pairing_token: &str,
        client_instance: &str,
    ) -> Result<(), RemoteClientError> {
        if client_instance.trim().is_empty() {
            return Err(RemoteClientError::EmptyField("client_instance"));
        }
        let mut channel = upgrade_ws(&open, pairing_token).await?;
        write_frame(
            &mut channel,
            &Opening {
                version: HOST_PROTOCOL_VERSION,
                epoch: None,
                client_instance: Some(client_instance.to_owned()),
                request: WireRequest::FinalizeAccess,
            },
        )
        .await?;
        let mut reader = BufReader::new(channel);
        match read_frame::<_, WireResponse>(&mut reader).await? {
            WireResponse::Finalized(Ok(())) => Ok(()),
            WireResponse::Finalized(Err(reason)) => Err(RemoteClientError::HostRejected(reason)),
            _ => Err(RemoteClientError::Protocol(
                "unexpected Host response to FinalizeAccess".into(),
            )),
        }
    }

    /// Connect and admit a remote Maka Host, enforcing that the advertised
    /// state_domain matches expected_root_id fail-closed.
    pub async fn connect(
        open: OpenStream,
        bearer: Arc<str>,
        expected_root_id: &str,
        client_instance: Arc<str>,
    ) -> Result<RemoteHostConnection, RemoteClientError> {
        if expected_root_id.trim().is_empty() {
            return Err(RemoteClientError::EmptyField("expected_root_id"));
        }
        if client_instance.trim().is_empty() {
            return Err(RemoteClientError::EmptyField("client_instance"));
        }
        let mut channel = upgrade_ws(&open, &bearer).await?;
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
            let _ = anchor.into_inner().shutdown().await;
            return Err(RemoteClientError::RootIdMismatch {
                expected: expected_root_id.to_owned(),
                actual: connected.source.state_domain,
            });
        }
        Ok(RemoteHostConnection {
            handle: RemoteCallHandle {
                open,
                bearer,
                client_instance,
                epoch: connected.epoch,
                session: connected.session,
                source: connected.source,
                consumers: Arc::new(connected.consumers),
                endpoints: Arc::new(connected.catalogue.endpoints),
            },
            anchor,
            closed: false,
        })
    }
}

/// Lock-free, cloneable handle for opening independent authenticated RPC call
/// channels against an already admitted Host session.
#[derive(Clone)]
pub struct RemoteCallHandle {
    open: OpenStream,
    bearer: Arc<str>,
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
    ) -> Result<BufReader<WsByteChannel<BoxedStream>>, RemoteClientError> {
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

        let mut channel = upgrade_ws(&self.open, &self.bearer).await?;
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
        let empty_descriptors: BTreeMap<String, Value> = BTreeMap::new();
        write_frame(reader.get_mut(), &open_msg).await?;
        write_frame(reader.get_mut(), &empty_descriptors).await?;

        match read_frame::<_, WireReply>(&mut reader).await? {
            WireReply::Ready => Ok(reader),
            WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                Err(RemoteClientError::HostRejected(reason))
            }
            _ => Err(RemoteClientError::Protocol(
                "Host did not reply Ready to call open".into(),
            )),
        }
    }

    /// Invoke a query method on an admitted Host endpoint and collect all
    /// frames through completion.
    pub async fn call(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Vec<RemoteCallEvent>, RemoteClientError> {
        let mut reader = self.open_call_channel(endpoint, method, input).await?;
        let mut events = Vec::new();
        loop {
            match read_frame::<_, WireReply>(&mut reader).await? {
                WireReply::Subscribed => events.push(RemoteCallEvent::Subscribed),
                WireReply::Progress { value } => events.push(RemoteCallEvent::Progress(value)),
                WireReply::Item { value } => events.push(RemoteCallEvent::Item(value)),
                WireReply::Finished { result, cleanup } => {
                    if let Err(err) = cleanup {
                        return Err(RemoteClientError::HostRejected(format!(
                            "call cleanup failed: {err}"
                        )));
                    }
                    let value = result.map_err(RemoteClientError::HostRejected)?;
                    events.push(RemoteCallEvent::Finished(value));
                    return Ok(events);
                }
                WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                    return Err(RemoteClientError::HostRejected(reason));
                }
                WireReply::Prepared { .. } | WireReply::Mutation { .. } => {
                    return Err(RemoteClientError::Protocol(
                        "method is a mutation; use mutate() instead of call()".into(),
                    ));
                }
                WireReply::Ready | WireReply::Other => {
                    return Err(RemoteClientError::Protocol(
                        "unexpected Reply frame during remote call".into(),
                    ));
                }
            }
        }
    }

    /// Invoke a query method on an admitted Host endpoint and return its final JSON value.
    pub async fn query(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Value, RemoteClientError> {
        let events = self.call(endpoint, method, input).await?;
        events
            .into_iter()
            .rev()
            .find_map(|ev| match ev {
                RemoteCallEvent::Finished(value) => Some(value),
                _ => None,
            })
            .ok_or_else(|| {
                RemoteClientError::Protocol("Host query completed without Finished payload".into())
            })
    }

    /// Invoke a mutation method over the authenticated public Host gateway
    /// (Open -> Ready -> Prepared -> Confirm -> Mutation) and return the
    /// recorded handler output value.
    pub async fn mutate(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Value, RemoteClientError> {
        let mut reader = self.open_call_channel(endpoint, method, input).await?;
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

        let recovery = json!({
            "kind": "maka_remote_mutation",
            "version": 1,
            "endpoint": endpoint,
            "method": method,
            "reference": reference,
        });
        write_frame(reader.get_mut(), &WireControl::Confirm { recovery }).await?;

        loop {
            match read_frame::<_, WireReply>(&mut reader).await? {
                WireReply::Progress { .. } => {}
                WireReply::Mutation { reply, cleanup } => {
                    if let Err(err) = cleanup {
                        return Err(RemoteClientError::HostRejected(format!(
                            "mutation cleanup failed: {err}"
                        )));
                    }
                    return extract_mutation_value(reply);
                }
                WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                    return Err(RemoteClientError::HostRejected(reason));
                }
                _ => {
                    return Err(RemoteClientError::Protocol(
                        "unexpected Reply frame while awaiting mutation completion".into(),
                    ));
                }
            }
        }
    }

    /// Open a demand-driven streaming subscription on an admitted Host endpoint
    /// (Open -> Ready -> Subscribed -> pull/cancel loop).
    pub async fn subscribe(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<RemoteSubscription, RemoteClientError> {
        let mut reader = self.open_call_channel(endpoint, method, input).await?;
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
        // Transfer any buffered bytes safely: Subscribed was the last read frame
        // and the server sends nothing further until the client sends Control::Pull.
        if !reader.buffer().is_empty() {
            return Err(RemoteClientError::Protocol(
                "unexpected trailing bytes before subscription Pull".into(),
            ));
        }
        let channel = reader.into_inner();
        let (read_half, write_half) = tokio::io::split(channel);
        Ok(RemoteSubscription {
            reader: BufReader::new(read_half),
            writer: write_half,
            closed: false,
        })
    }
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
                return Err(RemoteClientError::HostRejected(diagnostic.to_owned()));
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

/// Active demand-driven remote Host subscription.
pub struct RemoteSubscription {
    reader: BufReader<ReadHalf<WsByteChannel<BoxedStream>>>,
    writer: WriteHalf<WsByteChannel<BoxedStream>>,
    closed: bool,
}

async fn wait_for_stop(stop: &mut watch::Receiver<bool>) {
    if *stop.borrow() {
        return;
    }
    while stop.changed().await.is_ok() {
        if *stop.borrow() {
            return;
        }
    }
    // Sender dropped: treat as cancellation so tasks never hang forever.
}

impl RemoteSubscription {
    /// Pull the next item from the Host subscription. Returns Ok(None) on clean completion.
    pub async fn next(&mut self) -> Result<Option<Value>, RemoteClientError> {
        if self.closed {
            return Ok(None);
        }
        write_frame(&mut self.writer, &WireControl::Pull).await?;
        loop {
            match read_frame::<_, WireReply>(&mut self.reader).await? {
                WireReply::Item { value } => return Ok(Some(value)),
                WireReply::Progress { .. } => {}
                WireReply::Finished { result, cleanup } => {
                    self.closed = true;
                    if let Err(err) = cleanup {
                        return Err(RemoteClientError::HostRejected(format!(
                            "subscription cleanup failed: {err}"
                        )));
                    }
                    result.map_err(RemoteClientError::HostRejected)?;
                    return Ok(None);
                }
                WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                    self.closed = true;
                    return Err(RemoteClientError::HostRejected(reason));
                }
                _ => {
                    self.closed = true;
                    return Err(RemoteClientError::Protocol(
                        "unexpected Reply frame during remote subscription".into(),
                    ));
                }
            }
        }
    }

    /// Pull the next item while racing against a watch cancellation signal.
    /// When cancelled mid-pull, sends Control::Cancel on the writer half and
    /// shuts down the channel so the Host stops its subscription producer immediately.
    pub async fn next_or_cancel(
        &mut self,
        stop: &mut watch::Receiver<bool>,
    ) -> Result<Option<Value>, RemoteClientError> {
        if self.closed {
            return Ok(None);
        }
        if *stop.borrow() {
            self.abort_channel().await?;
            return Ok(None);
        }
        write_frame(&mut self.writer, &WireControl::Pull).await?;
        loop {
            let outcome = {
                let read_fut = Box::pin(read_frame::<_, WireReply>(&mut self.reader));
                let stop_fut = Box::pin(wait_for_stop(stop));
                match select(read_fut, stop_fut).await {
                    Either::Left((res, _)) => Some(res),
                    Either::Right(((), _)) => None,
                }
            };
            let reply = match outcome {
                Some(res) => res?,
                None => {
                    self.abort_channel().await?;
                    return Ok(None);
                }
            };
            match reply {
                WireReply::Item { value } => return Ok(Some(value)),
                WireReply::Progress { .. } => {}
                WireReply::Finished { result, cleanup } => {
                    self.closed = true;
                    if let Err(err) = cleanup {
                        return Err(RemoteClientError::HostRejected(format!(
                            "subscription cleanup failed: {err}"
                        )));
                    }
                    result.map_err(RemoteClientError::HostRejected)?;
                    return Ok(None);
                }
                WireReply::Aborted { reason } | WireReply::BindingRetired { reason } => {
                    self.closed = true;
                    return Err(RemoteClientError::HostRejected(reason));
                }
                _ => {
                    self.closed = true;
                    return Err(RemoteClientError::Protocol(
                        "unexpected Reply frame during remote subscription".into(),
                    ));
                }
            }
        }
    }

    /// Gracefully cancel the subscription and drain until the Host settles.
    /// Surfaces cancel-write failures, settlement timeouts, and shutdown errors
    /// so callers never mistake an unconfirmed cancel for clean Host cleanup.
    pub async fn cancel(self) -> Result<(), RemoteClientError> {
        self.cancel_with_timeout(Duration::from_secs(3)).await
    }

    /// Gracefully cancel the subscription with an explicit settlement deadline.
    pub async fn cancel_with_timeout(mut self, timeout: Duration) -> Result<(), RemoteClientError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let write_err = write_frame(&mut self.writer, &WireControl::Cancel)
            .await
            .err();
        let drain = async {
            loop {
                match read_frame::<_, WireReply>(&mut self.reader).await {
                    Ok(
                        WireReply::Finished { .. }
                        | WireReply::Aborted { .. }
                        | WireReply::BindingRetired { .. },
                    ) => return Ok(()),
                    Ok(_) => continue,
                    Err(RemoteClientError::Io(err))
                        if err.kind() == io::ErrorKind::UnexpectedEof =>
                    {
                        return Ok(());
                    }
                    Err(err) => return Err(err),
                }
            }
        };
        let drain_err = match tokio::time::timeout(timeout, drain).await {
            Ok(Ok(())) => None,
            Ok(Err(err)) => Some(err),
            Err(_) => Some(RemoteClientError::Io(io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out awaiting Host subscription cancellation settlement",
            ))),
        };
        let shutdown_err = self
            .writer
            .shutdown()
            .await
            .err()
            .map(RemoteClientError::Io);
        if let Some(err) = write_err.or(drain_err).or(shutdown_err) {
            return Err(err);
        }
        Ok(())
    }

    async fn abort_channel(&mut self) -> Result<(), RemoteClientError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let write_err = write_frame(&mut self.writer, &WireControl::Cancel)
            .await
            .err();
        let shutdown_err = self
            .writer
            .shutdown()
            .await
            .err()
            .map(RemoteClientError::Io);
        if let Some(err) = write_err.or(shutdown_err) {
            return Err(err);
        }
        Ok(())
    }
}

/// Active admitted remote Host session holding the anchor control stream.
pub struct RemoteHostConnection {
    handle: RemoteCallHandle,
    anchor: BufReader<WsByteChannel<BoxedStream>>,
    closed: bool,
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

    /// Invoke a method on an admitted Host endpoint over a fresh authenticated
    /// WebSocket call channel and collect all streamed events through completion.
    pub async fn call(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Vec<RemoteCallEvent>, RemoteClientError> {
        if self.closed {
            return Err(RemoteClientError::Protocol(
                "cannot invoke call on closed Host session".into(),
            ));
        }
        self.handle.call(endpoint, method, input).await
    }

    /// Invoke a query method on an admitted Host endpoint and return its JSON output.
    pub async fn query(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Value, RemoteClientError> {
        if self.closed {
            return Err(RemoteClientError::Protocol(
                "cannot invoke query on closed Host session".into(),
            ));
        }
        self.handle.query(endpoint, method, input).await
    }

    /// Invoke a mutation method on an admitted Host endpoint and return its recorded output.
    pub async fn mutate(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Value, RemoteClientError> {
        if self.closed {
            return Err(RemoteClientError::Protocol(
                "cannot invoke mutate on closed Host session".into(),
            ));
        }
        self.handle.mutate(endpoint, method, input).await
    }

    /// Open a demand-driven streaming subscription on an admitted Host endpoint.
    pub async fn subscribe(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<RemoteSubscription, RemoteClientError> {
        if self.closed {
            return Err(RemoteClientError::Protocol(
                "cannot subscribe on closed Host session".into(),
            ));
        }
        self.handle.subscribe(endpoint, method, input).await
    }

    /// Gracefully detach this remote session without stopping the Host.
    pub async fn close(mut self) -> Result<(), RemoteClientError> {
        if self.closed {
            return Ok(());
        }
        write_frame(self.anchor.get_mut(), &SessionControl::Close).await?;
        loop {
            match read_frame::<_, WireResponse>(&mut self.anchor).await? {
                WireResponse::Closed => {
                    self.closed = true;
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
