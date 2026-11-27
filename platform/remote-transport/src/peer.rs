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
    Watcher,
    dns::{DnsResolver, FallbackMode},
    endpoint::{
        ConnectError, ConnectOptions, ConnectingError, Connection, ConnectionError, RecvStream,
        SendStream, presets,
    },
};
use iroh_relay::{
    RelayConfig, RelayQuicConfig,
    client::{ClientBuilder, ConnectError as RelayConnectError},
};
use maka_remote_pairing::{
    DeviceIdentity, DevicePublicKey, RelayEndpoint, SAS_EXPORTER_LABEL, SignedPairingTicket,
    derive_handshake_sas, parse_peer_id,
};
use rustls::pki_types::ServerName;
use std::{
    collections::{BTreeMap, HashMap},
    time::Duration,
};
use tokio::{
    io::{Join, join},
    task::JoinSet,
    time::timeout,
};

pub const HOST_ALPN: &[u8] = b"maka/host/v1";
// A negotiated pre-redeem metadata query; the v1 ticket and redemption wire stay unchanged.
pub(crate) const PAIRING_INFO_ALPN: &[u8] = b"maka/host/v1/pairing-info";
pub(crate) const PEER_ACCESS_REVOKED_CODE: u32 = 1;

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
    relay_map: RelayMap,
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
            .relay_mode(RelayMode::Custom(map.clone()))
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
            relay_map: map,
        })
    }

    /// Prompt discovery to refresh after a route change or app suspension.
    pub async fn network_change(&self) {
        self.endpoint.network_change().await;
    }

    pub async fn connect(&self, host_key: &DevicePublicKey) -> Result<PeerConnection> {
        let dial = self.connect_via(
            host_key,
            self.routes.keys().cloned().map(TransportAddr::Relay),
            ConnectOptions::default(),
        );
        let mut home = self.endpoint.home_relay_status();
        let mut rejected = BTreeMap::new();
        let no_home = self.check_relays_without_home();
        let result = async {
            tokio::pin!(dial);
            tokio::pin!(no_home);
            let mut statuses = home.get();
            let mut checked_without_home = false;
            loop {
                for status in &statuses {
                    let url = status.url();
                    if !self.routes.contains_key(url)
                        || rejected.contains_key(url)
                        || !relay_auth_denied(status)
                    {
                        continue;
                    }
                    if rejected.len() + 1 == self.routes.len() {
                        return Err(Box::new(RelayAuthRejected) as _);
                    }
                    // iroh reports one home per transport. Remove only a
                    // confirmed rejection so discovery can select the next home.
                    if let Some(config) = self.endpoint.remove_relay(url).await {
                        rejected.insert(url.clone(), config);
                    }
                }
                tokio::select! {
                    biased;
                    update = home.updated() => statuses = update.map_err(|_| "relay status watcher closed")?,
                    result = &mut dial => return result,
                    denied = &mut no_home, if !checked_without_home => {
                        if denied? {
                            return Err(Box::new(RelayAuthRejected) as _);
                        }
                        checked_without_home = true;
                    }
                }
            }
        }.await;
        for (url, config) in rejected {
            self.endpoint.insert_relay(url, config).await;
        }
        result
    }

    async fn check_relays_without_home(&self) -> Result<bool> {
        let mut reports = self.endpoint.net_report();
        let mut report = reports.get();
        while !report.is_some_and(|report| report.preferred_relay.is_none()) {
            report = reports.updated().await?;
        }
        // iroh does not publish errors from non-home relay connections.
        // Failed latency probes are not auth evidence: try an actual relay dial
        // with the same credentials and TLS policy for each unconfirmed route.
        let dns = self.endpoint.dns_resolver()?;
        let relays = self.relay_map.relays::<Vec<_>>();
        if relays.is_empty() {
            return Ok(false);
        }
        let mut checks = JoinSet::new();
        for relay in relays {
            let mut client = ClientBuilder::new(
                relay.url.clone(),
                self.endpoint.secret_key().clone(),
                dns.clone(),
            )
            .tls_client_config(self.endpoint.tls_config().clone());
            if let Some(token) = &relay.auth_token {
                client = client.auth_token(token);
            }
            checks.spawn(async move {
                matches!(
                    timeout(Duration::from_secs(10), client.connect()).await,
                    Ok(Err(error)) if relay_http_auth_denied(&error)
                        || matches!(
                            error,
                            RelayConnectError::Handshake {
                                source: iroh_relay::protos::handshake::Error::ServerDeniedAuth { .. },
                                ..
                            }
                        )
                )
            });
        }
        while let Some(denied) = checks.join_next().await {
            if !denied? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn connect_via(
        &self,
        host_key: &DevicePublicKey,
        addresses: impl IntoIterator<Item = TransportAddr>,
        options: ConnectOptions,
    ) -> Result<PeerConnection> {
        let expected = EndpointId::from_bytes(host_key.as_bytes())?;
        let target = EndpointAddr::new(expected).with_addrs(addresses);
        // Dial immediately. Waiting for online here would serialize the relay
        // handshake behind local UDP address discovery on a cold endpoint.
        let dial = async {
            let connecting = self
                .endpoint
                .connect_with_opts(target, HOST_ALPN, options)
                .await?;
            Ok::<_, ConnectError>(connecting.await?)
        };
        let conn = dial
            .await
            .map_err(|cause| -> Box<dyn std::error::Error + Send + Sync> {
                match &cause {
                    ConnectError::Connection { source, .. }
                    | ConnectError::Connecting {
                        source: ConnectingError::ConnectionError { source, .. },
                        ..
                    } if is_peer_access_revoked(source) => Box::new(PeerAccessRevoked),
                    _ => Box::new(cause),
                }
            })?;
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
        self.connect_via(
            &parse_peer_id(&payload.host_peer_id)?,
            routes,
            ConnectOptions::new().with_additional_alpns(vec![PAIRING_INFO_ALPN.to_vec()]),
        )
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
        let mut home = self.endpoint.home_relay_status();
        let mut reports = self.endpoint.net_report();
        let mut report = reports.get();
        let mut rejected = BTreeMap::new();
        let mut authentication_rejected = false;
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
                break Err(if authentication_rejected {
                    relay_auth_rejected()
                } else {
                    "relay network probe failed; check connectivity and TLS trust".into()
                });
            }
            for status in &statuses {
                let url = status.url();
                if rejected.contains_key(url) {
                    continue;
                }
                if status.last_error().is_none() {
                    continue;
                }
                // Neither upstream error chains nor auth denial reasons are safe to display.
                authentication_rejected |= relay_auth_denied(status);
                if self.routes.len() == rejected.len() + 1 {
                    break 'registration Err(if authentication_rejected {
                        relay_auth_rejected()
                    } else {
                        "relay connection failed; check connectivity and TLS trust".into()
                    });
                }
                // A failed home registration can win the network probe. Let
                // iroh select another home, then restore this candidate.
                if let Some(config) = self.endpoint.remove_relay(url).await {
                    rejected.insert(url.clone(), config);
                }
            }
            tokio::select! {
                () = self.endpoint.closed() => return Err("peer endpoint closed before relay registration".into()),
                update = home.updated() => { update.map_err(|_| "relay status watcher closed")?; }
                update = reports.updated() => report = update.map_err(|_| "relay network watcher closed")?,
            };
        };
        for (url, config) in rejected {
            self.endpoint.insert_relay(url, config).await;
        }
        ready
    }
}

fn relay_auth_denied(status: &iroh::endpoint::RelayStatus) -> bool {
    status.auth_denied_reason().is_some()
        || status
            .last_error()
            .is_some_and(|error| relay_http_auth_denied(error))
}

fn relay_http_auth_denied(error: &(dyn std::error::Error + 'static)) -> bool {
    use tokio_websockets::upgrade::Error::DidNotSwitchProtocols;

    // The WebSocket library can reject an upgrade before iroh sees a response.
    let mut cause = Some(error);
    while let Some(error) = cause {
        if matches!(error.downcast_ref(), Some(DidNotSwitchProtocols(401 | 403)))
            || matches!(
                error.downcast_ref::<RelayConnectError>(),
                Some(RelayConnectError::UnexpectedUpgradeStatus { code, .. })
                    if matches!(code.as_u16(), 401 | 403)
            )
        {
            return true;
        }
        cause = error.source();
    }
    false
}

/// The configured relay routes rejected the endpoint's authorization.
#[derive(Debug)]
pub struct RelayAuthRejected;

impl std::fmt::Display for RelayAuthRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("relay rejected authentication (missing or invalid relay Bearer token, or relay policy denied access)")
    }
}

impl std::error::Error for RelayAuthRejected {}

#[cfg(feature = "host")]
fn relay_auth_rejected() -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(RelayAuthRejected)
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

    pub fn supports_pairing_info(&self) -> bool {
        self.conn.alpn() == PAIRING_INFO_ALPN
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

    pub fn access_revoked(&self) -> bool {
        self.conn
            .close_reason()
            .as_ref()
            .is_some_and(is_peer_access_revoked)
    }

    pub async fn closed(&self) -> iroh::endpoint::ConnectionError {
        self.conn.closed().await
    }
}

#[derive(Debug)]
pub struct PeerAccessRevoked;

impl std::fmt::Display for PeerAccessRevoked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("peer access revoked")
    }
}

impl std::error::Error for PeerAccessRevoked {}

fn is_peer_access_revoked(error: &ConnectionError) -> bool {
    let ConnectionError::ApplicationClosed(close) = error else {
        return false;
    };
    let code = u64::from(close.error_code);
    code == u64::from(PEER_ACCESS_REVOKED_CODE)
        // Hosts predating the dedicated code used these exact application-close frames.
        || (code == 0 && matches!(close.reason.as_ref(),
            b"peer access revoked" | b"peer access revoked during handshake"))
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
                relay_map: RelayMap::empty(),
            };
            let dial = client.connect_via(
                &target,
                [TransportAddr::Ip(imposter.bound_sockets()[0])],
                ConnectOptions::default(),
            );
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
