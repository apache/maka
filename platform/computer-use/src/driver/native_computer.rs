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

//! Raw requests share the existing immutable SDK binding and Core admission.

use super::*;

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
#[derive(Default)]
pub(super) struct NativeTurns {
    owners: std::collections::HashMap<String, Arc<cua_driver_sdk::NativeDesktopOwner>>,
    closed: std::collections::HashSet<String>,
}

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
pub(super) struct ActiveInput {
    bound: Arc<BoundSession>,
    turn: String,
    owner: Arc<cua_driver_sdk::NativeDesktopOwner>,
}

impl Driver {
    /// These are actual registered Cua tools. This narrow entry adds no model
    /// named-tool escape hatch to the ordinary App facade.
    pub(crate) async fn invoke_raw_native(
        driver: &Arc<Mutex<Self>>,
        tool: RawTool,
        input: Value,
        epoch: NativeEpochId,
        cancellation: &CancellationToken,
        language: Language,
        window_pixels: bool,
    ) -> Result<CallResult, ToolError> {
        Self::invoke_with_coordinates(
            driver,
            tool.name(),
            input,
            epoch,
            cancellation,
            language,
            if window_pixels {
                NativeCoordinates::WindowPixels
            } else {
                NativeCoordinates::Captured
            },
            #[cfg(target_os = "windows")]
            None,
        )
        .await
    }

    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    pub(crate) async fn input_raw_desktop(
        driver: &Arc<Mutex<Self>>,
        epoch: NativeEpochId,
        turn: &str,
        request: platform_linux::input::native_desktop::NativeDesktopRequest,
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
        let device = driver.lock().await.native_input.clone();
        let mut device = device.lock().await;
        if let Some(previous) = device.as_ref()
            && (!Arc::ptr_eq(&previous.bound, &bound) || previous.turn != turn)
        {
            previous.owner.seal();
            previous.owner.close().await.map_err(|error| {
                ToolError::Failed(format!(
                    "native_input_busy: previous input release is unconfirmed: {error}"
                ))
            })?;
            let mut turns = previous.bound.native_turns.lock().await;
            if turns
                .owners
                .get(&previous.turn)
                .is_some_and(|owner| Arc::ptr_eq(owner, &previous.owner))
            {
                turns.owners.remove(&previous.turn);
            }
            drop(turns);
            *device = None;
        }
        let owner = {
            let mut turns = bound.native_turns.lock().await;
            if turns.closed.contains(turn) {
                return Err(ToolError::Failed("native desktop turn is closed".into()));
            }
            // Passive SDK construction conveys no authority and opens no X11
            // connection. Every operation still enters the actual named tool.
            match turns.owners.entry(turn.to_owned()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.get().clone(),
                std::collections::hash_map::Entry::Vacant(entry) => entry
                    .insert(
                        session
                            .native_desktop_owner()
                            .map_err(|error| native_error(error, language))?,
                    )
                    .clone(),
            }
        };
        *device = Some(ActiveInput {
            bound: bound.clone(),
            turn: turn.to_owned(),
            owner: owner.clone(),
        });
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native input dispatch".into(),
            ));
        }
        // Stop closes this exact owner, then the same accepted invocation
        // settles under its original Host future and Core worker lease.
        let call = session.input_native_desktop(&owner, request);
        tokio::pin!(call);
        let result = tokio::select! {biased;
            _=cancellation.cancelled()=>{owner.seal();call.await},
            result=&mut call=>result,
        }
        .map_err(|error| native_error(error, language))?;
        native_input_result(result, language)
    }

    /// Finish a turn without initializing a runtime or native connection.
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    pub(crate) async fn finish_raw_native_turn(
        driver: &Arc<Mutex<Self>>,
        epoch: NativeEpochId,
        turn: &str,
    ) -> Result<(), ToolError> {
        let bound = driver.lock().await.sessions.get(&epoch).cloned();
        let Some(bound) = bound else {
            return Ok(());
        };
        let owner = {
            let mut turns = bound.native_turns.lock().await;
            turns.closed.insert(turn.to_owned());
            let owner = turns.owners.get(turn).cloned();
            if let Some(owner) = &owner {
                owner.seal();
            }
            owner
        };
        if let Some(owner) = owner {
            owner
                .close()
                .await
                .map_err(|error| ToolError::CleanupUnconfirmed(error.to_string()))?;
            // Failed close never reaches removal. The real connection/pressed
            // state stays owned and quarantined for subsequent cleanup.
            bound.native_turns.lock().await.owners.remove(turn);
        }
        Ok(())
    }
}

#[cfg(all(target_os = "linux", not(target_env = "musl")))]
impl BoundSession {
    pub(super) async fn close_raw_native(&self) -> Result<(), ToolError> {
        let owners = {
            let mut turns = self.native_turns.lock().await;
            let keys: Vec<_> = turns.owners.keys().cloned().collect();
            turns.closed.extend(keys);
            for owner in turns.owners.values() {
                owner.seal();
            }
            turns.owners.values().cloned().collect::<Vec<_>>()
        };
        let mut failures = Vec::new();
        for owner in owners {
            if let Err(error) = owner.close().await {
                failures.push(error.to_string());
            }
        }
        if failures.is_empty() {
            self.native_turns.lock().await.owners.clear();
            Ok(())
        } else {
            Err(ToolError::CleanupUnconfirmed(failures.join("; ")))
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum RawTool {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    ListApps,
    #[cfg(target_os = "windows")]
    GetWindowState,
    #[cfg(target_os = "windows")]
    Click,
    #[cfg(target_os = "windows")]
    Drag,
    #[cfg(target_os = "windows")]
    Scroll,
    #[cfg(target_os = "windows")]
    PressKey,
    #[cfg(target_os = "windows")]
    TypeText,
    #[cfg(target_os = "windows")]
    SetValue,
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    LaunchApp,
    #[cfg(any(
        target_os = "windows",
        all(target_os = "linux", not(target_env = "musl"))
    ))]
    ActivateWindow,
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    DesktopScreenshot,
    #[cfg(target_os = "windows")]
    SecondaryAction,
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    LinuxWindows,
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    LinuxApps,
    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    LinuxLaunch,
}

impl RawTool {
    pub(crate) const fn name(self) -> &'static str {
        match self {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            Self::ListApps => "list_apps",
            #[cfg(target_os = "windows")]
            Self::GetWindowState => "get_window_state",
            #[cfg(target_os = "windows")]
            Self::Click => "click",
            #[cfg(target_os = "windows")]
            Self::Drag => "drag",
            #[cfg(target_os = "windows")]
            Self::Scroll => "scroll",
            #[cfg(target_os = "windows")]
            Self::PressKey => "press_key",
            #[cfg(target_os = "windows")]
            Self::TypeText => "type_text",
            #[cfg(target_os = "windows")]
            Self::SetValue => "set_value",
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            Self::LaunchApp => "launch_app",
            #[cfg(any(
                target_os = "windows",
                all(target_os = "linux", not(target_env = "musl"))
            ))]
            Self::ActivateWindow => "bring_to_front",
            #[cfg(all(target_os = "linux", not(target_env = "musl")))]
            Self::DesktopScreenshot => "get_desktop_state",
            #[cfg(target_os = "windows")]
            Self::SecondaryAction => "native_secondary_action",
            #[cfg(all(target_os = "linux", not(target_env = "musl")))]
            Self::LinuxWindows => "native_list_windows",
            #[cfg(all(target_os = "linux", not(target_env = "musl")))]
            Self::LinuxApps => "native_list_apps",
            #[cfg(all(target_os = "linux", not(target_env = "musl")))]
            Self::LinuxLaunch => "native_launch_app",
        }
    }
}

#[cfg(all(test, target_os = "linux", not(target_env = "musl")))]
mod retirement_tests {
    use crate::desktop::{NativeEpochId, observe_retirement};
    use crate::driver::{Driver, RetiringEpoch, State};
    use cua_driver_contract::GetSessionInput;
    use maka_agent_facts::{language::Language, tools::ToolError};
    use std::sync::Arc;
    use tokio::sync::watch;

    #[cfg(all(target_os = "linux", not(target_env = "musl")))]
    #[tokio::test]
    async fn terminal_close_joins_pending_then_retries_only_original_passive_resources() {
        let mut driver = Driver::default();
        let epoch = NativeEpochId::new();
        let bound = driver.bind_epoch(epoch, Language::En).unwrap();
        let session = bound.ready(Language::En).await.unwrap();
        let owner = session.native_desktop_owner().unwrap();
        owner.seal();
        {
            let mut turns = bound.native_turns.lock().await;
            turns.closed.insert("original-turn".into());
            turns.owners.insert("original-turn".into(), owner);
        }
        driver.sessions.remove(&epoch);
        let (reply, pending) = watch::channel(None);
        let old_observer = pending.clone();
        driver.retiring_epochs.insert(
            epoch,
            RetiringEpoch {
                pending,
                _session: Some(session.clone()),
                _bound: Some(bound.clone()),
            },
        );
        // This fixture represents an original cleanup observation only. The
        // real SDK binding/passive owner open no X11 or clipboard resource;
        // it is an orchestration test, not a claim of a failed physical UP.
        let original =
            ToolError::CleanupUnconfirmed("original fixed cleanup did not acknowledge".into());
        {
            let first_close = driver.close();
            tokio::pin!(first_close);
            tokio::select! { biased;
                result = &mut first_close => panic!("pending original cleanup was not joined: {result:?}"),
                _ = tokio::task::yield_now() => {}
            }
            reply.send(Some(Err(original.clone()))).unwrap();
            assert!(matches!(
                first_close.await,
                Err(ToolError::CleanupUnconfirmed(_))
            ));
        }
        assert!(Arc::ptr_eq(
            driver.retiring_epochs[&epoch]._bound.as_ref().unwrap(),
            &bound
        ));
        assert_eq!(bound.native_turns.lock().await.owners.len(), 1);
        assert!(
            session
                .get_session(GetSessionInput { session: None })
                .await
                .is_ok(),
            "joining a failed resource cleanup must not close the original SDK session"
        );
        driver.release_epoch(epoch).await.unwrap();
        assert!(bound.native_turns.lock().await.owners.is_empty());
        driver.close().await.unwrap();
        assert!(matches!(driver.state, State::Closed));
        assert!(bound.native_turns.lock().await.owners.is_empty());
        assert!(
            bound
                .native_turns
                .lock()
                .await
                .closed
                .contains("original-turn")
        );
        assert!(
            session
                .get_session(GetSessionInput { session: None })
                .await
                .is_err()
        );
        assert_eq!(
            observe_retirement(old_observer)
                .await
                .unwrap_err()
                .to_string(),
            original.to_string(),
            "a later resource cleanup cannot rewrite the original failed observer"
        );
    }
}
