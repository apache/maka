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

//! The Host connection of one window, as an observable entity: the local
//! Host of the window's State Root, or one remote Host from the saved
//! profiles.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::{AppContext as _, Context, EventEmitter, SharedString, Task};
use host_client::{
    ConnectionEvent, HostBlocker, HostEvent, LOCAL_PROFILE_ID, LaunchOptions, ReconnectPolicy,
    RemoteConnector, RemoteHostProfile, ResolvedRemoteHost, RootConnector, Supervised,
    SupervisorHandle, client_identity_path, configured_maka_checkout, random_client_instance_id,
    supervise,
};
use host_protocol::{AccessCredential, ClientHello, HostAccepted, PushFrame, RemoteTransport};
use shared::copy::{
    STATUS_CONNECTED, STATUS_CONNECTING, STATUS_DISCONNECTED, STATUS_RECONNECTING, STATUS_STARTING,
    Text,
};

use crate::requester::{HostAccess, HostRequester, HostTransport, SupervisedTransport};

/// Events applied per foreground update. Bounds the work one frame does when
/// the Host sends a burst; the forwarding task yields after each batch, so the
/// rest waits until painting, input, and other foreground tasks have run.
const MAX_EVENTS_PER_UPDATE: usize = 64;

/// Where the connection stands.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum ConnectionStatus {
    /// The first attempt (or one the user asked for) is running.
    Connecting,
    /// No Host answered, so the window started one and waits for it to
    /// register and accept the connection.
    Starting,
    /// A connection is ready for requests.
    Connected,
    /// There is no connection. `reason` says why the last one ended or the
    /// last attempt failed.
    Disconnected { reason: SharedString, retry: RetryState },
}

/// What happens next while disconnected.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub enum RetryState {
    /// Attempt `attempt` is running.
    Attempting { attempt: u32 },
    /// Attempt `attempt` starts after `delay`.
    Waiting { attempt: u32, delay: Duration },
    /// Retrying cannot help; only [`HostSession::reconnect`] resumes.
    Suspended,
}

impl ConnectionStatus {
    pub fn is_connected(&self) -> bool {
        matches!(self, Self::Connected)
    }

    /// A short label for the sidebar footer.
    pub fn label(&self) -> Text {
        match self {
            Self::Connecting => STATUS_CONNECTING,
            Self::Starting => STATUS_STARTING,
            Self::Connected => STATUS_CONNECTED,
            Self::Disconnected { retry: RetryState::Suspended, .. } => STATUS_DISCONNECTED,
            Self::Disconnected { .. } => STATUS_RECONNECTING,
        }
    }
}

/// A remote Host a window talks to: its saved profile and the credential
/// stored for the profile's target.
#[derive(Debug, Clone)]
pub struct RemoteHost {
    profile: RemoteHostProfile,
    credential: AccessCredential,
}

impl RemoteHost {
    pub fn new(profile: RemoteHostProfile, credential: AccessCredential) -> Self {
        Self { profile, credential }
    }

    /// The Host a resolved profile names, when it has a credential and its
    /// pairing finished.
    pub fn from_resolved(resolved: ResolvedRemoteHost) -> Option<Self> {
        if resolved.pairing_pending {
            return None;
        }
        Some(Self::new(resolved.profile, resolved.credential?))
    }

    pub fn profile(&self) -> &RemoteHostProfile {
        &self.profile
    }

    pub fn credential(&self) -> &AccessCredential {
        &self.credential
    }
}

/// Which Host a window talks to.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub enum WindowHost {
    /// The Host of the window's State Root on this machine, started when
    /// none is running.
    #[default]
    Local,
    /// A Host on another machine, reached through its profile's transport.
    Remote(RemoteHost),
}

impl WindowHost {
    /// The profile id the Host selection knows it by: `local` or the remote
    /// profile's.
    pub fn profile_id(&self) -> &str {
        match self {
            Self::Local => LOCAL_PROFILE_ID,
            Self::Remote(remote) => remote.profile.id(),
        }
    }

    pub fn is_remote(&self) -> bool {
        matches!(self, Self::Remote(_))
    }

    /// What its connection's credential allows.
    pub fn access(&self) -> HostAccess {
        match self {
            Self::Local => HostAccess::LocalOwner,
            Self::Remote(_) => HostAccess::RemoteOwner,
        }
    }
}

/// Where a remote profile points, in one short line: the WebSocket's host
/// (and port), or the SSH destination.
pub fn remote_endpoint_label(profile: &RemoteHostProfile) -> SharedString {
    match profile.transport() {
        RemoteTransport::Tls(url) | RemoteTransport::Plaintext(url) => {
            let url = url.as_url();
            let host = url.host_str().unwrap_or_default();
            match url.port() {
                Some(port) => format!("{host}:{port}").into(),
                None => host.to_owned().into(),
            }
        }
        RemoteTransport::Ssh(ssh) => ssh.destination().to_owned().into(),
        _ => SharedString::default(),
    }
}

/// Emitted by [`HostSession`].
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum HostSessionEvent {
    /// [`HostSession::status`] changed.
    StatusChanged,
    /// A connection became ready. `host_changed` is true when it reached a
    /// different Host process than the previous connection: everything read
    /// from the old Host must be read again.
    Connected { host_changed: bool },
    /// A frame the Host sent unasked.
    Push(Arc<PushFrame>),
}

/// Owns the supervised Runtime Host connection of one window.
///
/// The `host-client` supervisor runs on the background executor; its events
/// are applied here on the foreground in batches. Every attempt that finds
/// no Host registered for the State Root starts one
/// ([`host_client::connect_or_spawn`], creating the State Root if needed) and
/// the status reads [`ConnectionStatus::Starting`] until it answers. That
/// Host is ephemeral: once this window disconnects (or the app quits) it
/// exits by itself after its idle grace, so nothing stops it here. The connection itself is
/// never exposed: features send requests through [`Self::requester`] and
/// react to [`HostSessionEvent`]s.
pub struct HostSession {
    root: PathBuf,
    /// The Host this session talks to.
    host: WindowHost,
    status: ConnectionStatus,
    /// Why automatic attempts stopped, when it is something the window
    /// explains on a screen of its own; see [`Self::blocker`].
    blocker: Option<HostBlocker>,
    /// The Maka checkout a Host is started from, read once from the
    /// environment ([`host_client::configured_maka_checkout`]).
    maka_checkout: Option<PathBuf>,
    accepted: Option<HostAccepted>,
    /// Set by `HostEpochChanged`, consumed by the `Connected` that follows.
    host_changed: bool,
    requester: HostRequester,
    supervisor: Option<SupervisorHandle>,
    _tasks: Vec<Task<()>>,
}

impl EventEmitter<HostSessionEvent> for HostSession {}

impl std::fmt::Debug for HostSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostSession")
            .field("root", &self.root)
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

impl HostSession {
    /// Connects to the Host registered for the State Root at `root`,
    /// starting one when none is, and keeps reconnecting. The client instance
    /// id persists across launches.
    pub fn connect(root: PathBuf, cx: &mut Context<Self>) -> Self {
        Self::open(root, WindowHost::Local, cx)
    }

    /// Connects to `host` and keeps reconnecting: the local Host of the
    /// State Root at `root` as [`Self::connect`] does, or a remote Host
    /// through its profile, greeting with the persisted client instance id
    /// its credential was paired with. `root` stays the window's State Root
    /// either way (the app keeps its own files there).
    pub fn open(root: PathBuf, host: WindowHost, cx: &mut Context<Self>) -> Self {
        let identity = client_identity_path();
        if let Err(error) = &identity {
            log::warn!("no config directory for the client identity: {error}");
        }
        let Supervised { handle, run, events, .. } = match &host {
            WindowHost::Local => {
                let connector = match identity {
                    Ok(path) => RootConnector::with_persisted_identity(&root, path),
                    Err(_) => {
                        RootConnector::new(&root, ClientHello::new(random_client_instance_id()))
                    }
                }
                .spawning(LaunchOptions::default());
                supervise(connector, ReconnectPolicy::default())
            }
            WindowHost::Remote(remote) => {
                log::info!("connecting to remote Runtime Host {}", remote.profile.id());
                let (profile, credential) = (remote.profile.clone(), remote.credential.clone());
                let connector = match identity {
                    Ok(path) => RemoteConnector::with_persisted_identity(profile, credential, path),
                    Err(_) => RemoteConnector::new(
                        profile,
                        credential,
                        ClientHello::new(random_client_instance_id()),
                    ),
                };
                supervise(connector, ReconnectPolicy::default())
            }
        };
        let run_task = cx.background_spawn(run);
        let forward_task = Self::forward_events(events, cx);
        let requester = HostRequester::new(Arc::new(SupervisedTransport(handle.clone())))
            .with_access(host.access());
        Self {
            root,
            host,
            status: ConnectionStatus::Connecting,
            blocker: None,
            maka_checkout: configured_maka_checkout(),
            accepted: None,
            host_changed: false,
            requester,
            supervisor: Some(handle),
            _tasks: vec![run_task, forward_task],
        }
    }

    /// A session whose requests go to `transport` and whose connection
    /// events are fed through [`Self::handle_host_event`]. No supervisor
    /// runs; used by tests and previews.
    pub fn with_transport(root: PathBuf, transport: Arc<dyn HostTransport>) -> Self {
        Self {
            root,
            host: WindowHost::Local,
            status: ConnectionStatus::Connecting,
            blocker: None,
            maka_checkout: configured_maka_checkout(),
            accepted: None,
            host_changed: false,
            requester: HostRequester::new(transport),
            supervisor: None,
            _tasks: Vec::new(),
        }
    }

    /// The same session, but for `host`: its requests carry that Host's
    /// access. With [`Self::with_transport`], for tests and previews.
    pub fn for_host(mut self, host: WindowHost) -> Self {
        self.requester = self.requester.clone().with_access(host.access());
        self.host = host;
        self
    }

    /// The window's State Root: the one its local Host serves, and where the
    /// app keeps its own files, whichever Host the session talks to.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The Host this session talks to.
    pub fn host(&self) -> &WindowHost {
        &self.host
    }

    /// Whether it talks to a Host on another machine.
    pub fn is_remote(&self) -> bool {
        self.host.is_remote()
    }

    /// What the connection's credential allows.
    pub fn access(&self) -> HostAccess {
        self.host.access()
    }

    /// A remote Host's name, from its profile; `None` for the local Host,
    /// which the interface names in the current language.
    pub fn remote_name(&self) -> Option<SharedString> {
        match &self.host {
            WindowHost::Local => None,
            WindowHost::Remote(remote) => Some(remote.profile.name().to_owned().into()),
        }
    }

    /// What tells this Host apart in one short word: the State Root's
    /// folder for the local Host, where a remote one points for a remote
    /// Host.
    pub fn host_badge(&self) -> SharedString {
        match &self.host {
            WindowHost::Local => self.root_label(),
            WindowHost::Remote(remote) => remote_endpoint_label(&remote.profile),
        }
    }

    /// The State Root's directory name, which is how a person tells Hosts
    /// apart (the Host has no display name of its own).
    pub fn root_label(&self) -> SharedString {
        self.root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.root.display().to_string())
            .into()
    }

    pub fn status(&self) -> &ConnectionStatus {
        &self.status
    }

    pub fn is_connected(&self) -> bool {
        self.status.is_connected()
    }

    /// What stops every attempt until a person acts: a Host of another
    /// compatibility epoch, or no built Maka checkout to start one from.
    /// Set by a suspension that names one; it stays through a retry the
    /// user asked for and through that attempt's failure, so the screen that
    /// explains it does not flicker, and goes once an attempt gets further
    /// (a Host starting, a connection, an ordinary retry) or a later
    /// suspension names none.
    pub fn blocker(&self) -> Option<&HostBlocker> {
        self.blocker.as_ref()
    }

    /// The Maka checkout this window starts Hosts from: `MAKA_REPO`, else
    /// `~/code/maka-pin`, as it was when the session was created.
    pub fn maka_checkout(&self) -> Option<&Path> {
        self.maka_checkout.as_deref()
    }

    /// The `accepted` frame of the current (or last) connection.
    pub fn accepted(&self) -> Option<&HostAccepted> {
        self.accepted.as_ref()
    }

    /// A handle for typed requests on whatever connection is ready.
    pub fn requester(&self) -> HostRequester {
        self.requester.clone()
    }

    /// Attempts to connect now instead of waiting out the backoff, or after
    /// automatic attempts were suspended.
    pub fn reconnect(&mut self, cx: &mut Context<Self>) {
        let Some(supervisor) = &self.supervisor else {
            return;
        };
        if self.status.is_connected() {
            return;
        }
        supervisor.reconnect_now();
        if let ConnectionStatus::Disconnected { retry, .. } = &mut self.status {
            let attempt = match *retry {
                RetryState::Attempting { attempt } | RetryState::Waiting { attempt, .. } => attempt,
                RetryState::Suspended => 1,
            };
            *retry = RetryState::Attempting { attempt };
            cx.emit(HostSessionEvent::StatusChanged);
            cx.notify();
        }
    }

    /// Applies one supervisor event.
    pub fn handle_host_event(&mut self, event: HostEvent, cx: &mut Context<Self>) {
        let connection = match event {
            HostEvent::Push(frame) => {
                cx.emit(HostSessionEvent::Push(Arc::new(frame)));
                return;
            }
            HostEvent::Connection(connection) => connection,
            _ => return,
        };
        // A failed attempt keeps the blocker, since the suspension that
        // usually follows replaces it; a Host starting, a lost connection or
        // an ordinary retry means the attempts got past it.
        let clears_blocker = matches!(
            connection,
            ConnectionEvent::Disconnected { .. }
                | ConnectionEvent::Reconnecting { .. }
                | ConnectionEvent::HostStarting { .. }
        );
        let status = match connection {
            ConnectionEvent::Connected { accepted } => {
                log::info!(
                    "connected to Runtime Host {} (epoch {}, connection {})",
                    accepted.root_id,
                    accepted.host_epoch,
                    accepted.connection_id
                );
                self.accepted = Some(accepted);
                self.set_blocker(None, cx);
                self.set_status(ConnectionStatus::Connected, cx);
                let host_changed = std::mem::take(&mut self.host_changed);
                cx.emit(HostSessionEvent::Connected { host_changed });
                return;
            }
            ConnectionEvent::HostEpochChanged { previous, current } => {
                log::info!("the Runtime Host restarted (epoch {previous} → {current})");
                self.host_changed = true;
                return;
            }
            ConnectionEvent::Lagging => {
                log::warn!("Runtime Host events arrive faster than the window applies them");
                return;
            }
            ConnectionEvent::Disconnected { reason } => {
                log::warn!("Runtime Host connection lost: {reason}");
                ConnectionStatus::Disconnected {
                    reason: reason.as_ref().into(),
                    retry: RetryState::Attempting { attempt: 1 },
                }
            }
            ConnectionEvent::Reconnecting { attempt, delay } => {
                let retry = if delay.is_zero() {
                    RetryState::Attempting { attempt }
                } else {
                    RetryState::Waiting { attempt, delay }
                };
                ConnectionStatus::Disconnected { reason: self.last_reason(), retry }
            }
            ConnectionEvent::HostStarting { attempt, pid } => {
                log::info!("attempt {attempt} started Runtime Host process {pid}");
                ConnectionStatus::Starting
            }
            ConnectionEvent::AttemptFailed { attempt, reason } => {
                log::info!("Runtime Host connection attempt {attempt} failed: {reason}");
                ConnectionStatus::Disconnected {
                    reason: reason.as_ref().into(),
                    retry: RetryState::Attempting { attempt: attempt.saturating_add(1) },
                }
            }
            ConnectionEvent::Suspended { reason, blocker } => {
                self.set_blocker(blocker, cx);
                ConnectionStatus::Disconnected {
                    reason: reason.as_ref().into(),
                    retry: RetryState::Suspended,
                }
            }
            _ => return,
        };
        if clears_blocker {
            self.set_blocker(None, cx);
        }
        self.set_status(status, cx);
    }

    fn set_blocker(&mut self, blocker: Option<HostBlocker>, cx: &mut Context<Self>) {
        if self.blocker != blocker {
            self.blocker = blocker;
            cx.emit(HostSessionEvent::StatusChanged);
            cx.notify();
        }
    }

    fn last_reason(&self) -> SharedString {
        match &self.status {
            ConnectionStatus::Disconnected { reason, .. } => reason.clone(),
            _ => SharedString::default(),
        }
    }

    fn set_status(&mut self, status: ConnectionStatus, cx: &mut Context<Self>) {
        if self.status != status {
            self.status = status;
            cx.emit(HostSessionEvent::StatusChanged);
            cx.notify();
        }
    }

    /// Moves supervisor events onto the foreground in batches of at most
    /// [`MAX_EVENTS_PER_UPDATE`].
    ///
    /// `events.recv()` completes without suspending while the channel holds an
    /// event, so without an explicit yield the task would keep the main thread
    /// until the channel is empty. After each batch it suspends once and is
    /// rescheduled behind the work already queued on the main thread.
    fn forward_events(
        events: async_channel::Receiver<HostEvent>,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        cx.spawn(async move |this, cx| {
            while let Ok(first) = events.recv().await {
                let mut batch = vec![first];
                while batch.len() < MAX_EVENTS_PER_UPDATE
                    && let Ok(next) = events.try_recv()
                {
                    batch.push(next);
                }
                let applied = this.update(cx, |this, cx| {
                    for event in batch {
                        this.handle_host_event(event, cx);
                    }
                });
                if applied.is_err() {
                    break;
                }
                futures_lite::future::yield_now().await;
            }
        })
    }
}

impl Drop for HostSession {
    fn drop(&mut self) {
        if let Some(supervisor) = &self.supervisor {
            supervisor.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::{Entity, TestAppContext};
    use host_protocol::{ChangeNotice, HostAccepted};
    use serde_json::json;

    use super::*;
    use crate::requester::HostRequestError;
    use host_client::EpochMismatch;

    struct NoTransport;

    impl HostTransport for NoTransport {
        fn request(
            &self,
            _: &'static str,
            _: serde_json::Value,
            _: Duration,
        ) -> futures_lite::future::Boxed<Result<serde_json::Value, HostRequestError>> {
            Box::pin(async { Err(HostRequestError::NotConnected) })
        }
    }

    fn accepted(host_epoch: &str) -> HostAccepted {
        serde_json::from_value(json!({
            "kind": "accepted", "rootId": "r", "hostEpoch": host_epoch, "connectionId": "c",
            "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
            "compositionRevision": "3", "state": "ready"
        }))
        .expect("accepted")
    }

    fn session(cx: &mut TestAppContext) -> (Entity<HostSession>, Entity<Recorder>) {
        let host = cx.new(|_| {
            HostSession::with_transport(PathBuf::from("/tmp/.dev-root"), Arc::new(NoTransport))
        });
        let recorder = cx.new(|cx| Recorder::new(&host, cx));
        (host, recorder)
    }

    struct Recorder {
        events: Vec<String>,
        _subscription: gpui_kit::Subscription,
    }

    impl Recorder {
        fn new(host: &Entity<HostSession>, cx: &mut Context<Self>) -> Self {
            let subscription = cx.subscribe(host, |this, _, event: &HostSessionEvent, _| {
                this.events.push(match event {
                    HostSessionEvent::StatusChanged => "status".to_owned(),
                    HostSessionEvent::Connected { host_changed } => {
                        format!("connected {host_changed}")
                    }
                    HostSessionEvent::Push(_) => "push".to_owned(),
                });
            });
            Self { events: Vec::new(), _subscription: subscription }
        }
    }

    fn feed(host: &Entity<HostSession>, event: ConnectionEvent, cx: &mut TestAppContext) {
        host.update(cx, |host, cx| host.handle_host_event(HostEvent::Connection(event), cx));
    }

    #[gpui_kit::test]
    fn connection_events_drive_the_status(cx: &mut TestAppContext) {
        let (host, recorder) = session(cx);
        host.read_with(cx, |host, _| {
            assert_eq!(host.status(), &ConnectionStatus::Connecting);
            assert_eq!(host.root_label(), ".dev-root");
        });

        feed(&host, ConnectionEvent::AttemptFailed { attempt: 1, reason: "no Host".into() }, cx);
        feed(
            &host,
            ConnectionEvent::Reconnecting { attempt: 2, delay: Duration::from_secs(1) },
            cx,
        );
        host.read_with(cx, |host, _| {
            assert_eq!(
                host.status(),
                &ConnectionStatus::Disconnected {
                    reason: "no Host".into(),
                    retry: RetryState::Waiting { attempt: 2, delay: Duration::from_secs(1) }
                }
            );
            assert_eq!(host.status().label(), STATUS_RECONNECTING);
        });

        feed(&host, ConnectionEvent::Connected { accepted: accepted("e1") }, cx);
        feed(&host, ConnectionEvent::Disconnected { reason: "closed".into() }, cx);
        feed(
            &host,
            ConnectionEvent::HostEpochChanged { previous: "e1".into(), current: "e2".into() },
            cx,
        );
        feed(&host, ConnectionEvent::Connected { accepted: accepted("e2") }, cx);
        host.read_with(cx, |host, _| {
            assert!(host.is_connected());
            assert_eq!(host.accepted().map(|accepted| accepted.host_epoch.as_str()), Some("e2"));
        });
        cx.run_until_parked();
        recorder.read_with(cx, |recorder, _| {
            assert_eq!(
                recorder.events,
                [
                    "status",
                    "status",
                    "status",
                    "connected false",
                    "status",
                    "status",
                    "connected true"
                ]
            );
        });
    }

    #[gpui_kit::test]
    fn starting_a_host_is_a_status_of_its_own(cx: &mut TestAppContext) {
        let (host, recorder) = session(cx);
        feed(&host, ConnectionEvent::HostStarting { attempt: 1, pid: 42 }, cx);
        host.read_with(cx, |host, _| {
            assert_eq!(host.status(), &ConnectionStatus::Starting);
            assert_eq!(host.status().label(), STATUS_STARTING);
            assert!(!host.is_connected());
        });
        feed(&host, ConnectionEvent::AttemptFailed { attempt: 1, reason: "no Node".into() }, cx);
        feed(&host, ConnectionEvent::Suspended { reason: "no Node".into(), blocker: None }, cx);
        host.read_with(cx, |host, _| {
            assert_eq!(
                host.status(),
                &ConnectionStatus::Disconnected {
                    reason: "no Node".into(),
                    retry: RetryState::Suspended
                }
            );
        });
        feed(&host, ConnectionEvent::HostStarting { attempt: 1, pid: 43 }, cx);
        feed(&host, ConnectionEvent::Connected { accepted: accepted("e1") }, cx);
        host.read_with(cx, |host, _| assert!(host.is_connected()));
        cx.run_until_parked();
        recorder.read_with(cx, |recorder, _| {
            assert_eq!(
                recorder.events,
                ["status", "status", "status", "status", "status", "connected false"]
            );
        });
    }

    #[gpui_kit::test]
    fn a_suspension_waits_for_the_user(cx: &mut TestAppContext) {
        let (host, _) = session(cx);
        feed(
            &host,
            ConnectionEvent::Suspended { reason: "incompatible".into(), blocker: None },
            cx,
        );
        host.read_with(cx, |host, _| {
            assert_eq!(
                host.status(),
                &ConnectionStatus::Disconnected {
                    reason: "incompatible".into(),
                    retry: RetryState::Suspended
                }
            );
            assert_eq!(host.status().label(), STATUS_DISCONNECTED);
        });
    }

    #[gpui_kit::test]
    fn a_blocker_stays_through_the_retry_the_user_asked_for(cx: &mut TestAppContext) {
        let (host, recorder) = session(cx);
        let older = HostBlocker::Epoch(EpochMismatch::new(196, None));
        let suspended = |blocker: Option<HostBlocker>| ConnectionEvent::Suspended {
            reason: "the Runtime Host is incompatible with this client".into(),
            blocker,
        };
        feed(&host, ConnectionEvent::AttemptFailed { attempt: 1, reason: "refused".into() }, cx);
        feed(&host, suspended(Some(older.clone())), cx);
        host.read_with(cx, |host, _| {
            assert_eq!(host.blocker(), Some(&older));
            assert_eq!(host.status().label(), STATUS_DISCONNECTED);
        });

        // Retry: the attempt runs and fails again, then the next
        // suspension names what it found this time.
        host.update(cx, |host, cx| host.reconnect(cx));
        host.read_with(cx, |host, _| assert_eq!(host.blocker(), Some(&older)));
        feed(&host, ConnectionEvent::AttemptFailed { attempt: 1, reason: "refused".into() }, cx);
        host.read_with(cx, |host, _| assert_eq!(host.blocker(), Some(&older), "no flicker"));
        let newer = HostBlocker::Epoch(EpochMismatch::new(198, None));
        feed(&host, suspended(Some(newer.clone())), cx);
        host.read_with(cx, |host, _| assert_eq!(host.blocker(), Some(&newer)));

        // A suspension for another reason, a Host starting, or a connection
        // clears it.
        feed(&host, suspended(None), cx);
        host.read_with(cx, |host, _| assert_eq!(host.blocker(), None));
        feed(&host, suspended(Some(older.clone())), cx);
        feed(&host, ConnectionEvent::HostStarting { attempt: 1, pid: 7 }, cx);
        host.read_with(cx, |host, _| assert_eq!(host.blocker(), None));
        feed(&host, suspended(Some(older)), cx);
        feed(&host, ConnectionEvent::Connected { accepted: accepted("e1") }, cx);
        host.read_with(cx, |host, _| assert_eq!(host.blocker(), None));
        cx.run_until_parked();
        recorder.read_with(cx, |recorder, _| {
            assert!(recorder.events.iter().filter(|event| *event == "status").count() >= 8);
        });
    }

    /// Adversarial review 2026-09-26: `forward_events` applies at most
    /// `MAX_EVENTS_PER_UPDATE` events per update so that a burst "waits for
    /// the next turn of the loop", but `events.recv()` completes without
    /// yielding while the channel holds an event. The loop therefore kept
    /// the foreground until the channel was empty: while the Host sent faster
    /// than the window applied frames, nothing else on the foreground
    /// (painting, input, request completions) ran. It now yields after each
    /// batch.
    #[gpui_kit::test]
    fn a_burst_of_events_lets_other_foreground_work_run_between_batches(cx: &mut TestAppContext) {
        let (host, recorder) = session(cx);
        let total = MAX_EVENTS_PER_UPDATE * 8;
        let (sender, events) = async_channel::unbounded();
        for revision in 0..total as u64 {
            let notice = ChangeNotice::ProjectCatalogChanged { revision };
            sender.try_send(HostEvent::Push(PushFrame::Change(notice))).expect("queued");
        }
        // Other foreground work: it notes how many pushes were applied each
        // time it gets to run.
        let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let probe = {
            let (seen, recorder) = (seen.clone(), recorder.clone());
            cx.spawn(|cx| async move {
                loop {
                    let applied = recorder.read_with(&cx, |recorder, _| recorder.events.len());
                    seen.borrow_mut().push(applied);
                    if applied >= total {
                        break;
                    }
                    futures_lite::future::yield_now().await;
                }
            })
        };
        let _forward = host.update(cx, |_, cx| HostSession::forward_events(events, cx));
        cx.run_until_parked();
        drop(probe);
        let seen = seen.borrow();
        assert_eq!(seen.last(), Some(&total), "every event is applied");
        assert!(
            seen.iter().any(|&applied| applied > 0 && applied < total),
            "other foreground work runs between batches, not only before or after the whole \
             burst: {seen:?}"
        );
    }

    #[gpui_kit::test]
    fn push_frames_are_re_emitted(cx: &mut TestAppContext) {
        let (host, recorder) = session(cx);
        host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Push(PushFrame::Change(ChangeNotice::ProjectCatalogChanged {
                    revision: 1,
                })),
                cx,
            )
        });
        cx.run_until_parked();
        recorder.read_with(cx, |recorder, _| assert_eq!(recorder.events, ["push"]));
    }
}
