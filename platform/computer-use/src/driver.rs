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

use crate::desktop::{NativeCleanup, NativeEpochId, observe_retirement};
use cua_driver_sdk::{
    ConfiguredDriverOptions, CuaDriver, CuaDriverSession, DriverError, RuntimeAuthorizationOptions,
    SessionPermissionMode, TrustedSessionOptions, worker::ActionCompletion,
};
use futures_util::future::BoxFuture;
use maka_agent_facts::capability::CallResult;
use maka_agent_facts::{language::Language, tools::ToolError};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{Mutex, OnceCell, watch};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
enum State {
    #[default]
    Idle,
    Active(Arc<CuaDriver>),
    Closing(Option<Arc<CuaDriver>>),
    Closed,
}

/// One native runtime per Host process, created only after authorization/T1.
#[derive(Default)]
pub struct Driver {
    state: State,
    pub(crate) audio_enabled: bool,
    sessions: std::collections::HashMap<NativeEpochId, Arc<BoundSession>>,
    retiring_epochs: std::collections::HashMap<NativeEpochId, RetiringEpoch>,
    pub(crate) cursors: crate::cursor::Host,
    pub(crate) windows: crate::desktop::worker::Worker,
    pub(crate) browsers: Arc<tokio::sync::Mutex<crate::browser::Host>>,
    pub(crate) native_browsers: crate::browser::provider::NativeCache,
    #[cfg(target_os = "macos")]
    mac_controllers: std::collections::HashMap<i32, MacController>,
}

#[cfg(target_os = "macos")]
struct MacController {
    generation: String,
    controller: crate::macos::controller::Controller,
}

struct BoundSession {
    session: Arc<CuaDriverSession>,
    started: OnceCell<Result<(), ToolError>>,
}

struct RetiringEpoch {
    pending: NativeCleanup,
    _session: Option<Arc<CuaDriverSession>>,
    #[cfg(target_os = "macos")]
    _controllers: Vec<crate::macos::controller::Controller>,
}

enum NativeCoordinates {
    Captured,
    WindowPixels,
}

impl BoundSession {
    async fn ready(&self, language: Language) -> Result<Arc<CuaDriverSession>, ToolError> {
        self.started
            .get_or_init(|| async {
                self.session
                    .start_session(cua_driver_contract::StartSessionInput {
                        session: None,
                        capture_scope: None,
                        cursor_theme: None,
                        cursor_motion: None,
                    })
                    .await
                    .map(|_| ())
                    .map_err(|error| native_error(error, language))
            })
            .await
            .clone()?;
        Ok(self.session.clone())
    }
}

impl Driver {
    #[cfg(target_os = "macos")]
    pub(crate) async fn mac_controller(
        driver: &Arc<Mutex<Self>>,
        pid: i32,
        generation: &str,
    ) -> Result<crate::macos::controller::Controller, ToolError> {
        use crate::macos::page_scroll::metadata::{Observation, Query};
        Self::verify_mac_generation(driver, pid, generation).await?;
        let pending = {
            let mut driver = driver.lock().await;
            driver.mac_admission()?;
            driver.cursors.mac_metadata(Query::Process { pid })
        };
        let Observation::Process { application } = pending.await? else {
            return Err(ToolError::Failed(
                "unexpected native process observation".into(),
            ));
        };
        let Some(application) = application.filter(|app| !app.terminated) else {
            Self::retire_mac_generation(driver, pid, generation).await?;
            return Err(ToolError::Failed(
                "stale_target: native application terminated".into(),
            ));
        };
        Self::verify_mac_generation(driver, pid, generation).await?;
        loop {
            Self::verify_mac_generation(driver, pid, generation).await?;
            let controller = {
                let mut driver = driver.lock().await;
                driver.mac_admission()?;
                match driver.mac_controllers.entry(pid) {
                    std::collections::hash_map::Entry::Occupied(entry)
                        if entry.get().generation == generation =>
                    {
                        Ok(entry.get().controller.clone())
                    }
                    std::collections::hash_map::Entry::Occupied(entry) => {
                        Err(entry.get().controller.clone())
                    }
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        let controller = crate::macos::controller::Controller::new(
                            pid,
                            generation.to_owned(),
                            application.bundle_identifier.clone(),
                        );
                        entry.insert(MacController {
                            generation: generation.to_owned(),
                            controller: controller.clone(),
                        });
                        Ok(controller)
                    }
                }
            };
            match controller {
                Ok(controller) => {
                    // Start at authorized getApp, so notifications are retained
                    // even before the first indexed or pointer action.
                    controller.ensure_started().await?;
                    return Ok(controller);
                }
                Err(controller) => {
                    // A recycled PID must not drop a live native thread. Keep
                    // its custody until Stop ACK and join both succeed.
                    Self::retire_mac_controller_owner(driver, pid, controller).await?;
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn mac_admission(&self) -> Result<(), ToolError> {
        if matches!(self.state, State::Closing(_) | State::Closed) {
            return Err(ToolError::Failed("Computer Use Host is closing".into()));
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    async fn verify_mac_generation(
        driver: &Arc<Mutex<Self>>,
        pid: i32,
        generation: &str,
    ) -> Result<(), ToolError> {
        let process_id = u32::try_from(pid).map_err(native_identity_error)?;
        let error = match crate::identity::process(process_id) {
            Ok(current) if current == generation => return Ok(()),
            Ok(_) => ToolError::Failed("stale_target: native application process changed".into()),
            Err(error) => ToolError::Failed(format!(
                "stale_target: native application process unavailable: {error}"
            )),
        };
        Self::retire_mac_generation(driver, pid, generation)
            .await
            .map_err(|cleanup| ToolError::CleanupUnconfirmed(format!("{error}; {cleanup}")))?;
        Err(error)
    }

    #[cfg(target_os = "macos")]
    pub(crate) async fn retire_mac_generation(
        driver: &Arc<Mutex<Self>>,
        pid: i32,
        generation: &str,
    ) -> Result<(), ToolError> {
        let controller = driver
            .lock()
            .await
            .mac_controllers
            .get(&pid)
            .filter(|record| record.generation == generation)
            .map(|record| record.controller.clone());
        if let Some(controller) = controller {
            Self::retire_mac_controller_owner(driver, pid, controller).await?;
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    async fn retire_mac_controller_owner(
        driver: &Arc<Mutex<Self>>,
        pid: i32,
        controller: crate::macos::controller::Controller,
    ) -> Result<(), ToolError> {
        controller.close().await?;
        let mut driver = driver.lock().await;
        if driver
            .mac_controllers
            .get(&pid)
            .is_some_and(|record| record.controller.same_owner(&controller))
        {
            driver.mac_controllers.remove(&pid);
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub(crate) async fn native_page_scroll(
        driver: &Arc<Mutex<Self>>,
        request: platform_macos::input::page_scroll::NativePageScrollRequest,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before page dispatch".into(),
            ));
        }
        let bound = driver.lock().await.bind_epoch(epoch, language)?;
        let session = bound.ready(language).await?;
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before page dispatch".into(),
            ));
        }
        let result = session
            .scroll_native_pages(request)
            .await
            .map_err(|error| native_error(error, language))?;
        native_input_result(result, language)
    }

    #[cfg(target_os = "macos")]
    pub(crate) async fn native_pointer_move(
        driver: &Arc<Mutex<Self>>,
        request: platform_macos::input::native_move::NativeMoveRequest,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native move dispatch".into(),
            ));
        }
        let bound = driver.lock().await.bind_epoch(epoch, language)?;
        let session = bound.ready(language).await?;
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native move dispatch".into(),
            ));
        }
        let result = session
            .move_native_pointer(request)
            .await
            .map_err(|error| native_error(error, language))?;
        native_input_result(result, language)
    }
    pub fn with_audio(audio_enabled: bool) -> Self {
        Self {
            audio_enabled,
            windows: crate::desktop::worker::Worker::with_audio(audio_enabled),
            ..Default::default()
        }
    }
    /// Embedding hosts may provide their trusted cursor-capable executable.
    pub fn with_cursor_executable(path: std::path::PathBuf) -> Self {
        Self {
            cursors: crate::cursor::Host::with_executable(path),
            ..Default::default()
        }
    }
    pub fn release_epoch(
        &mut self,
        epoch: NativeEpochId,
    ) -> BoxFuture<'static, Result<(), ToolError>> {
        self.reap_retired_epochs();
        if let Some(retirement) = self.retiring_epochs.get(&epoch) {
            return Box::pin(observe_retirement(retirement.pending.clone()));
        }
        let session = self
            .sessions
            .remove(&epoch)
            .map(|bound| bound.session.clone());
        #[cfg(target_os = "macos")]
        let controllers: Vec<_> = self
            .mac_controllers
            .values()
            .map(|record| record.controller.clone())
            .collect();
        let has_resources = session.is_some();
        #[cfg(target_os = "macos")]
        let has_resources = has_resources || !controllers.is_empty();
        if !has_resources {
            return Box::pin(async { Ok(()) });
        }
        let (reply, pending) = watch::channel(None);
        self.retiring_epochs.insert(
            epoch,
            RetiringEpoch {
                pending: pending.clone(),
                _session: session.clone(),
                #[cfg(target_os = "macos")]
                _controllers: controllers.clone(),
            },
        );
        // One custodian owns the complete epoch cleanup. Observers cannot
        // delay AX retirement past a replacement or cancel native teardown.
        tokio::spawn(async move {
            let mut failures = Vec::new();
            #[cfg(target_os = "macos")]
            for controller in controllers {
                if let Err(error) = controller.release_epoch(epoch).await {
                    failures.push(error.to_string());
                }
            }
            if let Some(session) = session {
                let ended = session
                    .end_session(cua_driver_contract::EndSessionInput { session: None })
                    .await;
                session.close();
                match ended {
                    Ok(_) | Err(DriverError::Shutdown) => {}
                    Err(DriverError::Tool { error_code, .. })
                        if matches!(
                            error_code.as_str(),
                            "permission_denied" | "session_ended" | "authorization_revoked"
                        ) => {}
                    Err(error) => failures.push(error.to_string()),
                }
            }
            let result = if failures.is_empty() {
                Ok(())
            } else {
                Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
            };
            let _ = reply.send(Some(result));
        });
        Box::pin(observe_retirement(pending))
    }

    fn reap_retired_epochs(&mut self) {
        self.retiring_epochs
            .retain(|_, retirement| !matches!(retirement.pending.borrow().as_ref(), Some(Ok(()))));
    }
    /// Discard audio owned by an existing native session without creating a
    /// runtime or changing that session's other observations and targets.
    pub(crate) fn discard_audio(
        &self,
        epoch: NativeEpochId,
    ) -> BoxFuture<'static, Result<(), ToolError>> {
        let bound = self.sessions.get(&epoch).map(|bound| bound.session.clone());
        Box::pin(async move {
            if let Some(bound) = bound {
                bound
                    .discard_audio()
                    .await
                    .map_err(|error| ToolError::CleanupUnconfirmed(error.to_string()))?;
            }
            Ok(())
        })
    }

    pub(crate) fn audio_completion(
        &self,
        epoch: NativeEpochId,
    ) -> BoxFuture<'static, Result<cua_driver_sdk::AudioCompletion, ToolError>> {
        let bound = self.sessions.get(&epoch).map(|bound| bound.session.clone());
        Box::pin(async move {
            let bound = bound
                .ok_or_else(|| ToolError::Failed("Computer audio epoch is unavailable".into()))?;
            bound
                .audio_completion()
                .await
                .map_err(|error| ToolError::CleanupUnconfirmed(error.to_string()))
        })
    }

    pub async fn invoke(
        driver: &Arc<Mutex<Self>>,
        name: &str,
        input: Value,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        Self::invoke_with_coordinates(
            driver,
            name,
            input,
            epoch,
            cancellation,
            language,
            NativeCoordinates::Captured,
        )
        .await
    }

    pub(crate) async fn invoke_native_window_pixels(
        driver: &Arc<Mutex<Self>>,
        name: &str,
        input: Value,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        Self::invoke_with_coordinates(
            driver,
            name,
            input,
            epoch,
            cancellation,
            language,
            NativeCoordinates::WindowPixels,
        )
        .await
    }

    /// Match the selected Cua dispatch backend; DISPLAY alone is not XID proof.
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    pub(crate) fn linux_x11_selected() -> bool {
        !platform_linux::wayland::is_wayland()
    }

    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    pub(crate) async fn observe_native_window(
        driver: &Arc<Mutex<Self>>,
        request: platform_linux::atspi::native_observation::NativeObservationRequest,
        options: cua_driver_sdk::NativeObservationOptions,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        if !Self::linux_x11_selected() {
            return Err(ToolError::Failed("native_profile_requires_x11".into()));
        }
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use observation cancelled".into(),
            ));
        }
        let bound = driver.lock().await.bind_epoch(epoch, language)?;
        let session = bound.ready(language).await?;
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(ToolError::Failed("Computer Use observation cancelled".into())),
            result = session.observe_native_window(request, options) => result,
        }.map_err(|error| native_error(error, language))?;
        native_input_result(result, language)
    }

    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    pub(crate) async fn input_native_window(
        driver: &Arc<Mutex<Self>>,
        request: platform_linux::input::native_window::NativeWindowInputRequest,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        if !Self::linux_x11_selected() {
            return Err(ToolError::Failed("native_profile_requires_x11".into()));
        }
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native input dispatch".into(),
            ));
        }
        let bound = driver.lock().await.bind_epoch(epoch, language)?;
        let session = bound.ready(language).await?;
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native input dispatch".into(),
            ));
        }
        let result = session
            .input_native_window(request)
            .await
            .map_err(|error| native_error(error, language))?;
        native_input_result(result, language)
    }

    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    pub(crate) async fn click_native_element_window(
        driver: &Arc<Mutex<Self>>,
        request: platform_linux::input::native_element::NativeElementClickRequest,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        if !Self::linux_x11_selected() {
            return Err(ToolError::Failed("native_profile_requires_x11".into()));
        }
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native element dispatch".into(),
            ));
        }
        let bound = driver.lock().await.bind_epoch(epoch, language)?;
        let session = bound.ready(language).await?;
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native element dispatch".into(),
            ));
        }
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(ToolError::OutcomeUnknown("Computer Use native element invocation cancelled; input outcome unknown".into())),
            result = session.click_native_element_window(request) => result,
        }.map_err(|error| native_error(error, language))?;
        native_element_result(result, language)
    }

    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    pub(crate) async fn scroll_native_element_window(
        driver: &Arc<Mutex<Self>>,
        request: platform_linux::input::native_element::NativeElementScrollRequest,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        if !Self::linux_x11_selected() {
            return Err(ToolError::Failed("native_profile_requires_x11".into()));
        }
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native element dispatch".into(),
            ));
        }
        let bound = driver.lock().await.bind_epoch(epoch, language)?;
        let session = bound.ready(language).await?;
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native element dispatch".into(),
            ));
        }
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(ToolError::OutcomeUnknown("Computer Use native element invocation cancelled; input outcome unknown".into())),
            result = session.scroll_native_element_window(request) => result,
        }.map_err(|error| native_error(error, language))?;
        native_element_result(result, language)
    }

    #[cfg(target_os = "macos")]
    pub(crate) async fn capture_prepared_window(
        driver: &Arc<Mutex<Self>>,
        prepared: platform_macos::capture::FrozenWindowCapture,
        include_accessibility_tree: bool,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before capture dispatch".into(),
            ));
        }
        let bound = driver.lock().await.bind_epoch(epoch, language)?;
        let session = bound.ready(language).await?;
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before capture dispatch".into(),
            ));
        }
        let result = session
            .capture_prepared_window(prepared, include_accessibility_tree)
            .await
            .map_err(|error| native_error(error, language))?;
        if result.is_error {
            let code = result
                .error_code
                .as_deref()
                .unwrap_or("computer_use_refused");
            return Err(ToolError::Failed(format!(
                "{code}: {}",
                refusal(code, &result.text, language)
            )));
        }
        serde_json::from_str(&result.raw_json)
            .map_err(|error| ToolError::OutcomeUnknown(format!("invalid native result: {error}")))
    }

    async fn invoke_with_coordinates(
        driver: &Arc<Mutex<Self>>,
        name: &str,
        input: Value,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
        coordinates: NativeCoordinates,
    ) -> Result<CallResult, ToolError> {
        if ![
            "list_apps",
            "list_windows",
            "get_window_state",
            "click",
            "type_text",
            "press_key",
            "scroll",
            "drag",
            "set_value",
            "launch_app",
            "element_bounds",
            "start_audio_recording",
            "stop_audio_recording",
        ]
        .contains(&name)
        {
            return Err(ToolError::Failed("unsupported native operation".into()));
        }
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before dispatch".into(),
            ));
        }
        let bound = driver.lock().await.bind_epoch(epoch, language)?;
        let session = bound.ready(language).await?;
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before dispatch".into(),
            ));
        }
        // Every operation, including inventory whose schema has no `session`
        // field, uses the same bound SDK surface. Once dispatched, await its
        // result: dropping an FFI future is not evidence of settlement.
        let result = match coordinates {
            NativeCoordinates::Captured => session.call_tool(name.into(), input.to_string()).await,
            NativeCoordinates::WindowPixels => {
                session
                    .call_tool_with_native_window_pixels(name.into(), input.to_string())
                    .await
            }
        }
        .map_err(|error| native_error(error, language))?;
        if result.is_error {
            let code = result
                .error_code
                .as_deref()
                .unwrap_or("computer_use_refused");
            let message = refusal(code, &result.text, language);
            let message = format!("{code}: {message}");
            return Err(
                if matches!(code, "input_outcome_unknown" | "action_outcome_mismatch") {
                    ToolError::OutcomeUnknown(message)
                } else {
                    ToolError::Failed(message)
                },
            );
        }
        serde_json::from_str(&result.raw_json)
            .map_err(|error| ToolError::OutcomeUnknown(format!("invalid native result: {error}")))
    }

    fn bind_epoch(
        &mut self,
        epoch: NativeEpochId,
        language: Language,
    ) -> Result<Arc<BoundSession>, ToolError> {
        self.reap_retired_epochs();
        if let Some(retirement) = self.retiring_epochs.get(&epoch) {
            return Err(retirement
                .pending
                .borrow()
                .as_ref()
                .and_then(|result| result.as_ref().err())
                .cloned()
                .unwrap_or_else(|| {
                    ToolError::CleanupUnconfirmed("native epoch is still closing".into())
                }));
        }
        if matches!(self.state, State::Idle) {
            self.state = State::Active(
                CuaDriver::create_configured(ConfiguredDriverOptions {
                    claude_code_compatibility: false,
                    audio_enabled: self.audio_enabled,
                    authorization: RuntimeAuthorizationOptions {
                        allowed_modes: vec![SessionPermissionMode::Standard],
                        compatibility_mode: SessionPermissionMode::Standard,
                        compatibility_capability_manifest_path: None,
                        compatibility_bounded_manifest_path: None,
                        unrestricted_acknowledged: false,
                        max_session_ttl_seconds: 86400,
                        max_idle_ttl_seconds: 86400,
                    },
                })
                // No operation has been dispatched during construction. In
                // particular, a non-interactive desktop is a known refusal.
                .map_err(|error| ToolError::Failed(error.to_string()))?,
            );
        }
        let State::Active(driver) = &self.state else {
            return Err(ToolError::Failed("Computer Use Session is closed".into()));
        };
        let session = match self.sessions.entry(epoch) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                let session = driver
                    .create_trusted_session(TrustedSessionOptions {
                        // SDK lifecycle tombstones belong to their original transport.
                        // A reset owns a fresh episode, never revives an old lease's ID.
                        public_session: format!("maka-{}", uuid::Uuid::new_v4()),
                        mode: SessionPermissionMode::Standard,
                        ttl_seconds: 86400,
                        idle_ttl_seconds: 86400,
                        capability_manifest_path: None,
                        bounded_manifest_path: None,
                    })
                    .map_err(|error| native_error(error, language))?;
                entry.insert(Arc::new(BoundSession {
                    session,
                    started: OnceCell::new(),
                }))
            }
        };
        Ok(Arc::clone(session))
    }

    /// Host calls this after all Session resources retire.
    pub async fn close(&mut self) -> Result<(), ToolError> {
        let driver = match std::mem::replace(&mut self.state, State::Closing(None)) {
            State::Idle => None,
            State::Active(driver) | State::Closing(Some(driver)) => Some(driver),
            State::Closing(None) => None,
            State::Closed => {
                self.state = State::Closed;
                return Ok(());
            }
        };
        self.state = State::Closing(driver.clone());
        let mut failures = Vec::new();
        for retirement in self.retiring_epochs.values() {
            if let Err(error) = observe_retirement(retirement.pending.clone()).await {
                failures.push(error.to_string());
            }
        }
        #[cfg(target_os = "macos")]
        for record in self.mac_controllers.values() {
            if let Err(error) = record.controller.close().await {
                failures.push(error.to_string());
            }
        }
        if let Err(error) = self.windows.close().await {
            failures.push(error.to_string());
        }
        if let Err(error) = self.cursors.stop().await {
            failures.push(error.to_string());
        }
        if !failures.is_empty() {
            return Err(ToolError::CleanupUnconfirmed(failures.join("; ")));
        }
        if let Some(driver) = driver {
            driver
                .shutdown()
                .await
                .map_err(|error| ToolError::CleanupUnconfirmed(error.to_string()))?;
        }
        self.sessions.clear();
        self.retiring_epochs.clear();
        #[cfg(target_os = "macos")]
        self.mac_controllers.clear();
        self.state = State::Closed;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn native_identity_error(error: std::num::TryFromIntError) -> ToolError {
    ToolError::Failed(format!(
        "native process identity cannot be represented: {error}"
    ))
}

#[cfg(any(
    target_os = "macos",
    all(target_os = "linux", not(target_env = "musl"))
))]
fn native_input_result(
    result: cua_driver_sdk::ToolResult,
    language: Language,
) -> Result<CallResult, ToolError> {
    if result.is_error {
        let code = result
            .error_code
            .as_deref()
            .unwrap_or("computer_use_refused");
        #[cfg(all(target_os = "linux", not(target_env = "musl")))]
        if matches!(code, "point_outside_window" | "incomplete_point") {
            #[derive(serde::Deserialize)]
            struct NativeErrorEffect {
                effect: cua_driver_contract::ActionEffect,
            }
            let effect = result
                .structured_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<NativeErrorEffect>(value).ok())
                .map(|value| value.effect);
            let message = match code {
                "incomplete_point" => crate::linux_input::Error::IncompleteScrollPoint.to_string(),
                _ => crate::linux_input::Error::OutsideWindow.to_string(),
            };
            return Err(
                if effect == Some(cua_driver_contract::ActionEffect::Refused) {
                    ToolError::Failed(message)
                } else {
                    ToolError::OutcomeUnknown(message)
                },
            );
        }
        let message = format!("{code}: {}", refusal(code, &result.text, language));
        return Err(
            if matches!(
                code,
                "input_outcome_unknown"
                    | "action_outcome_mismatch"
                    | "typed_output_mismatch"
                    | "tool_output_invalid"
            ) {
                ToolError::OutcomeUnknown(message)
            } else {
                ToolError::Failed(message)
            },
        );
    }
    serde_json::from_str(&result.raw_json)
        .map_err(|error| ToolError::OutcomeUnknown(format!("invalid native result: {error}")))
}

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
fn native_element_result(
    result: cua_driver_sdk::ToolResult,
    language: Language,
) -> Result<CallResult, ToolError> {
    if result.is_error
        && matches!(
            result.error_code.as_deref(),
            Some("input_preparation_failed" | "input_outcome_unknown")
        )
    {
        #[derive(serde::Deserialize)]
        struct NativeEffect {
            effect: cua_driver_contract::ActionEffect,
        }
        let refused = result.error_code.as_deref() == Some("input_preparation_failed")
            && result
                .structured_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<NativeEffect>(value).ok())
                .is_some_and(|value| value.effect == cua_driver_contract::ActionEffect::Refused);
        return Err(if refused {
            ToolError::Failed(result.text)
        } else {
            ToolError::OutcomeUnknown(result.text)
        });
    }
    native_input_result(result, language)
}

#[cfg(all(test, target_os = "linux", not(target_env = "musl")))]
mod linux_element_boundary_tests {
    use super::*;

    #[test]
    fn native_element_refusals_keep_original_text_and_uncertain_dispatch_stays_uncertain() {
        let message = "element is not in this window's AT-SPI tree; refresh get_window_state()";
        for (code, effect, uncertain) in [
            ("input_preparation_failed", Some("refused"), false),
            ("input_preparation_failed", Some("unverifiable"), true),
            ("input_preparation_failed", None, true),
            ("input_outcome_unknown", Some("unverifiable"), true),
        ] {
            let result = cua_driver_sdk::ToolResult {
                text: message.into(),
                images: Vec::new(),
                structured_json: effect
                    .map(|effect| serde_json::json!({"code":code,"effect":effect}).to_string()),
                is_error: true,
                error_code: Some(code.into()),
                action: None,
                verification: None,
                degraded: false,
                raw_json: "{}".into(),
            };
            match native_element_result(result, Language::En).unwrap_err() {
                ToolError::Failed(actual) => {
                    assert!(!uncertain);
                    assert_eq!(actual, message);
                }
                ToolError::OutcomeUnknown(actual) => {
                    assert!(uncertain);
                    assert_eq!(actual, message);
                }
                other => panic!("unexpected native element error: {other}"),
            }
        }
    }
}

fn refusal(code: &str, reason: &str, language: Language) -> String {
    if code.starts_with("background_unavailable") {
        return format!(
            "{}\n{}",
            reason.chars().take(8192).collect::<String>(),
            crate::language::background_unavailable(language)
        );
    }
    let terminal = matches!(code, "session_ended" | "authorization_revoked")
        // The pinned SDK reports expiry under permission_denied, without a
        // structured subcode. Keep this adaptation at its native boundary;
        // ordinary permission refusals must not imply that reset grants access.
        || (code == "permission_denied" && reason.contains("authorization context expired"));
    let mut message: String = reason.chars().take(8192).collect();
    if terminal {
        message.push_str(crate::language::terminal(language));
    }
    message
}

fn native_error(error: DriverError, language: Language) -> ToolError {
    match error {
        DriverError::Shutdown => ToolError::Failed(crate::language::inactive(language).into()),
        DriverError::ActionInterrupted {
            completion: ActionCompletion::NotStarted,
            reason,
        } => ToolError::Failed(reason),
        DriverError::ActionInterrupted { reason, .. } => ToolError::OutcomeUnknown(reason),
        DriverError::Transport { .. }
        | DriverError::Protocol { .. }
        | DriverError::Worker { .. }
        | DriverError::Remote { .. } => ToolError::OutcomeUnknown(error.to_string()),
        error => ToolError::Failed(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cua_driver_contract::{EndSessionInput, GetSessionInput, StartSessionInput};

    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    #[test]
    fn linux_bounds_error_preserves_original_body_from_the_sdk_code() {
        let original = "background pointer position is outside the target window".to_owned();
        for (code, text, effect, unknown, expected) in [
            (
                "point_outside_window",
                "opaque native diagnostic",
                Some("unverifiable"),
                true,
                original.clone(),
            ),
            (
                "point_outside_window",
                "opaque native diagnostic",
                Some("partial"),
                true,
                original.clone(),
            ),
            (
                "point_outside_window",
                "opaque native diagnostic",
                Some("refused"),
                false,
                original.clone(),
            ),
            (
                "point_outside_window",
                "opaque native diagnostic",
                None,
                true,
                original.clone(),
            ),
            (
                "incomplete_point",
                "opaque native diagnostic",
                Some("unverifiable"),
                true,
                "x and y must be provided together".into(),
            ),
            (
                "incomplete_point",
                "opaque native diagnostic",
                Some("refused"),
                false,
                "x and y must be provided together".into(),
            ),
            (
                "other_native_error",
                original.as_str(),
                Some("unverifiable"),
                false,
                format!("other_native_error: {original}"),
            ),
        ] {
            let result = cua_driver_sdk::ToolResult {
                text: text.into(),
                images: Vec::new(),
                structured_json: effect
                    .map(|effect| serde_json::json!({"code":code,"effect":effect}).to_string()),
                is_error: true,
                error_code: Some(code.into()),
                action: None,
                verification: None,
                degraded: false,
                raw_json: "{}".into(),
            };
            match native_input_result(result, Language::En).unwrap_err() {
                ToolError::OutcomeUnknown(message) => {
                    assert!(unknown);
                    assert_eq!(message, expected);
                }
                ToolError::Failed(message) => {
                    assert!(!unknown);
                    assert_eq!(message, expected);
                }
                other => panic!("unexpected native error: {other}"),
            }
        }
    }

    #[tokio::test]
    async fn dropping_an_epoch_close_observer_keeps_the_original_cleanup() {
        let mut driver = Driver::default();
        let epoch = NativeEpochId::new();
        let session = driver
            .bind_epoch(epoch, Language::En)
            .unwrap()
            .ready(Language::En)
            .await
            .unwrap();
        let original = session
            .get_session(GetSessionInput { session: None })
            .await
            .unwrap();

        drop(driver.release_epoch(epoch));
        driver.release_epoch(epoch).await.unwrap();
        assert!(
            session
                .get_session(GetSessionInput { session: None })
                .await
                .is_err(),
            "the original epoch lease must be revoked after its observer disappears"
        );
        let replacement = driver
            .bind_epoch(epoch, Language::En)
            .unwrap()
            .ready(Language::En)
            .await
            .unwrap()
            .get_session(GetSessionInput { session: None })
            .await
            .unwrap();
        assert_ne!(
            original.session, replacement.session,
            "a confirmed epoch retirement must permit a fresh lifecycle episode"
        );
        driver.release_epoch(epoch).await.unwrap();
        driver.close().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn retiring_an_old_controller_preserves_its_replacement() {
        let driver = Arc::new(Mutex::new(Driver::default()));
        let old = crate::macos::controller::Controller::new(1, "old".into(), None);
        let current = crate::macos::controller::Controller::new(1, "current".into(), None);
        driver.lock().await.mac_controllers.insert(
            1,
            MacController {
                generation: "current".into(),
                controller: current.clone(),
            },
        );
        // A delayed old-generation cleanup must not erase a replacement that
        // another admitted getApp already installed for this PID.
        Driver::retire_mac_controller_owner(&driver, 1, old)
            .await
            .unwrap();
        assert!(
            driver.lock().await.mac_controllers[&1]
                .controller
                .same_owner(&current)
        );
        driver.lock().await.close().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn unpolled_actor_retirement_blocks_replacement_until_its_original_ack() {
        let mut driver = Driver::default();
        let epoch = NativeEpochId::new();
        let controller = crate::macos::controller::Controller::new(1, "generation".into(), None);
        driver.mac_controllers.insert(
            1,
            MacController {
                generation: "generation".into(),
                controller,
            },
        );
        let observer = driver.release_epoch(epoch);
        assert!(
            matches!(
                driver.bind_epoch(epoch, Language::En),
                Err(ToolError::CleanupUnconfirmed(_))
            ),
            "replacement admission must include the unpolled native retirement"
        );
        assert!(matches!(driver.state, State::Idle));
        drop(observer);
        driver.release_epoch(epoch).await.unwrap();
        driver.reap_retired_epochs();
        assert!(
            !driver.retiring_epochs.contains_key(&epoch),
            "the actor-only epoch must retire without an SDK session or observer"
        );
        driver.close().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn epoch_release_preserves_controller_until_terminal_host_close() {
        let mut driver = Driver::default();
        let controller = crate::macos::controller::Controller::new(1, "generation".into(), None);
        driver.mac_controllers.insert(
            1,
            MacController {
                generation: "generation".into(),
                controller: controller.clone(),
            },
        );
        // Dormant controllers exercise ownership without AX, native threads,
        // an SDK runtime, or a desktop fixture.
        driver.release_epoch(NativeEpochId::new()).await.unwrap();
        assert!(
            driver.mac_controllers[&1]
                .controller
                .same_owner(&controller)
        );
        assert!(matches!(driver.state, State::Idle));
        driver.close().await.unwrap();
        assert!(driver.mac_controllers.is_empty());
        assert!(matches!(driver.state, State::Closed));
        assert!(controller.ensure_started().await.is_err());
    }

    #[tokio::test]
    async fn observing_absent_audio_epoch_does_not_initialize_a_runtime() {
        let driver = Driver::default();
        let result = driver.audio_completion(NativeEpochId::new()).await;
        assert!(matches!(result,
            Err(ToolError::Failed(message)) if message == "Computer audio epoch is unavailable"));
        assert!(matches!(driver.state, State::Idle));
    }

    // This uses only SDK session administration, never desktop observation or
    // input. It exercises the real binding/expiry/reset ownership contract.
    #[tokio::test]
    #[cfg_attr(
        windows,
        ignore = "the SDK requires an interactive Windows desktop even for lifecycle administration"
    )]
    async fn bound_sessions_ignore_ended_implicit_state_and_reset_independently() {
        let mut driver = Driver::default();
        let a_epoch = NativeEpochId::new();
        let b_epoch = NativeEpochId::new();
        let expired_epoch = NativeEpochId::new();
        let a = driver
            .bind_epoch(a_epoch, Language::En)
            .unwrap()
            .ready(Language::En)
            .await
            .unwrap();
        let b = driver
            .bind_epoch(b_epoch, Language::En)
            .unwrap()
            .ready(Language::En)
            .await
            .unwrap();
        let State::Active(native) = &driver.state else {
            unreachable!()
        };
        native
            .start_session(StartSessionInput {
                session: None,
                capture_scope: None,
                cursor_theme: None,
                cursor_motion: None,
            })
            .await
            .unwrap();
        native
            .end_session(EndSessionInput { session: None })
            .await
            .unwrap();
        let before = a
            .get_session(GetSessionInput { session: None })
            .await
            .unwrap();
        let other = b
            .get_session(GetSessionInput { session: None })
            .await
            .unwrap();
        assert_ne!(before.session, other.session);
        assert!(
            before.expires_in_seconds > 300,
            "bound lifecycle must use its explicit idle lease"
        );
        driver.release_epoch(a_epoch).await.unwrap();
        assert!(
            a.get_session(GetSessionInput { session: None })
                .await
                .is_err()
        );
        let after = driver
            .bind_epoch(a_epoch, Language::En)
            .unwrap()
            .ready(Language::En)
            .await
            .unwrap()
            .get_session(GetSessionInput { session: None })
            .await
            .unwrap();
        assert_ne!(
            before.session, after.session,
            "reset owns a fresh lifecycle episode"
        );
        assert_eq!(
            other.session,
            b.get_session(GetSessionInput { session: None })
                .await
                .unwrap()
                .session
        );
        // Terminal authority must not make reset itself impossible.
        b.end_session(EndSessionInput { session: None })
            .await
            .unwrap();
        driver.release_epoch(b_epoch).await.unwrap();
        driver
            .bind_epoch(b_epoch, Language::En)
            .unwrap()
            .ready(Language::En)
            .await
            .unwrap()
            .get_session(GetSessionInput { session: None })
            .await
            .unwrap();
        driver.release_epoch(a_epoch).await.unwrap();
        driver.release_epoch(b_epoch).await.unwrap();
        // Exercise the SDK's real expiry diagnostic, not a fabricated error.
        let State::Active(native) = &driver.state else {
            unreachable!()
        };
        let expired = native
            .create_trusted_session(TrustedSessionOptions {
                public_session: format!("expiry-{}", uuid::Uuid::new_v4()),
                mode: SessionPermissionMode::Standard,
                ttl_seconds: 1,
                idle_ttl_seconds: 1,
                capability_manifest_path: None,
                bounded_manifest_path: None,
            })
            .unwrap();
        expired
            .start_session(StartSessionInput {
                session: None,
                capture_scope: None,
                cursor_theme: None,
                cursor_motion: None,
            })
            .await
            .unwrap();
        let started = OnceCell::new();
        started.set(Ok(())).unwrap();
        driver.sessions.insert(
            expired_epoch,
            Arc::new(BoundSession {
                session: expired,
                started,
            }),
        );
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        // SDK authorization rejects this before any desktop observation.
        let driver = Arc::new(Mutex::new(driver));
        let failure = Driver::invoke(
            &driver,
            "list_apps",
            serde_json::json!({}),
            expired_epoch,
            &CancellationToken::new(),
            Language::En,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            failure.contains("authorization context expired"),
            "{failure}"
        );
        assert!(failure.contains("cua_reset"), "{failure}");
        assert!(
            !refusal(
                "permission_denied",
                "desktop observation is forbidden by policy",
                Language::En,
            )
            .contains("cua_reset")
        );
        let cleanup = driver.lock().await.release_epoch(expired_epoch);
        cleanup.await.unwrap();
        let bound = driver
            .lock()
            .await
            .bind_epoch(expired_epoch, Language::En)
            .unwrap();
        bound
            .ready(Language::En)
            .await
            .unwrap()
            .get_session(GetSessionInput { session: None })
            .await
            .unwrap();
        let cleanup = driver.lock().await.release_epoch(expired_epoch);
        cleanup.await.unwrap();
        driver.lock().await.close().await.unwrap();
    }
}
