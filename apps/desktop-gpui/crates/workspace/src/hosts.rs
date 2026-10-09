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

//! The Runtime Hosts a window can talk to: the local Host and the remote
//! ones saved in the client's profile store, which is the default, which
//! are offered for switching, and adding one by pairing.
//!
//! [`HostDirectory`] is the one app-wide owner of that list (Desktop's
//! `DesktopRuntimeHostProfileService` in
//! `apps/desktop/src/main/runtime-host-profile-service.ts`). Settings'
//! Runtime Host block, the settings header's Host picker, and the sidebar
//! footer read it; a window switches Host by building its workbench for
//! the one chosen ([`HostDirectory::resolve`]).
//!
//! Adding a Host runs Desktop's pairing (`addAndEnableVerified`,
//! `#finalizeAccessCredential`) in this order: reach the Host once with the
//! credential ([`HostPairing::probe`]), so a typing mistake saves nothing;
//! save the profile with the credential marked pending; pair
//! ([`host_client::pair_remote_host`]); then mark it paired and enable it.
//! A refusal that proves the pairing did not happen (the credential or the
//! Host refused) removes the profile again, as Desktop's
//! `rollbackPairingIntent` does; any other failure after the probe keeps it,
//! "Pairing unfinished", to retry or discard, since the Host may have
//! finalized.
//!
//! A connection code names a Direct peer Host (Maka issues no other kind);
//! this client cannot dial one yet and says so.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_lite::future::{self, Boxed};
use gpui_kit::{App, AppContext as _, Context, Entity, Global, SharedString, Task};
use host_client::{
    ConnectError, Connected, HostSelection, LOCAL_PROFILE_ID, PairingError, ProfileStoreError,
    RemoteConnectError, RemoteConnectOptions, RemoteHostEntry, RemoteHostProfile,
    RemoteProfileStore, RequestError, SshError, SshFailure, WebSocketError, client_identity_path,
    connect_remote, error_chain, load_or_create_client_instance_id, pair_remote_host,
    random_client_instance_id,
};
use host_protocol::{
    AccessCredential, ClientHello, HostOperationErrorCode, RemoteTransportKind,
    decode_owner_connection_code,
};

use crate::host_session::{RemoteHost, WindowHost};

/// How long a probe waits for the Host to report `ready`.
const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// The budget of one pairing, reconnections included.
const PAIRING_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a connection this module opened may take to close.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// Why a Host could not be added, reached, or paired, in the terms a person
/// can act on. Each has a sentence in `shared::copy::remote_hosts`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HostRefusal {
    /// The text is not a connection code.
    InvalidCode,
    /// The code or profile names a Direct peer Host.
    DirectPeer,
    /// The Host refused the credential: it expired, was used or revoked,
    /// or another client claimed it.
    CredentialRefused,
    /// A Host answered, but not the one the profile names (another State
    /// Root or composition) or one of another protocol epoch.
    WrongHost,
    /// No TCP connection to `address`.
    Unreachable(SharedString),
    /// The TLS certificate of `host` is not one the platform trusts.
    Tls(SharedString),
    /// The Host answered the WebSocket upgrade with this HTTP status (a
    /// wrong path, say).
    UpgradeRefused(u16),
    /// The Host did not complete the handshake in time.
    NoAnswer,
    /// `ssh` could not be run.
    SshMissing,
    /// OpenSSH failed, for this reason.
    Ssh(SshFailure),
    /// The destination's OpenSSH configuration adds port forwarding.
    SshForwarding,
    /// The operator did not start the Host: its message.
    Activation(SharedString),
    /// The Host connected but did not become ready.
    NotReady,
    /// The pairing ran out of time; the Host may or may not have finalized.
    OutcomeUnknown,
    /// The profile store could not be read or written: its message.
    Store(SharedString),
    /// Anything else: the error as it reads.
    Other(SharedString),
}

impl HostRefusal {
    /// Whether it proves the Host did not pair: then the profile saved for
    /// the pairing is removed.
    fn proves_unpaired(&self) -> bool {
        matches!(
            self,
            Self::InvalidCode | Self::DirectPeer | Self::CredentialRefused | Self::WrongHost
        )
    }

    /// `remoteConnectFailure` and `connectionCodeImportFailure`: what a
    /// failed remote connection means.
    pub fn of_connect(error: &RemoteConnectError) -> Self {
        match error {
            RemoteConnectError::UnsupportedTransport(RemoteTransportKind::DirectPeer) => {
                Self::DirectPeer
            }
            RemoteConnectError::Ssh(SshError::Spawn { .. }) => Self::SshMissing,
            RemoteConnectError::Ssh(SshError::Failed { failure, .. }) => Self::Ssh(*failure),
            RemoteConnectError::Ssh(SshError::ForwardingConfigured { .. }) => Self::SshForwarding,
            RemoteConnectError::Ssh(SshError::Activation(error)) => {
                Self::Activation(error.to_string().into())
            }
            RemoteConnectError::Connect(error) => match error {
                ConnectError::WebSocket(WebSocketError::AuthenticationFailed) => {
                    Self::CredentialRefused
                }
                ConnectError::WebSocket(WebSocketError::Unreachable { address, .. }) => {
                    Self::Unreachable(address.clone().into())
                }
                ConnectError::WebSocket(WebSocketError::Tls { host, .. }) => {
                    Self::Tls(host.clone().into())
                }
                ConnectError::WebSocket(WebSocketError::UpgradeRefused(status)) => {
                    Self::UpgradeRefused(*status)
                }
                ConnectError::Timeout(_) => Self::NoAnswer,
                ConnectError::RootMismatch { .. }
                | ConnectError::CompositionMismatch { .. }
                | ConnectError::Incompatible(_)
                | ConnectError::CompatibilityEpochMismatch { .. }
                | ConnectError::ProtocolOutOfRange(_) => Self::WrongHost,
                other => Self::Other(error_chain(other).to_string().into()),
            },
            other => Self::Other(error_chain(other).to_string().into()),
        }
    }

    /// What a failed pairing means.
    pub fn of_pairing(error: &PairingError) -> Self {
        match error {
            PairingError::Connect(error) => Self::of_connect(error),
            PairingError::NotReady(_) => Self::NotReady,
            PairingError::Finalize(RequestError::Operation { error, .. })
                if matches!(
                    error.code,
                    HostOperationErrorCode::InvalidRequest | HostOperationErrorCode::Unauthorized
                ) =>
            {
                Self::CredentialRefused
            }
            PairingError::TimedOut(_) => Self::OutcomeUnknown,
            other => Self::Other(error_chain(other).to_string().into()),
        }
    }

    fn of_store(error: &ProfileStoreError) -> Self {
        Self::Store(error_chain(error).to_string().into())
    }
}

/// Reaches and pairs remote Hosts. [`LivePairing`] does it over the
/// network; tests script it.
pub trait HostPairing: Send + Sync + 'static {
    /// Connects once with `credential` and waits for the Host to be ready,
    /// then closes: the Host is there and takes the credential.
    fn probe(
        &self,
        profile: RemoteHostProfile,
        credential: AccessCredential,
    ) -> Boxed<Result<(), HostRefusal>>;

    /// Pairs with `credential` ([`host_client::pair_remote_host`]): once it
    /// succeeds, the credential is active for this client.
    fn pair(
        &self,
        profile: RemoteHostProfile,
        credential: AccessCredential,
    ) -> Boxed<Result<(), HostRefusal>>;
}

/// Pairing over the network, greeting with the persisted client instance
/// id (a credential the Host binds at pairing works only with the id that
/// paired it).
#[derive(Debug, Clone)]
pub struct LivePairing {
    identity: Option<PathBuf>,
    options: RemoteConnectOptions,
}

impl Default for LivePairing {
    fn default() -> Self {
        Self { identity: client_identity_path().ok(), options: RemoteConnectOptions::default() }
    }
}

impl LivePairing {
    /// Pairing that greets with the id stored at `identity` and connects
    /// with `options` (the `ssh` to run).
    pub fn new(identity: Option<PathBuf>, options: RemoteConnectOptions) -> Self {
        Self { identity, options }
    }

    async fn hello(identity: Option<PathBuf>) -> ClientHello {
        let id = match identity {
            Some(path) => match load_or_create_client_instance_id(&path).await {
                Ok(identity) => identity.id,
                Err(error) => {
                    log::warn!(
                        "pairing with a one-off client instance id: {}",
                        error_chain(&error)
                    );
                    random_client_instance_id()
                }
            },
            None => random_client_instance_id(),
        };
        ClientHello::new(id)
    }
}

/// Shuts `connection` down and lets its pump close the transport, for at
/// most [`CLOSE_GRACE`].
async fn close(connection: host_client::Connection, pump: host_client::ConnectionPump) {
    connection.shutdown();
    future::or(
        async {
            let _ = pump.await;
        },
        async {
            async_io::Timer::after(CLOSE_GRACE).await;
        },
    )
    .await;
}

impl HostPairing for LivePairing {
    fn probe(
        &self,
        profile: RemoteHostProfile,
        credential: AccessCredential,
    ) -> Boxed<Result<(), HostRefusal>> {
        let (identity, options) = (self.identity.clone(), self.options.clone());
        Box::pin(async move {
            let hello = Self::hello(identity).await;
            let connected = connect_remote(&profile, &credential, hello, &options)
                .await
                .map_err(|error| HostRefusal::of_connect(&error))?;
            let Connected { connection, mut pump, .. } = connected;
            let ready = future::or(
                async {
                    connection
                        .wait_until_ready(READY_TIMEOUT)
                        .await
                        .map(|_| ())
                        .map_err(|_| HostRefusal::NotReady)
                },
                async {
                    let _ = (&mut pump).await;
                    Err(HostRefusal::NotReady)
                },
            )
            .await;
            close(connection, pump).await;
            ready
        })
    }

    fn pair(
        &self,
        profile: RemoteHostProfile,
        credential: AccessCredential,
    ) -> Boxed<Result<(), HostRefusal>> {
        let (identity, options) = (self.identity.clone(), self.options.clone());
        Box::pin(async move {
            let hello = Self::hello(identity).await;
            match pair_remote_host(&profile, &credential, hello, &options, PAIRING_TIMEOUT).await {
                Ok(Connected { connection, pump, .. }) => {
                    close(connection, pump).await;
                    Ok(())
                }
                Err(error) => {
                    log::warn!("pairing {} failed: {}", profile.id(), error_chain(&error));
                    Err(HostRefusal::of_pairing(&error))
                }
            }
        })
    }
}

/// How a Host is being added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum AddMethod {
    ConnectionCode,
    Manual,
}

/// What the directory is doing for the person, one thing at a time.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HostAction {
    SetDefault(SharedString),
    SetEnabled(SharedString),
    Remove(SharedString),
    /// Reaching, then pairing with, a new Host.
    Add(AddMethod),
    RetryPairing(SharedString),
}

/// How the last action ended.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HostOutcome {
    /// A Host was added and enabled.
    Added { profile_id: SharedString, name: SharedString },
    /// `action` did not happen, or did not finish: why.
    Refused { action: HostAction, refusal: HostRefusal },
}

/// The local Host and the saved remote ones, with the selection.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct HostList {
    pub selection: HostSelection,
    /// Every saved remote profile, in the order they were added.
    pub remotes: Vec<RemoteHostEntry>,
}

/// One Host a window can be switched to.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct HostChoice {
    /// `local` or a remote profile's id.
    pub profile_id: SharedString,
    /// A remote Host's name; `None` for the local Host.
    pub name: Option<SharedString>,
}

impl HostList {
    pub fn default_profile_id(&self) -> &str {
        self.selection.default_profile_id()
    }

    pub fn is_enabled(&self, profile_id: &str) -> bool {
        self.selection.is_enabled(profile_id)
    }

    pub fn remote(&self, profile_id: &str) -> Option<&RemoteHostEntry> {
        self.remotes.iter().find(|entry| entry.profile.id() == profile_id)
    }

    /// The Hosts a window can switch to: the local Host, then each enabled
    /// remote one with a credential and a finished pairing, in the order
    /// they were added.
    pub fn choices(&self) -> Vec<HostChoice> {
        let local = HostChoice { profile_id: LOCAL_PROFILE_ID.into(), name: None };
        std::iter::once(local)
            .chain(
                self.remotes
                    .iter()
                    .filter(|entry| {
                        self.is_enabled(entry.profile.id())
                            && entry.has_credential
                            && !entry.pairing_pending
                    })
                    .map(|entry| HostChoice {
                        profile_id: entry.profile.id().to_owned().into(),
                        name: Some(entry.profile.name().to_owned().into()),
                    }),
            )
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ListState {
    Loading,
    Loaded(HostList),
    Failed(SharedString),
}

struct GlobalHostDirectory(Entity<HostDirectory>);

impl Global for GlobalHostDirectory {}

/// The app's Runtime Hosts: behavior owner of the profile store's list and
/// selection, and of adding a Host. One action runs at a time; another is
/// refused until it ends. Observe it for changes.
pub struct HostDirectory {
    store: Arc<RemoteProfileStore>,
    pairing: Arc<dyn HostPairing>,
    list: ListState,
    action: Option<HostAction>,
    outcome: Option<HostOutcome>,
    generation: u64,
    _load: Option<Task<()>>,
    _action: Option<Task<()>>,
}

impl std::fmt::Debug for HostDirectory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostDirectory")
            .field("store", &self.store.directory())
            .field("list", &self.list)
            .field("action", &self.action)
            .finish_non_exhaustive()
    }
}

impl HostDirectory {
    /// The directory of `store`, pairing through `pairing`, read at once.
    pub fn new(
        store: RemoteProfileStore,
        pairing: Arc<dyn HostPairing>,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self {
            store: Arc::new(store),
            pairing,
            list: ListState::Loading,
            action: None,
            outcome: None,
            generation: 0,
            _load: None,
            _action: None,
        };
        this.reload(cx);
        this
    }

    /// Makes `directory` the one every window reads.
    pub fn install(directory: Entity<Self>, cx: &mut App) {
        cx.set_global(GlobalHostDirectory(directory));
    }

    /// The installed directory; `None` in tests and previews that have
    /// none, where no Host block or picker shows.
    pub fn global(cx: &App) -> Option<Entity<Self>> {
        cx.try_global::<GlobalHostDirectory>().map(|global| global.0.clone())
    }

    /// The store's directory.
    pub fn store_directory(&self) -> &std::path::Path {
        self.store.directory()
    }

    /// The list, once read.
    pub fn list(&self) -> Option<&HostList> {
        match &self.list {
            ListState::Loaded(list) => Some(list),
            _ => None,
        }
    }

    /// Why the list could not be read, while no list has been.
    pub fn load_error(&self) -> Option<&SharedString> {
        match &self.list {
            ListState::Failed(message) => Some(message),
            _ => None,
        }
    }

    /// The action running now.
    pub fn action(&self) -> Option<&HostAction> {
        self.action.as_ref()
    }

    pub fn is_busy(&self) -> bool {
        self.action.is_some()
    }

    /// How the last action ended, until the next one starts.
    pub fn outcome(&self) -> Option<&HostOutcome> {
        self.outcome.as_ref()
    }

    /// Forgets the last outcome (the add form closed).
    pub fn clear_outcome(&mut self, cx: &mut Context<Self>) {
        if self.outcome.take().is_some() {
            cx.notify();
        }
    }

    /// Reads the profiles and the selection again. A newer read supersedes
    /// an older one; the list shown stays until it answers.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let store = self.store.clone();
        let read = cx.background_spawn(async move {
            let remotes = store.entries().await?;
            let selection = store.selection().await?;
            Ok::<_, ProfileStoreError>(HostList { selection, remotes })
        });
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                match result {
                    Ok(list) => this.list = ListState::Loaded(list),
                    Err(error) => {
                        log::warn!("could not read the Runtime Host profiles: {error}");
                        if this.list().is_none() {
                            this.list = ListState::Failed(error_chain(&error).to_string().into());
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// The Host `profile_id` names, for a window to switch to.
    pub fn resolve(&self, profile_id: &str, cx: &App) -> Task<Result<WindowHost, HostRefusal>> {
        if profile_id == LOCAL_PROFILE_ID {
            return Task::ready(Ok(WindowHost::Local));
        }
        let store = self.store.clone();
        let profile_id = profile_id.to_owned();
        cx.background_spawn(async move {
            let resolved =
                store.resolve(&profile_id).await.map_err(|e| HostRefusal::of_store(&e))?;
            RemoteHost::from_resolved(resolved)
                .map(WindowHost::Remote)
                .ok_or(HostRefusal::CredentialRefused)
        })
    }

    /// The Host a window opens on at launch: `requested` (`--host`) when
    /// given, else the default. One that cannot be used (unknown, no
    /// credential, an unfinished pairing) falls back to the local Host, with
    /// a warning in the log, so the window always opens.
    pub fn launch_host(&self, requested: Option<&str>, cx: &App) -> Task<WindowHost> {
        let store = self.store.clone();
        let requested = requested.map(str::to_owned);
        cx.background_spawn(async move {
            let id = match requested {
                Some(id) => id,
                None => match store.selection().await {
                    Ok(selection) => selection.default_profile_id().to_owned(),
                    Err(error) => {
                        log::warn!("could not read the Host selection: {}", error_chain(&error));
                        return WindowHost::Local;
                    }
                },
            };
            if id == LOCAL_PROFILE_ID {
                return WindowHost::Local;
            }
            match store.resolve(&id).await.map(RemoteHost::from_resolved) {
                Ok(Some(remote)) => WindowHost::Remote(remote),
                Ok(None) => {
                    log::warn!(
                        "Runtime Host {id} has no usable credential; opening the local Host"
                    );
                    WindowHost::Local
                }
                Err(error) => {
                    log::warn!(
                        "Runtime Host {id}: {}; opening the local Host",
                        error_chain(&error)
                    );
                    WindowHost::Local
                }
            }
        })
    }

    /// Makes `profile_id` the Host a window opens on (it must be enabled).
    pub fn set_default(&mut self, profile_id: &str, cx: &mut Context<Self>) {
        let id: SharedString = profile_id.to_owned().into();
        self.run(HostAction::SetDefault(id.clone()), cx, move |store, _| {
            Box::pin(async move {
                store.set_default(&id).await.map(|_| ()).map_err(|e| HostRefusal::of_store(&e))
            })
        });
    }

    /// Offers the remote Host `profile_id` for switching, or stops.
    pub fn set_enabled(&mut self, profile_id: &str, enabled: bool, cx: &mut Context<Self>) {
        let id: SharedString = profile_id.to_owned().into();
        self.run(HostAction::SetEnabled(id.clone()), cx, move |store, _| {
            Box::pin(async move {
                store
                    .set_enabled(&id, enabled)
                    .await
                    .map(|_| ())
                    .map_err(|e| HostRefusal::of_store(&e))
            })
        });
    }

    /// Removes the remote Host `profile_id` and its credential (it must be
    /// disabled and not the default), or discards an unfinished pairing.
    pub fn remove(&mut self, profile_id: &str, cx: &mut Context<Self>) {
        let id: SharedString = profile_id.to_owned().into();
        self.run(HostAction::Remove(id.clone()), cx, move |store, _| {
            Box::pin(async move {
                store.remove(&id).await.map(|_| ()).map_err(|e| HostRefusal::of_store(&e))
            })
        });
    }

    /// Adds the Host a connection code names. A Direct peer code is refused.
    pub fn import_code(&mut self, code: &str, cx: &mut Context<Self>) {
        let decoded = decode_owner_connection_code(code.trim());
        let action = HostAction::Add(AddMethod::ConnectionCode);
        let prepared = match decoded {
            Err(error) => {
                log::info!("{error}");
                Err(HostRefusal::InvalidCode)
            }
            Ok(code) if code.transport.kind() == RemoteTransportKind::DirectPeer => {
                Err(HostRefusal::DirectPeer)
            }
            Ok(code) => RemoteHostProfile::from_connection_code(&code)
                .map(|profile| (profile, code.credential))
                .map_err(|error| HostRefusal::Other(error.to_string().into())),
        };
        match prepared {
            Ok((profile, credential)) => self.add_paired(action, profile, credential, cx),
            Err(refusal) => {
                if self.action.is_none() {
                    self.outcome = Some(HostOutcome::Refused { action, refusal });
                    cx.notify();
                }
            }
        }
    }

    /// Adds the Host `profile` names with `credential`, from the manual
    /// form.
    pub fn add_manual(
        &mut self,
        profile: RemoteHostProfile,
        credential: AccessCredential,
        cx: &mut Context<Self>,
    ) {
        self.add_paired(HostAction::Add(AddMethod::Manual), profile, credential, cx);
    }

    /// Pairs again with the credential saved for `profile_id`, whose
    /// pairing did not finish.
    pub fn retry_pairing(&mut self, profile_id: &str, cx: &mut Context<Self>) {
        let id: SharedString = profile_id.to_owned().into();
        self.run(HostAction::RetryPairing(id.clone()), cx, move |store, pairing| {
            Box::pin(async move {
                let resolved = store.resolve(&id).await.map_err(|e| HostRefusal::of_store(&e))?;
                let credential = resolved.credential.ok_or(HostRefusal::CredentialRefused)?;
                pair_and_enable(&store, &*pairing, resolved.profile, credential).await.map(|_| ())
            })
        });
    }

    fn add_paired(
        &mut self,
        action: HostAction,
        profile: RemoteHostProfile,
        credential: AccessCredential,
        cx: &mut Context<Self>,
    ) {
        let (id, name): (SharedString, SharedString) =
            (profile.id().to_owned().into(), profile.name().to_owned().into());
        let added = HostOutcome::Added { profile_id: id, name };
        self.run_then(action, Some(added), cx, move |store, pairing| {
            Box::pin(async move {
                // Reach it first: a mistake in the address or the
                // credential saves nothing.
                pairing.probe(profile.clone(), credential.clone()).await?;
                store
                    .create_pending(&profile, &credential)
                    .await
                    .map_err(|e| HostRefusal::of_store(&e))?;
                pair_and_enable(&store, &*pairing, profile, credential).await
            })
        });
    }

    fn run(
        &mut self,
        action: HostAction,
        cx: &mut Context<Self>,
        work: impl FnOnce(
            Arc<RemoteProfileStore>,
            Arc<dyn HostPairing>,
        ) -> Boxed<Result<(), HostRefusal>>,
    ) {
        self.run_then(action, None, cx, work);
    }

    /// Runs `work` on the background executor as `action`, then reads the
    /// list again and keeps how it ended (`done` when it succeeded).
    fn run_then(
        &mut self,
        action: HostAction,
        done: Option<HostOutcome>,
        cx: &mut Context<Self>,
        work: impl FnOnce(
            Arc<RemoteProfileStore>,
            Arc<dyn HostPairing>,
        ) -> Boxed<Result<(), HostRefusal>>,
    ) {
        if self.action.is_some() {
            return;
        }
        log::info!("Runtime Host action {action:?}");
        let task = cx.background_spawn(work(self.store.clone(), self.pairing.clone()));
        self.action = Some(action.clone());
        self.outcome = None;
        cx.notify();
        self._action = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                this.action = None;
                this.outcome = match result {
                    Ok(()) => done,
                    Err(refusal) => Some(HostOutcome::Refused { action, refusal }),
                };
                this.reload(cx);
                cx.notify();
            })
            .ok();
        }));
    }
}

/// Pairs with the credential saved pending for `profile`, then marks it
/// paired and enables it. A refusal that proves the pairing did not happen
/// removes the profile; any other keeps it pending.
async fn pair_and_enable(
    store: &RemoteProfileStore,
    pairing: &dyn HostPairing,
    profile: RemoteHostProfile,
    credential: AccessCredential,
) -> Result<(), HostRefusal> {
    let id = profile.id().to_owned();
    if let Err(refusal) = pairing.pair(profile, credential).await {
        if refusal.proves_unpaired()
            && let Err(error) = store.remove(&id).await
        {
            log::warn!("could not remove the unpaired Runtime Host {id}: {error}");
        }
        return Err(refusal);
    }
    store.mark_paired(&id).await.map_err(|e| HostRefusal::of_store(&e))?;
    store.set_enabled(&id, true).await.map_err(|e| HostRefusal::of_store(&e))?;
    Ok(())
}
