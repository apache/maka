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

//! A handshaken connection to a Runtime Host.
//!
//! The handshake mirrors `exchangeRuntimeHostHandshake` in
//! `packages/runtime-host/src/client/connection.ts`; request dispatch mirrors
//! `RuntimeHostConnectionImpl#requestOperation` in the same file. Both run
//! the same way over the local socket or pipe and over a WebSocket
//! (`connectRuntimeHostMessageTransport`); only the transport differs.

use std::fmt;
use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_io::Timer;
use async_lock::Semaphore;
use futures_lite::{AsyncRead, AsyncWrite, future};
use host_protocol::{
    AccessCredential, ClientHello, FrameError, HandshakeResult, HostAccepted, HostDraining,
    HostFrame, HostIncompatible, HostLifecycleState, HostOperationError, HostRegistration,
    HostStatus, HostStatusInput, HostStatusResult, MAX_IN_FLIGHT_DOMAIN_REQUESTS, Operation,
    Outcome, ProtocolRange, RUNTIME_HOST_COMPATIBILITY_EPOCH, RemoteHostUrl, RequestFrame,
    encode_frame,
};
use serde_json::Value;
use thiserror::Error;

use crate::endpoint::EndpointError;
#[cfg(windows)]
use crate::endpoint::LocalEndpoint;
use crate::pump::{
    ConnectionError, ConnectionPump, FrameReader, MessageSink, MessageSource,
    PUSH_CHANNEL_CAPACITY, PushEvent, StreamSink, Transport, next_host_frame,
};
use crate::requests::RequestTable;
use crate::ssh::SshTunnel;
use crate::websocket::{self, WebSocketError};

/// Client-side cap on in-flight domain requests. One below the Host limit so
/// a `host.status` probe always has room, as `CLIENT_MAX_IN_FLIGHT_DOMAIN_REQUESTS`
/// does in the TS client.
const CLIENT_MAX_IN_FLIGHT_DOMAIN_REQUESTS: usize = MAX_IN_FLIGHT_DOMAIN_REQUESTS - 1;

/// `host.status` bypasses the domain budget (`isDomainRequest` in the TS client).
const HOST_STATUS: &str = HostStatus::NAME;

/// Interval between `host.status` polls in [`Connection::wait_until_ready`]
/// (`waitForRuntimeHostReady` uses 25 ms).
const READY_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Options for [`Connection::connect`] and [`Connection::handshake`].
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ConnectOptions {
    /// Budget for opening the transport and completing the handshake.
    pub timeout: Duration,
    /// Reject a Host that serves a different State Root.
    pub expected_root_id: Option<String>,
    /// Reject a Host whose epoch differs, e.g. one that replaced the Host a
    /// registration file described.
    pub expected_host_epoch: Option<String>,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(10), expected_root_id: None, expected_host_epoch: None }
    }
}

impl ConnectOptions {
    /// Replaces the connect and handshake budget.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Requires the Host to serve `root_id`.
    pub fn with_expected_root_id(mut self, root_id: impl Into<String>) -> Self {
        self.expected_root_id = Some(root_id.into());
        self
    }

    /// Requires the Host to have `host_epoch`.
    pub fn with_expected_host_epoch(mut self, host_epoch: impl Into<String>) -> Self {
        self.expected_host_epoch = Some(host_epoch.into());
        self
    }
}

/// Why a connection attempt failed.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ConnectError {
    #[error("failed to open the Runtime Host endpoint")]
    Io(#[from] io::Error),
    /// The registration names an endpoint this platform does not open.
    #[error(transparent)]
    Endpoint(#[from] EndpointError),
    /// The WebSocket to a remote Host could not be opened.
    #[error(transparent)]
    WebSocket(#[from] WebSocketError),
    #[error("the Runtime Host did not complete the handshake within {0:?}")]
    Timeout(Duration),
    #[error("the Runtime Host handshake failed")]
    Handshake(#[source] ConnectionError),
    #[error("failed to encode the hello frame")]
    Encode(#[source] FrameError),
    /// The Host sent something other than a handshake result first.
    #[error("the Runtime Host sent a non-handshake frame before accepting")]
    UnexpectedFrame,
    /// The Host runs a different protocol, epoch, or composition. The payload
    /// says whether it can be replaced now.
    #[error("the Runtime Host is incompatible with this client")]
    Incompatible(Box<HostIncompatible>),
    /// The Host is shutting down or handing off; retry against its successor.
    #[error("the Runtime Host is draining")]
    Draining(Box<HostDraining>),
    #[error("the Runtime Host epoch {actual} is not the expected {expected}")]
    HostEpochMismatch { expected: String, actual: String },
    #[error("the Runtime Host serves composition {actual}, not {expected}")]
    CompositionMismatch { expected: String, actual: String },
    #[error("the Runtime Host serves State Root {actual}, not {expected}")]
    RootMismatch { expected: String, actual: String },
    #[error("the Runtime Host accepted compatibility epoch {actual}, not {expected}")]
    CompatibilityEpochMismatch { expected: u32, actual: u32 },
    /// The handshake failed, and the registration it was opened from names
    /// another compatibility epoch: that Host could not answer this client's
    /// `hello` in a form this client reads (see
    /// [`Self::against_registration`]).
    #[error(
        "the Runtime Host is registered with compatibility epoch {registered}, not {expected}, \
         and its handshake failed"
    )]
    RegisteredEpochMismatch {
        expected: u32,
        registered: u32,
        #[source]
        source: Box<ConnectError>,
    },
    #[error("the Runtime Host selected protocol {0} outside the offered range")]
    ProtocolOutOfRange(u32),
}

impl ConnectError {
    /// Whether a Host is there that will not serve this client (a different
    /// protocol, compatibility epoch, composition, or State Root, or a
    /// refused access credential), so that trying again cannot help.
    pub fn is_permanent(&self) -> bool {
        match self {
            Self::WebSocket(error) => error.is_permanent(),
            _ => matches!(
                self,
                Self::Incompatible(_)
                    | Self::CompatibilityEpochMismatch { .. }
                    | Self::RegisteredEpochMismatch { .. }
                    | Self::CompositionMismatch { .. }
                    | Self::RootMismatch { .. }
                    | Self::ProtocolOutOfRange(_)
            ),
        }
    }

    /// `self`, or [`Self::RegisteredEpochMismatch`] when `self` is a failed
    /// handshake (the Host closed, sent something this client cannot decode,
    /// or sent another frame first) and `registration` names another
    /// compatibility epoch than this client's. A Host of another epoch
    /// answers `incompatible`, but one far enough apart may send it in a
    /// shape this client does not decode; its registration still says what
    /// it speaks, and retrying cannot help.
    pub fn against_registration(self, registration: &HostRegistration) -> Self {
        let failed_handshake = matches!(self, Self::Handshake(_) | Self::UnexpectedFrame);
        if failed_handshake && registration.compatibility_epoch != RUNTIME_HOST_COMPATIBILITY_EPOCH
        {
            return Self::RegisteredEpochMismatch {
                expected: RUNTIME_HOST_COMPATIBILITY_EPOCH,
                registered: registration.compatibility_epoch,
                source: Box::new(self),
            };
        }
        self
    }
}

/// Why one request failed.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum RequestError {
    /// The Host answered `ok: false`.
    #[error("{operation} failed: {error}")]
    Operation { operation: String, error: HostOperationError },
    /// The connection ended before the Host answered.
    #[error("{operation} did not complete: {reason}")]
    Disconnected { operation: String, reason: Arc<str> },
    /// No answer within the caller's timeout. The Host may still run it.
    #[error("{operation} timed out after {timeout:?}")]
    Timeout { operation: String, timeout: Duration },
    #[error("failed to encode {operation} input")]
    Encode {
        operation: String,
        #[source]
        source: FrameError,
    },
    /// The Host answered with a result this client cannot decode.
    #[error("failed to decode the {operation} result")]
    Decode {
        operation: String,
        #[source]
        source: serde_json::Error,
    },
    /// `host.status` reported a different Host than the handshake did; the
    /// connection has been shut down.
    #[error("the Runtime Host identity changed during the connection")]
    HostIdentityChanged,
    /// The Host began draining while the caller waited for it to become ready.
    #[error("the Runtime Host began draining")]
    HostDraining,
}

/// The result of a successful handshake.
///
/// Spawn `pump` on an executor and drain `pushes`; then issue requests on
/// `connection`, which is cheap to clone.
#[derive(Debug)]
#[non_exhaustive]
pub struct Connected {
    pub connection: Connection,
    pub pump: ConnectionPump,
    /// Frames the Host sends unasked: subscription frames, change notices,
    /// and anything this client does not model yet. Bounded at
    /// [`PUSH_CHANNEL_CAPACITY`]: when it is full the pump waits (and emits
    /// [`PushEvent::Lagging`] once) instead of dropping frames. Created with
    /// exactly one receiver so no frame is split between listeners.
    pub pushes: async_channel::Receiver<PushEvent>,
}

/// A handle to an accepted Runtime Host connection.
///
/// Clones share one connection. The connection ends when [`Self::shutdown`]
/// is called, when every handle is dropped, or when the Host or transport
/// ends it; its [`ConnectionPump`] reports which.
#[derive(Clone)]
pub struct Connection {
    inner: Arc<Inner>,
}

struct Inner {
    accepted: HostAccepted,
    outgoing: async_channel::Sender<Vec<u8>>,
    table: Arc<RequestTable>,
    domain_slots: Arc<Semaphore>,
}

impl fmt::Debug for Connection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Connection")
            .field("root_id", &self.inner.accepted.root_id)
            .field("host_epoch", &self.inner.accepted.host_epoch)
            .field("connection_id", &self.inner.accepted.connection_id)
            .field("closed", &self.is_closed())
            .finish()
    }
}

impl Connection {
    /// Opens the Unix domain socket at `endpoint` and completes the handshake.
    #[cfg(unix)]
    pub async fn connect(
        endpoint: impl AsRef<std::path::Path>,
        hello: ClientHello,
        options: ConnectOptions,
    ) -> Result<Connected, ConnectError> {
        let endpoint = endpoint.as_ref().to_owned();
        let timeout = options.timeout;
        let started = Instant::now();
        let stream = with_deadline(timeout, async {
            async_net::unix::UnixStream::connect(&endpoint).await.map_err(ConnectError::Io)
        })
        .await?;
        let remaining = timeout.saturating_sub(started.elapsed());
        Self::handshake(stream.clone(), stream, hello, options.with_timeout(remaining)).await
    }

    /// Opens the named pipe at `endpoint` and completes the handshake.
    ///
    /// `endpoint` is the registration's, a pipe on this machine
    /// (`\\.\pipe\maka-runtime-host-…`); anything else fails with
    /// [`ConnectError::Endpoint`] (see [`LocalEndpoint::parse`]). The
    /// transport is described in the `named_pipe` module.
    #[cfg(windows)]
    pub async fn connect(
        endpoint: impl AsRef<std::path::Path>,
        hello: ClientHello,
        options: ConnectOptions,
    ) -> Result<Connected, ConnectError> {
        let endpoint = endpoint.as_ref();
        let text = endpoint
            .to_str()
            .ok_or_else(|| EndpointError::Unrecognized(endpoint.to_string_lossy().into_owned()))?;
        let LocalEndpoint::NamedPipe(path) = LocalEndpoint::parse(text)? else {
            return Err(EndpointError::Unsupported(text.to_owned()).into());
        };
        let timeout = options.timeout;
        let started = Instant::now();
        let (reader, writer) = with_deadline(timeout, async {
            crate::named_pipe::open(&path).await.map_err(ConnectError::Io)
        })
        .await?;
        let remaining = timeout.saturating_sub(started.elapsed());
        Self::handshake(reader, writer, hello, options.with_timeout(remaining)).await
    }

    /// Opens the WebSocket at `url` with `credential` and completes the
    /// handshake (`connectRemoteRuntimeHost`). `options.timeout` covers the
    /// TCP connection, TLS, the upgrade, and the handshake.
    ///
    /// Remote Hosts are not registered locally, so there is no Host epoch to
    /// expect; pass the profile's State Root as `expected_root_id`.
    pub async fn connect_websocket(
        url: &RemoteHostUrl,
        credential: &AccessCredential,
        hello: ClientHello,
        options: ConnectOptions,
    ) -> Result<Connected, ConnectError> {
        Box::pin(Self::connect_websocket_through(url, credential, None, hello, options)).await
    }

    /// [`Self::connect_websocket`] through an SSH tunnel, which the returned
    /// connection owns: it ends when the tunnel's `ssh` exits, and closing
    /// the connection stops `ssh`. A failed attempt stops it too.
    pub(crate) async fn connect_websocket_through(
        url: &RemoteHostUrl,
        credential: &AccessCredential,
        tunnel: Option<SshTunnel>,
        hello: ClientHello,
        options: ConnectOptions,
    ) -> Result<Connected, ConnectError> {
        let timeout = options.timeout;
        let started = Instant::now();
        let opened = with_deadline(timeout, async {
            Box::pin(websocket::open(url, credential)).await.map_err(ConnectError::WebSocket)
        })
        .await;
        let (source, sink) = match opened {
            Ok(halves) => halves,
            Err(error) => {
                if let Some(tunnel) = tunnel {
                    tunnel.close().await;
                }
                return Err(error);
            }
        };
        let remaining = timeout.saturating_sub(started.elapsed());
        let transport = Transport { source, sink, tunnel };
        Box::pin(Self::handshake_over(transport, hello, options.with_timeout(remaining))).await
    }

    /// Completes the handshake over an already open byte stream.
    pub async fn handshake<R, W>(
        reader: R,
        writer: W,
        hello: ClientHello,
        options: ConnectOptions,
    ) -> Result<Connected, ConnectError>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let transport =
            Transport { source: FrameReader::new(reader), sink: StreamSink(writer), tunnel: None };
        Self::handshake_over(transport, hello, options).await
    }

    /// Completes the handshake over `transport`. On failure the transport,
    /// and its tunnel if it has one, is closed.
    async fn handshake_over<S: MessageSource, K: MessageSink>(
        mut transport: Transport<S, K>,
        hello: ClientHello,
        options: ConnectOptions,
    ) -> Result<Connected, ConnectError> {
        match exchange_hello(&mut transport, &hello, &options).await {
            Ok(accepted) => Ok(Self::start(accepted, transport)),
            Err(error) => {
                transport.sink.close().await;
                if let Some(tunnel) = transport.tunnel.take() {
                    tunnel.close().await;
                }
                Err(error)
            }
        }
    }

    fn start<S: MessageSource, K: MessageSink>(
        accepted: HostAccepted,
        transport: Transport<S, K>,
    ) -> Connected {
        let (outgoing, outgoing_rx) = async_channel::unbounded();
        let (pushes_tx, pushes) = async_channel::bounded(PUSH_CHANNEL_CAPACITY);
        let table = Arc::new(RequestTable::default());
        let pump = ConnectionPump::new(transport, outgoing_rx, table.clone(), pushes_tx);
        let connection = Connection {
            inner: Arc::new(Inner {
                accepted,
                outgoing,
                table,
                domain_slots: Arc::new(Semaphore::new(CLIENT_MAX_IN_FLIGHT_DOMAIN_REQUESTS)),
            }),
        };
        Connected { connection, pump, pushes }
    }

    /// The `accepted` frame, as the Host sent it.
    pub fn accepted(&self) -> &HostAccepted {
        &self.inner.accepted
    }

    /// The State Root this Host serves.
    pub fn root_id(&self) -> &str {
        &self.inner.accepted.root_id
    }

    /// The Host process incarnation. A change means a different Host.
    pub fn host_epoch(&self) -> &str {
        &self.inner.accepted.host_epoch
    }

    /// This connection's id, assigned by the Host.
    pub fn connection_id(&self) -> &str {
        &self.inner.accepted.connection_id
    }

    /// The negotiated protocol version.
    pub fn selected_protocol(&self) -> u32 {
        self.inner.accepted.selected_protocol
    }

    /// Whether the connection has ended or is ending.
    pub fn is_closed(&self) -> bool {
        self.inner.outgoing.is_closed() || self.inner.table.close_reason().is_some()
    }

    /// Ends the connection. Waiting requests fail with
    /// [`RequestError::Disconnected`]; the pump then resolves with `Ok(())`.
    pub fn shutdown(&self) {
        self.inner.outgoing.close();
    }

    /// Sends a typed request and waits for its result, without a timeout.
    pub async fn request<Op: Operation>(
        &self,
        input: &Op::Input,
    ) -> Result<Op::Output, RequestError> {
        self.typed_request::<Op>(input, None).await
    }

    /// Sends a typed request and waits at most `timeout` for its result.
    ///
    /// On timeout the request is retired, not cancelled: the Host may still
    /// run it, and it keeps its in-flight slot until the Host answers.
    pub async fn request_with_timeout<Op: Operation>(
        &self,
        input: &Op::Input,
        timeout: Duration,
    ) -> Result<Op::Output, RequestError> {
        self.typed_request::<Op>(input, Some(timeout)).await
    }

    /// Sends a request for an operation this crate does not model yet.
    pub async fn request_value(
        &self,
        operation: &str,
        input: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, RequestError> {
        self.send(operation, input, timeout).await
    }

    /// `host.status`, checked against the handshake identity the way
    /// `RuntimeHostConnectionImpl.status` does. A mismatch shuts the
    /// connection down.
    pub async fn host_status(&self) -> Result<HostStatusResult, RequestError> {
        let status = self.request::<HostStatus>(&HostStatusInput::default()).await?;
        let accepted = &self.inner.accepted;
        if status.host_epoch != accepted.host_epoch
            || status.composition_id != accepted.composition_id
            || status.composition_revision != accepted.composition_revision
        {
            self.shutdown();
            return Err(RequestError::HostIdentityChanged);
        }
        Ok(status)
    }

    /// Polls `host.status` until the Host reports `ready`
    /// (`waitForRuntimeHostReady` in `client/wait-for-ready.ts`).
    ///
    /// Operations with availability `ready`, such as
    /// `session.catalog.query`, answer `host_not_ready` before that.
    pub async fn wait_until_ready(
        &self,
        timeout: Duration,
    ) -> Result<HostStatusResult, RequestError> {
        let deadline = Instant::now() + timeout;
        let timed_out = || RequestError::Timeout { operation: HOST_STATUS.to_owned(), timeout };
        loop {
            let status = until(deadline, self.host_status()).await.ok_or_else(timed_out)??;
            match status.state {
                HostLifecycleState::Ready => return Ok(status),
                HostLifecycleState::Draining => return Err(RequestError::HostDraining),
                _ => {}
            }
            if Instant::now() + READY_POLL_INTERVAL > deadline {
                return Err(timed_out());
            }
            Timer::after(READY_POLL_INTERVAL).await;
        }
    }

    async fn typed_request<Op: Operation>(
        &self,
        input: &Op::Input,
        timeout: Option<Duration>,
    ) -> Result<Op::Output, RequestError> {
        let input = serde_json::to_value(input).map_err(|source| RequestError::Encode {
            operation: Op::NAME.to_owned(),
            source: FrameError::Encode(source),
        })?;
        let result = self.send(Op::NAME, input, timeout).await?;
        serde_json::from_value(result)
            .map_err(|source| RequestError::Decode { operation: Op::NAME.to_owned(), source })
    }

    async fn send(
        &self,
        operation: &str,
        input: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, RequestError> {
        let inner = &self.inner;
        let deadline = timeout.map(|timeout| Instant::now() + timeout);
        let timed_out = || RequestError::Timeout {
            operation: operation.to_owned(),
            timeout: timeout.unwrap_or_default(),
        };
        let disconnected = |reason: Arc<str>| RequestError::Disconnected {
            operation: operation.to_owned(),
            reason,
        };

        if let Some(reason) = inner.table.close_reason() {
            return Err(disconnected(reason));
        }
        // Queue behind the in-flight budget, as the TS client does, instead of
        // letting the Host tear the connection down at its limit.
        let slot = if operation == HOST_STATUS {
            None
        } else {
            let acquire = inner.domain_slots.acquire_arc();
            match deadline {
                None => Some(acquire.await),
                Some(deadline) => Some(until(deadline, acquire).await.ok_or_else(timed_out)?),
            }
        };

        let request_id = uuid::Uuid::new_v4().to_string();
        let frame = encode_frame(&RequestFrame::new(request_id.clone(), operation, input))
            .map_err(|source| RequestError::Encode { operation: operation.to_owned(), source })?;
        let (reply, response) = async_channel::bounded(1);
        inner.table.insert(request_id.clone(), operation, reply, slot).map_err(disconnected)?;
        if inner.outgoing.try_send(frame).is_err() {
            inner.table.remove(&request_id);
            return Err(disconnected(self.close_reason()));
        }

        let outcome = match deadline {
            None => response.recv().await.ok(),
            Some(deadline) => match until(deadline, response.recv()).await {
                Some(outcome) => outcome.ok(),
                None => {
                    inner.table.retire(&request_id);
                    return Err(timed_out());
                }
            },
        };
        match outcome {
            Some(Outcome::Ok(result)) => Ok(result),
            Some(Outcome::Err(error)) => {
                Err(RequestError::Operation { operation: operation.to_owned(), error })
            }
            None => Err(disconnected(self.close_reason())),
        }
    }

    fn close_reason(&self) -> Arc<str> {
        self.inner.table.close_reason().unwrap_or_else(|| "the connection was shut down".into())
    }
}

/// Sends `hello` and reads the Host's answer within `options.timeout`.
async fn exchange_hello<S: MessageSource, K: MessageSink>(
    transport: &mut Transport<S, K>,
    hello: &ClientHello,
    options: &ConnectOptions,
) -> Result<HostAccepted, ConnectError> {
    let offered = ProtocolRange::new(hello.protocol_min, hello.protocol_max);
    let hello_bytes = encode_frame(hello).map_err(ConnectError::Encode)?;
    let result = with_deadline(options.timeout, async {
        transport.sink.send_frame(hello_bytes).await.map_err(|error| match error {
            // A failed write of the hello is a transport failure, which the
            // election reports as a failed connect, not a refused handshake.
            ConnectionError::Io(error) => ConnectError::Io(error),
            error => ConnectError::Handshake(error),
        })?;
        match next_host_frame(&mut transport.source).await {
            Ok(Some(HostFrame::Handshake(result))) => Ok(result),
            Ok(Some(_)) => Err(ConnectError::UnexpectedFrame),
            Ok(None) => Err(ConnectError::Handshake(ConnectionError::HostClosed)),
            Err(error) => Err(ConnectError::Handshake(error)),
        }
    })
    .await?;
    check_handshake(result, hello, offered, options)
}

/// Applies the checks `exchangeRuntimeHostHandshake` makes, in its order.
fn check_handshake(
    result: HandshakeResult,
    hello: &ClientHello,
    offered: ProtocolRange,
    options: &ConnectOptions,
) -> Result<HostAccepted, ConnectError> {
    if let Some(expected) = &options.expected_host_epoch
        && result.host_epoch() != expected
    {
        return Err(ConnectError::HostEpochMismatch {
            expected: expected.clone(),
            actual: result.host_epoch().to_owned(),
        });
    }
    let accepted = match result {
        HandshakeResult::Incompatible(incompatible) => {
            return Err(ConnectError::Incompatible(Box::new(incompatible)));
        }
        HandshakeResult::Draining(draining) => {
            check_composition(&draining.composition_id, hello)?;
            return Err(ConnectError::Draining(Box::new(draining)));
        }
        HandshakeResult::Accepted(accepted) => accepted,
    };
    check_composition(&accepted.composition_id, hello)?;
    if let Some(expected) = &options.expected_root_id
        && &accepted.root_id != expected
    {
        return Err(ConnectError::RootMismatch {
            expected: expected.clone(),
            actual: accepted.root_id,
        });
    }
    if accepted.compatibility_epoch != hello.compatibility_epoch {
        return Err(ConnectError::CompatibilityEpochMismatch {
            expected: hello.compatibility_epoch,
            actual: accepted.compatibility_epoch,
        });
    }
    if !offered.contains(accepted.selected_protocol) {
        return Err(ConnectError::ProtocolOutOfRange(accepted.selected_protocol));
    }
    Ok(accepted)
}

fn check_composition(actual: &str, hello: &ClientHello) -> Result<(), ConnectError> {
    if actual == hello.composition_id {
        Ok(())
    } else {
        Err(ConnectError::CompositionMismatch {
            expected: hello.composition_id.clone(),
            actual: actual.to_owned(),
        })
    }
}

/// Runs `work`, failing with [`ConnectError::Timeout`] after `timeout`.
async fn with_deadline<T>(
    timeout: Duration,
    work: impl Future<Output = Result<T, ConnectError>>,
) -> Result<T, ConnectError> {
    until(Instant::now() + timeout, work).await.unwrap_or(Err(ConnectError::Timeout(timeout)))
}

/// Resolves to `None` if `deadline` passes before `work` finishes.
pub(crate) async fn until<T>(deadline: Instant, work: impl Future<Output = T>) -> Option<T> {
    future::or(async { Some(work.await) }, async {
        Timer::at(deadline).await;
        None
    })
    .await
}
