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

use iroh_relay::tls::CaTlsConfig;
use rustls::{
    CertificateError, DigitallySignedStruct, Error, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
    server::ParsedCertificate,
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io, sync::Arc};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum TlsTrust {
    #[default]
    System,
    CaDer(Vec<u8>),
    /// Trust this exact leaf and require proof of possession and a matching hostname.
    /// This substitutes for PKI chain validation, not validity dates.
    LeafSha256([u8; 32]),
}

pub(crate) fn ca_config(trust: HashMap<ServerName<'static>, TlsTrust>) -> CaTlsConfig {
    CaTlsConfig::custom_server_cert_verifier(Arc::new(move |provider| {
        let policies = trust
            .iter()
            .map(|(name, trust)| {
                let policy = match trust {
                    TlsTrust::System => {
                        Verify::Pki(CaTlsConfig::system().server_cert_verifier(provider.clone())?)
                    }
                    TlsTrust::CaDer(der) => Verify::Pki(
                        CaTlsConfig::custom_roots([CertificateDer::from(der.clone())])
                            .server_cert_verifier(provider.clone())?,
                    ),
                    TlsTrust::LeafSha256(pin) => Verify::Pin(*pin),
                };
                Ok((name.clone(), policy))
            })
            .collect::<io::Result<_>>()?;
        Ok(Arc::new(Verifier { policies, provider }))
    }))
}

#[derive(Debug)]
enum Verify {
    Pki(Arc<dyn ServerCertVerifier>),
    Pin([u8; 32]),
}

#[derive(Debug)]
struct Verifier {
    policies: HashMap<ServerName<'static>, Verify>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
        name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let rejected = Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure);
        match self.policies.get(name).ok_or(rejected.clone())? {
            Verify::Pki(verifier) => verifier.verify_server_cert(leaf, chain, name, ocsp, now),
            Verify::Pin(pin) => {
                let digest: [u8; 32] = Sha256::digest(leaf.as_ref()).into();
                if digest != *pin {
                    return Err(rejected);
                }
                let (_, cert) = x509_parser::parse_x509_certificate(leaf.as_ref())
                    .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;
                let validity = cert.validity();
                let now = i128::from(now.as_secs());
                if now < i128::from(validity.not_before.timestamp()) {
                    return Err(Error::InvalidCertificate(CertificateError::NotValidYet));
                }
                if now > i128::from(validity.not_after.timestamp()) {
                    return Err(Error::InvalidCertificate(CertificateError::Expired));
                }
                rustls::client::verify_server_name(&ParsedCertificate::try_from(leaf)?, name)?;
                Ok(ServerCertVerified::assertion())
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        msg: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            msg,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        msg: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            msg,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub(crate) fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

pub(crate) fn server_name(
    url: &url::Url,
) -> Result<ServerName<'static>, rustls::pki_types::InvalidDnsNameError> {
    Ok(match url.host().expect("validated URL has a host") {
        url::Host::Domain(host) => ServerName::try_from(host.to_owned())?,
        url::Host::Ipv4(ip) => std::net::IpAddr::V4(ip).into(),
        url::Host::Ipv6(ip) => std::net::IpAddr::V6(ip).into(),
    })
}
