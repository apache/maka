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
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey, TransportAddr,
    dns::{DnsResolver, FallbackMode},
    endpoint::{Connection, RecvStream, SendStream, presets},
};
use iroh_relay::{RelayConfig, RelayQuicConfig};
use maka_remote_pairing::{
    DeviceIdentity, DevicePublicKey, RelayEndpoint, SAS_EXPORTER_LABEL, SignedPairingTicket,
    derive_handshake_sas, parse_peer_id,
};
use rustls::pki_types::ServerName;
use std::{
    collections::{BTreeMap, HashMap},
    time::Duration,
};
use tokio::io::{Join, join};

pub const HOST_ALPN: &[u8] = b"maka/host/v1";

pub struct Relay {
    config: RelayConfig,
    public: RelayEndpoint,
    name: ServerName<'static>,
    trust: TlsTrust,
}

impl Relay {
    pub fn new(
        endpoint: &RelayEndpoint,
        ca_der: Option<Vec<u8>>,
        auth_token: Option<String>,
    ) -> Result<Self> {
        let validated = endpoint.validate()?;
        let url = validated.url;
        let name = tls::server_name(&url)?;
        let trust = match (validated.cert_sha256, ca_der) {
            (None, None) => TlsTrust::System,
            (None, Some(der)) => TlsTrust::CaDer(der),
            (Some(pin), None) => TlsTrust::LeafSha256(pin),
            (Some(_), Some(_)) => return Err("choose either a relay leaf pin or a relay CA".into()),
        };
        if url.scheme() != "https" && (trust != TlsTrust::System || auth_token.is_some()) {
            return Err("relay TLS trust and Bearer authentication require https://".into());
        }
        let mut config = RelayConfig::new(
            RelayUrl::from(url),
            validated.quic_port.map(RelayQuicConfig::new),
        );
        if let Some(token) = auth_token {
            validate_bearer(&token)?;
            config = config.with_auth_token(token);
        }
        Ok(Self {
            config,
            public: endpoint.clone(),
            name,
            trust,
        })
    }
}

pub(crate) fn validate_bearer(token: &str) -> Result<()> {
    if !maka_remote_pairing::valid_relay_bearer(token) {
        return Err("invalid Bearer token".into());
    }
    Ok(())
}

pub struct PeerEndpoint {
    pub(crate) endpoint: Endpoint,
    pub(crate) local_key: DevicePublicKey,
    routes: BTreeMap<RelayUrl, RelayEndpoint>,
}

impl PeerEndpoint {
    pub async fn bind(
        identity: &DeviceIdentity,
        relays: &[Relay],
        relay_only: bool,
    ) -> Result<Self> {
        Self::bind_alpn(identity, relays, relay_only, Vec::new()).await
    }

    pub(crate) async fn bind_alpn(
        identity: &DeviceIdentity,
        relays: &[Relay],
        relay_only: bool,
        alpns: Vec<Vec<u8>>,
    ) -> Result<Self> {
        let mut trust_by_name = HashMap::new();
        let mut routes = BTreeMap::new();
        for relay in relays {
            if routes
                .insert(relay.config.url.clone(), relay.public.clone())
                .is_some()
            {
                return Err(format!("duplicate relay URL: {}", relay.config.url).into());
            }
            // iroh shares one TLS verifier across relay HTTPS and QAD. The
            // verifier sees the server name, not the port or URL.
            if let Some(previous) = trust_by_name.insert(relay.name.clone(), relay.trust.clone())
                && previous != relay.trust
            {
                return Err(
                    "relays on the same hostname must use the same TLS trust policy".into(),
                );
            }
        }
        if routes.is_empty() {
            return Err("native peer transport requires a configured relay".into());
        }
        let map: RelayMap = relays
            .iter()
            .map(|relay| {
                let mut config = relay.config.clone();
                if relay_only {
                    config.quic = None;
                }
                config
            })
            .collect();
        let mut builder = Endpoint::builder(presets::Minimal)
            .crypto_provider(tls::provider())
            .secret_key(SecretKey::from_bytes(identity.secret_bytes()))
            .alpns(alpns)
            .relay_mode(RelayMode::Custom(map))
            .dns_resolver(
                DnsResolver::builder()
                    .with_system_defaults()
                    .with_fallback_mode(FallbackMode::Never)
                    .build(),
            )
            .ca_tls_config(tls::ca_config(trust_by_name));
        if relay_only {
            builder = builder.clear_ip_transports();
        }
        Ok(Self {
            endpoint: builder.bind().await?,
            local_key: identity.public_key(),
            routes,
        })
    }

    pub async fn connect(&self, host_key: &DevicePublicKey) -> Result<PeerConnection> {
        self.connect_via(
            host_key,
            self.routes.keys().cloned().map(TransportAddr::Relay),
        )
        .await
    }

    async fn connect_via(
        &self,
        host_key: &DevicePublicKey,
        addresses: impl IntoIterator<Item = TransportAddr>,
    ) -> Result<PeerConnection> {
        let expected = EndpointId::from_bytes(host_key.as_bytes())?;
        let target = EndpointAddr::new(expected).with_addrs(addresses);
        // Dial immediately. Waiting for online here would serialize the relay
        // handshake behind local UDP address discovery on a cold endpoint.
        let conn = self.endpoint.connect(target, HOST_ALPN).await?;
        if conn.remote_id() != expected {
            conn.close(0u32.into(), b"unexpected host identity");
            return Err("authenticated peer does not match the target Host".into());
        }
        Ok(PeerConnection {
            conn,
            host_key: *host_key,
            client_key: self.local_key,
        })
    }

    /// Dial only ticket routes configured on this endpoint. An explicit
    /// ticket pin must also be enforced by the endpoint's TLS configuration.
    pub async fn connect_ticket(&self, ticket: &SignedPairingTicket) -> Result<PeerConnection> {
        let payload = ticket.payload();
        let mut routes = Vec::new();
        for route in &payload.relays {
            let url = RelayUrl::from(url::Url::parse(&route.url)?);
            let Some(configured) = self.routes.get(&url) else {
                continue;
            };
            if let Some(pin) = &route.cert_sha256
                && !configured
                    .cert_sha256
                    .as_ref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(pin))
            {
                return Err("configured relay pin does not match the signed pairing ticket".into());
            }
            routes.push(TransportAddr::Relay(url));
        }
        if routes.is_empty() {
            return Err("pairing ticket does not name a configured relay".into());
        }
        self.connect_via(&parse_peer_id(&payload.host_peer_id)?, routes)
            .await
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }

    #[cfg(feature = "host")]
    pub(crate) fn connected_relays(
        &self,
        statuses: &[iroh::endpoint::RelayStatus],
    ) -> Vec<RelayEndpoint> {
        statuses
            .iter()
            .filter(|status| status.is_connected())
            .filter_map(|status| self.routes.get(status.url()).cloned())
            .collect()
    }

    /// Wait for a configured home relay to register. Outgoing connections
    /// do not require this startup step.
    #[cfg(feature = "host")]
    pub async fn wait_for_relay(&self) -> Result<Vec<RelayEndpoint>> {
        use iroh::Watcher;
        let mut home = self.endpoint.home_relay_status();
        let mut reports = self.endpoint.net_report();
        let mut report = reports.get();
        let mut rejected = BTreeMap::new();
        let mut failures = Vec::new();
        let ready = 'registration: loop {
            let statuses = home.get();
            let connected = self.connected_relays(&statuses);
            if !connected.is_empty() {
                break Ok(connected);
            }
            // A relay with an unreachable or failed TLS probe never becomes home.
            if report
                .take()
                .is_some_and(|report| report.preferred_relay.is_none())
            {
                failures.extend(
                    self.routes
                        .keys()
                        .filter(|url| !rejected.contains_key(*url))
                        .map(|url| format!("relay {url}: network probe failed")),
                );
                break Err(failures.join("; ").into());
            }
            for status in &statuses {
                let url = status.url();
                if rejected.contains_key(url) {
                    continue;
                }
                let Some(error) = status.last_error() else {
                    continue;
                };
                failures.push(if status.auth_denied_reason().is_some() {
                    // The server supplies the rejection text and can echo credentials.
                    format!("relay {url} rejected authentication (missing or invalid relay Bearer token, or relay policy denied access)")
                } else {
                    format!("relay {url}: {error:#}")
                });
                if self.routes.len() == rejected.len() + 1 {
                    break 'registration Err(failures.join("; ").into());
                }
                // A failed home registration can win the network probe. Let
                // iroh select another home, then restore this candidate.
                if let Some(config) = self.endpoint.remove_relay(url).await {
                    rejected.insert(url.clone(), config);
                }
            }
            tokio::select! {
                () = self.endpoint.closed() => return Err("peer endpoint closed before relay registration".into()),
                update = home.updated() => { update?; }
                update = reports.updated() => report = update?,
            };
        };
        for (url, config) in rejected {
            self.endpoint.insert_relay(url, config).await;
        }
        ready
    }
}

#[derive(Clone)]
pub struct PeerConnection {
    conn: Connection,
    host_key: DevicePublicKey,
    client_key: DevicePublicKey,
}

pub struct PathSummary {
    pub direct: bool,
    pub rtt: Duration,
    pub remote_addr: TransportAddr,
}

pub type PeerStream = Join<RecvStream, SendStream>;

impl PeerConnection {
    pub async fn open_bi(&self) -> Result<PeerStream> {
        let (send, recv) = self.conn.open_bi().await?;
        // iroh's SendStream::poll_shutdown finishes the send half.
        Ok(join(recv, send))
    }

    pub fn export_sas(&self) -> Result<String> {
        export_sas(&self.conn, &self.host_key, &self.client_key)
    }

    pub fn path_summary(&self) -> Option<PathSummary> {
        self.conn
            .paths()
            .iter()
            .find(|path| path.is_selected())
            .map(|path| PathSummary {
                direct: path.is_ip(),
                rtt: path.rtt(),
                remote_addr: path.remote_addr().clone(),
            })
    }

    pub fn close(&self) {
        self.conn.close(0u32.into(), b"");
    }

    pub async fn closed(&self) -> iroh::endpoint::ConnectionError {
        self.conn.closed().await
    }
}

pub(crate) fn export_sas(
    conn: &Connection,
    host: &DevicePublicKey,
    client: &DevicePublicKey,
) -> Result<String> {
    let mut exporter = [0; 32];
    conn.export_keying_material(&mut exporter, SAS_EXPORTER_LABEL, b"")
        .map_err(|_| "could not export QUIC pairing key material")?;
    Ok(derive_handshake_sas(host, client, &exporter))
}

#[cfg(feature = "host")]
use maka_host_runtime::application::host::{Channel, Client, OpenChannel, PeerPairingReceipt};
#[cfg(feature = "host")]
use std::{io, sync::Arc};

#[cfg(feature = "host")]
impl PeerConnection {
    pub fn channel_opener(&self) -> OpenChannel {
        let peer = self.clone();
        Arc::new(move || {
            let peer = peer.clone();
            Box::pin(async move {
                Ok(Box::new(peer.open_bi().await.map_err(io::Error::other)?) as Channel)
            })
        })
    }

    pub async fn connect_client(&self) -> Result<Client> {
        Ok(Client::connect_authenticated_peer(self.channel_opener(), None).await?)
    }

    /// Call only after the user has confirmed the SAS on this connection.
    pub async fn redeem_pairing(
        &self,
        ticket: &SignedPairingTicket,
        device_label: Option<String>,
    ) -> Result<PeerPairingReceipt> {
        let payload = ticket.payload();
        if parse_peer_id(&payload.host_peer_id)? != self.host_key {
            return Err("pairing ticket is not for the authenticated Host".into());
        }
        let receipt = Client::redeem_peer_pairing(
            self.channel_opener(),
            payload.invite_secret.clone(),
            device_label,
            &payload.root_id,
        )
        .await?;
        if parse_peer_id(&receipt.peer_id)? != self.client_key {
            return Err("pairing receipt is not for the authenticated device".into());
        }
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::time::timeout;

    #[tokio::test]
    async fn wrong_route_is_rejected_by_the_quic_handshake() {
        timeout(Duration::from_secs(5), async {
            // Deliver the target's dial packets to another key, as a
            // dishonest relay could. This time inject the bad address at
            // iroh's routing boundary instead of implementing a fake relay.
            let imposter = Endpoint::builder(presets::Minimal)
                .relay_mode(RelayMode::Disabled)
                .alpns(vec![HOST_ALPN.to_vec()])
                .clear_ip_transports()
                .bind_addr(SocketAddr::from(([127, 0, 0, 1], 0)))
                .unwrap()
                .bind()
                .await
                .unwrap();
            let target = DeviceIdentity::generate().unwrap().public_key();
            assert_ne!(imposter.id().as_bytes(), target.as_bytes());
            let identity = DeviceIdentity::generate().unwrap();
            let client = PeerEndpoint {
                endpoint: Endpoint::builder(presets::Minimal)
                    .relay_mode(RelayMode::Disabled)
                    .secret_key(SecretKey::from_bytes(identity.secret_bytes()))
                    .bind()
                    .await
                    .unwrap(),
                local_key: identity.public_key(),
                routes: BTreeMap::new(),
            };
            let dial =
                client.connect_via(&target, [TransportAddr::Ip(imposter.bound_sockets()[0])]);
            let accept = async { imposter.accept().await.unwrap().await };
            let (client_result, server_result) = tokio::join!(dial, accept);
            assert!(
                client_result.is_err(),
                "client exposed an application stream to an impostor"
            );
            assert!(server_result.is_err(), "impostor completed authentication");
            client.close().await;
            imposter.close().await;
        })
        .await
        .expect("an actual misrouted QUIC handshake must be attempted and rejected");
    }

    #[cfg(all(feature = "relay-server", feature = "host"))]
    #[tokio::test]
    async fn pinned_relay_leaf_must_be_currently_valid() {
        use crate::server::{RelayServer, RelayTls};
        use iroh_relay::client::ClientBuilder;
        use rcgen::{CertificateParams, KeyPair, date_time_ymd};
        timeout(Duration::from_secs(5), async {
            for (start, end, expected) in [(2000, 2001, "Expired"), (2999, 3000, "NotValidYet")] {
                let mut params = CertificateParams::new(vec!["127.0.0.1".into()]).unwrap();
                params.not_before = date_time_ymd(start, 1, 1);
                params.not_after = date_time_ymd(end, 1, 1);
                let key = KeyPair::generate().unwrap();
                let cert = params.self_signed(&key).unwrap();
                let tls = RelayTls::from_pem(cert.pem().as_bytes(), key.serialize_pem().as_bytes())
                    .unwrap();
                let relay = RelayServer::bind(
                    None,
                    Some("127.0.0.1:0".parse().unwrap()),
                    None,
                    Some(&tls),
                    None,
                )
                .await
                .unwrap();
                let route = Relay::new(
                    &RelayEndpoint {
                        url: format!("https://{}", relay.https_addr().unwrap()),
                        cert_sha256: relay.cert_sha256().map(hex::encode),
                        quic_port: None,
                    },
                    None,
                    None,
                )
                .unwrap();
                let identity = DeviceIdentity::generate().unwrap();
                let url = route.config.url.clone();
                let peer = PeerEndpoint::bind(&identity, &[route], true).await.unwrap();
                let result = ClientBuilder::new(
                    url,
                    SecretKey::from_bytes(identity.secret_bytes()),
                    peer.endpoint.dns_resolver().unwrap().clone(),
                )
                .tls_client_config(peer.endpoint.tls_config().clone())
                .connect()
                .await;
                let error =
                    result.expect_err("pinned relay completed TLS with an invalid validity window");
                assert!(format!("{error:#}").contains(expected), "{error:#}");
                let error = peer.wait_for_relay().await.unwrap_err();
                assert!(
                    error.to_string().contains("network probe failed"),
                    "{error}"
                );
                peer.close().await;
                relay.shutdown().await.unwrap();
            }
        })
        .await
        .expect("pinned relay validity check timed out");
    }
}
