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

//! Raw public computer calls remain children of the admitted Session.

use super::*;
use crate::driver::native_computer::RawTool;

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
mod files;
mod input;
#[cfg(all(target_os = "linux", not(target_env = "musl")))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Default)]
pub(super) struct RawComputer {
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    files: files::CaptureFiles,
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    ready_at: Option<tokio::time::Instant>,
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    pub(super) handles: HashMap<String, String>,
    #[cfg(target_os = "windows")]
    windows: HashMap<u64, WindowsObservation>,
    #[cfg(target_os = "macos")]
    mac_targets: HashMap<MacApplicationKey, MacApplicationRecord>,
}

#[cfg(target_os = "macos")]
struct MacApplicationRecord {
    pid: u32,
    process: String,
    controller: crate::macos::controller::Controller,
    application: crate::macos::controller::Application,
    state: MacApplicationState,
    window: MacWindowState,
    previous: Option<String>,
}

#[cfg(target_os = "macos")]
enum MacApplicationState {
    Active,
    Retiring { error: Option<ToolError> },
}

#[cfg(target_os = "macos")]
impl MacApplicationState {
    fn admit(&self) -> Result<(), ToolError> {
        match self {
            Self::Active => Ok(()),
            Self::Retiring { error } => Err(error.clone().unwrap_or_else(|| {
                ToolError::CleanupUnconfirmed(
                    "native application retirement has not completed".into(),
                )
            })),
        }
    }
}

#[cfg(target_os = "macos")]
enum MacWindowState {
    None,
    Live(String),
    Retiring {
        handle: String,
        error: Option<ToolError>,
    },
}

#[cfg(target_os = "macos")]
impl MacWindowState {
    fn current(&self) -> Result<Option<&str>, ToolError> {
        match self {
            Self::None => Ok(None),
            Self::Live(handle) => Ok(Some(handle)),
            Self::Retiring { error, .. } => Err(error.clone().unwrap_or_else(|| {
                ToolError::CleanupUnconfirmed("native window retirement has not completed".into())
            })),
        }
    }

    fn retained(&self) -> Option<&str> {
        match self {
            Self::None => None,
            Self::Live(handle) | Self::Retiring { handle, .. } => Some(handle),
        }
    }
}

#[cfg(target_os = "macos")]
fn admit_mac_application(
    state: &MacApplicationState,
    window: &MacWindowState,
) -> Result<(), ToolError> {
    state.admit()?;
    window.current().map(|_| ())
}

#[cfg(target_os = "macos")]
impl RawComputer {
    pub(super) fn retiring_mac_window(&mut self, handle: &str) {
        for record in self.mac_targets.values_mut() {
            if matches!(&record.window, MacWindowState::Live(current) if current == handle) {
                record.window = MacWindowState::Retiring {
                    handle: handle.into(),
                    error: None,
                };
            }
        }
    }

    pub(super) fn retired_mac_window(&mut self, handle: &str, result: &Result<(), ToolError>) {
        for record in self.mac_targets.values_mut() {
            if record.window.retained() == Some(handle) {
                record.window = match result {
                    Ok(()) => MacWindowState::None,
                    Err(error) => {
                        let original = match &record.window {
                            MacWindowState::Retiring {
                                error: Some(original),
                                ..
                            } => original.clone(),
                            _ => error.clone(),
                        };
                        MacWindowState::Retiring {
                            handle: handle.into(),
                            error: Some(original),
                        }
                    }
                };
            }
        }
    }

    pub(super) fn clear_mac_targets(&mut self) {
        self.mac_targets.clear();
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct MacApplicationKey {
    application_id: String,
    canonical_path: String,
}

#[cfg(target_os = "macos")]
impl MacApplicationKey {
    fn of(approved: &crate::ComputerAppTarget) -> Self {
        Self {
            application_id: approved.identity.application_id.clone(),
            canonical_path: approved.display.app_path.clone(),
        }
    }
}

#[cfg(target_os = "windows")]
struct WindowsObservation {
    binding: crate::ComputerAppBinding,
    generation: crate::desktop::worker::native_owner::NativeGeneration,
    state: WindowStateOutput,
    capture: Option<String>,
}

impl Session {
    pub(super) async fn native_computer(
        &mut self,
        call: NativeComputerCall,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        self.admit_invocation(invocation.session(), cancellation)?;
        #[cfg(all(target_os = "linux", not(target_env = "musl")))]
        {
            return self
                .raw_linux(call, invocation, cancellation, language)
                .await;
        }
        #[cfg(target_os = "windows")]
        {
            return self
                .raw_windows(call, invocation, cancellation, language)
                .await;
        }
        #[cfg(target_os = "macos")]
        {
            return self
                .raw_macos(call, invocation, cancellation, language)
                .await;
        }
        #[allow(unreachable_code)]
        Err(failed(
            "raw computer provider is unavailable on this target",
        ))
    }

    async fn raw_tool(
        &self,
        tool: RawTool,
        arguments: Value,
        pixels: bool,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<CallResult, ToolError> {
        Driver::invoke_raw_native(
            &self.native,
            tool,
            arguments,
            self.epoch,
            cancellation,
            language,
            pixels,
        )
        .await
    }

    /// Resolve the actual current window/process without the public getApp
    /// wrapper, which would additionally read AX and change the raw API.
    async fn raw_window(
        &mut self,
        id: u64,
        _invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<(WindowInfo, String), ToolError> {
        #[cfg(not(all(target_os = "linux", not(target_env = "musl"))))]
        let windows = self
            .windows(_invocation.session(), cancellation, language)
            .await?;
        #[cfg(all(target_os = "linux", not(target_env = "musl")))]
        let windows = self.raw_linux_bindings(cancellation, language).await?;
        let mut candidates = windows.into_iter().filter(|window| window.window_id == id);
        let window = candidates
            .next()
            .ok_or_else(|| failed("stale_target: native window is unavailable"))?;
        if candidates.next().is_some() {
            return Err(failed("native window selection is ambiguous"));
        }
        let pid = window
            .pid
            .ok_or_else(|| failed("window process identity unavailable"))?;
        #[cfg(not(target_os = "windows"))]
        let generation = crate::identity::process(pid)?;
        #[cfg(target_os = "windows")]
        let generation = {
            let approved = _invocation
                .app_target()
                .ok_or_else(|| failed("raw window requires current app consent"))?;
            let binding = crate::windows_permission_subject::verify_window(approved, id, language)?;
            if binding.pid != pid {
                return Err(failed("stale_target: native window changed during binding"));
            }
            binding.process_generation
        };
        Ok((window, generation))
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn data_url(block: &ContentBlock) -> Result<String, ToolError> {
    match block {
        ContentBlock::Image { data, mime_type } => Ok(format!("data:{mime_type};base64,{data}")),
        _ => Err(failed("native capture returned no image")),
    }
}

#[cfg(target_os = "windows")]
fn window_id(input: &Value) -> Result<u64, ToolError> {
    input
        .get("window")
        .and_then(|window| window.get("id"))
        .and_then(Value::as_u64)
        .ok_or_else(|| failed("window.id is required"))
}

fn structured(result: CallResult) -> Result<Value, ToolError> {
    result
        .structured_content
        .ok_or_else(|| failed("native provider returned no structured result"))
}

#[cfg(target_os = "windows")]
pub(super) fn windows_permission_input(
    method: NativeComputerMethod,
    args: &[Value],
) -> Result<Option<u64>, ToolError> {
    let input = input::windows(method, input::first(args))?;
    input.get("window").map(|_| window_id(&input)).transpose()
}

#[cfg(all(test, target_os = "macos"))]
mod mac_retirement_tests {
    use super::*;

    #[test]
    fn partial_app_or_window_retirement_keeps_its_original_cause_and_refuses_admission() {
        let active = MacApplicationState::Active;
        let live = MacWindowState::Live("old exact window".into());
        admit_mac_application(&active, &live).unwrap();
        let pending = MacWindowState::Retiring {
            handle: "old exact window".into(),
            error: None,
        };
        assert!(matches!(
            admit_mac_application(&active, &pending),
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        assert_eq!(pending.retained(), Some("old exact window"));
        let failed = MacWindowState::Retiring {
            handle: "old exact window".into(),
            error: Some(ToolError::OutcomeUnknown("original window release".into())),
        };
        assert!(matches!(admit_mac_application(&active, &failed),
            Err(ToolError::OutcomeUnknown(reason)) if reason == "original window release"));
        assert_eq!(failed.retained(), Some("old exact window"));
        let app = MacApplicationState::Retiring {
            error: Some(ToolError::CleanupUnconfirmed(
                "App ACK received; Window ACK unconfirmed".into(),
            )),
        };
        assert!(matches!(admit_mac_application(&app, &MacWindowState::None),
            Err(ToolError::CleanupUnconfirmed(reason)) if reason == "App ACK received; Window ACK unconfirmed"));
        assert!(matches!(active, MacApplicationState::Active));
    }
}
