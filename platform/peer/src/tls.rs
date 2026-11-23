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

//! Mutual Ed25519 TLS 1.3 authentication using RFC 7250 Raw Public Keys (RPK).
//!
//! Both direct QUIC peer connections and end-to-end encrypted transit tunnels
//! inside `A -> C -> B` mesh relays share this exact TLS 1.3 configuration so
//! neither X.509 certificate synthesis nor wall-clock certificate expiration
//! exists in peer authentication, and relay nodes cannot inspect or spoof
//! application traffic.

use crate::identity::{ED25519_PUBLIC_KEY_LEN, IdentityError, NodeIdentity, PeerId};
use aws_lc_rs::signature::{ED25519, UnparsedPublicKey};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName, Error as TlsError,
    OtherError, PeerIncompatible, ServerConfig, SignatureAlgorithm, SignatureScheme,
    client::{
        AlwaysResolvesClientRawPublicKeys,
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    },
    crypto::aws_lc_rs as rustls_aws_lc_rs,
    server::{
        AlwaysResolvesServerRawPublicKeys,
        danger::{ClientCertVerified, ClientCertVerifier},
    },
    sign::{CertifiedKey, Signer, SigningKey},
    version::TLS13,
};
use rustls_pki_types::{CertificateDer, ServerName, SubjectPublicKeyInfoDer, UnixTime};
use std::{fmt, io, sync::Arc};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::{TlsAcceptor, TlsConnector, client, server};

/// Fixed 12-byte ASN.1 DER prefix of an RFC 8410 Ed25519 SubjectPublicKeyInfo.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];
const ED25519_SPKI_LEN: usize = ED25519_SPKI_PREFIX.len() + ED25519_PUBLIC_KEY_LEN;

/// Synthetic SNI name required by rustls ClientConfig even when authenticating
/// strictly by RFC 7250 Raw Public Key fingerprint.
pub const PEER_TLS_SERVER_NAME: &str = "maka.peer";

/// Default ALPN protocol for end-to-end TLS 1.3 tunnels inside relayed streams.
pub const E2E_TUNNEL_ALPN: &[u8] = b"maka-peer-e2e/1";

#[derive(Debug, Error)]
pub enum PeerTlsError {
    #[error("TLS configuration error: {0}")]
    Tls(#[from] TlsError),
    #[error("peer TLS I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("peer raw public key error: {0}")]
    Identity(#[from] IdentityError),
    #[error("peer did not present an Ed25519 raw public key")]
    MissingPeerPublicKey,
}

/// Encodes a 32-byte Ed25519 public key as a 44-byte DER SubjectPublicKeyInfo.
pub fn encode_ed25519_spki(public_key: &[u8; ED25519_PUBLIC_KEY_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(ED25519_SPKI_LEN);
    out.extend_from_slice(&ED25519_SPKI_PREFIX);
    out.extend_from_slice(public_key);
    out
}

/// Strictly decodes a 44-byte DER Ed25519 SubjectPublicKeyInfo into raw key bytes.
pub fn decode_ed25519_spki(spki: &[u8]) -> Result<[u8; ED25519_PUBLIC_KEY_LEN], IdentityError> {
    if spki.len() != ED25519_SPKI_LEN || !spki.starts_with(&ED25519_SPKI_PREFIX) {
        return Err(IdentityError::InvalidPublicKey(format!(
            "expected {ED25519_SPKI_LEN}-byte Ed25519 SPKI DER, got {} bytes",
            spki.len()
        )));
    }
    let mut key = [0u8; ED25519_PUBLIC_KEY_LEN];
    key.copy_from_slice(&spki[ED25519_SPKI_PREFIX.len()..]);
    Ok(key)
}

/// Derives the verified `PeerId` from an RFC 7250 raw public key payload.
pub fn peer_id_from_raw_public_key(cert: &CertificateDer<'_>) -> Result<PeerId, IdentityError> {
    let raw = decode_ed25519_spki(cert.as_ref())?;
    PeerId::from_public_key_bytes(&raw)
}

fn verify_ed25519_tls13_signature(
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, TlsError> {
    if dss.scheme != SignatureScheme::ED25519 {
        return Err(TlsError::InvalidCertificate(CertificateError::BadSignature));
    }
    let raw_key = decode_ed25519_spki(cert.as_ref())
        .map_err(|_| TlsError::InvalidCertificate(CertificateError::BadEncoding))?;
    UnparsedPublicKey::new(&ED25519, &raw_key)
        .verify(message, dss.signature())
        .map_err(|_| TlsError::InvalidCertificate(CertificateError::BadSignature))?;
    Ok(HandshakeSignatureValid::assertion())
}

#[derive(Clone)]
struct IdentitySigningKey(NodeIdentity);

impl fmt::Debug for IdentitySigningKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("IdentitySigningKey")
            .field(self.0.peer_id())
            .finish()
    }
}

impl SigningKey for IdentitySigningKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        if offered.contains(&SignatureScheme::ED25519) {
            Some(Box::new(self.clone()))
        } else {
            None
        }
    }

    fn public_key(&self) -> Option<SubjectPublicKeyInfoDer<'_>> {
        Some(SubjectPublicKeyInfoDer::from(encode_ed25519_spki(
            self.0.public_key_bytes(),
        )))
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::ED25519
    }
}

impl Signer for IdentitySigningKey {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, TlsError> {
        Ok(self.0.sign(message).to_vec())
    }

    fn scheme(&self) -> SignatureScheme {
        SignatureScheme::ED25519
    }
}

fn certified_raw_public_key(identity: &NodeIdentity) -> Arc<CertifiedKey> {
    let spki = CertificateDer::from(encode_ed25519_spki(identity.public_key_bytes()));
    let key: Arc<dyn SigningKey> = Arc::new(IdentitySigningKey(identity.clone()));
    Arc::new(CertifiedKey::new(vec![spki], key))
}

#[derive(Debug)]
struct PinnedPeerServerVerifier {
    expected_peer_id: PeerId,
}

impl ServerCertVerifier for PinnedPeerServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        if !intermediates.is_empty() {
            return Err(TlsError::InvalidCertificate(CertificateError::BadEncoding));
        }
        let actual = peer_id_from_raw_public_key(end_entity)
            .map_err(|_| TlsError::InvalidCertificate(CertificateError::BadEncoding))?;
        if actual != self.expected_peer_id {
            return Err(TlsError::InvalidCertificate(CertificateError::Other(
                OtherError(Arc::new(IdentityError::PeerIdMismatch {
                    expected: self.expected_peer_id.clone(),
                    actual,
                })),
            )));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Err(TlsError::PeerIncompatible(PeerIncompatible::Tls12NotOffered))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_ed25519_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

#[derive(Debug)]
struct AuthenticatedPeerClientVerifier {
    expected_peer_id: Option<PeerId>,
}

impl ClientCertVerifier for AuthenticatedPeerClientVerifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, TlsError> {
        if !intermediates.is_empty() {
            return Err(TlsError::InvalidCertificate(CertificateError::BadEncoding));
        }
        let actual = peer_id_from_raw_public_key(end_entity)
            .map_err(|_| TlsError::InvalidCertificate(CertificateError::BadEncoding))?;
        if let Some(expected) = &self.expected_peer_id
            && &actual != expected
        {
            return Err(TlsError::InvalidCertificate(CertificateError::Other(
                OtherError(Arc::new(IdentityError::PeerIdMismatch {
                    expected: expected.clone(),
                    actual,
                })),
            )));
        }
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Err(TlsError::PeerIncompatible(PeerIncompatible::Tls12NotOffered))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_ed25519_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

/// Builds a mutual-Ed25519 TLS 1.3 `ClientConfig` pinned to `expected_peer`.
pub fn build_peer_client_config(
    identity: &NodeIdentity,
    expected_peer: PeerId,
    alpn_protocols: Vec<Vec<u8>>,
) -> Result<ClientConfig, PeerTlsError> {
    let provider = Arc::new(rustls_aws_lc_rs::default_provider());
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedPeerServerVerifier {
            expected_peer_id: expected_peer,
        }))
        .with_client_cert_resolver(Arc::new(AlwaysResolvesClientRawPublicKeys::new(
            certified_raw_public_key(identity),
        )));
    config.alpn_protocols = alpn_protocols;
    Ok(config)
}

/// Builds a mutual-Ed25519 TLS 1.3 `ServerConfig` requiring every connecting
/// peer to cryptographically prove possession of its Ed25519 key.
pub fn build_peer_server_config(
    identity: &NodeIdentity,
    expected_client: Option<PeerId>,
    alpn_protocols: Vec<Vec<u8>>,
) -> Result<ServerConfig, PeerTlsError> {
    let provider = Arc::new(rustls_aws_lc_rs::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&TLS13])?
        .with_client_cert_verifier(Arc::new(AuthenticatedPeerClientVerifier {
            expected_peer_id: expected_client,
        }))
        .with_cert_resolver(Arc::new(AlwaysResolvesServerRawPublicKeys::new(
            certified_raw_public_key(identity),
        )));
    config.alpn_protocols = alpn_protocols;
    Ok(config)
}

/// Upgrades a raw byte pipe (such as an `A -> C -> B` mesh relay circuit) into
/// a mutually-authenticated, end-to-end encrypted TLS 1.3 stream pinned to
/// `expected_peer`.
pub async fn connect_e2e_tls<S>(
    stream: S,
    identity: &NodeIdentity,
    expected_peer: PeerId,
) -> Result<client::TlsStream<S>, PeerTlsError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let config = build_peer_client_config(
        identity,
        expected_peer,
        vec![E2E_TUNNEL_ALPN.to_vec()],
    )?;
    let connector = TlsConnector::from(Arc::new(config));
    let server_name = ServerName::try_from(PEER_TLS_SERVER_NAME)
        .expect("static peer TLS server name must be valid DNS name");
    Ok(connector.connect(server_name, stream).await?)
}

/// Accepts an end-to-end encrypted mutual-Ed25519 TLS 1.3 stream over a raw
/// byte pipe and returns the cryptographically verified remote `PeerId`.
pub async fn accept_e2e_tls<S>(
    stream: S,
    identity: &NodeIdentity,
) -> Result<(PeerId, server::TlsStream<S>), PeerTlsError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let config = build_peer_server_config(identity, None, vec![E2E_TUNNEL_ALPN.to_vec()])?;
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let tls_stream = acceptor.accept(stream).await?;
    let peer_certs = tls_stream
        .get_ref()
        .1
        .peer_certificates()
        .ok_or(PeerTlsError::MissingPeerPublicKey)?;
    let [end_entity] = peer_certs else {
        return Err(PeerTlsError::MissingPeerPublicKey);
    };
    let remote_peer_id = peer_id_from_raw_public_key(end_entity)?;
    Ok((remote_peer_id, tls_stream))
}
