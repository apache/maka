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

use crate::{Result, peer::validate_bearer, tls};
use iroh_relay::server::{
    Access, AccessControl, CertConfig, ClientRequest, QuicConfig, RelayConfig, RelayService,
    Server, ServerConfig, TlsConfig,
};
use rustls::{
    ServerConfig as RustlsConfig,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, pem::PemObject},
};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, task::JoinSet};

pub struct RelayTls {
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
}

impl RelayTls {
    pub fn from_pem(cert: &[u8], key: &[u8]) -> Result<Self> {
        let chain =
            CertificateDer::pem_slice_iter(cert).collect::<std::result::Result<Vec<_>, _>>()?;
        if chain.is_empty() {
            return Err("relay certificate PEM contains no certificates".into());
        }
        Ok(Self {
            chain,
            key: PrivateKeyDer::from_pem_slice(key)?,
        })
    }

    pub fn self_signed(sans: Vec<String>) -> Result<Self> {
        if sans.is_empty() {
            return Err("self-signed relay TLS requires at least one SAN".into());
        }
        let cert = rcgen::generate_simple_self_signed(sans)?;
        Ok(Self {
            chain: vec![cert.cert.der().clone()],
            key: PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
        })
    }

    pub fn certificate_der(&self) -> &[u8] {
        self.chain[0].as_ref()
    }

    pub fn cert_sha256(&self) -> [u8; 32] {
        Sha256::digest(self.certificate_der()).into()
    }

    fn config(
        &self,
        versions: &[&'static rustls::SupportedProtocolVersion],
    ) -> Result<RustlsConfig> {
        Ok(RustlsConfig::builder_with_provider(tls::provider())
            .with_protocol_versions(versions)?
            .with_no_client_auth()
            .with_single_cert(self.chain.clone(), self.key.clone_key())?)
    }
}

#[derive(Debug)]
struct BearerDigest([u8; 32]);

impl AccessControl for BearerDigest {
    async fn on_connect(&self, request: &ClientRequest) -> Access {
        if let Some(token) = request.auth_token() {
            let actual: [u8; 32] = Sha256::digest(token.as_bytes()).into();
            if bool::from(self.0.ct_eq(&actual)) {
                return Access::Allow;
            }
        }
        Access::Deny {
            reason: Some("invalid relay Bearer token".into()),
        }
    }
}

pub struct RelayServer {
    server: Server,
    cert_sha256: Option<[u8; 32]>,
    http_addr: Option<SocketAddr>,
    plain_listener: JoinSet<Result<()>>,
}

impl RelayServer {
    /// HTTP and HTTPS listeners share iroh's same client registry.
    /// Expose plaintext only on a trusted network or behind a TLS proxy.
    pub async fn bind(
        http: Option<SocketAddr>,
        https: Option<SocketAddr>,
        quic: Option<SocketAddr>,
        credentials: Option<&RelayTls>,
        auth_token: Option<&str>,
    ) -> Result<Self> {
        if http.is_none() && https.is_none() {
            return Err("relay requires an HTTP or HTTPS listener".into());
        }
        if credentials.is_some() != (https.is_some() || quic.is_some()) {
            return Err(
                "TLS credentials are required exactly when HTTPS or QUIC is enabled".into(),
            );
        }

        let plain = match (http, https) {
            (Some(addr), Some(_)) => {
                let tcp = TcpListener::bind(addr).await?;
                let addr = tcp.local_addr()?;
                Some((tcp, addr))
            }
            _ => None,
        };
        // With TLS iroh's HTTP socket only serves captive-portal probes. Keep
        // it private; when requested, mount the same relay service on HTTP.
        let portal = SocketAddr::from(([127, 0, 0, 1], 0));
        let mut relay = RelayConfig::new(if https.is_some() {
            portal
        } else {
            http.expect("validated HTTP listener")
        });
        if let Some(token) = auth_token {
            validate_bearer(token)?;
            relay.access = Arc::new(BearerDigest(Sha256::digest(token.as_bytes()).into()));
        }
        if let Some(addr) = https {
            let mut server_config = credentials
                .expect("validated HTTPS credentials")
                .config(&[&rustls::version::TLS13, &rustls::version::TLS12])?;
            server_config.alpn_protocols = vec![b"http/1.1".to_vec()];
            relay.tls = Some(TlsConfig::new(addr, CertConfig::Manual { server_config }));
        }
        let mut config = ServerConfig::default();
        config.relay = Some(relay);
        if let Some(addr) = quic {
            let mut qad = QuicConfig::new(addr);
            qad.server_config = Some(
                credentials
                    .expect("validated QAD credentials")
                    .config(&[&rustls::version::TLS13])?,
            );
            config.quic = Some(qad);
        }
        let server = Server::spawn(config).await?;
        let mut plain_listener = JoinSet::new();
        let http_addr = if let Some((tcp, addr)) = plain {
            let service = server
                .relay_service()
                .expect("configured relay service")
                .clone();
            plain_listener.spawn(serve_plain(tcp, service));
            Some(addr)
        } else if https.is_none() {
            server.http_addr()
        } else {
            None
        };
        Ok(Self {
            server,
            cert_sha256: credentials.map(RelayTls::cert_sha256),
            http_addr,
            plain_listener,
        })
    }

    pub fn http_addr(&self) -> Option<SocketAddr> {
        self.http_addr
    }

    pub fn https_addr(&self) -> Option<SocketAddr> {
        self.server.https_addr()
    }

    pub fn quic_addr(&self) -> Option<SocketAddr> {
        self.server.quic_addr()
    }

    pub fn cert_sha256(&self) -> Option<[u8; 32]> {
        self.cert_sha256
    }

    pub async fn join(&mut self) -> Result<()> {
        tokio::select! {
            result = self.server.join() => { result??; Ok(()) }
            Some(result) = self.plain_listener.join_next() => result?,
        }
    }

    pub async fn shutdown(mut self) -> Result<()> {
        self.plain_listener.shutdown().await;
        self.server.shutdown().await?;
        Ok(())
    }
}

async fn serve_plain(listener: TcpListener, service: RelayService) -> Result<()> {
    // Same TLS/HTTP establishment and upgrade budget as iroh-relay's listener.
    const IROH_ESTABLISH_TIMEOUT: Duration = Duration::from_secs(30);
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            Some(result) = tasks.join_next() => result?,
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                tasks.spawn(service.clone().handle_connection(stream, None, IROH_ESTABLISH_TIMEOUT));
            }
        }
    }
}
