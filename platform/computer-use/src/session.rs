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

use crate::{driver::Driver, protocol::*};
use cua_driver_contract::{
    AppInfo, ListAppsOutput, ListWindowsOutput, WindowInfo, WindowStateOutput,
};
use maka_agent_facts::capability::CallResult;
use maka_agent_facts::capability::ContentBlock;
use maka_agent_facts::language::Language;
use maka_agent_facts::tools::ToolError;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

/// Native targets and observation identities have one Session owner. REPL
/// objects contain only random handles; the Host supplies current admission.
pub struct Session {
    native: std::sync::Arc<tokio::sync::Mutex<Driver>>,
    epoch: crate::desktop::NativeEpochId,
    targets: HashMap<String, Target>,
    id: Option<String>,
    state: EpochState,
    browsers: crate::browser::Browsers,
    owner: crate::desktop::SessionOwner,
}

enum EpochState {
    Open,
    Closing,
    Closed,
}
struct Target {
    #[cfg(target_os = "macos")]
    macos: Option<crate::macos::controller::Window>,
    #[cfg(target_os = "macos")]
    page_frame: Option<crate::macos::page_scroll::PageFrame>,
    window: WindowInfo,
    process: String,
    snapshot: Option<WindowStateOutput>,
    capture: Option<String>,
    previous: Option<String>,
}
impl Session {
    pub fn new(native: std::sync::Arc<tokio::sync::Mutex<Driver>>) -> Self {
        let owner = crate::desktop::SessionOwner::new(native.clone());
        Self::with_owner(native, crate::desktop::NativeEpochId::new(), owner)
    }

    pub(crate) fn with_owner(
        native: std::sync::Arc<tokio::sync::Mutex<Driver>>,
        epoch: crate::desktop::NativeEpochId,
        owner: crate::desktop::SessionOwner,
    ) -> Self {
        Self {
            native: native.clone(),
            epoch,
            targets: HashMap::new(),
            id: None,
            state: EpochState::Open,
            browsers: crate::browser::Browsers::with_epoch(
                native,
                owner.browser_owner(),
                epoch,
                owner.cursor_handle(),
            ),
            owner,
        }
    }

    async fn invoke_native(
        &self,
        name: &str,
        input: Value,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        Driver::invoke(
            &self.native,
            name,
            input,
            self.epoch,
            cancellation,
            language,
        )
        .await
    }

    async fn invoke_native_window_pixels(
        &self,
        name: &str,
        input: Value,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        Driver::invoke_native_window_pixels(
            &self.native,
            name,
            input,
            self.epoch,
            cancellation,
            language,
        )
        .await
    }
    pub(crate) fn target_label(&self, handle: &Handle) -> Option<&str> {
        match handle {
            Handle::App(id) => self
                .targets
                .get(id)
                .map(|target| target.window.app_name.as_str()),
            Handle::Tab(id) => self.browsers.target_label(id),
        }
    }
    pub fn configure_browsers(
        &mut self,
        connections: Vec<maka_capabilities::computer::BrowserConnection>,
        language: Language,
    ) -> Result<(), ToolError> {
        self.browsers.configure(connections, language)
    }
    /// Resolve the app's consent subject without reading AX or launching it.
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
        if !matches!(self.state, EpochState::Open) {
            return Err(failed("Computer Use Session is closed"));
        }
        self.owner.ensure_open()?;
        if self.id.as_deref().is_some_and(|id| id != session) {
            return Err(failed("Computer Use Session identity mismatch"));
        }
        #[cfg(target_os = "macos")]
        {
            use crate::macos::permission_subject::Request;
            let request = match command {
                Command::GetApp {
                    target: AppReference::Name(name),
                } => Request::Name(name.clone()),
                Command::GetApp {
                    target: AppReference::Window { window_id },
                } => Request::Window {
                    window_id: *window_id,
                    expected_process: None,
                },
                Command::Observe {
                    handle: Handle::App(handle),
                    ..
                }
                | Command::Action {
                    handle: Handle::App(handle),
                    ..
                } => {
                    let target = self
                        .targets
                        .get(handle)
                        .ok_or_else(|| failed("stale_target: bind the app again"))?;
                    Request::Window {
                        window_id: target.window.window_id,
                        expected_process: Some((
                            target
                                .window
                                .pid
                                .ok_or_else(|| failed("window process identity unavailable"))?,
                            target.process.clone(),
                        )),
                    }
                }
                _ => return Ok(None),
            };
            let target = tokio::task::spawn_blocking(move || request.resolve(language))
                .await
                .map_err(failed)??;
            if cancellation.is_cancelled() {
                return Err(failed("Computer Use cancelled during app resolution"));
            }
            Ok(Some(target))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (command, language);
            Ok(None)
        }
    }
    pub async fn invoke(
        &mut self,
        command: Command,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let session = invocation.session();
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use cancelled before dispatch"));
        }
        if !matches!(self.state, EpochState::Open) {
            return Err(failed("Computer Use Session is closed"));
        }
        self.owner.ensure_open()?;
        if self.id.as_deref().is_some_and(|id| id != session) {
            return Err(failed("Computer Use Session identity mismatch"));
        }
        self.id.get_or_insert_with(|| session.into());
        let cursor = self.owner.cursor();
        let mut result = match command {
            Command::Documentation => Ok(json!(crate::language::documentation(language))),
            Command::StartAudioRecording { options } => self
                .invoke_native(
                    "start_audio_recording",
                    serde_json::to_value(options).map_err(failed)?,
                    cancellation,
                    language,
                )
                .await
                .map(|result| result.structured_content.unwrap_or(Value::Null)),
            Command::StopAudioRecording => self
                .invoke_native("stop_audio_recording", json!({}), cancellation, language)
                .await
                .map(|result| result.structured_content.unwrap_or(Value::Null)),
            Command::ConfigureCursor { options } => {
                let cursor = self.owner.configure_cursor(options)?;
                let browsers = self.browsers.configure_cursor(&cursor).await;
                let mut native = self.native.lock().await;
                let cursor = self.owner.cursor();
                let native = native.cursors.configure(&cursor).await;
                Ok(json!({"settings":cursor,"native":native,"browsers":browsers}))
            }
            Command::CursorState { .. } => {
                let native = self.native.lock().await.cursors.state(&cursor).await;
                Ok(
                    json!({"settings":cursor,"native":native,"browsers":self.browsers.cursor_state(&cursor, language).await}),
                )
            }
            Command::ListApps { .. } => self.apps(session, cancellation, language).await,
            Command::ListWindows { .. } => Ok(json!(
                self.windows(session, cancellation, language)
                    .await?
                    .iter()
                    .map(window_info)
                    .collect::<Vec<_>>()
            )),
            Command::GetState { .. } => {
                let (browsers, mut errors) = self.browsers.state().await;
                #[cfg(target_os = "macos")]
                if let Err(error) = crate::macos::require_desktop() {
                    errors.push(error.to_string());
                }
                let apps = match self.apps(session, cancellation, language).await {
                    Ok(apps) => apps,
                    Err(error) => {
                        errors.push(error.to_string());
                        json!([])
                    }
                };
                Ok(json!({"apps": apps, "browsers": browsers, "errors":errors}))
            }
            Command::LaunchApp { app } => {
                if !cfg!(target_os = "windows") {
                    return Err(failed(
                        "unsupported: explicit native app launch is Windows-only",
                    ));
                }
                let apps: ListAppsOutput = decode(
                    self.invoke_native("list_apps", json!({}), cancellation, language)
                        .await?,
                )?;
                let args = launch_args(&app, &apps.apps, language)?;
                let launched = self
                    .invoke_native("launch_app", args, cancellation, language)
                    .await?;
                Ok(launched.structured_content.unwrap_or(Value::Null))
            }
            Command::GetApp { target } => {
                #[cfg(target_os = "macos")]
                crate::macos::require_desktop()?;
                #[cfg(target_os = "macos")]
                let expected = invocation.app_target().cloned();
                #[cfg(target_os = "macos")]
                let target = match (target, expected.as_ref()) {
                    (AppReference::Name(_), Some(expected)) => {
                        AppReference::Name(expected.display.app_path.clone())
                    }
                    (AppReference::Window { window_id }, Some(expected)) => {
                        if !expected
                            .binding
                            .as_ref()
                            .is_some_and(|binding| binding.window_id == window_id)
                        {
                            return Err(failed(
                                "approved window binding does not match this request",
                            ));
                        }
                        AppReference::Window { window_id }
                    }
                    (target, None) => target,
                };
                let windows = self.windows(session, cancellation, language).await?;
                #[cfg(target_os = "macos")]
                let windows = if let Some(binding) = expected
                    .as_ref()
                    .and_then(|expected| expected.binding.as_ref())
                {
                    windows
                        .into_iter()
                        .filter(|window| {
                            window.window_id == binding.window_id && window.pid == Some(binding.pid)
                        })
                        .collect()
                } else {
                    windows
                };
                let candidates: Vec<_> = match target {
                    AppReference::Window { window_id } => windows
                        .into_iter()
                        .filter(|w| w.window_id == window_id)
                        .collect(),
                    AppReference::Name(name) => {
                        let apps: ListAppsOutput = decode(
                            self.invoke_native("list_apps", json!({}), cancellation, language)
                                .await?,
                        )?;
                        #[cfg(target_os = "macos")]
                        let pids = {
                            let expected = expected.clone();
                            let name = name.clone();
                            tokio::task::spawn_blocking(move || {
                                crate::macos::permission_subject::matching_processes(
                                    &name,
                                    &apps.apps,
                                    expected.as_ref(),
                                )
                            })
                            .await
                            .map_err(failed)??
                        };
                        #[cfg(not(target_os = "macos"))]
                        let pids: Vec<_> = apps
                            .apps
                            .iter()
                            .filter(|a| {
                                a.name.eq_ignore_ascii_case(&name)
                                    || a.bundle_id.as_deref() == Some(&name)
                                    || a.launch_path.as_deref() == Some(&name)
                            })
                            .map(|a| a.pid)
                            .collect();
                        let selected: Vec<_> = windows
                            .into_iter()
                            .filter(|w| w.pid.is_some_and(|pid| pids.contains(&pid)))
                            .collect();
                        if selected.is_empty() && cfg!(target_os = "macos") {
                            #[cfg(target_os = "macos")]
                            if let Some(expected) = expected.clone() {
                                if expected.binding.is_some() {
                                    return Err(failed(
                                        "stale_target: approved window is no longer available",
                                    ));
                                }
                                tokio::task::spawn_blocking(move || {
                                    crate::macos::permission_subject::verify_launch(
                                        &expected, language,
                                    )
                                })
                                .await
                                .map_err(failed)??;
                            }
                            let bundle = name.contains('.')
                                && !name.contains('/')
                                && !name.contains(' ')
                                && !name.ends_with(".app")
                                && name.chars().all(|c| {
                                    c.is_ascii_lowercase()
                                        || c.is_ascii_digit()
                                        || matches!(c, '.' | '-')
                                });
                            let args = if bundle {
                                json!({"bundle_id":name})
                            } else {
                                json!({"name":name})
                            };
                            let launched = self
                                .invoke_native("launch_app", args, cancellation, language)
                                .await?;
                            let pid=launched.structured_content.as_ref().and_then(|value| value["pid"].as_u64()).ok_or_else(|| ToolError::OutcomeUnknown(match language { Language::En => "launch requested but process identity unavailable; inspect inventory before retrying", Language::ZhCn => "已请求启动但无法获取进程标识；重试前请检查清单", Language::ZhTw => "已請求啟動但無法取得程序識別；重試前請檢查清單" }.into()))?;
                            self.windows(session, cancellation, language)
                                .await?
                                .into_iter()
                                .filter(|w| w.pid.map(u64::from) == Some(pid))
                                .collect()
                        } else {
                            selected
                        }
                    }
                };
                if candidates.len() != 1 {
                    return Err(failed(match language {
                        Language::En => format!(
                            "App selection requires exactly one open window; found {}. Choose cua.getApp({{windowId}}) from {}",
                            candidates.len(),
                            json!(candidates.iter().map(window_info).collect::<Vec<_>>())
                        ),
                        Language::ZhCn => format!(
                            "应用选择需要恰好一个打开的窗口；找到 {} 个。请从 {} 中选择 cua.getApp({{windowId}})",
                            candidates.len(),
                            json!(candidates.iter().map(window_info).collect::<Vec<_>>())
                        ),
                        Language::ZhTw => format!(
                            "應用程式選擇需要恰好一個開啟的視窗；找到 {} 個。請從 {} 中選擇 cua.getApp({{windowId}})",
                            candidates.len(),
                            json!(candidates.iter().map(window_info).collect::<Vec<_>>())
                        ),
                    }));
                }
                let window = candidates.into_iter().next().unwrap();
                let pid = window
                    .pid
                    .ok_or_else(|| failed("window process identity unavailable"))?;
                let process = crate::identity::process(pid)?;
                #[cfg(target_os = "macos")]
                let macos = {
                    let id = window.window_id;
                    let expected = expected.clone();
                    let generation = process.clone();
                    tokio::task::spawn_blocking(move || {
                        if let Some(expected) = expected {
                            crate::macos::permission_subject::verify_window(
                                &expected,
                                pid,
                                id,
                                &generation,
                                language,
                            )?;
                        }
                        if crate::identity::process(pid)? != generation {
                            return Err(failed(
                                "stale_target: application process changed during binding",
                            ));
                        }
                        Ok::<(), ToolError>(())
                    })
                    .await
                    .map_err(failed)??;
                    let controller = Driver::mac_controller(
                        &self.native,
                        i32::try_from(pid).map_err(failed)?,
                        &process,
                    )
                    .await?;
                    Some(
                        controller
                            .bind_window(self.epoch, u32::try_from(id).map_err(failed)?)
                            .await?,
                    )
                };
                let handle = uuid::Uuid::new_v4().to_string();
                self.targets.insert(
                    handle.clone(),
                    Target {
                        #[cfg(target_os = "macos")]
                        macos,
                        #[cfg(target_os = "macos")]
                        page_frame: None,
                        window,
                        process,
                        snapshot: None,
                        capture: None,
                        previous: None,
                    },
                );
                let state = match self
                    .observe(
                        &handle,
                        ObservationKind::Ax,
                        false,
                        session,
                        cancellation,
                        language,
                    )
                    .await
                {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(self.retire_failed_target(&handle, error).await);
                    }
                };
                let bound = self
                    .targets
                    .get(&handle)
                    .expect("observed target remains bound");
                Ok(
                    json!({"handle":Handle::App(handle.clone()),"kind":"app","state":state["state"],"binding":{"pid":bound.window.pid,"windowId":bound.window.window_id,"processGeneration":bound.process}}),
                )
            }
            Command::Observe {
                handle: Handle::App(handle),
                kind,
                options,
            } => {
                validate_native_observation(crate::desktop::local_platform(), kind, &options)?;
                let result = self
                    .observe(
                        &handle,
                        kind,
                        !options.disable_diffing,
                        session,
                        cancellation,
                        language,
                    )
                    .await;
                if result.is_err()
                    && let Some(target) = self.targets.get_mut(&handle)
                {
                    target.invalidate_observation();
                    #[cfg(target_os = "macos")]
                    if let Some(window) = target.macos.as_ref() {
                        if let Err(cleanup) = window.clear().await {
                            return result.map_err(|error| {
                                ToolError::CleanupUnconfirmed(format!(
                                    "{error}; native observation cleanup: {cleanup}"
                                ))
                            });
                        }
                    }
                }
                result
            }
            Command::Action {
                handle: Handle::App(handle),
                action,
            } => {
                self.action(&handle, action, session, cancellation, language)
                    .await
            }
            command => self
                .browsers
                .invoke(command, invocation, &cursor, cancellation, language)
                .await
                .map_err(|error| crate::browser::with_unknown_guidance(error, language)),
        }?;
        if result
            .get("effect")
            .and_then(Value::as_str)
            .is_some_and(|effect| {
                matches!(
                    effect,
                    "unverifiable" | "unchanged" | "partial" | "suspected_noop"
                )
            })
        {
            result["guidance"] = json!(crate::language::uncertain(language));
        }
        Ok(result)
    }
    pub async fn discard_audio(&mut self) -> Result<(), ToolError> {
        if self.id.is_some() {
            let cleanup = self.native.lock().await.discard_audio(self.epoch);
            cleanup.await?;
        }
        Ok(())
    }

    pub fn wait_audio_finished(
        &self,
    ) -> futures_util::future::BoxFuture<'static, Result<(), ToolError>> {
        let native = self.native.clone();
        let epoch = self.epoch;
        Box::pin(async move {
            let finished = native.lock().await.wait_audio_finished(epoch);
            finished.await
        })
    }

    pub async fn finish_turn(
        &mut self,
        session: &str,
        turn: &str,
        language: Language,
    ) -> Result<(), ToolError> {
        if self.id.as_deref().is_some_and(|id| id != session) {
            return Err(failed("Computer Use Session identity mismatch"));
        }
        if !matches!(self.state, EpochState::Open) || self.id.is_none() {
            return Ok(());
        }
        let cursor = self.owner.cursor();
        self.browsers.finish_turn(turn, &cursor, language).await
    }
    async fn windows(
        &mut self,
        _session: &str,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Vec<WindowInfo>, ToolError> {
        let output: ListWindowsOutput = decode(
            self.invoke_native("list_windows", json!({}), cancellation, language)
                .await?,
        )?;
        Ok(output.windows)
    }
    async fn apps(
        &mut self,
        session: &str,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let apps: ListAppsOutput = decode(
            self.invoke_native("list_apps", json!({}), cancellation, language)
                .await?,
        )?;
        let windows = self.windows(session, cancellation, language).await?;
        Ok(json!(apps.apps.into_iter().map(|app| json!({
            "id":app_id(&app), "displayName":app.name,
            "isRunning":app.running, "windows":windows.iter().filter(|w| w.pid == Some(app.pid)).map(window_info).collect::<Vec<_>>()
        })).collect::<Vec<_>>()))
    }
    async fn retire_target(&mut self, handle: &str) -> Result<(), ToolError> {
        #[cfg(target_os = "macos")]
        if let Some(target) = self.targets.get_mut(handle) {
            target.invalidate_observation();
            if let Some(window) = target.macos.as_ref() {
                window.release().await.map_err(|error| {
                    ToolError::CleanupUnconfirmed(format!(
                        "native accessibility window release was not confirmed: {error}"
                    ))
                })?;
            }
        }
        self.targets.remove(handle);
        Ok(())
    }

    async fn retire_failed_target(&mut self, handle: &str, error: ToolError) -> ToolError {
        match self.retire_target(handle).await {
            Ok(()) => error,
            Err(cleanup) => ToolError::CleanupUnconfirmed(format!("{error}; {cleanup}")),
        }
    }

    async fn verify(
        &mut self,
        handle: &str,
        session: &str,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<WindowInfo, ToolError> {
        let target = self.targets.get(handle).ok_or_else(|| {
            failed(match language {
                Language::En => "stale_target: bind the app again",
                Language::ZhCn => "stale_target: 请重新绑定应用",
                Language::ZhTw => "stale_target: 請重新綁定應用程式",
            })
        })?;
        #[cfg(target_os = "macos")]
        crate::macos::require_desktop()?;
        let pid = target
            .window
            .pid
            .ok_or_else(|| failed("window has no process"))?;
        if crate::identity::process(pid).ok().as_ref() != Some(&target.process) {
            let error = failed(match language {
                Language::En => "stale_target: application process ended or changed; bind it again",
                Language::ZhCn => "stale_target: 应用进程已结束或改变；请重新绑定",
                Language::ZhTw => "stale_target: 應用程式程序已結束或變更；請重新綁定",
            });
            #[cfg(target_os = "macos")]
            Driver::retire_mac_generation(
                &self.native,
                i32::try_from(pid).map_err(failed)?,
                &target.process,
            )
            .await
            .map_err(|cleanup| ToolError::CleanupUnconfirmed(format!("{error}; {cleanup}")))?;
            return Err(self.retire_failed_target(handle, error).await);
        }
        let id = target.window.window_id;
        #[cfg(target_os = "macos")]
        let macos = target.macos.clone();
        let windows = self.windows(session, cancellation, language).await?;
        let Some(window) = windows
            .into_iter()
            .find(|w| w.pid == Some(pid) && w.window_id == id)
        else {
            let error = failed(match language {
                Language::En => "stale_target: window closed; bind a current window",
                Language::ZhCn => "stale_target: 窗口已关闭；请绑定当前窗口",
                Language::ZhTw => "stale_target: 視窗已關閉；請綁定目前視窗",
            });
            return Err(self.retire_failed_target(handle, error).await);
        };
        #[cfg(target_os = "macos")]
        let window = if let Some(macos) = macos {
            let verified = macos.verify().await;
            match verified {
                Ok(bounds) => WindowInfo { bounds, ..window },
                Err(error) => {
                    // AX timeouts do not prove that the window was replaced.
                    // Keep its retained identity, but require a fresh observation
                    // before any indexed or coordinate input can resume.
                    self.targets
                        .get_mut(handle)
                        .unwrap()
                        .invalidate_observation();
                    macos.clear().await.map_err(|cleanup| {
                        ToolError::CleanupUnconfirmed(format!("{error}; {cleanup}"))
                    })?;
                    return Err(error);
                }
            }
        } else {
            window
        };
        Ok(window)
    }
    #[cfg(target_os = "macos")]
    async fn prepare_page_frame(
        &mut self,
        handle: &str,
        window: &WindowInfo,
        cancellation: &CancellationToken,
    ) -> Result<platform_macos::capture::FrozenWindowCapture, ToolError> {
        use crate::macos::page_scroll::{PageFrame, SizingPolicy};

        if cancellation.is_cancelled() {
            return Err(failed("Computer Use cancelled before native geometry read"));
        }
        let pid = window
            .pid
            .ok_or_else(|| failed("window process identity unavailable"))?;
        let process = self.targets.get(handle).unwrap().process.clone();
        let pending = {
            self.native.lock().await.cursors.window_geometry(
                i32::try_from(pid).map_err(failed)?,
                u32::try_from(window.window_id).map_err(failed)?,
            )
        };
        let geometry = pending.await?;
        if crate::identity::process(pid).ok().as_ref() != Some(&process) {
            let error =
                failed("stale_target: application process changed during native geometry read");
            Driver::retire_mac_generation(
                &self.native,
                i32::try_from(pid).map_err(failed)?,
                &process,
            )
            .await
            .map_err(|cleanup| ToolError::CleanupUnconfirmed(format!("{error}; {cleanup}")))?;
            return Err(self.retire_failed_target(handle, error).await);
        }
        let frame =
            PageFrame::from_native_geometry(geometry.clone(), SizingPolicy::SOURCE_DEFAULTS)?;
        let requested_size = frame.requested_image_size();
        // Geometry belongs to this retained target, independently of AX binding
        // or image success. Observation invalidation does not roll it back.
        self.targets.get_mut(handle).unwrap().page_frame = Some(frame);
        platform_macos::capture::FrozenWindowCapture::source_defaults(geometry, requested_size)
            .map_err(failed)
    }
    async fn observe(
        &mut self,
        handle: &str,
        kind: ObservationKind,
        diff: bool,
        session: &str,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        self.verify(handle, session, cancellation, language).await?;
        let ax = !matches!(kind, ObservationKind::Screenshot);
        let screenshot = !matches!(kind, ObservationKind::Ax);
        let capture_image = screenshot || cfg!(target_os = "macos");
        // Clear old authority before attempting observation; failure cannot leave
        // a misleading older capture active under a newer model observation.
        let target = self.targets.get_mut(handle).unwrap();
        let previous_snapshot = target.snapshot.take();
        target.capture = None;
        #[cfg(target_os = "macos")]
        let own_ax = target.macos.is_some();
        #[cfg(not(target_os = "macos"))]
        let own_ax = false;
        #[cfg(target_os = "macos")]
        if let Some(macos) = target.macos.clone() {
            macos.clear().await?;
        }
        crate::observation::settle(crate::observation::NATIVE_SETTLE, cancellation).await?;
        // The application may move or close during the settling window.
        let window = self.verify(handle, session, cancellation, language).await?;
        #[cfg(target_os = "macos")]
        let prepared_capture = self
            .prepare_page_frame(handle, &window, cancellation)
            .await?;
        #[cfg(target_os = "macos")]
        let frozen_result = if window.is_on_screen {
            Some(
                Driver::capture_prepared_window(
                    &self.native,
                    prepared_capture,
                    ax && !own_ax,
                    self.epoch,
                    cancellation,
                    language,
                )
                .await?,
            )
        } else {
            // Original off-screen capture uses a separate WindowServer SPI.
            // Preserve the existing route until its exact native contract is known.
            None
        };
        #[cfg(not(target_os = "macos"))]
        let frozen_result: Option<CallResult> = None;
        let result = if let Some(result) = frozen_result {
            result
        } else if !own_ax || capture_image {
            let max_image_dimension = if cfg!(target_os = "linux") { 0 } else { 1600 };
            self.invoke_native("get_window_state", json!({"pid":window.pid,"window_id":window.window_id,"include_accessibility_tree":ax && !own_ax,"include_screenshot":capture_image,"tree_format":"both","max_elements":1000,"max_image_dimension":max_image_dimension}), cancellation, language).await?
        } else {
            CallResult {
                content: vec![],
                structured_content: Some(json!({"pid":window.pid,"window_id":window.window_id})),
            }
        };
        let capture = result
            .structured_content
            .as_ref()
            .and_then(|v| v["capture_id"].as_str())
            .map(str::to_owned);
        let image = result
            .content
            .iter()
            .find(|block| matches!(block, ContentBlock::Image { .. }))
            .cloned();
        let capture = image.as_ref().and(capture);
        let mut snapshot: WindowStateOutput = decode(result)?;
        if snapshot.pid != window.pid.unwrap() || snapshot.window_id != window.window_id {
            return Err(failed("observation target changed"));
        }
        if (matches!(kind, ObservationKind::Screenshot) || cfg!(target_os = "macos"))
            && image.is_none()
        {
            return Err(failed("screenshot_unavailable: provider returned no image"));
        }
        #[cfg(target_os = "macos")]
        if image.is_some() {
            self.verify(handle, session, cancellation, language).await?;
        }
        if image.is_some()
            && !cfg!(target_os = "macos")
            && self
                .verify(handle, session, cancellation, language)
                .await?
                .bounds
                != window.bounds
        {
            return Err(failed(match language {
                Language::En => "window geometry changed during capture; capture again",
                Language::ZhCn => "截图期间窗口几何信息已改变；请重新截图",
                Language::ZhTw => "擷取畫面期間視窗幾何資訊已變更；請重新擷取畫面",
            }));
        }
        if !ax
            && !cfg!(target_os = "macos")
            && let Some(previous) = previous_snapshot
            && snapshot.snapshot_id.is_some()
            && snapshot.snapshot_id == previous.snapshot_id
        {
            // The SDK refreshed this exact snapshot's image in place. Keep
            // only its retained rows; a different snapshot cannot reuse them.
            snapshot.elements = previous.elements;
        }
        #[cfg(target_os = "linux")]
        let image = if screenshot {
            match image {
                Some(ContentBlock::Image { data, .. }) => Some(ContentBlock::Image {
                    data: crate::linux_image::jpeg(data).await?,
                    mime_type: "image/jpeg".into(),
                }),
                other => other,
            }
        } else {
            image
        };
        let target = self.targets.get_mut(handle).unwrap();
        let mut output = serde_json::Map::new();
        if ax {
            let full = snapshot.tree_markdown.clone().unwrap_or_default();
            #[cfg(target_os = "macos")]
            let full = if let Some(macos) = target.macos.clone() {
                macos.observe().await?
            } else {
                full
            };
            // Retain raw observation rows, never localized framing, as the
            // diff basis across evaluations with different captured languages.
            let body = if diff && cfg!(target_os = "macos") {
                display_diff(target.previous.as_deref(), &full, language)
            } else {
                full.clone()
            };
            let (window_label, app_label) = match language {
                Language::En => ("Window", "App"),
                Language::ZhCn => ("窗口", "应用"),
                Language::ZhTw => ("視窗", "應用程式"),
            };
            let mut state = format!(
                "{window_label}: {:?}, {app_label}: {:?}.\n{body}",
                window.title, window.app_name
            );
            if snapshot.truncated == Some(true) || snapshot.degraded == Some(true) {
                let (label, fallback) = match language {
                    Language::En => ("Observation incomplete", "partial accessibility tree"),
                    Language::ZhCn => ("观察不完整", "部分无障碍树"),
                    Language::ZhTw => ("觀察不完整", "部分輔助使用樹"),
                };
                let reason = snapshot
                    .truncation_reason
                    .as_deref()
                    .or(snapshot.degraded_reason.as_deref())
                    .unwrap_or(fallback);
                state.push_str(&format!("\n{label}: {reason}"));
            }
            target.previous = Some(full);
            output.insert("state".into(), json!(state));
        } else {
            target.previous = None;
        }
        if screenshot && let Some(image) = image {
            #[cfg(target_os = "macos")]
            let image = match image {
                // The original facade labels bytes independently of the native codec.
                ContentBlock::Image { data, .. } => ContentBlock::Image {
                    data,
                    mime_type: "image/png".into(),
                },
                other => other,
            };
            output.insert("image".into(), json!(image));
        }
        target.window = window;
        target.snapshot = Some(snapshot);
        target.capture = capture;
        Ok(Value::Object(output))
    }
    async fn action(
        &mut self,
        handle: &str,
        action: Action,
        session: &str,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let cursor = self.owner.cursor();
        validate_native_action(crate::desktop::local_platform(), &action)?;
        let window = self.verify(handle, session, cancellation, language).await?;
        #[cfg(target_os = "macos")]
        {
            use crate::macos::page_scroll::dispatch::{Operation, PointerAction};
            let pointer = match &action {
                Action::Scroll {
                    target: position,
                    direction,
                    distance,
                } => {
                    let pages = match distance {
                        None => 1.0,
                        Some(Distance::Pages(pages)) => *pages,
                        Some(Distance::Pixels { .. }) => unreachable!(),
                    };
                    let direction = match direction {
                        Direction::Up => Direction::Up,
                        Direction::Down => Direction::Down,
                        Direction::Left => Direction::Left,
                        Direction::Right => Direction::Right,
                    };
                    Some((position.clone(), Operation::Pages { direction, pages }))
                }
                Action::MoveCursor { target } => Some((target.clone(), Operation::Move)),
                _ => None,
            };
            if let Some((position, operation)) = pointer {
                let target = self.targets.get(handle).unwrap();
                let request = PointerAction {
                    pid: i32::try_from(
                        window
                            .pid
                            .ok_or_else(|| failed("native application process unavailable"))?,
                    )
                    .map_err(failed)?,
                    generation: target.process.clone(),
                    frame: target.page_frame.clone().ok_or_else(|| {
                        failed("native pointer input requires retained app-state geometry")
                    })?,
                    accessibility: target.macos.clone(),
                    position,
                    operation,
                };
                let result = request
                    .run(&self.native, self.epoch, &cursor, cancellation, language)
                    .await;
                self.targets.get_mut(handle).unwrap().capture = None;
                return result.map(|result| result.structured_content.unwrap_or(Value::Null));
            }
        }
        let cursor_requested = matches!(action, Action::MoveCursor { .. });
        let point = if cursor_requested
            || (cursor.enabled && self.native.lock().await.cursors.registered())
        {
            self.cursor_point(
                handle,
                action.cursor_target(),
                &window,
                session,
                cancellation,
                language,
            )
            .await
        } else {
            Err(failed("automatic native cursor disabled"))
        };
        if matches!(action, Action::MoveCursor { .. }) {
            let mut native = self.native.lock().await;
            let cursor = self.owner.cursor();
            return native
                .cursors
                .update(
                    &cursor,
                    Some(point?),
                    cursor_overlay::CursorAction::Idle,
                    Some(window.window_id),
                )
                .await
                .map(|state| json!(state));
        }
        if cursor.enabled
            && let Ok(point) = point
        {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(failed("Computer Use cancelled before input dispatch")),
                _ = async {
                    let mut native = self.native.lock().await;
                    let cursor = self.owner.cursor();
                    let _ = native.cursors.update(
                        &cursor,
                        Some(point),
                        action.cursor_action(),
                        Some(window.window_id),
                    ).await;
                } => {}
            }
        }
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use cancelled before input dispatch"));
        }
        let target = self.targets.get(handle).unwrap();
        #[cfg(target_os = "macos")]
        if crate::macos::Target::handles(&action)
            && let Some(macos) = target.macos.clone()
        {
            let result = macos.action(action, cancellation.clone()).await;
            self.targets.get_mut(handle).unwrap().capture = None;
            return result.map(|()| Value::Null);
        }
        let bound = json!({"kind":"window","pid":window.pid,"window_id":window.window_id});
        #[cfg(target_os = "macos")]
        if let Action::Paste {
            index: None,
            text,
            options,
        } = action
        {
            let macos = target
                .macos
                .clone()
                .ok_or_else(|| failed("paste requires an exact native accessibility target"))?;
            let result = macos
                .paste(
                    text,
                    options.format.unwrap_or(PasteFormat::Text),
                    cancellation.clone(),
                )
                .await;
            self.targets.get_mut(handle).unwrap().capture = None;
            let restored = result?;
            return Ok(if restored {
                Value::Null
            } else {
                json!({"warning":match language { Language::En => "Clipboard changed during paste; preserved the newer clipboard contents.", Language::ZhCn => "粘贴期间剪贴板已改变；已保留较新的剪贴板内容。", Language::ZhTw => "貼上期間剪貼簿已變更；已保留較新的剪貼簿內容。" }})
            });
        }
        let (name, args) = match action {
            Action::Click {
                target: position,
                options,
            } => {
                let count = options.click_count.unwrap_or(1);
                if !(1..=3).contains(&count) {
                    return Err(failed("clickCount must be between 1 and 3"));
                }
                let mut args = json!({"target":bound,"button":options.mouse_button.unwrap_or(MouseButton::Left).name(),"count":count,"delivery_mode":native_delivery_mode()});
                match position {
                    Position::Element(index) => {
                        args["element_token"] =
                            json!(target.element(index, language)?.element_token)
                    }
                    Position::Point(point) => {
                        target.point(point, &window, language)?;
                        args["x"] = json!(point[0]);
                        args["y"] = json!(point[1]);
                        #[cfg(target_os = "macos")]
                        {
                            args["capture_id"] = json!(target.capture);
                        }
                    }
                }
                ("click", args)
            }
            Action::SetValue { index, value } => (
                "set_value",
                json!({"pid":window.pid,"window_id":window.window_id,"element_token":target.element(index, language)?.element_token,"value":value}),
            ),
            Action::Secondary { index, action } if cfg!(target_os = "macos") => {
                let element = target.element(index, language)?;
                let (native, name) = match action.as_str() {
                    "AXShowMenu" | "Show Menu" => ("AXShowMenu", "show_menu"),
                    "AXPick" | "Pick" => ("AXPick", "pick"),
                    "AXConfirm" | "Confirm" => ("AXConfirm", "confirm"),
                    "AXCancel" | "Cancel" => ("AXCancel", "cancel"),
                    "AXOpen" | "Open" => ("AXOpen", "open"),
                    _ => {
                        return Err(failed(
                            "unsupported: Cua cannot deliver this accessibility action",
                        ));
                    }
                };
                if !element
                    .actions
                    .as_ref()
                    .is_some_and(|actions| actions.iter().any(|a| a == native))
                {
                    return Err(failed(
                        "action_not_exposed: select an action from the current accessibility observation",
                    ));
                }
                (
                    "click",
                    json!({"pid":window.pid,"window_id":window.window_id,"element_token":element.element_token,"action":name,"delivery_mode":"background"}),
                )
            }
            Action::TypeText { index: None, text } => (
                "type_text",
                json!({"target":bound,"text":text,"delivery_mode":native_delivery_mode()}),
            ),
            Action::Paste {
                index: None,
                text,
                options,
            } if matches!(options.format, None | Some(PasteFormat::Text)) => (
                "type_text",
                json!({"target":bound,"text":text,"delivery_mode":native_delivery_mode()}),
            ),
            Action::PressKey { index: None, key } => {
                let mut parts: Vec<_> = key.split('+').collect();
                let key = parts.pop().ok_or_else(|| failed("key must not be empty"))?;
                if key.is_empty() {
                    return Err(failed("key must not be empty"));
                }
                let modifiers: Result<Vec<_>, _> = parts
                    .into_iter()
                    .map(|part| match part.to_ascii_lowercase().as_str() {
                        "super" | "meta" | "cmd" | "command" => Ok(if cfg!(target_os = "macos") {
                            "cmd"
                        } else {
                            "super"
                        }),
                        "ctrl" | "control" => Ok("ctrl"),
                        "alt" | "option" => Ok("alt"),
                        "shift" => Ok("shift"),
                        _ => Err(failed("unsupported key modifier")),
                    })
                    .collect();
                (
                    "press_key",
                    json!({"target":bound,"key":key,"modifiers":modifiers?,"delivery_mode":native_delivery_mode()}),
                )
            }
            Action::Scroll {
                target: position,
                direction,
                distance,
            } => {
                let mut args = if cfg!(target_os = "windows") {
                    let Some(Distance::Pixels { pixels }) = distance else {
                        unreachable!()
                    };
                    json!({"direction":direction.name(),"pixels":pixels,"delivery_mode":native_delivery_mode()})
                } else if cfg!(target_os = "linux") {
                    let pixels = match distance {
                        None => 800.0,
                        Some(Distance::Pixels { pixels }) => pixels,
                        Some(Distance::Pages(_)) => unreachable!(),
                    };
                    let pixels = linux_scroll_pixels(pixels)?;
                    json!({"direction":direction.name(),"pixels":pixels,"delivery_mode":native_delivery_mode()})
                } else {
                    return Err(failed("unsupported native scroll platform"));
                };
                match position {
                    Position::Point(point) => {
                        let point = if cfg!(target_os = "windows") && args.get("pixels").is_some() {
                            windows_scroll_point(point)?
                        } else {
                            point
                        };
                        target.point(point, &window, language)?;
                        args["target"] = bound;
                        args["x"] = json!(point[0]);
                        args["y"] = json!(point[1]);
                    }
                    Position::Element(index)
                        if cfg!(any(target_os = "macos", target_os = "windows"))
                            || args.get("pixels").is_some() =>
                    {
                        args["pid"] = json!(window.pid);
                        args["window_id"] = json!(window.window_id);
                        args["element_token"] =
                            json!(target.element(index, language)?.element_token);
                        args["delivery_mode"] = json!(native_delivery_mode());
                    }
                    _ => {
                        return Err(failed(
                            "unsupported: element scrolling is unavailable on this platform",
                        ));
                    }
                }
                ("scroll", args)
            }
            Action::Drag { from, to } => {
                target.point(from, &window, language)?;
                target.point(to, &window, language)?;
                (
                    "drag",
                    json!({"target":bound,"from_x":from[0],"from_y":from[1],"to_x":to[0],"to_y":to[1],"delivery_mode":native_delivery_mode()}),
                )
            }
            _ => {
                return Err(failed(
                    "unsupported: this native operation is not implemented by the current adapter",
                ));
            }
        };
        let native_window_pixels =
            cfg!(target_os = "linux") && (args.get("x").is_some() || name == "drag");
        let result = if native_window_pixels {
            self.invoke_native_window_pixels(name, args, cancellation, language)
                .await
        } else {
            self.invoke_native(name, args, cancellation, language).await
        };
        // Linux/Windows keep their image frame until another observation.
        // Retained element tokens are revalidated by Cua on each action.
        #[cfg(target_os = "macos")]
        {
            self.targets.get_mut(handle).unwrap().capture = None;
        }
        result.map(|result| result.structured_content.unwrap_or(Value::Null))
    }
    pub async fn close_native(&mut self) -> Result<(), ToolError> {
        match &self.state {
            EpochState::Closed => return Ok(()),
            EpochState::Open | EpochState::Closing => {}
        }
        self.state = EpochState::Closing;
        let mut failures = Vec::new();
        let handles: Vec<_> = self.targets.keys().cloned().collect();
        for handle in handles {
            if let Err(error) = self.retire_target(&handle).await {
                failures.push(error.to_string());
            }
        }
        let cursor = self.owner.cursor();
        if let Err(error) = self.browsers.retire_epoch(&cursor).await {
            failures.push(error.to_string());
        }
        let native_cleanup = if self.id.is_some() {
            let cleanup = self.native.lock().await.release_epoch(self.epoch);
            cleanup.await
        } else {
            Ok(())
        };
        if let Err(error) = native_cleanup {
            failures.push(error.to_string());
        }
        if !failures.is_empty() {
            return Err(ToolError::CleanupUnconfirmed(failures.join("; ")));
        }
        self.id = None;
        self.state = EpochState::Closed;
        Ok(())
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
    async fn cursor_point(
        &self,
        handle: &str,
        position: Option<Position>,
        window: &WindowInfo,
        session: &str,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<[f64; 2], ToolError> {
        #[cfg(not(target_os = "windows"))]
        let _ = (session, cancellation);
        let target = self
            .targets
            .get(handle)
            .ok_or_else(|| failed("stale_target"))?;
        match position {
            None => Ok([
                window.bounds.x + window.bounds.width / 2.0,
                window.bounds.y + window.bounds.height / 2.0,
            ]),
            Some(Position::Point(point)) => {
                target.point(point, window, language)?;
                #[cfg(target_os = "linux")]
                {
                    Ok([window.bounds.x + point[0], window.bounds.y + point[1]])
                }
                #[cfg(not(target_os = "linux"))]
                {
                    let snapshot = target.snapshot.as_ref().unwrap();
                    let width = f64::from(snapshot.screenshot_width.unwrap_or(0));
                    let height = f64::from(snapshot.screenshot_height.unwrap_or(0));
                    if width <= 0.0 || height <= 0.0 {
                        return Err(failed("cursor capture dimensions unavailable"));
                    }
                    Ok([
                        window.bounds.x + point[0] * window.bounds.width / width,
                        window.bounds.y + point[1] * window.bounds.height / height,
                    ])
                }
            }
            Some(Position::Element(index)) => {
                #[cfg(target_os = "macos")]
                if let Some(macos) = target.macos.clone() {
                    return macos.cursor_point(index).await;
                }
                #[cfg(target_os = "windows")]
                {
                    let element = target.element(index, language)?;
                    let result = self
                        .invoke_native(
                            "element_bounds",
                            json!({
                                "pid": window.pid,
                                "window_id": window.window_id,
                                "element_token": element.element_token,
                            }),
                            cancellation,
                            language,
                        )
                        .await?;
                    let frame: cua_driver_contract::ElementFrame = serde_json::from_value(
                        result
                            .structured_content
                            .and_then(|mut value| value.get_mut("frame").map(Value::take))
                            .ok_or_else(|| failed("native element bounds unavailable"))?,
                    )
                    .map_err(failed)?;
                    return Ok([frame.x + frame.w / 2.0, frame.y + frame.h / 2.0]);
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = index;
                    Err(failed(match language {
                        Language::En => {
                            "native cursor element geometry unavailable; use screenshot coordinates"
                        }
                        Language::ZhCn => "无法获取原生光标元素几何信息；请使用截图坐标",
                        Language::ZhTw => "無法取得原生游標元素幾何資訊；請使用擷取畫面座標",
                    }))
                }
            }
        }
    }
}
impl Target {
    fn invalidate_observation(&mut self) {
        self.snapshot = None;
        self.capture = None;
        self.previous = None;
    }
    fn element(
        &self,
        index: u64,
        language: Language,
    ) -> Result<&cua_driver_contract::WindowElement, ToolError> {
        self.snapshot
            .as_ref()
            .and_then(|s| s.elements.as_ref())
            .and_then(|elements| {
                elements
                    .iter()
                    .find(|e| e.element_index == index && e.element_token.is_some())
            })
            .ok_or_else(|| {
                failed(match language {
                    Language::En => "stale_element: read getAXState before using this index",
                    Language::ZhCn => "stale_element: 使用此索引前请先读取 getAXState",
                    Language::ZhTw => "stale_element: 使用此索引前請先讀取 getAXState",
                })
            })
    }
    fn point(
        &self,
        point: [f64; 2],
        window: &WindowInfo,
        language: Language,
    ) -> Result<(), ToolError> {
        #[cfg(target_os = "linux")]
        {
            let _ = language;
            crate::linux_input::Point::try_from(point)
                .and_then(|point| point.check_window(&window.bounds))
                .map_err(|error| failed(error.to_string()))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let snapshot = self.snapshot.as_ref().ok_or_else(|| {
                failed(match language {
                    Language::En => "capture_required: read getScreenshot before coordinate input",
                    Language::ZhCn => "capture_required: 按坐标输入前请先读取 getScreenshot",
                    Language::ZhTw => "capture_required: 按座標輸入前請先讀取 getScreenshot",
                })
            })?;
            if self.capture.is_none()
                || self.window.bounds != window.bounds
                || snapshot.screenshot_frame_valid == Some(false)
            {
                return Err(failed(match language {
                    Language::En => {
                        "stale_capture: window changed or capture was consumed; getScreenshot again"
                    }
                    Language::ZhCn => {
                        "stale_capture: 窗口已改变或截图已消耗；请重新调用 getScreenshot"
                    }
                    Language::ZhTw => {
                        "stale_capture: 視窗已變更或擷取畫面已消耗；請重新呼叫 getScreenshot"
                    }
                }));
            }
            if !point.iter().all(|v| v.is_finite() && *v >= 0.0)
                || point[0] >= f64::from(snapshot.screenshot_width.unwrap_or(0))
                || point[1] >= f64::from(snapshot.screenshot_height.unwrap_or(0))
            {
                return Err(failed("coordinate outside the captured image"));
            }
            Ok(())
        }
    }
}
fn validate_native_observation(
    platform: &str,
    kind: ObservationKind,
    options: &ObservationOptions,
) -> Result<(), ToolError> {
    if platform == "windows" && !matches!(kind, ObservationKind::Ax) && options.emit == Some(false)
    {
        return Err(failed(
            "Windows screenshots are displayed by Sky; emit: false is unavailable.",
        ));
    }
    Ok(())
}

fn validate_native_action(platform: &str, action: &Action) -> Result<(), ToolError> {
    match (platform, action) {
        ("linux", Action::SetValue { .. }) => Err(failed(
            "setValue is unavailable on Linux; use click, pressKey, and typeText.",
        )),
        ("linux" | "windows", Action::SelectText { .. }) => Err(failed(format!(
            "selectText is unavailable on {}.",
            if platform == "linux" {
                "Linux"
            } else {
                "Windows"
            }
        ))),
        (
            "linux" | "windows",
            Action::Paste {
                options: PasteOptions {
                    format: Some(format),
                },
                ..
            },
        ) if !matches!(format, PasteFormat::Text) => Err(failed(format!(
            "{} paste supports only text format.",
            if platform == "linux" {
                "Linux"
            } else {
                "Windows"
            }
        ))),
        (
            "linux",
            Action::Scroll {
                distance: Some(Distance::Pages(_)),
                ..
            },
        ) => Err(failed("Linux scroll accepts { pixels }, not pages.")),
        (
            "mac",
            Action::Scroll {
                distance: Some(Distance::Pixels { .. }),
                ..
            },
        ) => Err(failed("macOS scroll accepts pages, not pixels.")),
        (
            "mac",
            Action::Scroll {
                distance: Some(Distance::Pages(pages)),
                ..
            },
        ) if !pages.is_finite() || *pages <= 0.0 => {
            Err(failed("pages must be a finite number > 0"))
        }
        (
            "windows",
            Action::Scroll {
                target: Position::Point(_),
                distance: Some(Distance::Pixels { pixels }),
                ..
            },
        ) => {
            if !pixels.is_finite() || *pixels <= 0.0 {
                Err(failed("pixels must be a positive finite number."))
            } else {
                Ok(())
            }
        }
        ("windows", Action::Scroll { .. }) => Err(failed(
            "Windows scroll requires a point and a { pixels } distance.",
        )),
        _ => Ok(()),
    }
}

fn linux_scroll_pixels(pixels: f64) -> Result<u16, ToolError> {
    if !pixels.is_finite()
        || pixels.fract() != 0.0
        || !(1.0..=f64::from(u16::MAX)).contains(&pixels)
    {
        return Err(failed("pixels must be an integer between 1 and 65535"));
    }
    Ok(pixels as u16)
}

fn windows_scroll_point(point: [f64; 2]) -> Result<[f64; 2], ToolError> {
    if !point.iter().all(|coordinate| coordinate.is_finite()) {
        return Err(failed("scroll coordinates must be finite numbers"));
    }
    // Round screenshot coordinates before validating their captured-image bounds.
    // JavaScript Math.round chooses positive infinity at a negative half.
    Ok(point.map(|coordinate| {
        let floor = coordinate.floor();
        if coordinate - floor >= 0.5 {
            floor + 1.0
        } else {
            floor
        }
    }))
}

fn native_delivery_mode() -> &'static str {
    if cfg!(target_os = "linux") {
        "background"
    } else {
        "foreground"
    }
}
fn window_info(window: &WindowInfo) -> Value {
    json!({"id":window.window_id,"app":window.app_name,"title":window.title,"isOnScreen":window.is_on_screen,"minimized":window.minimized,"onCurrentSpace":window.on_current_space,"zIndex":window.z_index})
}
fn decode<T: DeserializeOwned>(result: CallResult) -> Result<T, ToolError> {
    serde_json::from_value(
        result
            .structured_content
            .ok_or_else(|| failed("native structured output unavailable"))?,
    )
    .map_err(|error| ToolError::OutcomeUnknown(format!("invalid native result: {error}")))
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
pub(crate) fn display_diff(previous: Option<&str>, current: &str, language: Language) -> String {
    let Some(previous) = previous else {
        return current.into();
    };
    if previous == current {
        return match language {
            Language::En => "Accessibility state unchanged.",
            Language::ZhCn => "无障碍状态未改变。",
            Language::ZhTw => "輔助使用狀態未變更。",
        }
        .into();
    }
    let old: std::collections::HashSet<_> = previous.lines().collect();
    let new: std::collections::HashSet<_> = current.lines().collect();
    let changes: Vec<_> = previous
        .lines()
        .filter(|line| !new.contains(line))
        .map(|line| format!("- {line}"))
        .chain(
            current
                .lines()
                .filter(|line| !old.contains(line))
                .map(|line| format!("+ {line}")),
        )
        .collect();
    let label = match language {
        Language::En => "Accessibility changes",
        Language::ZhCn => "无障碍变化",
        Language::ZhTw => "輔助使用變更",
    };
    let diff = format!("{label}:\n{}", changes.join("\n"));
    if changes.is_empty() || diff.len() >= current.len() {
        current.into()
    } else {
        diff
    }
}

fn app_id(app: &AppInfo) -> String {
    use sha2::{Digest, Sha256};
    if cfg!(target_os = "windows")
        && app.kind.as_deref() != Some("uwp")
        && let Some(path) = &app.launch_path
    {
        return format!("launch:{}", hex::encode(Sha256::digest(path.as_bytes())));
    }
    if let Some(bundle) = &app.bundle_id {
        return bundle.clone();
    }
    if let Some(path) = &app.launch_path {
        return format!("launch:{}", hex::encode(Sha256::digest(path.as_bytes())));
    }
    format!("pid:{}", app.pid)
}

fn launch_args(app: &str, inventory: &[AppInfo], language: Language) -> Result<Value, ToolError> {
    let mut matches = inventory
        .iter()
        .filter(|candidate| app_id(candidate) == app);
    let target = matches.next().ok_or_else(|| {
        failed(match language {
            Language::En => "app identity missing; refresh cua.listApps before launch",
            Language::ZhCn => "应用标识已缺失；启动前请刷新 cua.listApps",
            Language::ZhTw => "應用程式識別已缺少；啟動前請重新整理 cua.listApps",
        })
    })?;
    if matches.next().is_some() {
        return Err(failed(match language {
            Language::En => "app identity ambiguous; refresh cua.listApps before launch",
            Language::ZhCn => "应用标识有歧义；启动前请刷新 cua.listApps",
            Language::ZhTw => "應用程式識別有歧義；啟動前請重新整理 cua.listApps",
        }));
    }
    if target.kind.as_deref() == Some("uwp")
        && let Some(bundle) = target
            .bundle_id
            .as_ref()
            .filter(|bundle| bundle.contains('!'))
    {
        Ok(json!({"aumid":bundle}))
    } else if let Some(path) = &target.launch_path {
        Ok(json!({"launch_path":path}))
    } else {
        Err(failed(match language {
            Language::En => "launch unavailable for this inventory entry; select its open window",
            Language::ZhCn => "此清单条目不支持启动；请选择其已打开的窗口",
            Language::ZhTw => "此清單項目不支援啟動；請選擇其已開啟的視窗",
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn native_geometry_survives_observation_invalidation() {
        let frame = crate::macos::page_scroll::PageFrame::from_native_geometry(
            platform_macos::geometry::NativeWindowGeometry {
                pid: 1,
                window_id: 1,
                layer: 0,
                bounds: platform_macos::windows::WindowBounds {
                    x: -10.0,
                    y: 20.0,
                    width: 100.25,
                    height: 80.125,
                },
                native_scale: 2.0,
            },
            crate::macos::page_scroll::SizingPolicy::SOURCE_DEFAULTS,
        )
        .unwrap();
        let mut target = Target {
            macos: None,
            page_frame: Some(frame),
            window: serde_json::from_value(json!({
                "window_id":1,"pid":1,"app_name":"fixture","title":"fixture",
                "bounds":{"x":0.0,"y":0.0,"width":100.0,"height":80.0},
                "is_on_screen":true,"z_index":null
            }))
            .unwrap(),
            process: "fixture".into(),
            snapshot: None,
            capture: Some("old-image".into()),
            previous: Some("old-AX".into()),
        };
        target.invalidate_observation();
        assert!(target.capture.is_none());
        assert!(target.previous.is_none());
        let retained = target.page_frame.unwrap();
        assert_eq!(retained.bounds().x, -10.0);
        assert_eq!(retained.requested_image_size(), [200.5, 160.25]);
    }

    fn scroll(target: Position, distance: Option<Distance>) -> Action {
        Action::Scroll {
            target,
            direction: Direction::Down,
            distance,
        }
    }

    #[test]
    fn original_native_scroll_shapes_and_positive_domains_are_enforced() {
        let point = || Position::Point([10.0, 20.0]);
        assert!(validate_native_action("linux", &scroll(point(), None)).is_ok());
        assert!(validate_native_action("mac", &scroll(point(), None)).is_ok());
        assert!(validate_native_action("windows", &scroll(point(), None)).is_err());
        for pages in [-1.0, 0.0, 0.5, 1.0, 51.0, f64::MAX] {
            assert!(
                validate_native_action("linux", &scroll(point(), Some(Distance::Pages(pages))))
                    .is_err()
            );
            assert!(
                validate_native_action("windows", &scroll(point(), Some(Distance::Pages(pages))))
                    .is_err()
            );
            assert_eq!(
                validate_native_action("mac", &scroll(point(), Some(Distance::Pages(pages))))
                    .is_ok(),
                pages > 0.0
            );
        }
        for pixels in [f64::NEG_INFINITY, -1.0, 0.0, f64::NAN, f64::INFINITY] {
            assert!(
                validate_native_action(
                    "windows",
                    &scroll(point(), Some(Distance::Pixels { pixels }))
                )
                .is_err()
            );
        }
        for pixels in [0.1, 1.0, 65536.0, f64::MAX] {
            assert!(
                validate_native_action(
                    "windows",
                    &scroll(point(), Some(Distance::Pixels { pixels }))
                )
                .is_ok()
            );
            assert!(
                validate_native_action(
                    "windows",
                    &scroll(Position::Element(1), Some(Distance::Pixels { pixels }))
                )
                .is_err()
            );
            assert!(
                validate_native_action("mac", &scroll(point(), Some(Distance::Pixels { pixels })))
                    .is_err()
            );
        }
    }

    #[test]
    fn original_windows_screenshot_emission_refusal_is_native_only() {
        let options = ObservationOptions {
            emit: Some(false),
            ..Default::default()
        };
        for kind in [ObservationKind::Screenshot, ObservationKind::Both] {
            assert!(validate_native_observation("windows", kind, &options).is_err());
            assert!(validate_native_observation("linux", kind, &options).is_ok());
            assert!(validate_native_observation("mac", kind, &options).is_ok());
        }
        assert!(validate_native_observation("windows", ObservationKind::Ax, &options).is_ok());
        assert!(
            validate_native_observation(
                "windows",
                ObservationKind::Both,
                &ObservationOptions::default()
            )
            .is_ok()
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_unavailable_actions_refuse_before_target_resolution_or_native_dispatch() {
        let driver = std::sync::Arc::new(tokio::sync::Mutex::new(Driver::default()));
        let mut session = Session::new(driver);
        for (action, expected) in [
            (
                Action::SetValue {
                    index: 1,
                    value: "never sent".into(),
                },
                "setValue is unavailable on Linux; use click, pressKey, and typeText.",
            ),
            (
                Action::SelectText {
                    index: 1,
                    text: "never selected".into(),
                    options: SelectOptions::default(),
                },
                "selectText is unavailable on Linux.",
            ),
            (
                scroll(Position::Point([10.0, 20.0]), Some(Distance::Pages(1.0))),
                "Linux scroll accepts { pixels }, not pages.",
            ),
        ] {
            let result = session
                .action(
                    "unresolved",
                    action,
                    "fixture",
                    &CancellationToken::new(),
                    Language::En,
                )
                .await;
            assert!(matches!(result, Err(ToolError::Failed(message)) if message == expected));
        }
    }

    #[test]
    fn windows_scroll_rounds_points_before_captured_image_validation() {
        assert_eq!(windows_scroll_point([0.5, -0.5]).unwrap(), [1.0, 0.0]);
        assert_eq!(
            windows_scroll_point([99.9, 0.49999999999999994]).unwrap(),
            [100.0, 0.0]
        );
        assert!(windows_scroll_point([f64::INFINITY, 0.0]).is_err());
        assert!(windows_scroll_point([0.0, f64::NAN]).is_err());
    }

    #[test]
    fn linux_pixels_preserve_the_original_native_u16_domain_without_rounding() {
        for pixels in [1.0, 49.0, 150.0, 800.0, 5100.0, 65535.0] {
            assert_eq!(f64::from(linux_scroll_pixels(pixels).unwrap()), pixels);
        }
        for pixels in [
            0.0,
            -1.0,
            0.1,
            49.5,
            149.5,
            150.1,
            65536.0,
            f64::NAN,
            f64::INFINITY,
        ] {
            assert!(matches!(linux_scroll_pixels(pixels),
                Err(ToolError::Failed(message))
                    if message == "pixels must be an integer between 1 and 65535"));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shortcuts_keep_different_parameters_for_the_same_executable() {
        let first: AppInfo = serde_json::from_value(json!({"pid":0,"name":"First profile","running":false,"active":false,"bundle_id":"C:\\Apps\\Browser.exe","launch_path":"C:\\Apps\\Browser.exe --profile first"})).unwrap();
        let mut second = first.clone();
        second.launch_path = Some("C:\\Apps\\Browser.exe --profile second".into());
        assert_ne!(app_id(&first), app_id(&second));
        let id = app_id(&second);
        let expected = json!({"launch_path":second.launch_path});
        assert_eq!(
            launch_args(&id, &[first, second], Language::En).unwrap(),
            expected
        );
    }
    #[test]
    fn launch_uses_revalidated_inventory_identity_not_pid_zero_or_caller_path() {
        let app = |path: &str| AppInfo {
            pid: 0,
            name: "Installed app".into(),
            running: false,
            active: false,
            bundle_id: None,
            launch_path: Some(path.into()),
            kind: Some("desktop".into()),
            last_used: None,
        };
        let first = app(r#""C:\Apps\First.exe" --profile owned"#);
        let second = app(r#"C:\Apps\Second.exe"#);
        assert_ne!(app_id(&first), app_id(&second));
        let id = app_id(&first);
        let inventory = [first.clone(), second];
        assert_eq!(
            launch_args(&id, &inventory, Language::En).unwrap(),
            json!({"launch_path":first.launch_path})
        );
        assert!(
            matches!(launch_args("C:\\Apps\\First.exe", &inventory, Language::En), Err(ToolError::Failed(message)) if message.contains("app identity missing"))
        );
        assert!(
            matches!(launch_args(&id, &[inventory[1].clone()], Language::En), Err(ToolError::Failed(message)) if message.contains("app identity missing"))
        );
        assert!(
            matches!(launch_args(&id, &[first.clone(), first.clone()], Language::En), Err(ToolError::Failed(message)) if message.contains("app identity ambiguous"))
        );
        let mut family_only = first.clone();
        family_only.kind = Some("uwp".into());
        family_only.bundle_id = Some("Maka_fixture_family".into());
        family_only.launch_path = Some(r"shell:appsFolder\Maka_fixture_family!App".into());
        assert_eq!(
            launch_args("Maka_fixture_family", &[family_only], Language::En).unwrap(),
            json!({"launch_path":r"shell:appsFolder\Maka_fixture_family!App"})
        );
        let mut packaged = first;
        packaged.bundle_id = Some("Maka_fixture!App".into());
        packaged.kind = Some("uwp".into());
        assert_eq!(
            launch_args("Maka_fixture!App", &[packaged], Language::En).unwrap(),
            json!({"aumid":"Maka_fixture!App"})
        );
    }
}
