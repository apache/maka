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

//! A Host connection that notices when it dies and comes back.
//!
//! [`supervise`] returns a future that runs the whole lifecycle: discover the
//! Host, connect, wait for `ready`, probe liveness while connected, and after
//! a loss reconnect with bounded exponential backoff. Each attempt re-reads
//! the registration file, so a Host that restarted on a new socket is found.
//! Everything that happens is reported, in order, on one event channel:
//! connection changes and the Host's push frames interleaved exactly as they
//! occurred.
//!
//! Sources in `packages/runtime-host/src/client/`:
//! - reconnect loop, backoff, stable-connection reset, and the identity
//!   checks on reconnect: `reconnect-lifecycle.ts` and
//!   `createRuntimeHostReconnectingConnection` in `reconnecting-connection.ts`;
//! - liveness: `#scheduleLivenessCheck` and `#startLivenessProbe` in
//!   `connection.ts`. One `host.status` probe runs at a time; the next starts
//!   [`ReconnectPolicy::liveness_interval`] after the previous one answered,
//!   and a probe unanswered for [`ReconnectPolicy::liveness_timeout`] ends the
//!   connection. Other inbound frames do not count as liveness.
//!
//! With [`RootConnector::spawning`], an attempt that finds no Host starts
//! one ([`crate::connect_or_spawn`]) and reports it as
//! [`ConnectionEvent::HostStarting`], so the reconnect path also restarts a
//! Host that exited or crashed.
//!
//! Requests are never replayed on a new connection
//! (`runtime-host-architecture.md` §7): a request in flight when the
//! connection drops fails with [`crate::RequestError::Disconnected`], and
//! [`SupervisorHandle::connection`] is `None` until the next connection is
//! ready.

use std::error::Error as StdError;
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use async_io::Timer;
use futures_lite::future;
use host_protocol::{ClientHello, ClientInstanceId, HostAccepted, HostStatusResult, PushFrame};
use thiserror::Error;

use crate::connection::until;
use crate::{
    ConnectError, Connected, Connection, ConnectionError, ConnectionPump, DiscoveryError,
    HostBlocker, LaunchError, LaunchOptions, PushEvent, ReconnectPolicy, RemoteConnectError,
    RequestError,
};

/// Capacity of the supervisor's event channel. It sits after the
/// per-connection push channel ([`crate::PUSH_CHANNEL_CAPACITY`]), which
/// carries the real backpressure bound; this adds a little slack.
pub const EVENT_CHANNEL_CAPACITY: usize = 16;

/// How long a pump may take to wind down after the supervisor ended its
/// connection before it is dropped.
const PUMP_SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

/// One item on the supervisor's event channel.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum HostEvent {
    /// The connection changed.
    Connection(ConnectionEvent),
    /// A frame the current connection's Host sent unasked. Always between
    /// that connection's `Connected` and `Disconnected`.
    Push(PushFrame),
}

/// A change in the supervised connection.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum ConnectionEvent {
    /// A connection completed its handshake and the Host reported `ready`.
    /// [`SupervisorHandle::connection`] now returns it.
    Connected { accepted: HostAccepted },
    /// The Host this connection reached is a different process from the one
    /// before (its epoch changed). Sent just before that connection's
    /// `Connected`. Anything derived from the old Host (subscriptions,
    /// snapshots, cursors) must be reopened.
    HostEpochChanged { previous: String, current: String },
    /// The current connection ended.
    Disconnected { reason: Arc<str> },
    /// Connection attempt `attempt` of the current outage starts after
    /// `delay`. [`SupervisorHandle::reconnect_now`] skips the wait.
    Reconnecting { attempt: u32, delay: Duration },
    /// Attempt `attempt` found no Host and started one, process `pid`; it
    /// now waits for that Host to register and accept the connection.
    HostStarting { attempt: u32, pid: u32 },
    /// Attempt `attempt` failed.
    AttemptFailed { attempt: u32, reason: Arc<str> },
    /// Retrying cannot help (an incompatible Host, a different State Root):
    /// automatic attempts stop until [`SupervisorHandle::reconnect_now`].
    /// `blocker` is set when the cause is one a window explains on a screen
    /// of its own ([`AttemptError::blocker`]).
    Suspended { reason: Arc<str>, blocker: Option<HostBlocker> },
    /// The event consumer fell behind and the pump is waiting for it. No frame
    /// was dropped. Reported once per episode.
    Lagging,
}

/// Why one connection attempt failed.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum AttemptError {
    #[error(transparent)]
    Discovery(#[from] DiscoveryError),
    #[error(transparent)]
    Connect(#[from] ConnectError),
    /// The handshake succeeded but `host.status` never reported `ready`.
    #[error("the Runtime Host did not become ready")]
    NotReady(#[source] RequestError),
    /// The Host closed the connection while it was starting.
    #[error("the Runtime Host closed the connection before it was ready")]
    ClosedBeforeReady(#[source] ConnectionError),
    /// The Host now runs a different protocol, composition, or State Root
    /// than the first connection did (the checks in
    /// `createRuntimeHostReconnectingConnection`).
    #[error("{0}")]
    HostChanged(String),
    /// No Host answered and starting one failed.
    #[error(transparent)]
    Launch(Box<LaunchError>),
    /// A remote Host could not be reached through its profile's transport.
    #[error(transparent)]
    Remote(Box<RemoteConnectError>),
    /// This platform has no local IPC transport yet.
    #[error("local Runtime Host connections are not supported on this platform yet")]
    Unsupported,
}

impl From<LaunchError> for AttemptError {
    fn from(error: LaunchError) -> Self {
        Self::Launch(Box::new(error))
    }
}

impl AttemptError {
    /// Whether retrying without a user decision is pointless.
    pub fn is_permanent(&self) -> bool {
        match self {
            Self::Discovery(error) => {
                matches!(
                    error,
                    DiscoveryError::RootMismatch { .. } | DiscoveryError::NoHomeDirectory
                )
            }
            Self::Connect(error) => error.is_permanent(),
            Self::Launch(error) => error.is_permanent(),
            Self::Remote(error) => error.is_permanent(),
            Self::HostChanged(_) | Self::Unsupported => true,
            Self::NotReady(_) | Self::ClosedBeforeReady(_) => false,
        }
    }
}

/// Opens one handshaken connection. The supervisor calls it for every
/// attempt; an implementation must look the Host up afresh each time.
///
/// The supervisor, the connectors, and the connect paths under them box
/// the larger futures they await. GPUI polls background tasks on Grand
/// Central Dispatch workers on macOS, whose stacks are 512 KiB, and an
/// unoptimized build gives every inline future it awaits room of its own
/// in each poll frame up the chain: a remote attempt nested inline needed
/// more than that and overflowed the worker's stack.
pub trait HostConnector: Send + Sync + 'static {
    /// Connects within `timeout`, telling `reporter` about progress worth
    /// showing (a Host being started).
    fn connect(
        &self,
        timeout: Duration,
        reporter: &AttemptReporter,
    ) -> impl Future<Output = Result<Connected, AttemptError>> + Send;
}

/// Reports progress from inside one connection attempt on the supervisor's
/// event channel, in order with the attempt's other events.
#[derive(Debug, Clone)]
pub struct AttemptReporter {
    attempt: u32,
    events: Option<async_channel::Sender<HostEvent>>,
}

impl AttemptReporter {
    /// A reporter that drops everything, for a connector used on its own.
    pub fn detached() -> Self {
        Self { attempt: 1, events: None }
    }

    /// The 1-based attempt number within the current outage.
    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    /// Reports [`ConnectionEvent::HostStarting`].
    pub async fn host_starting(&self, pid: u32) {
        if let Some(events) = &self.events {
            let event = ConnectionEvent::HostStarting { attempt: self.attempt, pid };
            // A closed channel stops the supervisor at its next event.
            let _ = events.send(HostEvent::Connection(event)).await;
        }
    }
}

/// Connects to whatever Host is registered for a State Root and, when built
/// with [`Self::spawning`], starts one when none answers.
#[derive(Debug)]
pub struct RootConnector {
    root: PathBuf,
    identity: Identity,
    launch: Option<LaunchOptions>,
}

/// The hello a connector greets with on every attempt.
#[derive(Debug)]
pub(crate) enum Identity {
    /// Greet with this hello every time.
    Fixed(ClientHello),
    /// Load the id from this file on the first attempt, then keep it.
    Persisted { path: PathBuf, loaded: OnceLock<ClientInstanceId> },
}

impl Identity {
    pub(crate) fn persisted(path: PathBuf) -> Self {
        Self::Persisted { path, loaded: OnceLock::new() }
    }

    pub(crate) async fn hello(&self) -> ClientHello {
        match self {
            Self::Fixed(hello) => hello.clone(),
            Self::Persisted { path, loaded } => {
                if let Some(id) = loaded.get() {
                    return ClientHello::new(id.clone());
                }
                let id = match crate::load_or_create_client_instance_id(path).await {
                    Ok(identity) => {
                        log::info!(
                            "client instance id {} ({:?}) from {}",
                            identity.id,
                            identity.origin,
                            path.display()
                        );
                        identity.id
                    }
                    Err(error) => {
                        log::warn!("using a one-off client instance id: {}", error_chain(&error));
                        crate::random_client_instance_id()
                    }
                };
                ClientHello::new(loaded.get_or_init(|| id).clone())
            }
        }
    }
}

impl RootConnector {
    /// A connector for the State Root at `root` that greets with `hello`.
    pub fn new(root: impl Into<PathBuf>, hello: ClientHello) -> Self {
        Self { root: root.into(), identity: Identity::Fixed(hello), launch: None }
    }

    /// A connector that greets with the persisted client instance id at
    /// `identity_path` (see [`crate::load_or_create_client_instance_id`]),
    /// read on the first attempt. If the file cannot be read or written, this
    /// launch uses a random id and logs a warning; the Host then sees a new
    /// client, which is harmless.
    pub fn with_persisted_identity(root: impl Into<PathBuf>, identity_path: PathBuf) -> Self {
        Self { root: root.into(), identity: Identity::persisted(identity_path), launch: None }
    }

    /// Makes every attempt run [`crate::connect_or_spawn`] with `options`:
    /// the State Root is created if needed, and a Host is started when none
    /// answers. The election has its own deadline and per-poll budget; the
    /// supervisor's connect timeout does not apply to it.
    pub fn spawning(mut self, options: LaunchOptions) -> Self {
        self.launch = Some(options);
        self
    }

    /// The State Root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl HostConnector for RootConnector {
    async fn connect(
        &self,
        timeout: Duration,
        reporter: &AttemptReporter,
    ) -> Result<Connected, AttemptError> {
        let hello = self.identity.hello().await;
        if let Some(options) = &self.launch {
            let launched = crate::connect_or_spawn(&self.root, hello, options, reporter).await?;
            return Ok(launched.connected);
        }
        #[cfg(any(unix, windows))]
        {
            let started = Instant::now();
            let host = crate::discover_host(&self.root).await?;
            let options = crate::ConnectOptions::default()
                .with_timeout(timeout.saturating_sub(started.elapsed()))
                .with_expected_root_id(host.root_id.clone())
                .with_expected_host_epoch(host.registration.host_epoch.clone());
            Connection::connect(&host.registration.endpoint, hello, options)
                .await
                .map_err(|error| error.against_registration(&host.registration).into())
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (timeout, hello);
            Err(AttemptError::Unsupported)
        }
    }
}

/// The parts [`supervise`] returns.
#[derive(Debug)]
#[non_exhaustive]
pub struct Supervised {
    pub handle: SupervisorHandle,
    /// Must be polled (spawned on a background executor) or nothing happens.
    pub run: SupervisorRun,
    /// Connection events and push frames, in order. Bounded at
    /// [`EVENT_CHANNEL_CAPACITY`]; a slow consumer holds the pump back
    /// rather than losing frames.
    pub events: async_channel::Receiver<HostEvent>,
}

/// Starts supervising the Host that `connector` reaches.
pub fn supervise<C: HostConnector>(connector: C, policy: ReconnectPolicy) -> Supervised {
    let (control_tx, control) = async_channel::bounded(1);
    let shared = Arc::new(Shared {
        current: Mutex::new(None),
        shut_down: AtomicBool::new(false),
        control: control_tx,
    });
    let (events_tx, events) = async_channel::bounded(EVENT_CHANNEL_CAPACITY);
    let loop_state = Supervisor { policy, shared: shared.clone(), events: events_tx, control };
    Supervised {
        handle: SupervisorHandle { shared },
        run: SupervisorRun { future: Box::pin(loop_state.run(connector)) },
        events,
    }
}

/// The future that runs a supervised connection until
/// [`SupervisorHandle::shutdown`] or until the event receiver is dropped.
/// Dropping it closes the current connection.
#[must_use = "a supervised connection makes no progress unless its run future is polled"]
pub struct SupervisorRun {
    future: Pin<Box<dyn Future<Output = ()> + Send>>,
}

impl Future for SupervisorRun {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        self.future.as_mut().poll(cx)
    }
}

impl fmt::Debug for SupervisorRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SupervisorRun").finish_non_exhaustive()
    }
}

/// Controls a supervised connection. Cheap to clone.
#[derive(Clone)]
pub struct SupervisorHandle {
    shared: Arc<Shared>,
}

impl fmt::Debug for SupervisorHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SupervisorHandle")
            .field("connected", &self.shared.current().is_some())
            .field("shut_down", &self.shared.is_shut_down())
            .finish()
    }
}

impl SupervisorHandle {
    /// The ready connection, if there is one right now. Requests on a
    /// connection that has since dropped fail; they are not retried.
    pub fn connection(&self) -> Option<Connection> {
        self.shared.current().clone()
    }

    /// Ends a backoff wait or a suspension and attempts at once. Does
    /// nothing while connected.
    pub fn reconnect_now(&self) {
        self.shared.wake();
    }

    /// Closes the connection and stops the run future.
    pub fn shutdown(&self) {
        self.shared.shut_down.store(true, Ordering::SeqCst);
        if let Some(connection) = self.shared.current().as_ref() {
            connection.shutdown();
        }
        self.shared.wake();
    }
}

struct Shared {
    current: Mutex<Option<Connection>>,
    shut_down: AtomicBool,
    /// Wakes the loop. Capacity 1: wakes coalesce.
    control: async_channel::Sender<()>,
}

impl Shared {
    fn current(&self) -> MutexGuard<'_, Option<Connection>> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set_current(&self, connection: Option<Connection>) {
        *self.current() = connection;
    }

    fn is_shut_down(&self) -> bool {
        self.shut_down.load(Ordering::SeqCst)
    }

    fn wake(&self) {
        let _ = self.control.try_send(());
    }
}

struct Supervisor {
    policy: ReconnectPolicy,
    shared: Arc<Shared>,
    events: async_channel::Sender<HostEvent>,
    control: async_channel::Receiver<()>,
}

/// A connection that reported `ready`.
struct Ready {
    connection: Connection,
    pump: ConnectionPump,
    pushes: async_channel::Receiver<PushEvent>,
    /// `Some` when the pump already finished while readiness was checked;
    /// it must not be polled again.
    ended: Option<Result<(), ConnectionError>>,
}

impl Supervisor {
    async fn run<C: HostConnector>(self, connector: C) {
        // Consecutive failures, counting a lost connection as one; a
        // connection that lived `stable_connection` resets it first.
        let mut failures = 0u32;
        // Attempts in the current outage, 1-based in events.
        let mut attempt = 0u32;
        let mut suspended = false;
        // The identity the first connection established.
        let mut pinned: Option<HostAccepted> = None;
        let mut previous_epoch: Option<String> = None;

        while !self.shared.is_shut_down() {
            if suspended {
                if !self.wait_for_wake().await {
                    break;
                }
                // The user chose to reconnect: accept whatever Host is there.
                suspended = false;
                pinned = None;
            } else if failures > 0 {
                let delay = self.policy.reconnect_delay(failures, fastrand::f64());
                let event = ConnectionEvent::Reconnecting { attempt: attempt + 1, delay };
                if !self.emit(event).await || !self.sleep_unless_woken(delay).await {
                    break;
                }
            }

            attempt += 1;
            // Shutdown must not wait out a connect or readiness budget. The
            // attempt is boxed: see `HostConnector::connect`.
            let outcome = future::or(
                async { Some(Box::pin(self.attempt(&connector, attempt, pinned.as_ref())).await) },
                async {
                    self.wait_for_shutdown().await;
                    None
                },
            )
            .await;
            let Some(outcome) = outcome else {
                break;
            };
            let ready = match outcome {
                Ok(ready) => ready,
                Err(error) => {
                    failures = failures.saturating_add(1);
                    let reason = error_chain(&error);
                    let mut delivered = self
                        .emit(ConnectionEvent::AttemptFailed { attempt, reason: reason.clone() })
                        .await;
                    if error.is_permanent() {
                        suspended = true;
                        let blocker = error.blocker();
                        delivered = delivered
                            && self.emit(ConnectionEvent::Suspended { reason, blocker }).await;
                    }
                    if !delivered {
                        break;
                    }
                    continue;
                }
            };

            let accepted = ready.connection.accepted().clone();
            pinned.get_or_insert_with(|| accepted.clone());
            if let Some(previous) = previous_epoch.replace(accepted.host_epoch.clone())
                && previous != accepted.host_epoch
            {
                let event = ConnectionEvent::HostEpochChanged {
                    previous,
                    current: accepted.host_epoch.clone(),
                };
                if !self.emit(event).await {
                    ready.connection.shutdown();
                    break;
                }
            }
            // A wake sent before this connection existed is stale.
            while self.control.try_recv().is_ok() {}
            self.shared.set_current(Some(ready.connection.clone()));
            if !self.emit(ConnectionEvent::Connected { accepted }).await {
                ready.connection.shutdown();
                self.shared.set_current(None);
                break;
            }
            attempt = 0;
            let installed = Instant::now();

            let reason = Box::pin(self.run_live(ready)).await;
            self.shared.set_current(None);
            if installed.elapsed() >= self.policy.stable_connection {
                failures = 0;
            }
            failures = failures.saturating_add(1);
            if !self.emit(ConnectionEvent::Disconnected { reason }).await {
                break;
            }
        }
        self.shared.set_current(None);
    }

    /// Connects, checks the Host against the pinned identity, and waits for
    /// `ready` while the pump runs.
    async fn attempt<C: HostConnector>(
        &self,
        connector: &C,
        attempt: u32,
        pinned: Option<&HostAccepted>,
    ) -> Result<Ready, AttemptError> {
        let reporter = AttemptReporter { attempt, events: Some(self.events.clone()) };
        let Connected { connection, mut pump, pushes } =
            Box::pin(connector.connect(self.policy.connect_timeout, &reporter)).await?;
        if let Some(pinned) = pinned
            && let Err(error) = check_same_host(pinned, connection.accepted())
        {
            connection.shutdown();
            return Err(error);
        }

        // Drive the pump while waiting, without letting its end win the race:
        // a Host can answer the readiness probe and close in the same read,
        // and the pushes it sent before closing still belong to a ready
        // connection.
        let mut ended = None;
        let ready = future::or(connection.wait_until_ready(self.policy.ready_timeout), async {
            ended = Some((&mut pump).await);
            future::pending::<Result<HostStatusResult, RequestError>>().await
        })
        .await;
        match (ready, ended) {
            (Ok(_), ended) => Ok(Ready { connection, pump, pushes, ended }),
            (Err(_), Some(Err(error))) => Err(AttemptError::ClosedBeforeReady(error)),
            (Err(_), Some(Ok(()))) => {
                Err(AttemptError::ClosedBeforeReady(ConnectionError::HostClosed))
            }
            (Err(error), None) => {
                connection.shutdown();
                Err(AttemptError::NotReady(error))
            }
        }
    }

    /// Runs one ready connection until it ends, forwarding its pushes.
    /// Returns why it ended.
    async fn run_live(&self, ready: Ready) -> Arc<str> {
        let Ready { connection, mut pump, pushes, ended } = ready;
        if let Some(result) = ended {
            drop(pump);
            self.forward(pushes).await;
            return match result {
                Ok(()) => "the connection was shut down".into(),
                Err(error) => error_chain(&error),
            };
        }
        let live = async move {
            enum End {
                Pump(Result<(), ConnectionError>),
                Liveness(Arc<str>),
                Shutdown,
            }
            let end = future::or(
                async { End::Pump((&mut pump).await) },
                future::or(
                    async { End::Liveness(watch_liveness(&connection, &self.policy).await) },
                    async {
                        self.wait_for_shutdown().await;
                        End::Shutdown
                    },
                ),
            )
            .await;
            let reason: Arc<str> = match end {
                End::Pump(Ok(())) => "the connection was shut down".into(),
                End::Pump(Err(error)) => error_chain(&error),
                End::Liveness(reason) => {
                    connection.shutdown();
                    let _ = until(Instant::now() + PUMP_SHUTDOWN_GRACE, &mut pump).await;
                    reason
                }
                End::Shutdown => {
                    connection.shutdown();
                    let _ = until(Instant::now() + PUMP_SHUTDOWN_GRACE, &mut pump).await;
                    "the client closed the connection".into()
                }
            };
            // Dropping the pump drops its push sender, which lets the
            // forwarder drain what is queued and finish.
            drop(pump);
            reason
        };
        let (reason, ()) = future::zip(live, self.forward(pushes)).await;
        reason
    }

    /// Moves one connection's pushes onto the event channel, in order.
    async fn forward(&self, pushes: async_channel::Receiver<PushEvent>) {
        while let Ok(push) = pushes.recv().await {
            let event = match push {
                PushEvent::Frame(frame) => HostEvent::Push(frame),
                PushEvent::Lagging => HostEvent::Connection(ConnectionEvent::Lagging),
            };
            if self.events.send(event).await.is_err() {
                // Nobody listens any more: stop supervising.
                self.shared.shut_down.store(true, Ordering::SeqCst);
                self.shared.wake();
                return;
            }
        }
    }

    /// Sends one event. `false` means the receiver is gone and the loop
    /// should stop.
    async fn emit(&self, event: ConnectionEvent) -> bool {
        if self.events.send(HostEvent::Connection(event)).await.is_ok() {
            true
        } else {
            self.shared.shut_down.store(true, Ordering::SeqCst);
            false
        }
    }

    /// Waits out `delay` unless woken. `false` means shut down.
    async fn sleep_unless_woken(&self, delay: Duration) -> bool {
        if !delay.is_zero() {
            future::or(
                async {
                    Timer::after(delay).await;
                },
                async {
                    let _ = self.control.recv().await;
                },
            )
            .await;
        }
        !self.shared.is_shut_down()
    }

    /// Waits for a wake. `false` means shut down.
    async fn wait_for_wake(&self) -> bool {
        let _ = self.control.recv().await;
        !self.shared.is_shut_down()
    }

    /// Resolves once shutdown is requested; other wakes are ignored.
    async fn wait_for_shutdown(&self) {
        while !self.shared.is_shut_down() {
            if self.control.recv().await.is_err() {
                return;
            }
        }
    }
}

/// Probes `host.status` until a probe fails or times out; returns why.
async fn watch_liveness(connection: &Connection, policy: &ReconnectPolicy) -> Arc<str> {
    loop {
        Timer::after(policy.liveness_interval).await;
        match until(Instant::now() + policy.liveness_timeout, connection.host_status()).await {
            None => {
                return format!(
                    "the Runtime Host did not answer host.status within {} ms",
                    policy.liveness_timeout.as_millis()
                )
                .into();
            }
            Some(Err(error)) => return error_chain(&error),
            Some(Ok(_)) => {}
        }
    }
}

fn check_same_host(pinned: &HostAccepted, actual: &HostAccepted) -> Result<(), AttemptError> {
    if actual.root_id != pinned.root_id {
        return Err(AttemptError::HostChanged(format!(
            "the Runtime Host State Root changed from {} to {}",
            pinned.root_id, actual.root_id
        )));
    }
    if actual.selected_protocol != pinned.selected_protocol {
        return Err(AttemptError::HostChanged(format!(
            "the Runtime Host protocol changed from {} to {}",
            pinned.selected_protocol, actual.selected_protocol
        )));
    }
    if actual.composition_id != pinned.composition_id
        || actual.composition_revision != pinned.composition_revision
    {
        return Err(AttemptError::HostChanged(format!(
            "the Runtime Host composition changed from {}@{} to {}@{}",
            pinned.composition_id,
            pinned.composition_revision,
            actual.composition_id,
            actual.composition_revision
        )));
    }
    Ok(())
}

/// `error: source: source…`, for a reason a person reads.
pub fn error_chain(error: &(dyn StdError + 'static)) -> Arc<str> {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.ends_with(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text.into()
}
