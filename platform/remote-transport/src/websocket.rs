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

use crate::{Result, TlsTrust, tls};
use std::{io, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{
        handshake::{client::generate_key, derive_accept_key, headers::MAX_HEADERS},
        protocol::Role,
    },
};
use url::Url;

pub type WebSocket = WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

pub struct WebSocketEndpoint {
    url: Url,
    tls: Option<(rustls::pki_types::ServerName<'static>, TlsConnector)>,
}

impl WebSocketEndpoint {
    pub fn new(raw: &str, trust: TlsTrust) -> Result<Self> {
        let url = maka_remote_pairing::parse_websocket_url(raw)?;
        let tls = if url.scheme() == "wss" {
            let name = tls::server_name(&url)?;
            let config =
                tls::ca_config([(name.clone(), trust)].into()).client_config(tls::provider())?;
            Some((name, Arc::new(config).into()))
        } else {
            if trust != TlsTrust::System {
                return Err("WebSocket TLS trust requires wss://".into());
            }
            None
        };
        Ok(Self { url, tls })
    }

    pub async fn open(&self, bearer: Option<&str>) -> Result<WebSocket> {
        self.open_with_timeout(bearer, Duration::from_secs(15))
            .await
    }

    pub async fn open_with_timeout(
        &self,
        bearer: Option<&str>,
        deadline: Duration,
    ) -> Result<WebSocket> {
        tokio::time::timeout(deadline, self.connect(bearer))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "WebSocket open timed out"))?
    }

    async fn connect(&self, bearer: Option<&str>) -> Result<WebSocket> {
        if let Some(bearer) = bearer {
            crate::peer::validate_bearer(bearer)?;
        }
        let host = match self.url.host().expect("validated WebSocket URL") {
            url::Host::Domain(name) => name.to_owned(),
            url::Host::Ipv4(ip) => ip.to_string(),
            url::Host::Ipv6(ip) => ip.to_string(),
        };
        let port = self.url.port_or_known_default().expect("WebSocket scheme");
        let stream = TcpStream::connect((host.as_str(), port)).await?;
        let mut stream = match &self.tls {
            Some((name, connector)) => {
                MaybeTlsStream::Rustls(connector.connect(name.clone(), stream).await?)
            }
            None => {
                if !stream.peer_addr()?.ip().is_loopback() {
                    return Err("plain WebSocket must connect to loopback".into());
                }
                MaybeTlsStream::Plain(stream)
            }
        };
        // tungstenite's client handshake traces the serialized request, even
        // headers marked sensitive. Use it only for framing after HTTP upgrade.
        let key = generate_key();
        let authority = &self.url[url::Position::BeforeHost..url::Position::AfterPort];
        let target = &self.url[url::Position::BeforePath..];
        let mut request = format!(
            "GET {target} HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        );
        if let Some(bearer) = bearer {
            use std::fmt::Write as _;
            write!(request, "Authorization: Bearer {bearer}\r\n").expect("writing to String");
        }
        request.push_str("\r\n");
        let tail =
            exchange_upgrade(&mut stream, request, &derive_accept_key(key.as_bytes())).await?;
        Ok(WebSocketStream::from_partially_read(stream, tail, Role::Client, None).await)
    }
}

async fn exchange_upgrade(
    stream: &mut (impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin),
    request: String,
    expected_accept: &str,
) -> io::Result<Vec<u8>> {
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;
    drop(request);
    read_upgrade(stream, expected_accept).await
}

async fn read_upgrade(
    stream: &mut (impl tokio::io::AsyncRead + Unpin),
    expected_accept: &str,
) -> io::Result<Vec<u8>> {
    // Match tungstenite's existing HTTP handshake byte and field-count bounds.
    const MAX_RESPONSE_HEAD: usize = 64 * 1024;
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    let head_end = loop {
        let remaining = MAX_RESPONSE_HEAD - bytes.len();
        if remaining == 0 {
            return Err(invalid_upgrade(
                "WebSocket upgrade response headers too large",
            ));
        }
        let limit = remaining.min(chunk.len());
        let read = stream.read(&mut chunk[..limit]).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "WebSocket upgrade response ended early",
            ));
        }
        let start = bytes.len().saturating_sub(3);
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(offset) = bytes[start..].windows(4).position(|w| w == b"\r\n\r\n") {
            break start + offset + 4;
        }
    };

    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut response = httparse::Response::new(&mut headers);
    if response
        .parse(&bytes[..head_end])
        .map_err(|_| invalid_upgrade("invalid WebSocket upgrade response"))?
        != httparse::Status::Complete(head_end)
        || response.version != Some(1)
    {
        return Err(invalid_upgrade("invalid WebSocket upgrade response"));
    }
    if response.code != Some(101) {
        return Err(io::Error::other(format!(
            "WebSocket upgrade rejected: {}",
            response.code.expect("parsed HTTP status")
        )));
    }

    let mut upgrade = false;
    let mut connection = false;
    let mut accepted = false;
    for header in response.headers {
        if header.name.eq_ignore_ascii_case("upgrade") {
            if upgrade || !header.value.eq_ignore_ascii_case(b"websocket") {
                return Err(invalid_upgrade("invalid WebSocket Upgrade header"));
            }
            upgrade = true;
        } else if header.name.eq_ignore_ascii_case("connection") {
            connection |= contains_token(header.value, b"upgrade");
        } else if header.name.eq_ignore_ascii_case("sec-websocket-accept") {
            if accepted || header.value != expected_accept.as_bytes() {
                return Err(invalid_upgrade("invalid Sec-WebSocket-Accept"));
            }
            accepted = true;
        } else if header.name.eq_ignore_ascii_case("sec-websocket-protocol")
            || header.name.eq_ignore_ascii_case("sec-websocket-extensions")
        {
            return Err(invalid_upgrade(
                "unsolicited WebSocket protocol or extensions",
            ));
        }
    }
    if !(upgrade && connection && accepted) {
        return Err(invalid_upgrade(
            "missing WebSocket upgrade response headers",
        ));
    }
    Ok(bytes.split_off(head_end))
}

fn contains_token(value: &[u8], token: &[u8]) -> bool {
    value
        .split(|&b| b == b',')
        .any(|part| part.trim_ascii().eq_ignore_ascii_case(token))
}

fn invalid_upgrade(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{BufWriter, duplex};

    #[tokio::test]
    async fn upgrade_flushes_a_buffered_stream_before_reading() {
        let (io, mut server) = duplex(1024);
        let mut client = BufWriter::new(io);
        let request = "GET / HTTP/1.1\r\n\r\n";
        let server_upgrade = async {
            let mut received = vec![0; request.len()];
            server.read_exact(&mut received).await.unwrap();
            assert_eq!(received, request.as_bytes());
            server.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n").await.unwrap();
        };
        let (response, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                exchange_upgrade(&mut client, request.into(), "test"),
                server_upgrade
            )
        })
        .await
        .expect("server couldn't receive the buffered request");
        response.unwrap();
    }
}
