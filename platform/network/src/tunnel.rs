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

use crate::Policy;
use base64::Engine;
use maka_sandbox::Destination;
use rustls_platform_verifier::BuilderVerifierExt;
use std::{io, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
};
use tokio_rustls::{TlsConnector, rustls};

pub(crate) trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub(crate) type Tunnel = Box<dyn Stream>;

/// Routing is captured by the caller; neither environment variables nor a
/// failed proxy connection can select a different route.
pub(crate) async fn connect(policy: &Policy, destination: &Destination) -> io::Result<Tunnel> {
    tokio::time::timeout(Duration::from_secs(15), connect_inner(policy, destination))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "proxy connection timed out"))?
}

async fn connect_inner(policy: &Policy, destination: &Destination) -> io::Result<Tunnel> {
    let target = (destination.host(), destination.port());
    // CONNECT carries no URL scheme. It routes like an https destination,
    // including tunnels to nonstandard destination ports.
    let Some(proxy) = policy.proxy_for("https", destination.host(), destination.port()) else {
        return Ok(Box::new(TcpStream::connect(target).await?));
    };
    let host = proxy
        .host_str()
        .ok_or_else(|| io::Error::other("proxy host missing"))?
        .trim_matches(['[', ']']);
    let port = proxy
        .port_or_known_default()
        .ok_or_else(|| io::Error::other("proxy port missing"))?;
    let user = decode(proxy.username())?;
    let password = decode(proxy.password().unwrap_or_default())?;
    if matches!(proxy.scheme(), "socks5" | "socks5h") {
        let target = if proxy.scheme() == "socks5" {
            tokio_socks::TargetAddr::Ip(
                tokio::net::lookup_host(target)
                    .await?
                    .next()
                    .ok_or_else(|| io::Error::other("SOCKS destination resolution failed"))?,
            )
        } else {
            tokio_socks::IntoTargetAddr::into_target_addr(target).map_err(io::Error::other)?
        };
        let stream = if user.is_empty() {
            tokio_socks::tcp::Socks5Stream::connect((host, port), target).await
        } else {
            tokio_socks::tcp::Socks5Stream::connect_with_password(
                (host, port),
                target,
                &user,
                &password,
            )
            .await
        }
        .map_err(|_| io::Error::other("upstream SOCKS connection failed"))?;
        return Ok(Box::new(stream));
    }
    let tcp = TcpStream::connect((host, port)).await?;
    let mut stream: Tunnel = match proxy.scheme() {
        "http" => Box::new(tcp),
        "https" => {
            let config = rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::aws_lc_rs::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .map_err(io::Error::other)?
            .with_platform_verifier()
            .map_err(io::Error::other)?
            .with_no_client_auth();
            let name = rustls::pki_types::ServerName::try_from(host.to_owned())
                .map_err(io::Error::other)?;
            Box::new(
                TlsConnector::from(Arc::new(config))
                    .connect(name, tcp)
                    .await?,
            )
        }
        _ => return Err(io::Error::other("unsupported upstream proxy")),
    };
    let authority = authority(destination);
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if !user.is_empty() {
        let credentials =
            base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {credentials}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await?;
    // Preserve read-ahead after the header boundary without a syscall per byte.
    let mut stream = BufReader::new(stream);
    let mut head = Vec::new();
    {
        let mut bounded = (&mut stream).take(16 * 1024);
        loop {
            if bounded.read_until(b'\n', &mut head).await? == 0 {
                return Err(io::Error::other(
                    "incomplete or oversized upstream proxy headers",
                ));
            }
            if head.ends_with(b"\r\n\r\n") {
                break;
            }
        }
    }
    let status = head.split(|b| *b == b'\n').next().unwrap_or_default();
    if !(status.starts_with(b"HTTP/1.1 200 ")
        || status.starts_with(b"HTTP/1.0 200 ")
        || status == b"HTTP/1.1 200\r"
        || status == b"HTTP/1.0 200\r")
    {
        return Err(io::Error::other("upstream proxy refused tunnel"));
    }
    Ok(Box::new(stream))
}

fn decode(value: &str) -> io::Result<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .map(|v| v.into_owned())
        .map_err(io::Error::other)
}

pub(crate) fn authority(destination: &Destination) -> String {
    if destination.host().contains(':') {
        format!("[{}]:{}", destination.host(), destination.port())
    } else {
        format!("{}:{}", destination.host(), destination.port())
    }
}
