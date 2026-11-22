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

//! HTTP authentication precedes the ordinary bounded application protocol.
mod bytes;
mod upgrade;
use super::{Channel, Host, OpenChannel, Result, access::Authority};
use std::{io, net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpListener,
    sync::mpsc,
};

enum Ingress {
    Tcp(TcpListener),
    Streams(mpsc::Receiver<Channel>),
}

pub struct WebSocketListener {
    ingress: Option<Ingress>,
    extra_streams: Option<mpsc::Receiver<Channel>>,
    allowed_origins: Arc<[String]>,
}
impl WebSocketListener {
    pub async fn bind(address: SocketAddr, allowed_origins: Vec<String>) -> Result<Self> {
        if !address.ip().is_loopback() {
            return Err("Plain WebSocket listener requires a loopback address".into());
        }
        let allowed_origins = validate_origins(allowed_origins)?;
        Ok(Self {
            ingress: Some(Ingress::Tcp(
                TcpListener::bind(address)
                    .await
                    .map_err(|error| error.to_string())?,
            )),
            extra_streams: None,
            allowed_origins,
        })
    }

    /// Accept remote WebSocket application channels over caller-supplied streams.
    pub fn from_streams(
        streams: mpsc::Receiver<Channel>,
        allowed_origins: Vec<String>,
    ) -> Result<Self> {
        Ok(Self {
            ingress: Some(Ingress::Streams(streams)),
            extra_streams: None,
            allowed_origins: validate_origins(allowed_origins)?,
        })
    }

    /// Attach an additional supplied-stream ingress (such as a QUIC P2P Mesh
    /// node) alongside an existing TCP WebSocket listener.
    pub fn attach_streams(&mut self, streams: mpsc::Receiver<Channel>) {
        self.extra_streams = Some(streams);
    }

    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        match &self.ingress {
            Some(Ingress::Tcp(listener)) => listener.local_addr(),
            Some(Ingress::Streams(_)) | None => Err(io::Error::new(
                io::ErrorKind::AddrNotAvailable,
                "supplied stream listener has no socket address",
            )),
        }
    }

    pub(super) async fn accept(&mut self) -> io::Result<Option<(Channel, Arc<[String]>)>> {
        loop {
            if self.ingress.is_none() && self.extra_streams.is_none() {
                return Ok(None);
            }
            let stream: Option<Channel> = tokio::select! {
                primary = async {
                    match &mut self.ingress {
                        Some(Ingress::Tcp(listener)) => {
                            listener.accept().await.map(|(s, _)| Some(Box::new(s) as Channel))
                        }
                        Some(Ingress::Streams(streams)) => Ok(streams.recv().await),
                        None => std::future::pending().await,
                    }
                } => match primary? {
                    Some(stream) => Some(stream),
                    None => {
                        self.ingress = None;
                        None
                    }
                },
                extra = async {
                    match &mut self.extra_streams {
                        Some(streams) => streams.recv().await,
                        None => std::future::pending().await,
                    }
                } => match extra {
                    Some(stream) => Some(stream),
                    None => {
                        self.extra_streams = None;
                        None
                    }
                },
            };
            if let Some(stream) = stream {
                return Ok(Some((stream, self.allowed_origins.clone())));
            }
        }
    }
}

fn validate_origins(allowed_origins: Vec<String>) -> Result<Arc<[String]>> {
    if allowed_origins
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != allowed_origins.len()
    {
        return Err("WebSocket Origin allowlist contains duplicates".into());
    }
    Ok(allowed_origins.into())
}

pub(super) async fn connection<S>(
    socket: S,
    host: Arc<Host>,
    allowed_origins: Arc<[String]>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let upgraded = tokio::select! {
        biased;
        () = host.stop.cancelled() => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(5), upgrade::accept(socket, host.clone(), allowed_origins)) => result.map_err(|_| "HTTP upgrade timed out")??,
    };
    let Some((socket, hash)) = upgraded else {
        return Ok(());
    };
    host.channel(bytes::Channel::new(socket), Authority::Remote { hash })
        .await
}

/// Upgrade each fresh transport stream to the authenticated Host WebSocket.
pub fn channel_opener(open: OpenChannel, bearer: Arc<str>) -> OpenChannel {
    Arc::new(move || {
        let stream = open();
        let bearer = bearer.clone();
        Box::pin(async move {
            Ok(Box::new(connect_on_stream(stream.await?, &bearer).await?) as Channel)
        })
    })
}

/// Open the existing application WebSocket on an already connected byte stream.
async fn connect_on_stream<S>(
    stream: S,
    bearer: &str,
) -> io::Result<impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + use<S>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio_tungstenite::tungstenite::{
        Error, client::IntoClientRequest, error::ProtocolError, http::header,
    };

    // The URI selects the existing Host route. It never causes a TCP dial.
    let mut request = "ws://localhost/runtime-host"
        .into_client_request()
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid Host WebSocket request",
            )
        })?;
    let mut authorization = header::HeaderValue::from_str(&format!("Bearer {bearer}"))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid Host Bearer header"))?;
    authorization.set_sensitive(true);
    request
        .headers_mut()
        .insert(header::AUTHORIZATION, authorization);
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::client_async_with_config(request, stream, Some(bytes::config())),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Host WebSocket upgrade timed out"))?
    .map_err(|error| match error {
        Error::Http(response) => io::Error::other(format!(
            "Host WebSocket upgrade rejected: {}",
            response.status()
        )),
        Error::Io(error) => io::Error::new(
            error.kind(),
            format!("Host WebSocket upgrade I/O error: {:?}", error.kind()),
        ),
        Error::ConnectionClosed
        | Error::AlreadyClosed
        | Error::Protocol(ProtocolError::HandshakeIncomplete) => io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Host WebSocket closed during upgrade",
        ),
        Error::Protocol(_) | Error::HttpFormat(_) => io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid Host WebSocket upgrade response",
        ),
        Error::Capacity(_) => io::Error::new(
            io::ErrorKind::InvalidData,
            "Host WebSocket upgrade response exceeded its size limit",
        ),
        _ => io::Error::other("Host WebSocket upgrade failed"),
    })?;
    Ok(bytes::Channel::new(socket))
}
