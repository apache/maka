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

//! The WebSocket transport to a remote Runtime Host.
//!
//! Mirrors `openWebSocketTransport` and `classifyRemoteRuntimeHostConnectFailure`
//! in `packages/runtime-host/src/client/connection.ts` and `WebSocketTransport`
//! in `transport/websocket-transport.ts`, against the Host's listener in
//! `server/websocket-listener.ts`:
//!
//! - the upgrade carries `Authorization: Bearer <credential>` and no `Origin`
//!   (the Host admits a request without `Origin`, and one with an `Origin`
//!   only when it is allowlisted); a `401` means the credential was refused;
//! - no extensions are offered, so permessage-deflate stays off;
//! - each text message is exactly one protocol JSON message, with no newline;
//!   binary messages are a protocol violation;
//! - a message or frame over [`MAX_MESSAGE_BYTES`] ends the connection.
//!
//! TLS is rustls on the ring provider with the platform verifier: the
//! operating system's trust store and policy decide, as Node's TLS stack does
//! for Maka Desktop. The bytes go over `async-net`'s TCP stream, so this runs
//! on the same executor as the local transports. The credential is in the
//! upgrade request, which tungstenite logs at trace level; the app caps other
//! crates' logs at warn (`crates/app/src/logging.rs`).

use std::error::Error as StdError;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use async_net::TcpStream;
use async_tungstenite::tungstenite::client::IntoClientRequest as _;
use async_tungstenite::tungstenite::error::CapacityError;
use async_tungstenite::tungstenite::http::{HeaderValue, header::AUTHORIZATION};
use async_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use async_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use async_tungstenite::tungstenite::{self, Message};
use async_tungstenite::{WebSocketReceiver, WebSocketSender, client_async_with_config};
use futures_lite::{AsyncRead, AsyncWrite, StreamExt as _};
use futures_rustls::client::TlsStream;
use futures_rustls::pki_types::ServerName;
use futures_rustls::{TlsConnector, rustls};
use host_protocol::{AccessCredential, FrameError, MAX_MESSAGE_BYTES, RemoteHostUrl};
use rustls_platform_verifier::BuilderVerifierExt as _;
use thiserror::Error;
use url::Host;

use crate::connection::until;
use crate::pump::{ConnectionError, MessageSink, MessageSource};

/// How long closing waits for the close frame to be written.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// Why the WebSocket to a remote Host could not be opened. Maps to the
/// `unavailable` reasons of `ConnectRemoteRuntimeHostResult`.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum WebSocketError {
    /// The upgrade was answered `401` (`authentication_failed`): the Host
    /// does not accept this credential, or it expired before pairing.
    #[error("the Runtime Host rejected its access credential")]
    AuthenticationFailed,
    /// Any other answer than `101` (`connect_failed`), for example `404` for
    /// a wrong path or `403` for an Origin the Host does not allow.
    #[error("the Runtime Host refused the WebSocket upgrade with HTTP status {0}")]
    UpgradeRefused(u16),
    /// No TCP connection (`unreachable`): the name did not resolve, or the
    /// connection was refused, reset, or timed out.
    #[error("could not reach the Runtime Host at {address}")]
    Unreachable {
        address: String,
        #[source]
        source: io::Error,
    },
    /// The TLS handshake failed (`tls_failed`), typically a certificate the
    /// platform does not trust for this host.
    #[error("could not verify the TLS connection to {host}")]
    Tls {
        host: String,
        #[source]
        source: io::Error,
    },
    /// The platform verifier could not be set up.
    #[error("could not set up TLS certificate verification")]
    TlsSetup(#[source] rustls::Error),
    /// The upgrade failed for another reason (`connect_failed`).
    #[error("the WebSocket upgrade failed")]
    Upgrade(#[source] Box<dyn StdError + Send + Sync>),
}

impl WebSocketError {
    /// Whether retrying without a user decision is pointless. As in
    /// `remoteRuntimeHostUnavailableError`, only a refused credential is.
    pub fn is_permanent(&self) -> bool {
        matches!(self, Self::AuthenticationFailed)
    }
}

/// Opens the WebSocket at `url` and completes the HTTP upgrade.
pub(crate) async fn open(
    url: &RemoteHostUrl,
    credential: &AccessCredential,
) -> Result<(WebSocketSource, WebSocketSink), WebSocketError> {
    let parsed = url.as_url();
    let port = parsed.port_or_known_default().unwrap_or(if url.is_tls() { 443 } else { 80 });
    let host = parsed.host().ok_or_else(|| {
        WebSocketError::Upgrade("the Runtime Host URL has no host".to_owned().into())
    })?;
    let address = format!("{host}:{port}");
    let unreachable = |source| WebSocketError::Unreachable { address: address.clone(), source };
    let tcp = match &host {
        Host::Domain(domain) => TcpStream::connect((*domain, port)).await,
        Host::Ipv4(ip) => TcpStream::connect((*ip, port)).await,
        Host::Ipv6(ip) => TcpStream::connect((*ip, port)).await,
    }
    .map_err(unreachable)?;
    // Protocol messages are small and latency-bound; `ws` disables Nagle too.
    tcp.set_nodelay(true).map_err(unreachable)?;

    let socket = if url.is_tls() {
        let server_name = match &host {
            Host::Domain(domain) => {
                ServerName::try_from((*domain).to_owned()).map_err(|error| WebSocketError::Tls {
                    host: host.to_string(),
                    source: io::Error::new(io::ErrorKind::InvalidInput, error),
                })?
            }
            Host::Ipv4(ip) => ServerName::IpAddress(std::net::IpAddr::V4(*ip).into()),
            Host::Ipv6(ip) => ServerName::IpAddress(std::net::IpAddr::V6(*ip).into()),
        };
        let connector = TlsConnector::from(Arc::new(tls_config()?));
        match Box::pin(connector.connect(server_name, tcp)).await {
            Ok(stream) => Socket::Tls(Box::new(stream)),
            Err(source) if is_tls_failure(&source) => {
                return Err(WebSocketError::Tls { host: host.to_string(), source });
            }
            Err(source) => return Err(unreachable(source)),
        }
    } else {
        Socket::Plain(tcp)
    };

    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| WebSocketError::Upgrade(error.into()))?;
    let mut authorization = HeaderValue::from_str(&format!("Bearer {}", credential.expose()))
        .map_err(|error| WebSocketError::Upgrade(error.into()))?;
    authorization.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, authorization);
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES));
    let (stream, _response) = Box::pin(client_async_with_config(request, socket, Some(config)))
        .await
        .map_err(|error| match error {
            tungstenite::Error::Http(response) if response.status().as_u16() == 401 => {
                WebSocketError::AuthenticationFailed
            }
            tungstenite::Error::Http(response) => {
                WebSocketError::UpgradeRefused(response.status().as_u16())
            }
            error => WebSocketError::Upgrade(error.into()),
        })?;
    let (sender, receiver) = stream.split();
    Ok((WebSocketSource(receiver), WebSocketSink(sender)))
}

/// A rustls client configuration on the ring provider that verifies
/// certificates with the platform verifier.
fn tls_config() -> Result<rustls::ClientConfig, WebSocketError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .and_then(|builder| builder.with_platform_verifier())
        .map_err(WebSocketError::TlsSetup)?
        .with_no_client_auth())
}

/// Whether a failed TLS connect failed in TLS itself (the error carries a
/// rustls error) rather than on the TCP connection under it.
fn is_tls_failure(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|inner| inner.downcast_ref::<rustls::Error>().is_some())
}

/// The receiving half: one protocol message per text message.
pub(crate) struct WebSocketSource(WebSocketReceiver<Socket>);

impl MessageSource for WebSocketSource {
    async fn next_message(&mut self) -> Result<Option<String>, ConnectionError> {
        loop {
            // tungstenite answers pings itself and replies to a close frame;
            // the stream then ends.
            let message = match self.0.next().await {
                None => return Ok(None),
                Some(Ok(message)) => message,
                Some(Err(error)) => return Err(read_error(error)),
            };
            match message {
                Message::Text(text) => {
                    if text.is_empty() {
                        return Err(FrameError::Empty.into());
                    }
                    if text.len() > MAX_MESSAGE_BYTES {
                        return Err(FrameError::TooLarge.into());
                    }
                    return Ok(Some(text.as_str().to_owned()));
                }
                Message::Binary(_) => {
                    return Err(ConnectionError::Protocol(
                        "Runtime Host WebSocket messages must be text".to_owned(),
                    ));
                }
                Message::Ping(_) | Message::Pong(_) | Message::Close(_) | Message::Frame(_) => {}
            }
        }
    }
}

/// The sending half: each frame becomes one text message.
pub(crate) struct WebSocketSink(WebSocketSender<Socket>);

impl MessageSink for WebSocketSink {
    async fn send_frame(&mut self, mut frame: Vec<u8>) -> Result<(), ConnectionError> {
        // `encode_frame` ends every frame with one newline, which the local
        // transports need and a WebSocket message must not carry.
        if frame.last() == Some(&b'\n') {
            frame.pop();
        }
        let text = String::from_utf8(frame).map_err(|_| FrameError::InvalidUtf8)?;
        self.0.send(Message::text(text)).await.map_err(write_error)
    }

    async fn close(&mut self) {
        // `closeAfterFlush`: a normal closure. The Host may be gone already.
        let frame = CloseFrame { code: CloseCode::Normal, reason: "".into() };
        let _ = until(Instant::now() + CLOSE_GRACE, self.0.close(Some(frame))).await;
    }
}

fn read_error(error: tungstenite::Error) -> ConnectionError {
    match error {
        tungstenite::Error::Io(error) => ConnectionError::Io(error),
        tungstenite::Error::Capacity(CapacityError::MessageTooLong { .. }) => {
            FrameError::TooLarge.into()
        }
        tungstenite::Error::Utf8(_) => FrameError::InvalidUtf8.into(),
        error => ConnectionError::Io(io::Error::other(error)),
    }
}

fn write_error(error: tungstenite::Error) -> ConnectionError {
    match error {
        tungstenite::Error::Io(error) => ConnectionError::Io(error),
        error => ConnectionError::Io(io::Error::other(error)),
    }
}

/// The byte stream under the WebSocket: plain TCP or TLS over TCP.
pub(crate) enum Socket {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl AsyncRead for Socket {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Socket {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_close(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_close(cx),
        }
    }
}
