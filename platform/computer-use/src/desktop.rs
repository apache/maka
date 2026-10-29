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

//! Select the desktop independently of the OS running the Agent.
#[cfg(feature = "native-desktop")]
use crate::session;
use crate::{Driver, protocol::Command};
use maka_agent_facts::{language::Language, tools::ToolError};
use maka_capabilities::computer::BrowserConnection;
use maka_capabilities::computer::Desktop;
use serde_json::Value;
use std::sync::Arc;
use std::{path::PathBuf, sync::OnceLock};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub(crate) mod worker;
pub use worker::bootstrap;

pub(crate) type NativeCleanup = tokio::sync::watch::Receiver<Option<Result<(), ToolError>>>;

pub(crate) async fn observe_retirement(mut pending: NativeCleanup) -> Result<(), ToolError> {
    loop {
        if let Some(result) = pending.borrow().clone() {
            return result;
        }
        pending.changed().await.map_err(|error| {
            ToolError::CleanupUnconfirmed(format!(
                "native epoch close observation was lost: {error}"
            ))
        })?;
    }
}

/// The embedding application owns distribution and version selection. Neither
/// the model nor plugin configuration can provide a downloader or executable.
pub type WindowsHelperResolver = fn() -> maka_agent_facts::tools::ToolFuture<PathBuf>;
static WINDOWS_HELPER: OnceLock<WindowsHelperResolver> = OnceLock::new();

pub fn register_windows_helper(resolver: WindowsHelperResolver) {
    assert!(
        WINDOWS_HELPER.set(resolver).is_ok(),
        "Windows helper resolver is configured once at application startup"
    );
}

pub(crate) fn local_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "mac",
        other => other,
    }
}

fn is_wsl() -> bool {
    cfg!(target_os = "linux")
        && std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|release| release.to_ascii_lowercase().contains("microsoft"))
}

fn use_windows(desktop: Desktop, platform: &str, wsl: bool) -> Result<bool, ToolError> {
    match desktop {
        Desktop::Local => Ok(false),
        Desktop::Auto => Ok(platform == "linux" && wsl),
        Desktop::Windows if platform == "windows" => Ok(false),
        Desktop::Windows if platform == "linux" && wsl => Ok(true),
        Desktop::Windows => Err(failed("Windows desktop requires Windows or WSL")),
    }
}

/// Monotonically allocated process-local identity, never a wire capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NativeEpochId(u64);

impl NativeEpochId {
    pub fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Self(
            NEXT.try_update(
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
                |next| next.checked_add(1),
            )
            .expect("native epoch identity exhausted"),
        )
    }
}

impl Default for NativeEpochId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for NativeEpochId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Logical browser and cursor custody shared by replaceable native epochs.
/// The Host closes this owner after joining the epochs it created.
#[derive(Clone)]
pub struct SessionOwner {
    driver: Arc<Mutex<Driver>>,
    state: Arc<std::sync::Mutex<OwnerState>>,
    remote_id: NativeEpochId,
    #[cfg(feature = "native-desktop")]
    browser_owner: uuid::Uuid,
    #[cfg(feature = "native-desktop")]
    cursor: Arc<std::sync::Mutex<crate::cursor::Spec>>,
}

struct OwnerState {
    closed: bool,
    remote_epochs: std::collections::HashMap<NativeEpochId, Option<String>>,
    remote_registered: bool,
    cleanup: Option<NativeCleanup>,
}

impl SessionOwner {
    pub fn new(driver: Arc<Mutex<Driver>>) -> Self {
        Self {
            driver,
            state: Arc::new(std::sync::Mutex::new(OwnerState {
                closed: false,
                remote_epochs: std::collections::HashMap::new(),
                remote_registered: false,
                cleanup: None,
            })),
            remote_id: NativeEpochId::new(),
            #[cfg(feature = "native-desktop")]
            browser_owner: uuid::Uuid::new_v4(),
            #[cfg(feature = "native-desktop")]
            cursor: Arc::new(std::sync::Mutex::new(crate::cursor::Spec::default())),
        }
    }

    /// Create fresh interpreter-facing caches without borrowing an older epoch.
    pub fn new_epoch(&self) -> Result<Session, ToolError> {
        let epoch = NativeEpochId::new();
        self.ensure_open()?;
        Ok(Session::from_owner(self.clone(), epoch))
    }

    pub(crate) fn ensure_open(&self) -> Result<(), ToolError> {
        if self.state.lock().unwrap().closed {
            Err(failed("Computer Use Session owner is closed"))
        } else {
            Ok(())
        }
    }

    fn register_remote(&self, epoch: NativeEpochId) -> Result<(), ToolError> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(failed("Computer Use Session owner is closed"));
        }
        state.remote_epochs.entry(epoch).or_default();
        Ok(())
    }

    fn bind_remote(&self, epoch: NativeEpochId, session: &str) -> Result<(), ToolError> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(failed("Computer Use Session owner is closed"));
        }
        let current = state
            .remote_epochs
            .get_mut(&epoch)
            .ok_or_else(|| failed("Windows native epoch is unavailable"))?;
        if current.as_deref().is_some_and(|id| id != session) {
            return Err(failed("Computer Use Session identity mismatch"));
        }
        current.get_or_insert_with(|| session.to_owned());
        state.remote_registered = true;
        Ok(())
    }

    fn remote_session(&self, epoch: NativeEpochId) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .remote_epochs
            .get(&epoch)
            .cloned()
            .flatten()
    }

    fn release_remote(&self, epoch: NativeEpochId) {
        self.state.lock().unwrap().remote_epochs.remove(&epoch);
    }

    #[cfg(feature = "native-desktop")]
    pub(crate) fn browser_owner(&self) -> uuid::Uuid {
        self.browser_owner
    }

    #[cfg(feature = "native-desktop")]
    pub(crate) fn cursor(&self) -> crate::cursor::Spec {
        self.cursor.lock().unwrap().clone()
    }

    #[cfg(feature = "native-desktop")]
    pub(crate) fn cursor_handle(&self) -> Arc<std::sync::Mutex<crate::cursor::Spec>> {
        self.cursor.clone()
    }

    #[cfg(feature = "native-desktop")]
    pub(crate) fn configure_cursor(
        &self,
        options: crate::cursor::Options,
    ) -> Result<crate::cursor::Spec, ToolError> {
        self.ensure_open()?;
        let mut cursor = self.cursor.lock().unwrap();
        cursor.configure(options)?;
        Ok(cursor.clone())
    }

    pub async fn finish_turn(&self, turn: &str, language: Language) -> Result<(), ToolError> {
        let registered = self.state.lock().unwrap().remote_registered;
        let mut failures = Vec::new();
        if registered {
            let connection = self.driver.lock().await.windows.connection();
            let result = match connection {
                Some(connection) => connection
                    .invoke(
                        worker::Request::FinishOwnerTurn {
                            owner: self.remote_id.to_string(),
                            turn: turn.to_owned(),
                            language,
                        },
                        None,
                        CancellationToken::new(),
                    )
                    .await
                    .map(|_| ()),
                None => Err(ToolError::CleanupUnconfirmed(
                    "Windows logical owner lost its original connection".into(),
                )),
            };
            if let Err(error) = result {
                failures.push(error.to_string());
            }
        }
        #[cfg(feature = "native-desktop")]
        if let Err(error) =
            crate::browser::Browsers::with_owner(self.driver.clone(), self.browser_owner)
                .finish_turn(turn, &self.cursor(), language)
                .await
        {
            failures.push(error.to_string());
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
        }
    }

    /// Finalize shared resources after joining every original epoch close.
    /// All observers retain the same original cleanup result.
    pub async fn close(&self) -> Result<(), ToolError> {
        let pending = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            if let Some(pending) = &state.cleanup {
                pending.clone()
            } else {
                let remote_live = !state.remote_epochs.is_empty();
                let registered = state.remote_registered;
                let driver = self.driver.clone();
                let remote_id = self.remote_id.to_string();
                #[cfg(feature = "native-desktop")]
                let cursor = self.cursor();
                #[cfg(feature = "native-desktop")]
                let browser_owner = self.browser_owner;
                let (reply, pending) = tokio::sync::watch::channel(None);
                tokio::spawn(async move {
                    let mut failures = Vec::new();
                    if remote_live {
                        failures
                            .push("Windows native epoch has not confirmed its cleanup".to_owned());
                    }
                    if registered {
                        let connection = driver.lock().await.windows.connection();
                        match connection {
                            Some(connection) => {
                                if let Err(error) = connection
                                    .invoke(
                                        worker::Request::CloseOwner { owner: remote_id },
                                        None,
                                        CancellationToken::new(),
                                    )
                                    .await
                                {
                                    failures.push(error.to_string());
                                }
                            }
                            None => failures
                                .push("Windows logical owner lost its original connection".into()),
                        }
                    }
                    #[cfg(feature = "native-desktop")]
                    {
                        if let Err(error) =
                            crate::browser::Browsers::with_owner(driver.clone(), browser_owner)
                                .close(&cursor)
                                .await
                        {
                            failures.push(error.to_string());
                        }
                        if let Err(error) = driver.lock().await.cursors.remove(&cursor.id).await {
                            failures.push(error.to_string());
                        }
                    }
                    let result = if failures.is_empty() {
                        Ok(())
                    } else {
                        Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
                    };
                    let _ = reply.send(Some(result));
                });
                state.cleanup = Some(pending.clone());
                pending
            }
        };
        observe_retirement(pending).await
    }
}

/// The selected desktop owns all targets, including browser connections. The
/// embedding Host still admits and journals every operation before invoking it.
pub struct Session {
    driver: Arc<Mutex<Driver>>,
    native_epoch: NativeEpochId,
    owner: SessionOwner,
    backend: Option<Backend>,
    state: SessionState,
    remote_cleanup: Option<NativeCleanup>,
}
enum SessionState {
    Open,
    Closing,
    Closed,
}
enum Backend {
    #[cfg(feature = "native-desktop")]
    Local(Box<session::Session>),
    Windows {
        browsers: Vec<BrowserConnection>,
        audio: Option<worker::AudioObservation>,
    },
}
impl Session {
    pub fn new(driver: Arc<Mutex<Driver>>) -> Self {
        Self::from_owner(SessionOwner::new(driver), NativeEpochId::new())
    }

    fn from_owner(owner: SessionOwner, native_epoch: NativeEpochId) -> Self {
        Self {
            driver: owner.driver.clone(),
            owner,
            native_epoch,
            backend: None,
            state: SessionState::Open,
            remote_cleanup: None,
        }
    }

    pub fn native_epoch(&self) -> NativeEpochId {
        self.native_epoch
    }

    /// Snapshot display metadata from the same target owner used for execution.
    /// Remote/unknown bindings use a generic action, never a guessed window name.
    pub fn activity(&self, command: &Command) -> maka_agent_facts::display::Text {
        let target = match (&self.backend, command) {
            #[cfg(feature = "native-desktop")]
            (
                Some(Backend::Local(local)),
                Command::Observe { handle, .. }
                | Command::Action { handle, .. }
                | Command::BrowserRead { handle, .. }
                | Command::BrowserEvaluate { handle, .. }
                | Command::TabPageAssetsList { handle }
                | Command::TabPageAssetsBundle { handle, .. }
                | Command::BrowserCua { handle, .. }
                | Command::BrowserWait { handle, .. }
                | Command::BrowserMutation { handle, .. }
                | Command::ClipboardRead { handle }
                | Command::ClipboardReadText { handle }
                | Command::ClipboardWrite { handle, .. }
                | Command::ClipboardWriteText { handle, .. }
                | Command::GetJsDialog { handle, .. }
                | Command::HandleJsDialog { handle, .. },
            ) => local.target_label(handle),
            _ => None,
        };
        crate::activity::command(command, target)
    }

    pub fn configure(
        &mut self,
        desktop: Desktop,
        browsers: Vec<BrowserConnection>,
        language: Language,
    ) -> Result<(), ToolError> {
        if !matches!(self.state, SessionState::Open) {
            return Err(failed("Computer Use Session is closed"));
        }
        self.owner.ensure_open()?;
        validate_connections(&browsers)?;
        let windows = use_windows(desktop, local_platform(), is_wsl())?;
        if let Some(backend) = &self.backend
            && windows != matches!(backend, Backend::Windows { .. })
        {
            return Err(failed(match language {
                Language::En => {
                    "desktop configuration changed; reset Cua before switching desktops"
                }
                Language::ZhCn => "桌面配置已改变；请先重置 Cua，再切换桌面",
                Language::ZhTw => "桌面設定已變更；請先重設 Cua，再切換桌面",
            }));
        }
        if self.backend.is_none() {
            self.backend = Some(if windows {
                self.owner.register_remote(self.native_epoch)?;
                Backend::Windows {
                    browsers: Vec::new(),
                    audio: None,
                }
            } else {
                #[cfg(feature = "native-desktop")]
                {
                    Backend::Local(Box::new(session::Session::with_owner(
                        self.driver.clone(),
                        self.native_epoch,
                        self.owner.clone(),
                    )))
                }
                #[cfg(not(feature = "native-desktop"))]
                return Err(native_unavailable());
            });
        }
        match self.backend.as_mut().unwrap() {
            #[cfg(feature = "native-desktop")]
            Backend::Local(local) => local.configure_browsers(browsers, language),
            Backend::Windows {
                browsers: current, ..
            } => {
                *current = browsers;
                Ok(())
            }
        }
    }

    pub fn configure_browsers(
        &mut self,
        browsers: Vec<BrowserConnection>,
        language: Language,
    ) -> Result<(), ToolError> {
        self.configure(Desktop::Auto, browsers, language)
    }

    pub fn platform(&self) -> &'static str {
        if matches!(self.backend, Some(Backend::Windows { .. })) {
            "windows"
        } else {
            local_platform()
        }
    }

    /// Prepare dependencies and the private channel outside the REPL deadline.
    /// This does not create a native Cua runtime or dispatch any input.
    pub async fn prepare(
        &mut self,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use preparation cancelled"));
        }
        if !matches!(self.state, SessionState::Open) {
            return Err(failed("Computer Use Session is closed"));
        }
        self.owner.ensure_open()?;
        if self.backend.is_none() {
            self.configure(Desktop::Auto, Vec::new(), language)?;
        }
        if matches!(self.backend, Some(Backend::Windows { .. })) {
            prepare_windows(&self.driver, cancellation).await?;
        }
        Ok(())
    }

    pub async fn permission_subject(
        &mut self,
        command: &Command,
        session: &str,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Option<crate::ComputerAppTarget>, ToolError> {
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use cancelled before app resolution"));
        }
        if !matches!(self.state, SessionState::Open) {
            return Err(failed("Computer Use Session is closed"));
        }
        self.owner.ensure_open()?;
        if self.backend.is_none() {
            self.configure(Desktop::Auto, Vec::new(), language)?;
        }
        match self.backend.as_mut().unwrap() {
            #[cfg(feature = "native-desktop")]
            Backend::Local(local) => {
                local
                    .permission_subject(command, session, cancellation, language)
                    .await
            }
            Backend::Windows { .. } => {
                let _ = (command, session, language);
                Ok(None)
            }
        }
    }

    pub async fn invoke(
        &mut self,
        command: Command,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        self.prepare_invoke(command, invocation, cancellation, language)
            .await?
            .wait()
            .await
    }

    /// Run the retained native page request under an independently admitted
    /// Host service. This route cannot be called through the model protocol.
    pub async fn adopt_browser_lease_child(
        &mut self,
        request: crate::BrowserLeaseChildRequest,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        self.prepare(cancellation, language).await?;
        match self.backend.as_mut().expect("prepared desktop backend") {
            #[cfg(feature = "native-desktop")]
            Backend::Local(local) => {
                local
                    .adopt_browser_lease_child(request, invocation, cancellation, language)
                    .await
            }
            Backend::Windows { browsers, .. } => {
                let operation_id = invocation
                    .operation_id()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        failed("Browser lease-child service lacks its fresh Host operation")
                    })?;
                let message = worker::Request::LeaseChild {
                    preparation_policy: invocation.browser_preparation_policy().clone(),
                    owner: self.owner.remote_id.to_string(),
                    epoch: self.native_epoch.to_string(),
                    session: invocation.session().to_owned(),
                    turn: invocation.turn().to_owned(),
                    operation_id: operation_id.to_owned(),
                    browsers: browsers.clone(),
                    request,
                    language,
                };
                let connection = prepare_windows(&self.driver, cancellation).await?;
                self.owner
                    .bind_remote(self.native_epoch, invocation.session())?;
                connection
                    .invoke_browser(message, invocation, cancellation.clone())
                    .await
                    .map(|reply| reply.value)
            }
        }
    }

    /// Queue the original operation and return its observation without a Session borrow.
    pub async fn prepare_invoke(
        &mut self,
        command: Command,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<crate::InvocationCompletion, ToolError> {
        if !matches!(
            &command,
            Command::BrowserDownloadWait { .. } | Command::BrowserWait { .. }
        ) {
            return self
                .invoke_immediate(command, invocation, cancellation, language)
                .await
                .map(crate::InvocationCompletion::ready);
        }
        self.prepare(cancellation, language).await?;
        match self.backend.as_mut().expect("prepared desktop backend") {
            #[cfg(feature = "native-desktop")]
            Backend::Local(local) => {
                local
                    .prepare_invoke(command, invocation, cancellation, language)
                    .await
            }
            Backend::Windows { browsers, .. } => {
                let request = worker::Request::Invoke {
                    preparation_policy: invocation.browser_preparation_policy().clone(),
                    owner: self.owner.remote_id.to_string(),
                    epoch: self.native_epoch.to_string(),
                    session: invocation.session().into(),
                    turn: invocation.turn().into(),
                    native_observer_available: false,
                    operation_id: invocation.operation_id().map(str::to_owned),
                    browsers: browsers.clone(),
                    command: Box::new(command),
                    language,
                };
                let connection = prepare_windows(&self.driver, cancellation).await?;
                self.owner
                    .bind_remote(self.native_epoch, invocation.session())?;
                // Enqueue while holding the Session lock. The existing FIFO places
                // the arm before a later click without serializing a Rust future.
                let completion =
                    connection.begin_browser(request, invocation, cancellation.clone())?;
                Ok(crate::InvocationCompletion::pending(async move {
                    completion.await.map(|reply| reply.value)
                }))
            }
        }
    }

    async fn invoke_immediate(
        &mut self,
        command: Command,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let session = invocation.session();
        let turn = invocation.turn();
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use cancelled before dispatch"));
        }
        if !matches!(self.state, SessionState::Open) {
            return Err(failed("Computer Use Session is closed"));
        }
        self.owner.ensure_open()?;
        if matches!(
            command,
            Command::StartAudioRecording { .. } | Command::StopAudioRecording
        ) && !self.driver.lock().await.audio_enabled
        {
            return Err(failed(
                "Computer audio recording is disabled in Host configuration",
            ));
        }
        if self.backend.is_none() {
            self.configure(Desktop::Auto, Vec::new(), language)?;
        }
        match self.backend.as_mut().unwrap() {
            #[cfg(feature = "native-desktop")]
            Backend::Local(local) => {
                local
                    .invoke(command, invocation, cancellation, language)
                    .await
            }
            Backend::Windows { browsers, audio } => {
                let start_audio = matches!(&command, Command::StartAudioRecording { .. });
                let stop_audio = matches!(&command, Command::StopAudioRecording);
                let request = worker::Request::Invoke {
                    preparation_policy: invocation.browser_preparation_policy().clone(),
                    owner: self.owner.remote_id.to_string(),
                    epoch: self.native_epoch.to_string(),
                    session: session.into(),
                    turn: turn.into(),
                    native_observer_available: false,
                    operation_id: invocation.operation_id().map(str::to_owned),
                    browsers: browsers.clone(),
                    command: Box::new(command),
                    language,
                };
                let connection = prepare_windows(&self.driver, cancellation).await?;
                self.owner.bind_remote(self.native_epoch, session)?;
                let reply = connection
                    .invoke_browser(request, invocation, cancellation.clone())
                    .await?;
                if start_audio {
                    *audio = Some(reply.audio.ok_or_else(|| {
                        ToolError::CleanupUnconfirmed(
                            "Windows audio startup reply lost its bound capture observation".into(),
                        )
                    })?);
                } else if stop_audio {
                    *audio = None;
                }
                Ok(reply.value)
            }
        }
    }

    /// Discard only this Session's owned audio; absence never initializes a backend.
    pub async fn discard_audio(&mut self) -> Result<(), ToolError> {
        match self.backend.as_mut() {
            #[cfg(feature = "native-desktop")]
            Some(Backend::Local(local)) => local.discard_audio().await,
            Some(Backend::Windows { audio, .. }) => {
                if self.owner.remote_session(self.native_epoch).is_some() {
                    let connection = self.driver.lock().await.windows.connection();
                    let connection = connection.ok_or_else(|| {
                        ToolError::CleanupUnconfirmed(
                            "Windows native epoch lost its original connection".into(),
                        )
                    })?;
                    connection
                        .invoke(
                            worker::Request::DiscardAudio {
                                owner: self.owner.remote_id.to_string(),
                                epoch: self.native_epoch.to_string(),
                            },
                            None,
                            CancellationToken::new(),
                        )
                        .await
                        .map_err(unconfirmed_remote_cleanup)?;
                }
                *audio = None;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Observe this native epoch's already-bound recording without the Session lock.
    pub fn wait_audio_finished(
        &self,
    ) -> futures_util::future::BoxFuture<'static, Result<(), ToolError>> {
        match self.backend.as_ref() {
            #[cfg(feature = "native-desktop")]
            Some(Backend::Local(local)) => local.wait_audio_finished(),
            Some(Backend::Windows { audio, .. }) => {
                let audio = audio.clone();
                Box::pin(async move {
                    let mut audio =
                        audio.ok_or_else(|| failed("Computer audio recording is not active"))?;
                    loop {
                        if let Some(result) = audio.borrow().clone() {
                            return result;
                        }
                        audio.changed().await.map_err(|error| {
                            ToolError::CleanupUnconfirmed(format!(
                                "Windows audio completion observation was lost: {error}"
                            ))
                        })?;
                    }
                })
            }
            _ => Box::pin(async { Err(failed("Computer audio recording is not active")) }),
        }
    }

    /// End resources owned by this trusted Host turn while retaining REPL bindings.
    pub async fn finish_turn(
        &mut self,
        session: &str,
        turn: &str,
        language: Language,
    ) -> Result<(), ToolError> {
        match &mut self.backend {
            #[cfg(feature = "native-desktop")]
            Some(Backend::Local(local)) => local.finish_turn(session, turn, language).await,
            Some(Backend::Windows { audio, .. }) => {
                if self
                    .owner
                    .remote_session(self.native_epoch)
                    .as_deref()
                    .is_some_and(|id| id != session)
                {
                    return Err(failed("Computer Use Session identity mismatch"));
                }
                if self.owner.remote_session(self.native_epoch).is_none() {
                    return Ok(());
                }
                let connection =
                    self.driver
                        .lock()
                        .await
                        .windows
                        .connection()
                        .ok_or_else(|| {
                            ToolError::CleanupUnconfirmed(
                                "Windows native epoch lost its original connection".into(),
                            )
                        })?;
                connection
                    .invoke(
                        worker::Request::FinishTurn {
                            owner: self.owner.remote_id.to_string(),
                            epoch: self.native_epoch.to_string(),
                            session: session.to_owned(),
                            turn: turn.to_owned(),
                            language,
                        },
                        None,
                        CancellationToken::new(),
                    )
                    .await
                    .map_err(unconfirmed_remote_cleanup)?;
                *audio = None;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Release this epoch without ending the logical browser or cursor lifetime.
    pub async fn close_native(&mut self) -> Result<(), ToolError> {
        if matches!(self.state, SessionState::Closed) {
            return Ok(());
        }
        self.state = SessionState::Closing;
        let result = match &mut self.backend {
            #[cfg(feature = "native-desktop")]
            Some(Backend::Local(local)) => local.close_native().await,
            Some(Backend::Windows { .. }) => {
                let pending = self.remote_cleanup.get_or_insert_with(|| {
                    let (reply, pending) = tokio::sync::watch::channel(None);
                    let driver = self.driver.clone();
                    let owner = self.owner.clone();
                    let epoch = self.native_epoch;
                    tokio::spawn(async move {
                        let result = if owner.remote_session(epoch).is_some() {
                            let connection = driver.lock().await.windows.connection();
                            match connection {
                                Some(connection) => connection
                                    .invoke(
                                        worker::Request::CloseEpoch {
                                            owner: owner.remote_id.to_string(),
                                            epoch: epoch.to_string(),
                                        },
                                        None,
                                        CancellationToken::new(),
                                    )
                                    .await
                                    .map(|_| ())
                                    .map_err(unconfirmed_remote_cleanup),
                                None => Err(ToolError::CleanupUnconfirmed(
                                    "Windows native epoch lost its original connection".into(),
                                )),
                            }
                        } else {
                            Ok(())
                        };
                        if result.is_ok() {
                            owner.release_remote(epoch);
                        }
                        let _ = reply.send(Some(result));
                    });
                    pending
                });
                observe_retirement(pending.clone()).await
            }
            None => {
                self.owner.release_remote(self.native_epoch);
                Ok(())
            }
        };
        if result.is_ok() {
            self.backend = None;
            self.remote_cleanup = None;
            self.state = SessionState::Closed;
        }
        result
    }

    pub async fn close(&mut self) -> Result<(), ToolError> {
        let native = self.close_native().await;
        let shared = self.owner.close().await;
        match (native, shared) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(native), Err(shared)) => Err(ToolError::CleanupUnconfirmed(format!(
                "{native}; shared desktop cleanup: {shared}"
            ))),
        }
    }
}

fn unconfirmed_remote_cleanup(error: ToolError) -> ToolError {
    match error {
        ToolError::CleanupUnconfirmed(_) => error,
        other => ToolError::CleanupUnconfirmed(format!(
            "Windows native cleanup was not confirmed: {other}"
        )),
    }
}

async fn prepare_windows(
    driver: &Arc<Mutex<Driver>>,
    cancellation: &CancellationToken,
) -> Result<worker::Connection, ToolError> {
    let mut driver = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(failed("Computer Use preparation cancelled")),
        driver = driver.lock() => driver,
    };
    driver.windows.prepare(cancellation).await?;
    driver
        .windows
        .connection()
        .ok_or_else(|| failed("Windows desktop connection is unavailable"))
}

pub(crate) fn validate_connections(connections: &[BrowserConnection]) -> Result<(), ToolError> {
    let mut ids = std::collections::HashSet::new();
    for connection in connections {
        let url = reqwest::Url::parse(&connection.endpoint).map_err(failed)?;
        let loopback = url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if !loopback
            || url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(failed(
                "browser endpoint must be a loopback HTTP origin, without credentials, path or query",
            ));
        }
        if connection.id.is_empty() || !ids.insert(&connection.id) {
            return Err(failed("browser IDs must be nonempty and unique"));
        }
    }
    Ok(())
}

#[cfg(not(feature = "native-desktop"))]
fn native_unavailable() -> ToolError {
    failed(
        "Local desktop support is not included in this build; build Maka with the native-desktop feature, or use the Windows desktop from WSL",
    )
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn closing_an_epoch_preserves_replacement_until_the_logical_owner_closes() {
        let driver = Arc::new(Mutex::new(Driver::default()));
        let owner = SessionOwner::new(driver.clone());
        let mut first = owner.new_epoch().unwrap();
        first.close_native().await.unwrap();
        let mut second = owner.new_epoch().unwrap();
        assert_ne!(first.native_epoch(), second.native_epoch());
        second.close_native().await.unwrap();
        owner.close().await.unwrap();
        assert!(owner.new_epoch().is_err());
        driver.lock().await.close().await.unwrap();
    }

    #[tokio::test]
    async fn windows_replacement_does_not_reuse_unconfirmed_epoch_cleanup() {
        let driver = Arc::new(Mutex::new(Driver::default()));
        let owner = SessionOwner::new(driver.clone());
        let mut first = owner.new_epoch().unwrap();
        owner.register_remote(first.native_epoch()).unwrap();
        first.backend = Some(Backend::Windows {
            browsers: Vec::new(),
            audio: None,
        });
        owner
            .bind_remote(first.native_epoch(), "logical-session")
            .unwrap();
        let error = first.close_native().await.unwrap_err();
        assert!(matches!(&error, ToolError::CleanupUnconfirmed(message)
            if message == "Windows native epoch lost its original connection"));
        let mut second = owner.new_epoch().unwrap();
        owner.register_remote(second.native_epoch()).unwrap();
        assert_ne!(first.native_epoch(), second.native_epoch());
        assert_eq!(
            owner.remote_session(first.native_epoch()).as_deref(),
            Some("logical-session")
        );
        assert_eq!(
            first.close_native().await.unwrap_err().to_string(),
            error.to_string()
        );
        second.close_native().await.unwrap();
        assert_eq!(
            owner.remote_session(first.native_epoch()).as_deref(),
            Some("logical-session")
        );
        let error = owner.close().await.unwrap_err();
        assert!(matches!(&error, ToolError::CleanupUnconfirmed(message)
            if message.contains("Windows native epoch has not confirmed its cleanup")
                && message.contains("Windows logical owner lost its original connection")));
        assert_eq!(
            owner.close().await.unwrap_err().to_string(),
            error.to_string()
        );
        assert!(owner.new_epoch().is_err());
        driver.lock().await.close().await.unwrap();
    }

    #[test]
    fn desktop_selection_never_falls_back_from_windows() {
        for platform in ["linux", "mac", "windows"] {
            for wsl in [false, true] {
                assert!(!use_windows(Desktop::Local, platform, wsl).unwrap());
                assert_eq!(
                    use_windows(Desktop::Auto, platform, wsl).unwrap(),
                    platform == "linux" && wsl
                );
                let result = use_windows(Desktop::Windows, platform, wsl);
                match platform {
                    "windows" => assert!(!result.unwrap()),
                    "linux" if wsl => assert!(result.unwrap()),
                    _ => assert!(
                        matches!(result, Err(ToolError::Failed(message)) if message == "Windows desktop requires Windows or WSL")
                    ),
                }
            }
        }
    }

    #[cfg(not(feature = "native-desktop"))]
    #[tokio::test]
    async fn bridge_build_rejects_local_configuration_and_keeps_windows_available() {
        let driver = Arc::new(Mutex::new(Driver::default()));
        let mut session = Session::new(driver.clone());
        let error = session
            .configure(Desktop::Local, Vec::new(), Language::En)
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "tool failed: Local desktop support is not included in this build; build Maka with the native-desktop feature, or use the Windows desktop from WSL"
        );
        // Auto may select the Windows worker only in WSL. Elsewhere it must
        // report the missing native capability during configuration too.
        if !is_wsl() {
            assert_eq!(
                session
                    .configure(Desktop::Auto, Vec::new(), Language::En)
                    .unwrap_err()
                    .to_string(),
                error.to_string()
            );
        } else {
            session
                .configure(Desktop::Auto, Vec::new(), Language::En)
                .unwrap();
            assert_eq!(session.platform(), "windows");
        }
        session.close().await.unwrap();
        driver.lock().await.close().await.unwrap();
    }
}
