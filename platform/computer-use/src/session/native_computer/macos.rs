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

use super::*;

#[derive(Clone, Copy)]
enum MacWindowSelection {
    Retained,
    Primary(u32),
}

impl Session {
    pub(super) async fn raw_macos(
        &mut self,
        call: NativeComputerCall,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let NativeComputerCall::Invoke { operation, args } = call else {
            return Err(failed("drag_handle is not installed for macOS"));
        };
        if matches!(operation, NativeComputerMethod::ListApps) {
            let apps: ListAppsOutput = decode(
                self.raw_tool(RawTool::ListApps, json!({}), false, cancellation, language)
                    .await?,
            )?;
            return Ok(project_app_records(&apps.apps));
        }
        // The Host has already resolved policy/approval from the immutable app
        // selector. Action coordinate validation intentionally occurs afterward.
        let approved = invocation
            .app_target()
            .cloned()
            .ok_or_else(|| failed("native app requires current app consent"))?;
        let mut input = input::mac(operation, input::first(&args))?;
        input["app"] = approved.display.app_path.clone().into();
        if matches!(operation, NativeComputerMethod::GetAppState) {
            let key = self
                .raw_mac_application(&approved, cancellation, language)
                .await?;
            return self
                .raw_mac_state(&key, &approved, &input, invocation, cancellation, language)
                .await;
        }
        let index = || -> Result<u64, ToolError> {
            // Direct-client signed integers and the native negative-index
            // error boundary remain an explicit parity seam; never saturate
            // a negative value into an unrelated retained element handle.
            input
                .get("element_index")
                .and_then(Value::as_i64)
                .and_then(|index| u64::try_from(index).ok())
                .ok_or_else(|| failed("elementIndex must be an integer"))
        };
        let position = || -> Result<Position, ToolError> {
            if input
                .get("element_index")
                .is_some_and(|value| !value.is_null())
            {
                Ok(Position::Element(index()?))
            } else {
                Ok(Position::Point([
                    input::finite(input.get("x"), "x")?,
                    input::finite(input.get("y"), "y")?,
                ]))
            }
        };
        let text = |name: &str| -> Result<String, ToolError> {
            input
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| failed(format!("{name} is required")))
        };
        if matches!(operation, NativeComputerMethod::Click)
            && input.get("element_index").is_none_or(Value::is_null)
        {
            let point = [
                input::finite(input.get("x"), "x")?,
                input::finite(input.get("y"), "y")?,
            ];
            let button = input::mac_mouse_button(&input["mouse_button"])?;
            let count: i64 =
                serde_json::from_value(input["click_count"].clone()).map_err(failed)?;
            let key = self
                .raw_mac_application(&approved, cancellation, language)
                .await?;
            let handle = self
                .raw_mac_window(
                    &key,
                    &approved,
                    MacWindowSelection::Retained,
                    invocation,
                    cancellation,
                    language,
                )
                .await?;
            if self.targets.get(&handle).unwrap().page_frame.is_none() {
                let window = self
                    .verify(&handle, invocation.session(), cancellation, language)
                    .await?;
                self.prepare_page_frame(&handle, &window, cancellation)
                    .await?;
            }
            let frame = self
                .targets
                .get(&handle)
                .unwrap()
                .page_frame
                .clone()
                .expect("native geometry preparation retains its frame");
            let record = self
                .raw_computer
                .mac_targets
                .get(&key)
                .ok_or_else(|| failed("native app target unavailable"))?;
            let application = record.application.clone();
            let controller = record.controller.clone();
            let authority = invocation
                .native_monitor_authority()
                .ok_or_else(|| failed("native input requires its current Host monitor lease"))?;
            if authority.subject() != &approved {
                return Err(failed("native monitor lease belongs to a different app"));
            }
            let focus = controller.attach_focus(self.epoch, authority).await?;
            let request = crate::macos::mouse::CoordinateClick {
                application,
                controller,
                epoch: self.epoch,
                frame,
                input: crate::macos::mouse::Input {
                    point,
                    button,
                    count,
                },
                cursor: self.owner.cursor(),
                cancellation: cancellation.clone(),
                focus,
            };
            let result = request.run(self.native.clone()).await;
            self.targets.get_mut(&handle).unwrap().capture = None;
            return result.map(|()| Value::Null);
        }
        let action = match operation {
            NativeComputerMethod::Click => Action::Click {
                target: position()?,
                options: ClickOptions {
                    mouse_button: Some(input::mac_mouse_button(&input["mouse_button"])?),
                    click_count: Some(
                        serde_json::from_value(input["click_count"].clone()).map_err(failed)?,
                    ),
                },
            },
            NativeComputerMethod::Drag => Action::Drag {
                from: [
                    input::finite(input.get("from_x"), "from_x")?,
                    input::finite(input.get("from_y"), "from_y")?,
                ],
                to: [
                    input::finite(input.get("to_x"), "to_x")?,
                    input::finite(input.get("to_y"), "to_y")?,
                ],
            },
            NativeComputerMethod::Scroll => Action::Scroll {
                target: position()?,
                direction: input::mac_direction(&input["direction"])?,
                distance: Some(Distance::Pages(input["pages"].as_f64().unwrap())),
            },
            NativeComputerMethod::SetValue => Action::SetValue {
                index: index()?,
                value: text("value")?,
            },
            NativeComputerMethod::SelectText => Action::SelectText {
                index: index()?,
                text: text("text")?,
                options: SelectOptions {
                    prefix: input
                        .get("prefix")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    suffix: input
                        .get("suffix")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    selection_type: Some(
                        serde_json::from_value(input["selection_type"].clone()).map_err(failed)?,
                    ),
                },
            },
            NativeComputerMethod::PerformSecondaryAction => Action::Secondary {
                index: index()?,
                action: text("action")?,
            },
            NativeComputerMethod::PressKey => Action::PressKey {
                index: None,
                key: text("key")?,
            },
            NativeComputerMethod::TypeText => Action::TypeText {
                index: None,
                text: text("text")?,
            },
            NativeComputerMethod::Paste => {
                let format: PasteFormat = serde_json::from_value(
                    input
                        .get("format")
                        .cloned()
                        .ok_or_else(|| failed("format is required"))?,
                )
                .map_err(failed)?;
                let text = text("text")?;
                // The native app-wide paste body remains a separate parity seam.
                let key = self
                    .raw_mac_application(&approved, cancellation, language)
                    .await?;
                let handle = self
                    .raw_mac_window(
                        &key,
                        &approved,
                        MacWindowSelection::Retained,
                        invocation,
                        cancellation,
                        language,
                    )
                    .await?;
                let target = self
                    .targets
                    .get(&handle)
                    .and_then(|target| target.macos.clone())
                    .ok_or_else(|| failed("native app target unavailable"))?;
                target.paste(text, format, cancellation.clone()).await?;
                return Ok(Value::Null);
            }
            _ => return Err(failed("native method is not installed for macOS")),
        };
        let key = self
            .raw_mac_application(&approved, cancellation, language)
            .await?;
        if matches!(&action, Action::PressKey { .. } | Action::TypeText { .. }) {
            let input = match action {
                Action::PressKey { key, .. } => crate::macos::keyboard::Input::PressKey(key),
                Action::TypeText { text, .. } => crate::macos::keyboard::Input::TypeText(text),
                _ => unreachable!("keyboard action was selected"),
            };
            let record = self
                .raw_computer
                .mac_targets
                .get(&key)
                .ok_or_else(|| failed("native app target unavailable"))?;
            let application = record.application.clone();
            let controller = record.controller.clone();
            let authority = invocation
                .native_monitor_authority()
                .ok_or_else(|| failed("native input requires its current Host monitor lease"))?;
            if authority.subject() != &approved {
                return Err(failed("native monitor lease belongs to a different app"));
            }
            let focus = controller.attach_focus(self.epoch, authority).await?;
            application
                .keyboard(input, cancellation.clone(), focus, self.native.clone())
                .await?;
            return Ok(Value::Null);
        }
        if crate::macos::Target::handles(&action) {
            let application = self
                .raw_computer
                .mac_targets
                .get(&key)
                .ok_or_else(|| failed("native app target unavailable"))?
                .application
                .clone();
            let authority = invocation
                .native_monitor_authority()
                .ok_or_else(|| failed("native input requires its current Host monitor lease"))?;
            if authority.subject() != &approved {
                return Err(failed("native monitor lease belongs to a different app"));
            }
            let controller = self
                .raw_computer
                .mac_targets
                .get(&key)
                .ok_or_else(|| failed("native app target unavailable"))?
                .controller
                .clone();
            let focus = controller.attach_focus(self.epoch, authority).await?;
            application
                .native_action(action, cancellation.clone(), focus)
                .await?;
        } else {
            let handle = self
                .raw_mac_window(
                    &key,
                    &approved,
                    MacWindowSelection::Retained,
                    invocation,
                    cancellation,
                    language,
                )
                .await?;
            if matches!(
                action,
                Action::Scroll {
                    target: Position::Element(_),
                    ..
                }
            ) {
                self.raw_mac_indexed_scroll(
                    &key,
                    &handle,
                    action,
                    invocation,
                    cancellation,
                    language,
                )
                .await?;
            } else {
                // Coordinate routes retain their existing exact-window input.
                self.action(
                    &handle,
                    action,
                    invocation.session(),
                    cancellation,
                    language,
                )
                .await?;
            }
        }
        Ok(Value::Null)
    }

    async fn raw_mac_processes(
        &self,
        approved: &crate::ComputerAppTarget,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Vec<u32>, ToolError> {
        let apps: ListAppsOutput = decode(
            self.raw_tool(RawTool::ListApps, json!({}), false, cancellation, language)
                .await?,
        )?;
        let name = approved.display.app_path.clone();
        let expected = approved.clone();
        let mut pids = tokio::task::spawn_blocking(move || {
            crate::macos::permission_subject::matching_processes(&name, &apps.apps, Some(&expected))
        })
        .await
        .map_err(failed)??;
        pids.retain(|pid| *pid != 0);
        pids.sort_unstable();
        pids.dedup();
        Ok(pids)
    }

    async fn retire_raw_mac_application(
        &mut self,
        key: &MacApplicationKey,
    ) -> Result<(), ToolError> {
        let Some(record) = self.raw_computer.mac_targets.get_mut(key) else {
            return Ok(());
        };
        let application = record.application.clone();
        let controller = record.controller.clone();
        let window = record.window.retained().map(str::to_owned);
        record.state = MacApplicationState::Retiring { error: None };
        let result: Result<(), ToolError> = async {
            controller.release_focus(self.epoch).await?;
            application.release().await?;
            if let Some(handle) = window
                && self.targets.contains_key(&handle)
            {
                self.retire_target(&handle).await?;
            }
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                self.raw_computer.mac_targets.remove(key);
                Ok(())
            }
            Err(error) => {
                self.raw_computer.mac_targets.get_mut(key).unwrap().state =
                    MacApplicationState::Retiring {
                        error: Some(error.clone()),
                    };
                Err(error)
            }
        }
    }

    async fn raw_mac_application(
        &mut self,
        approved: &crate::ComputerAppTarget,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<MacApplicationKey, ToolError> {
        let key = MacApplicationKey::of(approved);
        if let Some(record) = self.raw_computer.mac_targets.get(&key) {
            admit_mac_application(&record.state, &record.window)?;
        }
        let mut pids = self
            .raw_mac_processes(approved, cancellation, language)
            .await?;
        let cached = self.raw_computer.mac_targets.get(&key).map(|record| {
            (
                record.pid,
                record.process.clone(),
                record.controller.clone(),
            )
        });
        if let Some((pid, generation, issued)) = cached {
            let current = match crate::identity::process(pid) {
                Ok(current) => Some(current),
                Err(ToolError::Failed(_)) => None,
                Err(error) => return Err(error),
            };
            if current.as_ref() == Some(&generation) && pids.contains(&pid) {
                let controller = Driver::mac_controller(
                    &self.native,
                    i32::try_from(pid).map_err(failed)?,
                    &generation,
                )
                .await?;
                if controller.same_owner(&issued) {
                    return Ok(key);
                }
            }
            if current.as_ref() != Some(&generation) {
                Driver::retire_mac_generation(
                    &self.native,
                    i32::try_from(pid).map_err(failed)?,
                    &generation,
                )
                .await?;
            }
            self.retire_raw_mac_application(&key).await?;
        }
        if pids.is_empty() {
            let expected = approved.clone();
            tokio::task::spawn_blocking(move || {
                crate::macos::permission_subject::verify_launch(&expected, language)
            })
            .await
            .map_err(failed)??;
            let launched = structured(
                self.raw_tool(
                    RawTool::LaunchApp,
                    json!({"name":approved.display.app_path}),
                    false,
                    cancellation,
                    language,
                )
                .await?,
            )?;
            let pid = launched["pid"]
                .as_u64()
                .and_then(|pid| u32::try_from(pid).ok())
                .filter(|pid| *pid != 0)
                .ok_or_else(|| {
                    ToolError::OutcomeUnknown(
                        "launch requested but process identity unavailable".into(),
                    )
                })?;
            pids = self
                .raw_mac_processes(approved, cancellation, language)
                .await?;
            if !pids.contains(&pid) {
                return Err(ToolError::OutcomeUnknown(
                    "launch returned a process without matching current app identity".into(),
                ));
            }
            pids.retain(|current| *current == pid);
        }
        let pid = unique_app_process(&pids)?;
        let generation = crate::identity::process(pid)?;
        let controller = Driver::mac_controller(
            &self.native,
            i32::try_from(pid).map_err(failed)?,
            &generation,
        )
        .await?;
        let application = controller.bind_application(self.epoch).await?;
        self.raw_computer.mac_targets.insert(
            key.clone(),
            MacApplicationRecord {
                pid,
                process: generation,
                controller,
                application,
                state: MacApplicationState::Active,
                window: MacWindowState::None,
                previous: None,
            },
        );
        Ok(key)
    }

    async fn raw_mac_window(
        &mut self,
        key: &MacApplicationKey,
        approved: &crate::ComputerAppTarget,
        selection: MacWindowSelection,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<String, ToolError> {
        let record = self
            .raw_computer
            .mac_targets
            .get(key)
            .ok_or_else(|| failed("native app target unavailable"))?;
        let (pid, generation, controller, cached) = (
            record.pid,
            record.process.clone(),
            record.controller.clone(),
            record.window.current()?.map(str::to_owned),
        );
        if let Some(handle) = cached {
            match self
                .verify(&handle, invocation.session(), cancellation, language)
                .await
            {
                Ok(window)
                    if match selection {
                        MacWindowSelection::Retained => true,
                        MacWindowSelection::Primary(id) => window.window_id == u64::from(id),
                    } =>
                {
                    return Ok(handle);
                }
                Ok(_) | Err(ToolError::Failed(_)) => {}
                Err(error) => {
                    self.raw_computer.mac_targets.get_mut(key).unwrap().window =
                        MacWindowState::Retiring {
                            handle,
                            error: Some(error.clone()),
                        };
                    return Err(error);
                }
            }
            self.raw_computer.mac_targets.get_mut(key).unwrap().window = MacWindowState::Retiring {
                handle: handle.clone(),
                error: None,
            };
            if self.targets.contains_key(&handle)
                && let Err(error) = self.retire_target(&handle).await
            {
                self.raw_computer.mac_targets.get_mut(key).unwrap().window =
                    MacWindowState::Retiring {
                        handle,
                        error: Some(error.clone()),
                    };
                return Err(error);
            }
            self.raw_computer.mac_targets.get_mut(key).unwrap().window = MacWindowState::None;
        }
        let id = match selection {
            MacWindowSelection::Primary(id) => id,
            MacWindowSelection::Retained => controller
                .primary_window_id()
                .await?
                .ok_or_else(|| failed("application has no primary AX window"))?,
        };
        let windows = self
            .windows(invocation.session(), cancellation, language)
            .await?;
        let window = primary_app_window(windows, pid, id)?;
        let expected = approved.clone();
        let observed = generation.clone();
        tokio::task::spawn_blocking(move || {
            crate::macos::permission_subject::verify_window(
                &expected,
                pid,
                u64::from(id),
                &observed,
                language,
            )
        })
        .await
        .map_err(failed)??;
        let native = controller.bind_window(self.epoch, id).await?;
        let handle = uuid::Uuid::new_v4().to_string();
        self.targets.insert(
            handle.clone(),
            Target {
                macos: Some(native),
                page_frame: None,
                window,
                process: generation,
                snapshot: None,
                capture: None,
                previous: None,
            },
        );
        self.raw_computer
            .mac_targets
            .get_mut(key)
            .ok_or_else(|| failed("native app target retired"))?
            .window = MacWindowState::Live(handle.clone());
        Ok(handle)
    }

    async fn raw_mac_indexed_scroll(
        &mut self,
        key: &MacApplicationKey,
        handle: &str,
        action: Action,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<(), ToolError> {
        use crate::macos::page_scroll::dispatch::{AccessibilityTarget, Operation, PointerAction};
        let Action::Scroll {
            target: Position::Element(index),
            direction,
            distance,
        } = action
        else {
            return Err(failed(
                "native app indexed pointer operation is unavailable",
            ));
        };
        let pages = match distance {
            None => 1.0,
            Some(Distance::Pages(pages)) => pages,
            Some(Distance::Pixels { .. }) => {
                return Err(failed("native app scroll requires pages"));
            }
        };
        let window = self
            .verify(handle, invocation.session(), cancellation, language)
            .await?;
        let record = self
            .raw_computer
            .mac_targets
            .get(key)
            .ok_or_else(|| failed("native app target unavailable"))?;
        let target = self
            .targets
            .get(handle)
            .ok_or_else(|| failed("native window target retired"))?;
        let request = PointerAction {
            pid: i32::try_from(record.pid).map_err(failed)?,
            generation: record.process.clone(),
            frame: target.page_frame.clone().ok_or_else(|| {
                failed("native pointer input requires retained app-state geometry")
            })?,
            accessibility: Some(AccessibilityTarget::Application {
                application: record.application.clone(),
                window_id: u32::try_from(window.window_id).map_err(failed)?,
            }),
            position: Position::Element(index),
            operation: Operation::Pages { direction, pages },
        };
        let result = request
            .run(
                &self.native,
                self.epoch,
                &self.owner.cursor(),
                cancellation,
                language,
            )
            .await;
        self.targets.get_mut(handle).unwrap().capture = None;
        result.map(|_| ())
    }

    async fn raw_mac_state(
        &mut self,
        key: &MacApplicationKey,
        approved: &crate::ComputerAppTarget,
        input: &Value,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let record = self
            .raw_computer
            .mac_targets
            .get(key)
            .ok_or_else(|| failed("native app target unavailable"))?;
        let controller = record.controller.clone();
        let application = record.application.clone();
        let result = async {
            let id = controller.primary_window_id().await?
                .ok_or_else(|| failed("application has no primary AX window"))?;
            let handle = self.raw_mac_window(key, approved, MacWindowSelection::Primary(id),
                invocation, cancellation, language).await?;
            let window = self.verify(&handle, invocation.session(), cancellation, language).await?;
            {
                let target = self.targets.get_mut(&handle).unwrap();
                target.snapshot = None;
                target.capture = None;
                target.page_frame = None;
            }
            let prepared = self.prepare_page_frame(&handle, &window, cancellation).await?;
            let result = Driver::capture_prepared_window(&self.native, prepared, false,
                self.epoch, cancellation, language).await?;
            let capture = result.structured_content.as_ref()
                .and_then(|value| value["capture_id"].as_str()).map(str::to_owned);
            let image = result.content.iter().find(|block| matches!(block, ContentBlock::Image { .. }))
                .map(super::data_url).transpose()?;
            let state: WindowStateOutput = decode(result)?;
            let observed = application.observe().await?;
            if observed.id != id {
                return Err(failed("stale_target: application observation and captured window differ"));
            }
            self.verify(&handle, invocation.session(), cancellation, language).await?;
            let previous = &mut self.raw_computer.mac_targets.get_mut(key)
                .ok_or_else(|| failed("native app target retired"))?.previous;
            let diff = !input.get("disableDiff").map(input::truthy).unwrap_or(false);
            let text = commit_app_text(previous, observed.text, diff, language);
            let target = self.targets.get_mut(&handle).unwrap();
            target.snapshot = Some(state);
            target.capture = capture;
            Ok(json!({"app":input["app"],"screenshot":image.map(|url|json!({"url":url})),"text":text}))
        }.await;
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if let Some(handle) = self
                    .raw_computer
                    .mac_targets
                    .get(key)
                    .and_then(|record| record.window.retained())
                    && let Some(target) = self.targets.get_mut(handle)
                {
                    target.snapshot = None;
                    target.capture = None;
                    target.page_frame = None;
                }
                match application.clear().await {
                    Ok(()) => Err(error),
                    Err(cleanup) => {
                        let error = preserve_raw_error(error, cleanup);
                        self.raw_computer.mac_targets.get_mut(key).unwrap().state =
                            MacApplicationState::Retiring {
                                error: Some(error.clone()),
                            };
                        Err(error)
                    }
                }
            }
        }
    }
}

fn unique_app_process(pids: &[u32]) -> Result<u32, ToolError> {
    match pids {
        [pid] if *pid != 0 => Ok(*pid),
        [] => Err(failed("application has no observable native process")),
        _ => Err(failed(
            "application has multiple running processes; choose an exact instance",
        )),
    }
}

fn commit_app_text(
    previous: &mut Option<String>,
    full: String,
    diff: bool,
    language: Language,
) -> String {
    let text = if diff {
        display_diff(previous.as_deref(), &full, language)
    } else {
        full.clone()
    };
    *previous = Some(full);
    text
}

fn preserve_raw_error(error: ToolError, cleanup: ToolError) -> ToolError {
    match error {
        error @ (ToolError::OutcomeUnknown(_)
        | ToolError::CleanupUnconfirmed(_)
        | ToolError::OperationUnknown { .. }
        | ToolError::OperationCleanupUnconfirmed { .. }
        | ToolError::Persistence(_)) => error,
        _ => cleanup,
    }
}

fn primary_app_window(
    windows: Vec<WindowInfo>,
    pid: u32,
    primary_id: u32,
) -> Result<WindowInfo, ToolError> {
    let mut matching = windows
        .into_iter()
        .filter(|window| window.pid == Some(pid) && window.window_id == u64::from(primary_id));
    let window = matching.next().ok_or_else(|| {
        failed("primary AX window has no matching current native window metadata")
    })?;
    if matching.next().is_some() {
        return Err(failed("primary native window metadata is ambiguous"));
    }
    Ok(window)
}

fn project_app_records(apps: &[cua_driver_contract::AppInfo]) -> Value {
    Value::Array(
        apps.iter()
            .map(|app| {
                let id = app.bundle_id.as_deref().unwrap_or(&app.name);
                let mut result = json!({"id":id,"displayName":app.name,"isRunning":app.running});
                if let Some(date) = &app.last_used {
                    result["lastUsedDate"] = date.clone().into();
                }
                result
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        commit_app_text, preserve_raw_error, primary_app_window, project_app_records,
        unique_app_process,
    };
    use cua_driver_contract::{AppInfo, WindowBounds, WindowInfo};
    use serde_json::json;

    #[test]
    fn app_text_history_continues_across_primary_window_texts() {
        let common = (0..30)
            .map(|index| format!("unchanged app row {index}\n"))
            .collect::<String>();
        let first = format!("{common}Window A");
        let second = format!("{common}Window B");
        let mut previous = None;
        assert_eq!(
            commit_app_text(
                &mut previous,
                first.clone(),
                true,
                maka_agent_facts::language::Language::En
            ),
            first
        );
        let diff = commit_app_text(
            &mut previous,
            second.clone(),
            true,
            maka_agent_facts::language::Language::En,
        );
        assert!(diff.contains("- Window A"));
        assert!(diff.contains("+ Window B"));
        assert_eq!(previous.as_deref(), Some(second.as_str()));
        assert_eq!(
            commit_app_text(
                &mut previous,
                second,
                true,
                maka_agent_facts::language::Language::En
            ),
            "Accessibility state unchanged."
        );
    }

    #[test]
    fn observation_cleanup_does_not_replace_an_original_uncertain_outcome() {
        use maka_agent_facts::tools::ToolError;
        assert!(
            matches!(preserve_raw_error(ToolError::OutcomeUnknown("original observation".into()),
            ToolError::Failed("cleanup refused".into())),
            ToolError::OutcomeUnknown(reason) if reason == "original observation")
        );
        assert!(
            matches!(preserve_raw_error(ToolError::Failed("observation refused".into()),
            ToolError::CleanupUnconfirmed("original cleanup".into())),
            ToolError::CleanupUnconfirmed(reason) if reason == "original cleanup")
        );
    }

    fn app(name: &str, bundle_id: Option<&str>, launch_path: Option<&str>) -> AppInfo {
        AppInfo {
            pid: 42,
            name: name.into(),
            running: true,
            active: false,
            bundle_id: bundle_id.map(str::to_owned),
            launch_path: launch_path.map(str::to_owned),
            kind: Some("desktop".into()),
            last_used: None,
        }
    }

    #[test]
    fn public_app_ids_prefer_bundle_identity_to_launch_paths() {
        let apps = [app(
            "Example",
            Some("org.example.App"),
            Some("/Applications/Example.app"),
        )];
        assert_eq!(
            project_app_records(&apps),
            json!([{"id":"org.example.App","displayName":"Example","isRunning":true}])
        );
    }

    #[test]
    fn display_name_fallback_keeps_inventory_rows_and_their_order() {
        let apps = [
            app("Path known", None, Some("/Applications/First.app")),
            app("No path", None, None),
        ];
        assert_eq!(
            project_app_records(&apps),
            json!([
                {"id":"Path known","displayName":"Path known","isRunning":true},
                {"id":"No path","displayName":"No path","isRunning":true}
            ])
        );
    }

    #[test]
    fn empty_known_bundle_id_is_not_treated_as_missing_or_replaced_by_a_path() {
        let apps = [app("Example", Some(""), Some("/Applications/Example.app"))];
        assert_eq!(
            project_app_records(&apps),
            json!([{"id":"","displayName":"Example","isRunning":true}])
        );
    }

    fn window(pid: u32, id: u64) -> WindowInfo {
        WindowInfo {
            window_id: id,
            pid: Some(pid),
            app_name: "Example".into(),
            title: format!("window {id}"),
            bounds: WindowBounds {
                x: 0.0,
                y: 0.0,
                width: 640.0,
                height: 480.0,
            },
            is_on_screen: true,
            z_index: None,
            layer: None,
            minimized: None,
            current_space_id: None,
            on_current_space: None,
            space_ids: None,
        }
    }

    #[test]
    fn actual_primary_id_selects_among_multiple_windows_without_list_order() {
        let windows = vec![window(41, 100), window(41, 200), window(41, 300)];
        assert_eq!(unique_app_process(&[41]).unwrap(), 41);
        assert_eq!(
            primary_app_window(windows.clone(), 41, 200)
                .unwrap()
                .window_id,
            200
        );
        assert_eq!(
            primary_app_window(windows.into_iter().rev().collect(), 41, 200)
                .unwrap()
                .window_id,
            200
        );
    }

    #[test]
    fn primary_selection_never_substitutes_missing_or_foreign_metadata() {
        assert!(primary_app_window(vec![window(41, 100)], 41, 200).is_err());
        assert!(primary_app_window(vec![window(42, 200)], 41, 200).is_err());
        assert!(primary_app_window(vec![window(41, 200), window(41, 200)], 41, 200).is_err());
        assert!(unique_app_process(&[]).is_err());
        assert!(unique_app_process(&[41, 42]).is_err());
    }

    #[test]
    fn app_cache_identity_keeps_the_approved_canonical_installation() {
        let target = |path: &str| {
            crate::permission_subject::macos_target(
                "Editor".into(),
                "org.example.Editor".into(),
                path.into(),
                maka_agent_facts::language::Language::En,
            )
            .unwrap()
        };
        let first = target("/Applications/Editor.app");
        let second = target("/Volumes/Other/Editor.app");
        let mut targets = std::collections::HashMap::new();
        targets.insert(super::MacApplicationKey::of(&first), "first actual target");
        assert_eq!(
            targets.get(&super::MacApplicationKey::of(&first)),
            Some(&"first actual target")
        );
        assert!(!targets.contains_key(&super::MacApplicationKey::of(&second)));
    }
}
