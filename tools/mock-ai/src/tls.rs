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

use rustls_platform_verifier::BuilderVerifierExt;
use std::io::{self, Cursor};
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName};
use tokio_rustls::{TlsAcceptor, TlsConnector, rustls};
use tokio_tungstenite::WebSocketStream;

/// Inbound TLS server configuration for serving HTTPS and WSS on `MockAiServer`.
#[derive(Clone)]
pub struct TlsServerConfig {
    acceptor: TlsAcceptor,
}

impl std::fmt::Debug for TlsServerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TlsServerConfig").finish_non_exhaustive()
    }
}

impl TlsServerConfig {
    /// Load a PEM-encoded certificate chain and private key from memory.
    pub fn from_pem_bytes(cert_pem: &[u8], key_pem: &[u8]) -> Result<Self, String> {
        let mut cert_reader = Cursor::new(cert_pem);
        let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_reader)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to parse TLS certificate PEM: {e}"))?;
        if certs.is_empty() {
            return Err("TLS certificate PEM contained no certificates".into());
        }

        let mut key_reader = Cursor::new(key_pem);
        let key = rustls_pemfile::private_key(&mut key_reader)
            .map_err(|e| format!("failed to parse TLS private key PEM: {e}"))?
            .ok_or_else(|| "TLS private key PEM contained no private key".to_string())?;

        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let mut server_cfg = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("TLS protocol version config failed: {e}"))?
            .with_no_client_auth()
            .with_single_cert(certs, key)
            .map_err(|e| format!("invalid TLS cert/key pair: {e}"))?;
        // Stick to HTTP/1.1 ALPN so HTTP/1.1 SSE and WebSocket Upgrade work seamlessly over TLS.
        server_cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Self {
            acceptor: TlsAcceptor::from(Arc::new(server_cfg)),
        })
    }

    /// Load a PEM-encoded certificate chain and private key from files on disk.
    pub fn from_pem_files(cert_path: &Path, key_path: &Path) -> Result<Self, String> {
        let cert_pem = std::fs::read(cert_path)
            .map_err(|e| format!("failed to read TLS cert {}: {e}", cert_path.display()))?;
        let key_pem = std::fs::read(key_path)
            .map_err(|e| format!("failed to read TLS key {}: {e}", key_path.display()))?;
        Self::from_pem_bytes(&cert_pem, &key_pem)
    }

    pub(crate) fn acceptor(&self) -> TlsAcceptor {
        self.acceptor.clone()
    }
}

/// Build an outbound `TlsConnector` using either a custom CA PEM bundle or the OS platform verifier.
pub fn build_tls_connector(custom_ca_pem: Option<&[u8]>) -> Result<TlsConnector, String> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS client protocol config failed: {e}"))?;

    let mut cfg = if let Some(pem) = custom_ca_pem {
        let mut roots = rustls::RootCertStore::empty();
        let mut reader = Cursor::new(pem);
        let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to parse upstream CA PEM: {e}"))?;
        if certs.is_empty() {
            return Err("upstream CA PEM contained no certificates".into());
        }
        for cert in certs {
            roots
                .add(cert)
                .map_err(|e| format!("invalid upstream CA certificate: {e}"))?;
        }
        builder.with_root_certificates(roots).with_no_client_auth()
    } else {
        builder
            .with_platform_verifier()
            .map_err(|e| format!("platform TLS verifier init failed: {e}"))?
            .with_no_client_auth()
    };
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsConnector::from(Arc::new(cfg)))
}

/// Plain or TLS-wrapped TCP stream for upstream `ws://` and `wss://` proxy connections.
pub enum UpstreamWsStream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for UpstreamWsStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Self::Tls(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for UpstreamWsStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Self::Tls(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_flush(cx),
            Self::Tls(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Self::Tls(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// Connect to an upstream `ws://` or `wss://` endpoint using `tls_connector` for TLS handshakes.
pub async fn connect_ws_upstream(
    req: tokio_tungstenite::tungstenite::http::Request<()>,
    tls_connector: &TlsConnector,
) -> Result<WebSocketStream<UpstreamWsStream>, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        connect_ws_upstream_inner(req, tls_connector),
    )
    .await
    .map_err(|_| "upstream WebSocket connect timed out".to_string())?
}

async fn connect_ws_upstream_inner(
    req: tokio_tungstenite::tungstenite::http::Request<()>,
    tls_connector: &TlsConnector,
) -> Result<WebSocketStream<UpstreamWsStream>, String> {
    let uri = req.uri();
    let scheme = uri.scheme_str().unwrap_or("ws");
    let use_tls = match scheme {
        "ws" | "http" => false,
        "wss" | "https" => true,
        other => return Err(format!("unsupported WebSocket scheme '{other}'")),
    };
    let host = uri
        .host()
        .ok_or_else(|| format!("upstream WebSocket URI missing host: {uri}"))?
        .trim_matches(['[', ']'])
        .to_string();
    let port = uri.port_u16().unwrap_or(if use_tls { 443 } else { 80 });

    let tcp = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|e| format!("upstream ws TCP connect to {host}:{port} failed: {e}"))?;
    let _ = tcp.set_nodelay(true);

    let stream = if use_tls {
        let server_name = ServerName::try_from(host.clone())
            .map_err(|e| format!("invalid TLS server name '{host}': {e}"))?;
        let tls = tls_connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| format!("upstream wss TLS handshake to {host}:{port} failed: {e}"))?;
        UpstreamWsStream::Tls(Box::new(tls))
    } else {
        UpstreamWsStream::Plain(tcp)
    };

    let (ws, _) = tokio_tungstenite::client_async(req, stream)
        .await
        .map_err(|e| format!("upstream ws handshake failed: {e}"))?;
    Ok(ws)
}
