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

use clap::Args;
use maka_host_runtime::HostError;
use maka_remote_transport::server::{RelayServer, RelayTls};
use std::{net::SocketAddr, path::PathBuf};
use tokio_util::sync::CancellationToken;

#[derive(Args)]
pub(super) struct Relay {
    /// Plain HTTP relay listener, typically behind a TLS proxy.
    #[arg(long)]
    http: Option<SocketAddr>,
    /// Relay listener with TLS.
    #[arg(long)]
    https: Option<SocketAddr>,
    /// UDP listener for QUIC Address Discovery.
    #[arg(long)]
    quic: Option<SocketAddr>,
    #[arg(long, requires = "tls_key", conflicts_with = "self_signed")]
    tls_cert: Option<PathBuf>,
    #[arg(long, requires = "tls_cert", conflicts_with = "self_signed")]
    tls_key: Option<PathBuf>,
    /// Generate a new TLS certificate on each start.
    #[arg(long, requires = "tls_san")]
    self_signed: bool,
    /// DNS name or IP address covered by the self-signed certificate (repeatable).
    #[arg(long, requires = "self_signed")]
    tls_san: Vec<String>,
    #[arg(long, requires = "self_signed")]
    cert_der_out: Option<PathBuf>,
    #[arg(long, conflicts_with = "auth_token_env")]
    auth_token: Option<String>,
    /// Read the relay Bearer token from this environment variable.
    #[arg(long)]
    auth_token_env: Option<String>,
}

impl Relay {
    pub async fn run(self) -> Result<(), HostError> {
        let cancel = CancellationToken::new();
        let _signals = crate::signals::watch(cancel.clone())?;
        let credentials = match (self.self_signed, self.tls_cert.zip(self.tls_key)) {
            (true, _) => Some(RelayTls::self_signed(self.tls_san)?),
            (false, Some((cert, key))) => Some(RelayTls::from_pem(
                &tokio::fs::read(cert).await?,
                &tokio::fs::read(key).await?,
            )?),
            (false, None) => None,
        };
        let token = bearer(self.auth_token, self.auth_token_env)?;
        let mut server = RelayServer::bind(
            self.http,
            self.https,
            self.quic,
            credentials.as_ref(),
            token.as_deref(),
        )
        .await?;
        if let Some(path) = self.cert_der_out {
            let cert = credentials.as_ref().expect("clap requires --self-signed");
            if let Err(error) = tokio::fs::write(path, cert.certificate_der()).await {
                return Err::<(), HostError>(error.into()).and(server.shutdown().await);
            }
        }
        println!(
            "{}",
            serde_json::json!({
                "kind": "ready",
                "httpAddr": server.http_addr(),
                "httpsAddr": server.https_addr(),
                "quicAddr": server.quic_addr(),
                "certSha256": server.cert_sha256().map(hex::encode),
            })
        );
        tokio::select! {
            () = cancel.cancelled() => server.shutdown().await,
            result = server.join() => result,
        }
    }
}

pub(super) fn bearer(
    token: Option<String>,
    variable: Option<String>,
) -> Result<Option<String>, HostError> {
    match variable {
        Some(name) => Ok(Some(std::env::var(&name).map_err(|error| {
            std::io::Error::other(format!(
                "cannot read relay Bearer token from {name}: {error}"
            ))
        })?)),
        None => Ok(token),
    }
}
