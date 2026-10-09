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

//! The bot sidecar as an observable GPUI entity.
//!
//! [`BotService`] owns the chat bots of one State Root: their settings
//! (`bot-chat.json`, read once and then kept as last written), the sidecar
//! (its supervisor on the background executor), and what the sidecar reports
//! (the channel statuses, its connection to the Host). It runs the sidecar
//! while its Host is known and a channel is enabled, or while a settings
//! page holds it (a channel is tested before it is enabled), and stops it
//! when neither holds and when the app quits.
//!
//! It offers the settings actions Desktop's bot page calls (`settings:bots:*`
//! and `settings:testBotChannel` in
//! apps/desktop/src/main/settings-bots-ipc-main.ts) as tasks: each reads or
//! writes `bot-chat.json` and hands the result to the sidecar. It is the
//! only owner of the credentials: a page reads a channel as a
//! [`ChannelSummary`], which says whether a secret is saved but not what it
//! is, and a confirmed QR onboarding's credentials go from the sidecar into
//! the file without passing through any page.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::{AppContext as _, Context, EventEmitter, SharedString, Subscription, Task};
use host_protocol::WorkspaceTarget;
use thiserror::Error;

use crate::launch::{BotHost, LaunchOptions, LaunchRefusal, prepare_launch};
use crate::protocol::{
    BotTestResult, ChannelStatus, HostLinkState, OnboardingBrand, OnboardingSnapshot,
    WechatBridgeQr,
};
use crate::settings::{
    BotChannelSettings, BotChatSettings, BotProvider, BotSettingsError, BotSettingsStore,
    ChannelSummary,
};
use crate::supervisor::{BotCommandError, BotEvent, BotHandle, RestartPolicy, SupervisedBots};

/// Events applied per foreground update, as `HostSession` batches its own.
const MAX_EVENTS_PER_UPDATE: usize = 64;

/// Starts the sidecar for a Host: by default [`prepare_launch`], then
/// [`crate::PreparedLaunch::supervise`] ([`launcher`]). Tests supply their
/// own.
pub type BotLauncher =
    Arc<dyn Fn(BotHost) -> Boxed<Result<SupervisedBots, LaunchRefusal>> + Send + Sync>;

/// The launcher the app uses: the checkout, Node, and directories found as
/// `options` says, supervised with `policy`.
pub fn launcher(options: LaunchOptions, policy: RestartPolicy) -> BotLauncher {
    Arc::new(move |host| {
        let (options, policy) = (options.clone(), policy.clone());
        Box::pin(async move { Ok(prepare_launch(&host, &options).await?.supervise(policy)) })
    })
}

/// Where the sidecar stands.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum BotServiceState {
    /// No sidecar: no channel is enabled and no page holds the service, or
    /// its Host is not known yet.
    Idle,
    /// Checking the Host, the lock, the checkout and Node.
    Preparing,
    /// The sidecar process is starting.
    Starting,
    Running {
        pid: u32,
    },
    /// The sidecar exited; it starts again after `restart_in`.
    Restarting {
        reason: SharedString,
        restart_in: Duration,
    },
    /// The bots cannot run as things are: a remote Host, another window or
    /// client serving this State Root, no built checkout, no Node. Only
    /// [`BotService::restart`] tries again.
    Unavailable {
        reason: SharedString,
        held_elsewhere: bool,
    },
}

/// Emitted by [`BotService`].
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum BotServiceEvent {
    StateChanged,
    /// [`BotService::channel_status`] of this provider changed.
    StatusChanged(BotProvider),
    /// [`BotService::host_link`] changed.
    HostLinkChanged,
    /// The saved settings were read or written: [`BotService::channel`] may
    /// say something new.
    SettingsChanged,
}

/// A settings action that did not complete.
#[derive(Debug, Clone, Error)]
#[non_exhaustive]
pub enum BotServiceError {
    #[error("the chat bots are not running")]
    NotStarted,
    #[error(transparent)]
    Settings(Arc<BotSettingsError>),
    #[error(transparent)]
    Command(#[from] BotCommandError),
    /// The service went away while the action ran.
    #[error("the chat bots were closed")]
    Closed,
}

impl From<BotSettingsError> for BotServiceError {
    fn from(error: BotSettingsError) -> Self {
        Self::Settings(Arc::new(error))
    }
}

/// Owns the chat bots of one State Root.
pub struct BotService {
    store: Arc<BotSettingsStore>,
    /// The saved settings as last read or written; `None` until the first
    /// read ends.
    settings: Option<BotChatSettings>,
    /// Why the settings could not be read; nothing starts until they are.
    settings_error: Option<SharedString>,
    state: BotServiceState,
    statuses: BTreeMap<BotProvider, ChannelStatus>,
    host_link: Option<HostLinkState>,
    handle: Option<BotHandle>,
    /// A sidecar asked to stop; the next start waits for it to release the
    /// State Root's lock.
    retiring: Option<BotHandle>,
    /// Where bot Sessions go; handed to every sidecar this entity starts.
    workspace: Option<WorkspaceTarget>,
    /// The Host the bots follow ([`Self::set_host`]).
    host: Option<BotHost>,
    /// Settings pages keeping the sidecar running.
    holds: usize,
    launcher: BotLauncher,
    /// The Host of the sidecar started last, while it runs or was refused:
    /// what [`Self::restart`] starts again.
    launched: Option<BotHost>,
    /// Onboarding sessions cancelled here: a confirmation still on its way
    /// is not saved.
    cancelled_onboardings: HashSet<String>,
    /// Bumped by every start and stop; a preparation that finishes after a
    /// newer one began is dropped.
    generation: u64,
    /// The first read of the settings.
    _load: Task<()>,
    tasks: Vec<Task<()>>,
    _quit: Subscription,
}

impl EventEmitter<BotServiceEvent> for BotService {}

impl std::fmt::Debug for BotService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BotService")
            .field("state", &self.state)
            .field("statuses", &self.statuses.len())
            .field("holds", &self.holds)
            .finish_non_exhaustive()
    }
}

impl BotService {
    /// A service whose settings live in `store`, which it starts reading.
    /// No sidecar runs until [`Self::set_host`] names a Host.
    pub fn new(store: Arc<BotSettingsStore>, cx: &mut Context<Self>) -> Self {
        let quit = cx.on_app_quit(|this, _| {
            let handle = this.handle.take();
            async move {
                if let Some(handle) = handle {
                    handle.shutdown().await;
                }
            }
        });
        let read = cx.background_spawn({
            let store = store.clone();
            async move { store.load().await }
        });
        let load = cx.spawn(async move |this, cx| {
            let loaded = read.await;
            let _ = this.update(cx, |this, cx| match loaded {
                Ok(settings) => this.set_settings(settings, cx),
                Err(error) => {
                    log::warn!("the bot settings cannot be read: {error}");
                    this.settings_error = Some(error.to_string().into());
                    cx.emit(BotServiceEvent::SettingsChanged);
                    cx.notify();
                }
            });
        });
        Self {
            store,
            settings: None,
            settings_error: None,
            state: BotServiceState::Idle,
            statuses: BTreeMap::new(),
            host_link: None,
            handle: None,
            retiring: None,
            workspace: None,
            host: None,
            holds: 0,
            launcher: launcher(LaunchOptions::default(), RestartPolicy::default()),
            launched: None,
            cancelled_onboardings: HashSet::new(),
            generation: 0,
            _load: load,
            tasks: Vec::new(),
            _quit: quit,
        }
    }

    /// Starts sidecars with `launcher` instead of [`launcher`]'s defaults.
    pub fn with_launcher(mut self, launcher: BotLauncher) -> Self {
        self.launcher = launcher;
        self
    }

    pub fn state(&self) -> &BotServiceState {
        &self.state
    }

    /// Whether a sidecar is ready for commands.
    pub fn is_running(&self) -> bool {
        matches!(self.state, BotServiceState::Running { .. })
    }

    /// The last status the sidecar reported for `provider`.
    pub fn channel_status(&self, provider: BotProvider) -> Option<&ChannelStatus> {
        self.statuses.get(&provider)
    }

    /// The sidecar's connection to the Runtime Host.
    pub fn host_link(&self) -> Option<&HostLinkState> {
        self.host_link.as_ref()
    }

    pub fn store(&self) -> &Arc<BotSettingsStore> {
        &self.store
    }

    /// `provider`'s saved channel without its secrets; `None` until the
    /// settings are read.
    pub fn channel(&self, provider: BotProvider) -> Option<ChannelSummary> {
        self.settings.as_ref().map(|settings| settings.channel(provider).summary())
    }

    /// Why the saved settings could not be read.
    pub fn settings_error(&self) -> Option<&SharedString> {
        self.settings_error.as_ref()
    }

    /// The Host the bots answer through: the window's, once it is known
    /// (`None` while it is not). A remote Host ends in
    /// [`BotServiceState::Unavailable`] once a channel wants the bots.
    pub fn set_host(&mut self, host: Option<BotHost>, cx: &mut Context<Self>) {
        if self.host == host {
            return;
        }
        self.host = host;
        if self.launched.is_some() {
            // A sidecar serves one State Root.
            self.halt(cx);
        }
        self.reconcile(cx);
    }

    /// Keeps the sidecar running while a settings page shows, so a channel
    /// can be tested before it is enabled. Undo with [`Self::release`].
    pub fn hold(&mut self, cx: &mut Context<Self>) {
        self.holds += 1;
        self.reconcile(cx);
    }

    pub fn release(&mut self, cx: &mut Context<Self>) {
        self.holds = self.holds.saturating_sub(1);
        self.reconcile(cx);
    }

    /// Whether the sidecar should run: a Host is known, the settings are
    /// read, and a channel is enabled or a page holds the service.
    fn wanted(&self) -> bool {
        let Some(settings) = &self.settings else {
            return false;
        };
        self.host.is_some()
            && (self.holds > 0 || settings.channels().any(|channel| channel.enabled))
    }

    /// Starts or stops the sidecar as [`Self::wanted`] says.
    fn reconcile(&mut self, cx: &mut Context<Self>) {
        match (self.wanted(), self.launched.is_some()) {
            (true, false) => {
                if let Some(host) = self.host.clone() {
                    self.launch(host, cx);
                }
            }
            (false, true) => {
                self.halt(cx);
            }
            _ => {}
        }
    }

    /// Starts a sidecar for `host`, replacing any this entity runs.
    fn launch(&mut self, host: BotHost, cx: &mut Context<Self>) {
        let previous = self.shut_down_current().or_else(|| self.retiring.take());
        self.launched = Some(host.clone());
        let generation = self.generation;
        self.statuses.clear();
        self.host_link = None;
        self.set_state(BotServiceState::Preparing, cx);
        let launcher = self.launcher.clone();
        let prepare = cx.background_spawn(async move {
            // The previous sidecar holds the State Root's lock until it exits.
            if let Some(previous) = previous {
                previous.shutdown().await;
            }
            launcher(host).await
        });
        let task = cx.spawn(async move |this, cx| {
            let prepared = prepare.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match prepared {
                    Ok(supervised) => this.attach(supervised, cx),
                    Err(refusal) => {
                        log::warn!("chat bots not started: {refusal}");
                        let held_elsewhere = refusal.is_held_elsewhere();
                        this.set_state(
                            BotServiceState::Unavailable {
                                reason: refusal.to_string().into(),
                                held_elsewhere,
                            },
                            cx,
                        );
                    }
                }
            });
        });
        self.tasks.push(task);
    }

    /// Runs `supervised` (from [`crate::PreparedLaunch::supervise`] or
    /// [`crate::supervise`]) and hands it the saved settings and the
    /// workspace.
    pub fn attach(&mut self, supervised: SupervisedBots, cx: &mut Context<Self>) {
        let SupervisedBots { handle, run, events, .. } = supervised;
        // Detached: the supervisor ends by itself after a shutdown, or when
        // every handle is gone, and kills the sidecar if the app exits first.
        cx.background_spawn(run).detach();
        let forward_task = Self::forward_events(events, cx);
        let store = self.store.clone();
        let workspace = self.workspace.clone();
        let apply = handle.clone();
        let apply_task = cx.background_spawn(async move {
            // Recorded by the supervisor, so they reach the sidecar once it
            // is ready, and every sidecar after it.
            if let Some(workspace) = workspace {
                let _ = apply.set_workspace(Some(workspace)).await;
            }
            match store.load().await {
                Ok(settings) => {
                    if let Err(error) = apply.apply_settings(settings).await {
                        log::warn!("applying the bot settings failed: {error}");
                    }
                }
                Err(error) => log::warn!("the bot settings cannot be read: {error}"),
            }
        });
        self.handle = Some(handle);
        self.tasks.extend([forward_task, apply_task]);
        self.set_state(BotServiceState::Starting, cx);
    }

    /// Starts the sidecar again now: after a crash, without waiting for the
    /// backoff; after a refusal, on the same Host.
    pub fn restart(&mut self, cx: &mut Context<Self>) {
        if let Some(handle) = &self.handle {
            handle.restart();
            return;
        }
        if let Some(host) = self.launched.clone().or_else(|| self.host.clone())
            && self.wanted()
        {
            self.launch(host, cx);
        }
    }

    /// Stops the sidecar and forgets the Host; the task completes once the
    /// sidecar has exited.
    pub fn stop(&mut self, cx: &mut Context<Self>) -> Task<()> {
        self.host = None;
        let handle = self.halt(cx);
        cx.background_spawn(async move {
            if let Some(handle) = handle {
                handle.shutdown().await;
            }
        })
    }

    /// Stops the sidecar and returns its handle to wait on; the handle stays
    /// as the retiring one, so a start that follows waits for it too.
    fn halt(&mut self, cx: &mut Context<Self>) -> Option<BotHandle> {
        let handle = self.shut_down_current();
        self.launched = None;
        self.statuses.clear();
        self.host_link = None;
        self.set_state(BotServiceState::Idle, cx);
        if let Some(handle) = handle.clone() {
            self.retiring = Some(handle.clone());
            cx.background_spawn(async move { handle.shutdown().await }).detach();
        }
        handle
    }

    /// Where bot Sessions are created: the project new tasks go into
    /// (Desktop's `currentDesktopWorkspaceTarget`).
    pub fn set_workspace(&mut self, workspace: Option<WorkspaceTarget>, cx: &mut Context<Self>) {
        if self.workspace == workspace {
            return;
        }
        self.workspace = workspace.clone();
        if let Some(handle) = self.handle.clone() {
            cx.background_spawn(async move {
                if let Err(error) = handle.set_workspace(workspace).await {
                    log::warn!("setting the bot workspace failed: {error}");
                }
            })
            .detach();
        }
    }

    /// Where bot Sessions are created, as last set.
    pub fn workspace(&self) -> Option<&WorkspaceTarget> {
        self.workspace.as_ref()
    }

    /// Changes one channel's saved settings and applies them; enabling the
    /// first channel starts the sidecar, disabling the last stops it.
    pub fn update_channel(
        &mut self,
        provider: BotProvider,
        change: impl FnOnce(&mut BotChannelSettings) + Send + 'static,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), BotServiceError>> {
        let store = self.store.clone();
        let handle = self.handle.clone();
        let write = cx.background_spawn(async move {
            let settings = store.update(|settings| change(settings.channel_mut(provider))).await?;
            if let Some(handle) = handle {
                handle.apply_settings(settings.clone()).await?;
            }
            Ok::<_, BotServiceError>((settings, ()))
        });
        self.after_write(write, cx)
    }

    /// Tests `provider`'s saved credentials, records the result in the
    /// settings, and applies them (`settings:testBotChannel`).
    pub fn test_channel(
        &mut self,
        provider: BotProvider,
        cx: &mut Context<Self>,
    ) -> Task<Result<BotTestResult, BotServiceError>> {
        let store = self.store.clone();
        let handle = self.handle.clone();
        let test = cx.background_spawn(async move {
            let handle = handle.ok_or(BotServiceError::NotStarted)?;
            let channel = store.load().await?.channel(provider).clone();
            let result = handle.test_channel(provider, channel).await?;
            let now_ms = unix_millis();
            let settings = store
                .update(|settings| settings.channel_mut(provider).record_test(&result, now_ms))
                .await?;
            handle.apply_settings(settings.clone()).await?;
            Ok::<_, BotServiceError>((settings, result))
        });
        self.after_write(test, cx)
    }

    /// Applies the saved settings again and resumes `provider` if a conflict
    /// suspended it (`settings:bots:restart`). Resolves to its status.
    pub fn restart_channel(
        &mut self,
        provider: BotProvider,
        cx: &mut Context<Self>,
    ) -> Task<Result<Option<ChannelStatus>, BotServiceError>> {
        let store = self.store.clone();
        let handle = self.handle.clone();
        cx.background_spawn(async move {
            let handle = handle.ok_or(BotServiceError::NotStarted)?;
            handle.apply_settings(store.load().await?).await?;
            let statuses = handle.restart_listeners(Some(provider)).await?;
            Ok(statuses.into_iter().find(|status| status.provider() == provider))
        })
    }

    /// Starts a QR onboarding of `provider` (Feishu with `brand`), which
    /// cancels its previous one (`settings:bots:onboarding:start`).
    pub fn start_onboarding(
        &mut self,
        provider: BotProvider,
        brand: Option<OnboardingBrand>,
        cx: &mut Context<Self>,
    ) -> Task<Result<OnboardingSnapshot, BotServiceError>> {
        let handle = self.handle.clone();
        cx.background_spawn(async move {
            let handle = handle.ok_or(BotServiceError::NotStarted)?;
            Ok(handle.onboarding_start(provider, brand).await?)
        })
    }

    /// Polls onboarding `session_id` (`settings:bots:onboarding:poll`). A
    /// confirmed scan's credentials are saved to the channel, enabled, and
    /// applied here; the snapshot that comes back says whether its listener
    /// started. A session cancelled meanwhile saves nothing.
    pub fn poll_onboarding(
        &mut self,
        session_id: SharedString,
        cx: &mut Context<Self>,
    ) -> Task<Result<OnboardingSnapshot, BotServiceError>> {
        let Some(handle) = self.handle.clone() else {
            return Task::ready(Err(BotServiceError::NotStarted));
        };
        let store = self.store.clone();
        let poll = cx.background_spawn({
            let (handle, session_id) = (handle.clone(), session_id.clone());
            async move { handle.onboarding_poll(&session_id).await }
        });
        cx.spawn(async move |this, cx| {
            let (snapshot, channel) = poll.await?;
            let Some(channel) = channel else {
                return Ok(snapshot);
            };
            let cancelled = this
                .read_with(cx, |this, _| this.cancelled_onboardings.contains(&*session_id))
                .map_err(|_| BotServiceError::Closed)?;
            if cancelled {
                return Ok(handle.onboarding_cancel(&session_id).await?);
            }
            let provider = snapshot.provider;
            let save = cx.background_spawn({
                let handle = handle.clone();
                async move {
                    let now_ms = unix_millis();
                    let settings = store
                        .update(|settings| channel.apply(settings.channel_mut(provider), now_ms))
                        .await?;
                    handle.apply_settings(settings.clone()).await?;
                    Ok::<_, BotServiceError>(settings)
                }
            });
            let settings = save.await?;
            this.update(cx, |this, cx| this.set_settings(settings, cx))
                .map_err(|_| BotServiceError::Closed)?;
            Ok(handle.onboarding_finish(&session_id).await?)
        })
    }

    /// Cancels onboarding `session_id`; a confirmation already on its way is
    /// not saved.
    pub fn cancel_onboarding(&mut self, session_id: SharedString, cx: &mut Context<Self>) {
        self.cancelled_onboardings.insert(session_id.to_string());
        if let Some(handle) = self.handle.clone() {
            cx.background_spawn(async move {
                if let Err(error) = handle.onboarding_cancel(&session_id).await {
                    log::info!("cancelling the bot onboarding: {error}");
                }
            })
            .detach();
        }
    }

    /// The HTTPS page of onboarding `session_id`, for a person who cannot
    /// scan (`settings:bots:onboarding:open`).
    pub fn onboarding_url(
        &mut self,
        session_id: SharedString,
        cx: &mut Context<Self>,
    ) -> Task<Result<String, BotServiceError>> {
        let handle = self.handle.clone();
        cx.background_spawn(async move {
            let handle = handle.ok_or(BotServiceError::NotStarted)?;
            Ok(handle.onboarding_url(&session_id).await?)
        })
    }

    /// The local wechat-bridge's sign-in QR code for the saved WeChat
    /// channel (`settings:bots:wechatQrCode`).
    pub fn wechat_bridge_qr(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Task<Result<WechatBridgeQr, BotServiceError>> {
        let store = self.store.clone();
        let handle = self.handle.clone();
        cx.background_spawn(async move {
            let handle = handle.ok_or(BotServiceError::NotStarted)?;
            let channel = store.load().await?.channel(BotProvider::Wechat).clone();
            Ok(handle.wechat_bridge_qr(channel).await?)
        })
    }

    /// Applies one supervisor event.
    pub fn handle_event(&mut self, event: BotEvent, cx: &mut Context<Self>) {
        match event {
            BotEvent::Started { pid, compatibility_epoch } => {
                if let Some(epoch) = compatibility_epoch
                    && epoch != host_protocol::RUNTIME_HOST_COMPATIBILITY_EPOCH
                {
                    log::warn!(
                        "the bots run from a Maka checkout at epoch {epoch}; this client speaks {}",
                        host_protocol::RUNTIME_HOST_COMPATIBILITY_EPOCH
                    );
                }
                self.set_state(BotServiceState::Running { pid }, cx);
            }
            BotEvent::Status(status) => {
                let provider = status.provider();
                if self.statuses.get(&provider) != Some(&status) {
                    self.statuses.insert(provider, status);
                    cx.emit(BotServiceEvent::StatusChanged(provider));
                    cx.notify();
                }
            }
            BotEvent::Host(state) => {
                if self.host_link.as_ref() != Some(&state) {
                    self.host_link = Some(state);
                    cx.emit(BotServiceEvent::HostLinkChanged);
                    cx.notify();
                }
            }
            BotEvent::Exited { reason, restart_in } => {
                log::warn!("{reason}; restarting in {} ms", restart_in.as_millis());
                self.clear_host_link(cx);
                self.set_state(
                    BotServiceState::Restarting { reason: reason.as_ref().into(), restart_in },
                    cx,
                );
            }
            BotEvent::Suspended { reason } => {
                log::warn!("chat bots stopped: {reason}");
                self.clear_host_link(cx);
                self.set_state(
                    BotServiceState::Unavailable {
                        reason: reason.as_ref().into(),
                        held_elsewhere: false,
                    },
                    cx,
                );
            }
            BotEvent::Stopped => {
                self.handle = None;
                self.launched = None;
                self.clear_host_link(cx);
                self.set_state(BotServiceState::Idle, cx);
            }
            // The supervisor already wrote them to the app log.
            BotEvent::Log { .. } => {}
        }
    }

    /// Takes `settings` as the saved ones and follows what they enable.
    fn set_settings(&mut self, settings: BotChatSettings, cx: &mut Context<Self>) {
        self.settings_error = None;
        if self.settings.as_ref() != Some(&settings) {
            self.settings = Some(settings);
            cx.emit(BotServiceEvent::SettingsChanged);
            cx.notify();
        }
        self.reconcile(cx);
    }

    /// Resolves to the second part of what `write` returns, after taking its
    /// first, the settings as written, as the saved ones.
    fn after_write<R: 'static>(
        &mut self,
        write: Task<Result<(BotChatSettings, R), BotServiceError>>,
        cx: &mut Context<Self>,
    ) -> Task<Result<R, BotServiceError>> {
        cx.spawn(async move |this, cx| {
            let (settings, answer) = write.await?;
            this.update(cx, |this, cx| this.set_settings(settings, cx))
                .map_err(|_| BotServiceError::Closed)?;
            Ok(answer)
        })
    }

    /// The sidecar that reported the Host link is gone; the next reports its
    /// own.
    fn clear_host_link(&mut self, cx: &mut Context<Self>) {
        if self.host_link.take().is_some() {
            cx.emit(BotServiceEvent::HostLinkChanged);
            cx.notify();
        }
    }

    fn set_state(&mut self, state: BotServiceState, cx: &mut Context<Self>) {
        if self.state != state {
            self.state = state;
            cx.emit(BotServiceEvent::StateChanged);
            cx.notify();
        }
    }

    /// Detaches from the current sidecar; returns its handle so the caller
    /// can stop it and wait for that.
    fn shut_down_current(&mut self) -> Option<BotHandle> {
        self.generation += 1;
        // The old sidecar's events stop here; its supervisor, detached, winds
        // down once asked to (or once every handle is gone).
        self.tasks.clear();
        self.handle.take()
    }

    fn forward_events(
        events: async_channel::Receiver<BotEvent>,
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
                        this.handle_event(event, cx);
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

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}
