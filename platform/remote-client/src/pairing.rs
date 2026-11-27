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

use crate::{
    DeviceIdentity, HostProfile, PathSummary, RemoteClientError, RemoteHostConnection,
    client::redeem_pairing_invite, link::Link,
};
use maka_remote_pairing::{RelayEndpoint, SignedPairingTicket, parse_peer_id};
use maka_remote_transport::{PeerEndpoint, Relay};

/// A Bearer scoped to a single signed relay URL. Never serialized into the
/// profile or forwarded to other relays.
pub struct RelayAuthorization<'a> {
    pub relay_url: &'a str,
    pub bearer: &'a str,
}

pub struct PendingPairing {
    ticket: SignedPairingTicket,
    profile: HostProfile,
    link: Link,
    local_peer_id: String,
    sas: String,
}

impl PendingPairing {
    /// Verify the ticket and establish authenticated QUIC. Does not disclose
    /// the invitation secret to the Host until confirmation.
    pub async fn begin(
        identity: &DeviceIdentity,
        uri: &str,
        now_ms: u64,
        authorization: Option<RelayAuthorization<'_>>,
        saved: &crate::SavedHosts,
    ) -> Result<Self, RemoteClientError> {
        let ticket = SignedPairingTicket::parse_and_verify_uri(uri, now_ms)?;
        let payload = ticket.payload();
        let profile = HostProfile::from_ticket(payload);
        saved.check_host_key(&profile)?;
        let endpoint = bind(identity, &payload.relays, authorization).await?;
        let connection = endpoint
            .connect_ticket(&ticket)
            .await
            .map_err(RemoteClientError::Transport)?;
        let sas = connection
            .export_sas()
            .map_err(RemoteClientError::Transport)?;
        Ok(Self {
            ticket,
            profile,
            link: Link::peer(endpoint, connection),
            local_peer_id: identity.public_key().to_string(),
            sas,
        })
    }

    pub fn root_id(&self) -> &str {
        self.profile.root_id()
    }

    pub fn host_name(&self) -> &str {
        self.profile.host_name()
    }

    pub fn host_peer_id(&self) -> &str {
        self.profile.host_peer_id()
    }

    pub fn sas(&self) -> &str {
        &self.sas
    }

    pub fn path_summary(&self) -> Option<PathSummary> {
        self.link.path_summary()
    }

    /// Redeem only after the user has checked the code on the authenticated
    /// Host. There is no redial between code export, redemption and admission.
    pub async fn confirm(
        self,
        verified_sas: &str,
        device_label: Option<String>,
    ) -> Result<(HostProfile, RemoteHostConnection), RemoteClientError> {
        self.redeem(verified_sas, device_label).await?.admit().await
    }

    /// Verify the redemption receipt without opening a Host anchor yet.
    pub async fn redeem(
        self,
        verified_sas: &str,
        device_label: Option<String>,
    ) -> Result<RedeemedPairing, RemoteClientError> {
        if self.sas != verified_sas {
            return Err(RemoteClientError::Protocol(
                "pairing code does not match".into(),
            ));
        }
        let receipt = redeem_pairing_invite(
            &self.link,
            self.ticket.payload().invite_secret.clone(),
            device_label,
        )
        .await?;
        if receipt.root_id != self.profile.root_id() || receipt.peer_id != self.local_peer_id {
            return Err(RemoteClientError::Protocol(
                "pairing receipt does not match the verified Host and device".into(),
            ));
        }
        Ok(RedeemedPairing {
            profile: self.profile,
            link: self.link,
            local_peer_id: self.local_peer_id,
        })
    }
}

/// An acknowledged pairing, holding the same authenticated QUIC connection
/// used to export the SAS and redeem the invitation.
pub struct RedeemedPairing {
    profile: HostProfile,
    link: Link,
    local_peer_id: String,
}

impl RedeemedPairing {
    pub fn profile(&self) -> &HostProfile {
        &self.profile
    }

    pub async fn admit(self) -> Result<(HostProfile, RemoteHostConnection), RemoteClientError> {
        let connection = RemoteHostConnection::connect(
            self.link,
            self.profile.root_id(),
            self.local_peer_id.into(),
        )
        .await?;
        Ok((self.profile, connection))
    }
}

impl HostProfile {
    /// Establish a new transport and anchor. Callers resume subscriptions from
    /// their last observed event cursor rather than replaying transport bytes.
    pub async fn reconnect(
        &self,
        identity: &DeviceIdentity,
        authorization: Option<RelayAuthorization<'_>>,
    ) -> Result<RemoteHostConnection, RemoteClientError> {
        let host_key = parse_peer_id(self.host_peer_id())?;
        let endpoint = bind(identity, self.relays(), authorization).await?;
        let connection = endpoint.connect(&host_key).await.map_err(|cause| {
            if cause.is::<maka_remote_transport::PeerAccessRevoked>() {
                return RemoteClientError::PeerAccessRevoked;
            }
            match cause.downcast::<maka_remote_transport::RelayAuthRejected>() {
                Ok(auth) => RemoteClientError::RelayAuth(*auth),
                Err(cause) => RemoteClientError::Transport(cause),
            }
        })?;
        RemoteHostConnection::connect(
            Link::peer(endpoint, connection),
            self.root_id(),
            identity.public_key().to_string().into(),
        )
        .await
    }
}

async fn bind(
    identity: &DeviceIdentity,
    routes: &[RelayEndpoint],
    authorization: Option<RelayAuthorization<'_>>,
) -> Result<PeerEndpoint, RemoteClientError> {
    if routes.is_empty() {
        return Err(RemoteClientError::NoNativeRoute);
    }
    let canonical = |value: &str| {
        maka_remote_pairing::RelayEndpoint {
            url: value.to_owned(),
            quic_port: None,
            cert_sha256: None,
        }
        .validate()
        .map(|route| route.url)
        .map_err(|error| RemoteClientError::Protocol(error.to_string()))
    };
    let authorized = authorization
        .as_ref()
        .map(|auth| canonical(auth.relay_url))
        .transpose()?;
    let mut matched = false;
    let mut relays = Vec::with_capacity(routes.len());
    for route in routes {
        let bearer = if authorized.as_ref() == Some(&canonical(&route.url)?) {
            matched = true;
            authorization.as_ref().map(|auth| auth.bearer.to_owned())
        } else {
            None
        };
        relays.push(Relay::new(route, None, bearer).map_err(RemoteClientError::Transport)?);
    }
    if authorized.is_some() && !matched {
        return Err(RemoteClientError::Protocol(
            "relay authorization has no matching route".into(),
        ));
    }
    PeerEndpoint::bind(identity, &relays, false)
        .await
        .map_err(RemoteClientError::Transport)
}
