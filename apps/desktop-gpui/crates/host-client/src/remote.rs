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

//! Connecting to a remote Runtime Host through its profile's transport, and
//! pairing with a pending credential.
//!
//! Mirrors `connectRemoteRuntimeHostProfile` in
//! `packages/runtime-host/src/client/host-profile.ts`: TLS and plaintext
//! profiles open the WebSocket directly; an SSH profile opens a `-L` forward
//! first, after running the operator activation when the profile has one; a
//! Direct peer profile is refused. The handshake after the transport is the
//! local one (`crate::Connection`), pinned to the profile's State Root.
//!
//! Pairing mirrors `#finalizeAccessCredential` in Desktop's
//! `apps/desktop/src/main/runtime-host-desktop-manager.ts`: connect with the
//! pending credential, wait for `ready`, finalize, and when the Host answers
//! `reconnectRequired` connect again with the same credential, now active. A
//! lost connection or `commit_outcome_unknown` is retried on a new
//! connection, because finalizing is idempotent for the current credential.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use async_io::Timer;
use futures_lite::future;
use host_protocol::{
    AccessCredential, AccessCredentialFinalize, AccessCredentialFinalizeInput,
    AccessCredentialFinalizeResult, ClientHello, HostOperationErrorCode, HostStatus,
    HostStatusResult, Operation as _, RemoteTransport, RemoteTransportKind, SshEndpoint,
};
use thiserror::Error;

use crate::connection::until;
use crate::profiles::RemoteHostProfile;
use crate::ssh::{self, SshError};
use crate::supervisor::Identity;
use crate::{
    AttemptError, AttemptReporter, ConnectError, ConnectOptions, Connected, Connection,
    ConnectionPump, HostConnector, RequestError,
};

/// How long a connection being replaced may take to close.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// The wait between pairing attempts after a lost connection.
const RETRY_DELAY: Duration = Duration::from_millis(250);

/// Options for [`connect_remote`] and [`pair_remote_host`].
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct RemoteConnectOptions {
    /// Budget for the WebSocket (TCP, TLS, upgrade) and the handshake. SSH
    /// setup has its own limits: 15 s for the forward, 120 s for an
    /// operator activation.
    pub timeout: Duration,
    /// The OpenSSH client to run; `ssh` on `PATH` by default.
    pub ssh_program: PathBuf,
}

impl Default for RemoteConnectOptions {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(10), ssh_program: PathBuf::from("ssh") }
    }
}

impl RemoteConnectOptions {
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_ssh_program(mut self, program: impl Into<PathBuf>) -> Self {
        self.ssh_program = program.into();
        self
    }
}

/// Why a remote connection attempt failed.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum RemoteConnectError {
    /// The profile's transport is one this client cannot use yet.
    #[error("{}", unsupported_transport(*.0))]
    UnsupportedTransport(RemoteTransportKind),
    #[error(transparent)]
    Ssh(#[from] SshError),
    #[error(transparent)]
    Connect(#[from] ConnectError),
}

impl RemoteConnectError {
    /// Whether retrying without a user decision is pointless: an unusable
    /// transport, a refused credential, or a Host that will not serve this
    /// client. SSH failures are retried, as Desktop retries them.
    pub fn is_permanent(&self) -> bool {
        match self {
            Self::UnsupportedTransport(_) => true,
            Self::Ssh(_) => false,
            Self::Connect(error) => error.is_permanent(),
        }
    }
}

fn unsupported_transport(kind: RemoteTransportKind) -> &'static str {
    match kind {
        RemoteTransportKind::DirectPeer => {
            "Direct peer (libp2p) Runtime Hosts are not supported by this client yet"
        }
        _ => "this Runtime Host transport is not supported by this client yet",
    }
}

/// Connects to the Host `profile` names and completes the handshake. The
/// Host must serve the profile's State Root. Readiness is the caller's to
/// wait for, as with [`Connection::connect`].
pub async fn connect_remote(
    profile: &RemoteHostProfile,
    credential: &AccessCredential,
    hello: ClientHello,
    options: &RemoteConnectOptions,
) -> Result<Connected, RemoteConnectError> {
    let connect_options = ConnectOptions::default()
        .with_timeout(options.timeout)
        .with_expected_root_id(profile.root_id());
    match profile.transport() {
        RemoteTransport::Tls(url) | RemoteTransport::Plaintext(url) => {
            Ok(Box::pin(Connection::connect_websocket(url, credential, hello, connect_options))
                .await?)
        }
        RemoteTransport::Ssh(transport) => {
            let program = &options.ssh_program;
            let (remote_port, websocket_path) = match transport.endpoint() {
                SshEndpoint::Forward { remote_port, websocket_path, .. } => {
                    (*remote_port, websocket_path.clone())
                }
                SshEndpoint::Operator(operator) => {
                    let activated = Box::pin(ssh::activate_operator(
                        program,
                        transport.destination(),
                        transport.ssh_port(),
                        operator,
                        profile.root_id(),
                    ))
                    .await?;
                    (activated.endpoint.port, activated.endpoint.websocket_path)
                }
            };
            let (tunnel, url) = Box::pin(ssh::open_tunnel(
                program,
                transport.destination(),
                transport.ssh_port(),
                remote_port,
                &websocket_path,
            ))
            .await?;
            Ok(Box::pin(Connection::connect_websocket_through(
                &url,
                credential,
                Some(tunnel),
                hello,
                connect_options,
            ))
            .await?)
        }
        other => Err(RemoteConnectError::UnsupportedTransport(other.kind())),
    }
}

/// Connects to the Host of a remote profile on every attempt of a
/// supervised connection ([`crate::supervise`]).
#[derive(Debug)]
pub struct RemoteConnector {
    profile: RemoteHostProfile,
    credential: AccessCredential,
    identity: Identity,
    options: RemoteConnectOptions,
}

impl RemoteConnector {
    /// A connector for `profile` that authenticates with `credential` and
    /// greets with `hello`.
    pub fn new(
        profile: RemoteHostProfile,
        credential: AccessCredential,
        hello: ClientHello,
    ) -> Self {
        Self::with_identity(profile, credential, Identity::Fixed(hello))
    }

    /// A connector that greets with the persisted client instance id at
    /// `identity_path` (see [`crate::RootConnector::with_persisted_identity`]).
    /// A credential bound at pairing only works with the id that paired it.
    pub fn with_persisted_identity(
        profile: RemoteHostProfile,
        credential: AccessCredential,
        identity_path: PathBuf,
    ) -> Self {
        Self::with_identity(profile, credential, Identity::persisted(identity_path))
    }

    fn with_identity(
        profile: RemoteHostProfile,
        credential: AccessCredential,
        identity: Identity,
    ) -> Self {
        Self { profile, credential, identity, options: RemoteConnectOptions::default() }
    }

    /// Replaces the connect options. The supervisor's connect timeout
    /// replaces `timeout` on each attempt.
    pub fn options(mut self, options: RemoteConnectOptions) -> Self {
        self.options = options;
        self
    }

    pub fn profile(&self) -> &RemoteHostProfile {
        &self.profile
    }
}

impl HostConnector for RemoteConnector {
    async fn connect(
        &self,
        timeout: Duration,
        _reporter: &AttemptReporter,
    ) -> Result<Connected, AttemptError> {
        let hello = self.identity.hello().await;
        let options = self.options.clone().with_timeout(timeout);
        Box::pin(connect_remote(&self.profile, &self.credential, hello, &options))
            .await
            .map_err(|error| AttemptError::Remote(Box::new(error)))
    }
}

/// Why pairing did not complete.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum PairingError {
    #[error("could not connect to the sharing Runtime Host")]
    Connect(#[source] RemoteConnectError),
    #[error("the sharing Runtime Host did not become ready")]
    NotReady(#[source] RequestError),
    /// The Host refused to finalize: the credential expired, was revoked,
    /// or another client claimed it (`invalid_request`).
    #[error("the sharing Runtime Host did not finalize the pairing")]
    Finalize(#[source] RequestError),
    /// The deadline passed; the pairing may or may not have been finalized.
    #[error("pairing did not finish within {0:?}")]
    TimedOut(Duration),
}

/// Pairs with the Host `profile` names using the pending `credential` (for
/// example from an [`host_protocol::OwnerConnectionCode`]) and returns a
/// ready connection that holds the activated credential. `timeout` bounds
/// the whole exchange, reconnections included.
///
/// Save the profile and credential before calling this: once the Host has
/// finalized, the pending credential is the active one, and a pairing that
/// bound it to this client instance works only with `hello`'s id.
pub async fn pair_remote_host(
    profile: &RemoteHostProfile,
    credential: &AccessCredential,
    hello: ClientHello,
    options: &RemoteConnectOptions,
    timeout: Duration,
) -> Result<Connected, PairingError> {
    let pairing = Pairing {
        profile,
        credential,
        hello,
        options,
        deadline: Instant::now() + timeout,
        timeout,
    };
    loop {
        let Connected { connection, mut pump, pushes } = Box::pin(pairing.connect()).await?;
        // Drive the pump while waiting for the answers.
        let mut ended = None;
        let finalized = future::or(pairing.finalize(&connection), async {
            ended = Some((&mut pump).await);
            future::pending::<Result<AccessCredentialFinalizeResult, Step>>().await
        })
        .await;
        match finalized {
            Ok(finalized) if finalized.reconnect_required => {
                // The credential is active; this connection still has the
                // pending authority. Connect again with the same credential.
                if ended.is_none() {
                    close(&connection, pump).await;
                }
                return Box::pin(pairing.reconnect()).await;
            }
            Ok(_) if ended.is_none() => return Ok(Connected { connection, pump, pushes }),
            // Finalized, but the Host closed the connection too; finalizing
            // again on the next one answers at once.
            Ok(_) | Err(Step::Retry) => {
                if ended.is_none() {
                    close(&connection, pump).await;
                }
                pairing.pause().await?;
            }
            Err(Step::Fail(error)) => {
                if ended.is_none() {
                    close(&connection, pump).await;
                }
                return Err(error);
            }
        }
    }
}

/// What a failed step of pairing calls for.
enum Step {
    /// Connect again and repeat: finalizing is idempotent.
    Retry,
    Fail(PairingError),
}

struct Pairing<'a> {
    profile: &'a RemoteHostProfile,
    credential: &'a AccessCredential,
    hello: ClientHello,
    options: &'a RemoteConnectOptions,
    deadline: Instant,
    timeout: Duration,
}

impl Pairing<'_> {
    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    async fn connect(&self) -> Result<Connected, PairingError> {
        let options = self.options.clone().with_timeout(self.options.timeout.min(self.remaining()));
        until(
            self.deadline,
            Box::pin(connect_remote(self.profile, self.credential, self.hello.clone(), &options)),
        )
        .await
        .ok_or(PairingError::TimedOut(self.timeout))?
        .map_err(PairingError::Connect)
    }

    /// Waits for `ready`, then finalizes.
    async fn finalize(
        &self,
        connection: &Connection,
    ) -> Result<AccessCredentialFinalizeResult, Step> {
        connection.wait_until_ready(self.remaining()).await.map_err(|error| match error {
            RequestError::Disconnected { .. } | RequestError::HostDraining => Step::Retry,
            error => self.fail(error, PairingError::NotReady),
        })?;
        connection
            .request_with_timeout::<AccessCredentialFinalize>(
                &AccessCredentialFinalizeInput {},
                self.remaining(),
            )
            .await
            .map_err(|error| {
                if is_retryable(&error) {
                    Step::Retry
                } else {
                    self.fail(error, PairingError::Finalize)
                }
            })
    }

    fn fail(&self, error: RequestError, wrap: fn(RequestError) -> PairingError) -> Step {
        Step::Fail(if matches!(error, RequestError::Timeout { .. }) {
            PairingError::TimedOut(self.timeout)
        } else {
            wrap(error)
        })
    }

    /// The connection after a finalize that asked for one, once it is ready.
    async fn reconnect(&self) -> Result<Connected, PairingError> {
        let Connected { connection, mut pump, pushes } = self.connect().await?;
        let mut ended = None;
        let ready = future::or(connection.wait_until_ready(self.remaining()), async {
            ended = Some((&mut pump).await);
            future::pending::<Result<HostStatusResult, RequestError>>().await
        })
        .await;
        match (ready, ended) {
            (Ok(_), None) => Ok(Connected { connection, pump, pushes }),
            (Err(RequestError::Timeout { .. }), _) => Err(PairingError::TimedOut(self.timeout)),
            (Err(error), _) => Err(PairingError::NotReady(error)),
            (Ok(_), Some(result)) => Err(PairingError::NotReady(RequestError::Disconnected {
                operation: HostStatus::NAME.to_owned(),
                reason: match result {
                    Ok(()) => "the connection was shut down".into(),
                    Err(error) => crate::error_chain(&error),
                },
            })),
        }
    }

    /// A short wait before the next attempt, within the deadline.
    async fn pause(&self) -> Result<(), PairingError> {
        if self.remaining() <= RETRY_DELAY {
            return Err(PairingError::TimedOut(self.timeout));
        }
        Timer::after(RETRY_DELAY).await;
        Ok(())
    }
}

/// Shuts `connection` down and lets its pump close the transport.
async fn close(connection: &Connection, mut pump: ConnectionPump) {
    connection.shutdown();
    let _ = until(Instant::now() + CLOSE_GRACE, &mut pump).await;
}

/// `pairingFinalizeRetry`: a lost connection, or an outcome the Host could
/// not confirm.
fn is_retryable(error: &RequestError) -> bool {
    match error {
        RequestError::Disconnected { .. } => true,
        RequestError::Operation { error, .. } => {
            error.code == HostOperationErrorCode::CommitOutcomeUnknown
        }
        _ => false,
    }
}
