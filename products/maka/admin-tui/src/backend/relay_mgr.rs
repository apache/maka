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

use crate::model::{LocalRelayConfig, LocalRelayRuntime, LocalRelayState, RelayTlsMode};
use jiff::Timestamp;
use maka_remote_transport::server::{RelayServer, RelayTls};
use std::{net::SocketAddr, path::PathBuf, time::Instant};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub struct RunningRelay {
    cancel: CancellationToken,
    task: JoinHandle<Result<(), String>>,
    started: Instant,
    started_at: String,
    http_addr: Option<SocketAddr>,
    https_addr: Option<SocketAddr>,
    quic_addr: Option<SocketAddr>,
    cert_sha256: Option<String>,
    auth_token: Option<String>,
    endpoint_url: String,
    cli_command: String,
}

pub struct RunningRelayEndpoint {
    pub url: String,
    pub quic_port: Option<u16>,
    pub cert_sha256: Option<String>,
    pub auth_token: Option<String>,
}

#[derive(Default)]
pub struct RelayManager {
    config: LocalRelayConfig,
    running: Option<RunningRelay>,
    last_error: Option<String>,
}

impl RelayManager {
    pub fn config(&self) -> &LocalRelayConfig {
        &self.config
    }

    pub fn set_generated_token(&mut self) -> String {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        self.config.auth_token = token.clone();
        token
    }

    pub fn current_auth_token(&self) -> Option<String> {
        self.running
            .as_ref()
            .and_then(|r| r.auth_token.clone())
            .or_else(|| {
                let t = self.config.auth_token.trim();
                (!t.is_empty()).then(|| t.to_owned())
            })
    }

    pub fn state(&mut self) -> LocalRelayState {
        if let Some(running) = &self.running
            && running.task.is_finished()
        {
            let finished = self.running.take().unwrap();
            let err = match finished.task.now_or_never() {
                Some(Ok(Err(message))) => message,
                Some(Err(join_err)) => format!("relay task aborted: {join_err}"),
                _ => "relay server exited unexpectedly".to_owned(),
            };
            self.last_error = Some(err);
        }

        if let Some(running) = &self.running {
            LocalRelayState::Running(LocalRelayRuntime {
                http_addr: running.http_addr.map(|a| a.to_string()),
                https_addr: running.https_addr.map(|a| a.to_string()),
                quic_addr: running.quic_addr.map(|a| a.to_string()),
                cert_sha256: running.cert_sha256.clone(),
                has_auth_token: running.auth_token.is_some(),
                started_at: running.started_at.clone(),
                uptime_secs: running.started.elapsed().as_secs(),
                endpoint_url: running.endpoint_url.clone(),
                cli_command: running.cli_command.clone(),
            })
        } else if let Some(message) = &self.last_error {
            LocalRelayState::Error {
                message: message.clone(),
            }
        } else {
            LocalRelayState::Stopped
        }
    }

    pub fn running_endpoint(&self) -> Option<RunningRelayEndpoint> {
        let running = self.running.as_ref()?;
        Some(RunningRelayEndpoint {
            url: running.endpoint_url.clone(),
            quic_port: running.quic_addr.map(|a| a.port()),
            cert_sha256: running.cert_sha256.clone(),
            auth_token: running.auth_token.clone(),
        })
    }

    pub async fn start(&mut self, config: LocalRelayConfig) -> Result<LocalRelayRuntime, String> {
        self.stop().await;
        self.config = config.clone();
        self.last_error = None;

        let http = parse_opt_addr("HTTP listener", &config.http_addr)?;
        let https = parse_opt_addr("HTTPS listener", &config.https_addr)?;
        let quic = parse_opt_addr("QUIC listener", &config.quic_addr)?;

        if http.is_none() && https.is_none() {
            let err = "Specify at least one HTTP or HTTPS bind address".to_owned();
            self.last_error = Some(err.clone());
            return Err(err);
        }

        let credentials = match config.tls_mode {
            RelayTlsMode::None => {
                if https.is_some() || quic.is_some() {
                    let err = "HTTPS or QUIC listeners require Self-Signed or PEM TLS".to_owned();
                    self.last_error = Some(err.clone());
                    return Err(err);
                }
                None
            }
            RelayTlsMode::SelfSigned => {
                let sans: Vec<String> = config
                    .tls_sans
                    .split([',', ' '])
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect();
                if sans.is_empty() {
                    let err =
                        "Self-signed TLS requires at least one SAN (e.g. localhost,127.0.0.1)"
                            .to_owned();
                    self.last_error = Some(err.clone());
                    return Err(err);
                }
                Some(RelayTls::self_signed(sans).map_err(|e| {
                    let msg = e.to_string();
                    self.last_error = Some(msg.clone());
                    msg
                })?)
            }
            RelayTlsMode::Pem => {
                let cert_path = PathBuf::from(config.tls_cert_path.trim());
                let key_path = PathBuf::from(config.tls_key_path.trim());
                if cert_path.as_os_str().is_empty() || key_path.as_os_str().is_empty() {
                    let err = "PEM mode requires both certificate and key paths".to_owned();
                    self.last_error = Some(err.clone());
                    return Err(err);
                }
                let cert_bytes = tokio::fs::read(&cert_path).await.map_err(|e| {
                    let msg = format!("cannot read TLS cert {}: {e}", cert_path.display());
                    self.last_error = Some(msg.clone());
                    msg
                })?;
                let key_bytes = tokio::fs::read(&key_path).await.map_err(|e| {
                    let msg = format!("cannot read TLS key {}: {e}", key_path.display());
                    self.last_error = Some(msg.clone());
                    msg
                })?;
                Some(RelayTls::from_pem(&cert_bytes, &key_bytes).map_err(|e| {
                    let msg = e.to_string();
                    self.last_error = Some(msg.clone());
                    msg
                })?)
            }
        };

        let token = {
            let trimmed = config.auth_token.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        };

        let mut server =
            RelayServer::bind(http, https, quic, credentials.as_ref(), token.as_deref())
                .await
                .map_err(|e| {
                    let msg = e.to_string();
                    self.last_error = Some(msg.clone());
                    msg
                })?;

        let bound_http = server.http_addr();
        let bound_https = server.https_addr();
        let bound_quic = server.quic_addr();
        let cert_sha256 = server.cert_sha256().map(hex::encode);

        let endpoint_url = if let Some(addr) = bound_https {
            format!("https://{}/", display_connect_addr(addr))
        } else if let Some(addr) = bound_http {
            format!("http://{}/", display_connect_addr(addr))
        } else {
            String::new()
        };

        let cli_command = build_cli_command(&config);
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            let result = tokio::select! {
                () = task_cancel.cancelled() => server.shutdown().await,
                result = server.join() => result,
            };
            result.map_err(|e| e.to_string())
        });

        let started_at = Timestamp::now().strftime("%H:%M:%S UTC").to_string();
        let running = RunningRelay {
            cancel,
            task,
            started: Instant::now(),
            started_at: started_at.clone(),
            http_addr: bound_http,
            https_addr: bound_https,
            quic_addr: bound_quic,
            cert_sha256: cert_sha256.clone(),
            auth_token: token.clone(),
            endpoint_url: endpoint_url.clone(),
            cli_command: cli_command.clone(),
        };
        self.running = Some(running);

        Ok(LocalRelayRuntime {
            http_addr: bound_http.map(|a| a.to_string()),
            https_addr: bound_https.map(|a| a.to_string()),
            quic_addr: bound_quic.map(|a| a.to_string()),
            cert_sha256,
            has_auth_token: token.is_some(),
            started_at,
            uptime_secs: 0,
            endpoint_url,
            cli_command,
        })
    }

    pub async fn stop(&mut self) {
        if let Some(running) = self.running.take() {
            running.cancel.cancel();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), running.task).await;
        }
    }
}

fn parse_opt_addr(label: &str, raw: &str) -> Result<Option<SocketAddr>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    trimmed
        .parse::<SocketAddr>()
        .map(Some)
        .map_err(|e| format!("invalid {label} '{trimmed}': {e}"))
}

fn display_connect_addr(addr: SocketAddr) -> String {
    if addr.ip().is_unspecified() {
        format!("127.0.0.1:{}", addr.port())
    } else {
        addr.to_string()
    }
}

pub fn build_cli_command(config: &LocalRelayConfig) -> String {
    let mut parts = vec!["maka".to_owned(), "relay".to_owned()];
    if !config.http_addr.trim().is_empty() {
        parts.push("--http".to_owned());
        parts.push(config.http_addr.trim().to_owned());
    }
    if !config.https_addr.trim().is_empty() {
        parts.push("--https".to_owned());
        parts.push(config.https_addr.trim().to_owned());
    }
    if !config.quic_addr.trim().is_empty() {
        parts.push("--quic".to_owned());
        parts.push(config.quic_addr.trim().to_owned());
    }
    match config.tls_mode {
        RelayTlsMode::None => {}
        RelayTlsMode::SelfSigned => {
            parts.push("--self-signed".to_owned());
            for san in config
                .tls_sans
                .split([',', ' '])
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                parts.push("--tls-san".to_owned());
                parts.push(san.to_owned());
            }
        }
        RelayTlsMode::Pem => {
            if !config.tls_cert_path.trim().is_empty() {
                parts.push("--tls-cert".to_owned());
                parts.push(config.tls_cert_path.trim().to_owned());
            }
            if !config.tls_key_path.trim().is_empty() {
                parts.push("--tls-key".to_owned());
                parts.push(config.tls_key_path.trim().to_owned());
            }
        }
    }
    if !config.auth_token.trim().is_empty() {
        parts.push("--auth-token-env".to_owned());
        parts.push("MAKA_RELAY_TOKEN".to_owned());
    }
    parts.join(" ")
}

trait NowOrNeverExt<T> {
    fn now_or_never(self) -> Option<T>;
}

impl<T> NowOrNeverExt<Result<T, tokio::task::JoinError>> for JoinHandle<T> {
    fn now_or_never(self) -> Option<Result<T, tokio::task::JoinError>> {
        use std::task::{Context, Poll, Waker};
        let mut handle = self;
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
        match std::pin::Pin::new(&mut handle).poll(&mut cx) {
            Poll::Ready(value) => Some(value),
            Poll::Pending => None,
        }
    }
}
