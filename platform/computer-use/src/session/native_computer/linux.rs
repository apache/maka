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
use platform_linux::input::native_desktop::NativeDesktopRequest;
use platform_linux::input::native_window_action::{NativeWindowAction, NativeWindowActionRequest};

impl Session {
    pub(super) async fn raw_linux(
        &mut self,
        call: NativeComputerCall,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        // Original Linux ActionSettler defers the following operation only
        // after a successful mutation. Read operations do not restart it.
        if let Some(ready) = self.raw_computer.ready_at.take() {
            tokio::select! { biased;
                _ = cancellation.cancelled() => return Err(failed("Computer Use cancelled before raw dispatch")),
                _ = tokio::time::sleep_until(ready) => {}
            }
        }
        let (result, mutation) = match call {
            NativeComputerCall::DragStart { handle, point } => {
                let point: NativePoint = native_decode(point)?;
                let result = self
                    .raw_desktop(
                        NativeDesktopRequest::DragStart {
                            handle: handle.clone(),
                            point: [point.x, point.y],
                        },
                        invocation,
                        cancellation,
                        language,
                    )
                    .await;
                if result.is_ok() {
                    self.raw_computer
                        .handles
                        .insert(handle, invocation.turn().into());
                }
                (result, true)
            }
            NativeComputerCall::DragMove { handle, point } => {
                self.raw_handle_started(&handle, invocation.turn())?;
                let point: NativePoint = native_decode(point)?;
                (
                    self.raw_desktop(
                        NativeDesktopRequest::DragMove {
                            handle,
                            point: [point.x, point.y],
                        },
                        invocation,
                        cancellation,
                        language,
                    )
                    .await,
                    true,
                )
            }
            NativeComputerCall::DragEnd { handle } => {
                self.raw_handle_started(&handle, invocation.turn())?;
                let result = self
                    .raw_desktop(
                        NativeDesktopRequest::DragEnd {
                            handle: handle.clone(),
                        },
                        invocation,
                        cancellation,
                        language,
                    )
                    .await;
                if result.is_ok() {
                    self.raw_computer.handles.remove(&handle);
                }
                (result, true)
            }
            NativeComputerCall::Invoke { operation, args } => {
                let input = input::first(&args);
                let mutation = !matches!(
                    operation,
                    NativeComputerMethod::GetScreenshot
                        | NativeComputerMethod::GetWindowState
                        | NativeComputerMethod::ListApps
                        | NativeComputerMethod::ListWindows
                );
                (
                    self.raw_linux_invoke(operation, input, invocation, cancellation, language)
                        .await,
                    mutation,
                )
            }
        };
        if result.is_ok() && mutation {
            self.raw_computer.ready_at =
                Some(tokio::time::Instant::now() + std::time::Duration::from_millis(100));
        }
        result
    }

    fn raw_handle_started(&self, handle: &str, turn: &str) -> Result<(), ToolError> {
        if self
            .raw_computer
            .handles
            .get(handle)
            .is_some_and(|owner| owner == turn)
        {
            Ok(())
        } else {
            Err(failed("Sky drag handle has not been started"))
        }
    }

    async fn raw_desktop(
        &self,
        request: NativeDesktopRequest,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        Driver::input_raw_desktop(
            &self.native,
            self.epoch,
            invocation.turn(),
            request,
            cancellation,
            language,
        )
        .await?;
        Ok(Value::Null)
    }

    async fn raw_linux_windows(
        &self,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Vec<Value>, ToolError> {
        let value = structured(
            self.raw_tool(
                RawTool::LinuxWindows,
                json!({}),
                false,
                cancellation,
                language,
            )
            .await?,
        )?;
        value["windows"]
            .as_array()
            .cloned()
            .ok_or_else(|| failed("native window inventory is unavailable"))
    }

    pub(super) async fn raw_linux_bindings(
        &self,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Vec<WindowInfo>, ToolError> {
        self.raw_linux_windows(cancellation,language).await?.into_iter().map(|window| {
            serde_json::from_value(json!({"window_id":window["id"],"pid":window["pid"],"app_name":window["app"],
                "title":window.get("title").and_then(Value::as_str).unwrap_or_default(),
                "bounds":{"x":window["x"],"y":window["y"],"width":window["width"],"height":window["height"]},
                "is_on_screen":true,"z_index":null})).map_err(failed)
        }).collect()
    }

    async fn raw_linux_invoke(
        &mut self,
        method: NativeComputerMethod,
        value: &Value,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        use NativeComputerMethod::*;
        let resolved;
        let value = if matches!(method, Click | Scroll | TypeText | PerformSecondaryAction) {
            // Source client resolves aliases before its native parser or any
            // window I/O, even when x/y are also supplied.
            resolved = self.raw_linux_selector(value)?;
            &resolved
        } else {
            value
        };
        match method {
            ListWindows => {
                return Ok(json!(
                    self.raw_linux_windows(cancellation, language)
                        .await?
                        .iter()
                        .map(public_linux_window)
                        .collect::<Vec<_>>()
                ));
            }
            GetScreenshot => {
                let result = self
                    .raw_tool(
                        RawTool::DesktopScreenshot,
                        json!({"max_image_dimension":0}),
                        false,
                        cancellation,
                        language,
                    )
                    .await?;
                let mut screenshots = Vec::new();
                for image in result
                    .content
                    .iter()
                    .filter(|block| matches!(block, ContentBlock::Image { .. }))
                {
                    screenshots.push(self.raw_computer.files.jpeg(image.clone()).await?);
                }
                if screenshots.is_empty() {
                    return Err(failed(
                        "screenshot_unavailable: native provider returned no image",
                    ));
                }
                return Ok(json!(screenshots));
            }
            TypeText if value.get("window").is_none_or(Value::is_null) => {
                let input: DesktopText = native_decode(value.clone())?;
                if input.element_id.is_some() {
                    return Err(failed("element typing requires window"));
                }
                return self
                    .raw_desktop(
                        NativeDesktopRequest::TypeText { text: input.text },
                        invocation,
                        cancellation,
                        language,
                    )
                    .await;
            }
            Drag if value.get("window").is_none_or(Value::is_null) => {
                let input: DesktopDrag = native_decode(value.clone())?;
                return self
                    .raw_desktop(
                        NativeDesktopRequest::Drag {
                            path: input
                                .path
                                .into_iter()
                                .map(|point| [point.x, point.y])
                                .collect(),
                            key: input.key,
                        },
                        invocation,
                        cancellation,
                        language,
                    )
                    .await;
            }
            Scroll if value.get("window").is_none_or(Value::is_null) => {
                let input: DesktopScroll = native_decode(value.clone())?;
                if input.element_id.is_some() {
                    return Err(failed("element scroll requires window"));
                }
                if input.pixels == Some(0) {
                    return Err(failed("pixels must be non-zero"));
                }
                let point = match (input.x, input.y) {
                    (Some(x), Some(y)) => Some([x, y]),
                    (None, None) => None,
                    _ => return Err(failed("x and y must be provided together")),
                };
                let direction = match Direction::from(input.direction) {
                    Direction::Up => cua_driver_contract::ScrollDirection::Up,
                    Direction::Down => cua_driver_contract::ScrollDirection::Down,
                    Direction::Left => cua_driver_contract::ScrollDirection::Left,
                    Direction::Right => cua_driver_contract::ScrollDirection::Right,
                };
                return self
                    .raw_desktop(
                        NativeDesktopRequest::Scroll {
                            point,
                            direction,
                            pixels: input.pixels.unwrap_or(800),
                            key: input.key,
                        },
                        invocation,
                        cancellation,
                        language,
                    )
                    .await;
            }
            PressKey if value.get("window").is_none_or(Value::is_null) => {
                let input: DesktopKey = native_decode(value.clone())?;
                return self
                    .raw_desktop(
                        NativeDesktopRequest::PressKey {
                            key: input.key,
                            duration_ms: input.duration.unwrap_or(33),
                        },
                        invocation,
                        cancellation,
                        language,
                    )
                    .await;
            }
            Click if value.get("window").is_none_or(Value::is_null) => {
                let input: DesktopClick = native_decode(value.clone())?;
                let [x, y] = input.desktop_point()?;
                return self
                    .raw_desktop(
                        NativeDesktopRequest::Click {
                            point: [x, y],
                            button: input
                                .mouse_button
                                .unwrap_or(cua_driver_contract::ClickButton::Left),
                            count: input.click_count.unwrap_or(1),
                            duration_ms: input.duration.unwrap_or(12),
                            key: input.key,
                        },
                        invocation,
                        cancellation,
                        language,
                    )
                    .await;
            }
            MoveRelative => {
                let value: Relative = native_decode(value.clone())?;
                return self
                    .raw_desktop(
                        NativeDesktopRequest::MoveRelative {
                            delta: [value.dx, value.dy],
                            key: value.key,
                        },
                        invocation,
                        cancellation,
                        language,
                    )
                    .await;
            }
            Move if value.get("window").is_none_or(Value::is_null) => {
                let value: Absolute = native_decode(value.clone())?;
                return self
                    .raw_desktop(
                        NativeDesktopRequest::Move {
                            point: [value.x, value.y],
                            key: value.key,
                        },
                        invocation,
                        cancellation,
                        language,
                    )
                    .await;
            }
            ListApps => {
                let mut result = structured(
                    self.raw_tool(RawTool::LinuxApps, json!({}), false, cancellation, language)
                        .await?,
                )?;
                let apps = result
                    .get_mut("apps")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| failed("native app inventory is unavailable"))?;
                for app in apps.iter_mut() {
                    let windows = app
                        .get_mut("windows")
                        .and_then(Value::as_array_mut)
                        .ok_or_else(|| failed("native app window inventory is unavailable"))?;
                    for window in windows {
                        *window = public_linux_window(window);
                    }
                }
                return Ok(Value::Array(apps.clone()));
            }
            LaunchApp => {
                let input: DesktopLaunch = native_decode(value.clone())?;
                self.raw_tool(
                    RawTool::LinuxLaunch,
                    json!({"app":input.app}),
                    false,
                    cancellation,
                    language,
                )
                .await?;
                return Ok(Value::Null);
            }
            GetWindowState => {
                return self
                    .raw_linux_state(value, invocation, cancellation, language)
                    .await;
            }
            _ => {}
        }
        let window = if value.get("window").is_some_and(|value| !value.is_null()) {
            let selected: WindowReference = native_decode(value["window"].clone())?;
            let (window, _) = self
                .raw_window(u64::from(selected.id), invocation, cancellation, language)
                .await?;
            Some(window)
        } else {
            None
        };
        match method {
            ActivateWindow => {
                let window = window.ok_or_else(|| failed("window.id is required"))?;
                self.raw_tool(
                    RawTool::ActivateWindow,
                    json!({"pid":window.pid,"window_id":window.window_id}),
                    false,
                    cancellation,
                    language,
                )
                .await?;
            }
            Move if window.is_some() => {
                let input: Absolute = native_decode(value.clone())?;
                let window = window.unwrap();
                self.raw_desktop(
                    window_action(
                        &window,
                        NativeWindowAction::Move {
                            point: [input.x, input.y],
                            key: input.key,
                        },
                    )?,
                    invocation,
                    cancellation,
                    language,
                )
                .await?;
            }
            PressKey if window.is_some() => {
                let input: DesktopKey = native_decode(value.clone())?;
                let window = window.unwrap();
                self.raw_desktop(
                    window_action(
                        &window,
                        NativeWindowAction::PressKey {
                            key: input.key,
                            duration_ms: input.duration.unwrap_or(33),
                        },
                    )?,
                    invocation,
                    cancellation,
                    language,
                )
                .await?;
            }
            Drag if window.is_some() => {
                let input: DesktopDrag = native_decode(value.clone())?;
                let window = window.unwrap();
                self.raw_desktop(
                    window_action(
                        &window,
                        NativeWindowAction::Drag {
                            path: input
                                .path
                                .into_iter()
                                .map(|point| [point.x, point.y])
                                .collect(),
                            key: input.key,
                        },
                    )?,
                    invocation,
                    cancellation,
                    language,
                )
                .await?;
            }
            TypeText if window.is_some() => {
                let input: DesktopText = native_decode(value.clone())?;
                let action = match input.element_id {
                    Some(element_id) => NativeWindowAction::TypeTextElement {
                        text: input.text,
                        element_id,
                    },
                    None => NativeWindowAction::TypeText { text: input.text },
                };
                let window = window.unwrap();
                self.raw_desktop(
                    window_action(&window, action)?,
                    invocation,
                    cancellation,
                    language,
                )
                .await?;
            }
            PerformSecondaryAction => {
                let input: DesktopSecondary = native_decode(value.clone())?;
                let window = window.ok_or_else(|| failed("window.id is required"))?;
                self.raw_desktop(
                    window_action(
                        &window,
                        NativeWindowAction::SecondaryAction {
                            element_id: input.element_id,
                            action: input.action,
                        },
                    )?,
                    invocation,
                    cancellation,
                    language,
                )
                .await?;
            }
            Click if window.is_some() => {
                let input: DesktopClick = native_decode(value.clone())?;
                input.validate_window_target()?;
                let window = window.unwrap();
                let click = crate::linux_input::Click::parse(value.clone()).map_err(failed)?;
                match click.target {
                    crate::linux_input::ClickTarget::Coordinates(point) => {
                        self.raw_desktop(
                            window_action(
                                &window,
                                NativeWindowAction::Click {
                                    point: point.coordinates(),
                                    button: input
                                        .mouse_button
                                        .unwrap_or(cua_driver_contract::ClickButton::Left),
                                    count: input.click_count.unwrap_or(1),
                                    duration_ms: input.duration.unwrap_or(12),
                                    key: input.key,
                                },
                            )?,
                            invocation,
                            cancellation,
                            language,
                        )
                        .await?;
                    }
                    crate::linux_input::ClickTarget::Element(_) => {
                        if input.key.is_some() || input.duration.is_some() {
                            return Err(failed(
                                crate::linux_input::Error::UnsupportedElementClickOptions,
                            ));
                        }
                        let selector = self
                            .linux_ids
                            .resolve(window.window_id, input.element_id.as_deref())
                            .map_err(failed)?
                            .map(str::to_owned);
                        Driver::click_native_element_window(
                            &self.native,
                            platform_linux::input::native_element::NativeElementClickRequest {
                                pid: window.pid.ok_or_else(|| failed("window has no process"))?,
                                window_id: u32::try_from(window.window_id).map_err(failed)?,
                                element_id: selector,
                                button: match click.button {
                                    MouseButton::Left => cua_driver_contract::ClickButton::Left,
                                    MouseButton::Right => cua_driver_contract::ClickButton::Right,
                                    MouseButton::Middle => cua_driver_contract::ClickButton::Middle,
                                },
                                count: click.count,
                                deadline: None,
                            },
                            self.epoch,
                            cancellation,
                            language,
                        )
                        .await?;
                    }
                }
            }
            Scroll if window.is_some() => {
                let input: DesktopScroll = native_decode(value.clone())?;
                let window = window.unwrap();
                let scroll = crate::linux_input::Scroll::parse(value.clone()).map_err(failed)?;
                let direction = match scroll.direction {
                    Direction::Up => cua_driver_contract::ScrollDirection::Up,
                    Direction::Down => cua_driver_contract::ScrollDirection::Down,
                    Direction::Left => cua_driver_contract::ScrollDirection::Left,
                    Direction::Right => cua_driver_contract::ScrollDirection::Right,
                };
                if let Some(selector) = scroll.element_id {
                    let element = self
                        .linux_ids
                        .resolve(window.window_id, Some(&selector))
                        .map_err(failed)?
                        .ok_or_else(|| failed("element selector is required"))?
                        .to_owned();
                    self.raw_desktop(
                        window_action(
                            &window,
                            NativeWindowAction::ScrollElement {
                                element_id: element,
                                direction,
                                pixels: scroll.pixels,
                                key: input.key,
                            },
                        )?,
                        invocation,
                        cancellation,
                        language,
                    )
                    .await?;
                } else {
                    self.raw_desktop(
                        window_action(
                            &window,
                            NativeWindowAction::Scroll {
                                x: input.x,
                                y: input.y,
                                direction,
                                pixels: input.pixels.unwrap_or(800),
                                key: input.key,
                            },
                        )?,
                        invocation,
                        cancellation,
                        language,
                    )
                    .await?;
                }
            }

            // Remaining branches are implemented below in the same profile;
            // none may fall through App wrapper defaults or generic click.
            _ => {
                return Err(failed(format!(
                    "raw native actuator is not connected for {method:?}"
                )));
            }
        }
        // Native admission/ownership is checked before and inside the actual
        // SDK actuator. A successfully posted click may intentionally close
        // its window; no extra inventory read may turn that into a refusal.
        Ok(Value::Null)
    }

    fn raw_linux_selector(&self, value: &Value) -> Result<Value, ToolError> {
        resolve_linux_selector(&self.linux_ids, value)
    }

    async fn raw_linux_state(
        &mut self,
        value: &Value,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let input: WindowRead = native_decode(value.clone())?;
        let id = u64::from(input.window.id);
        let query = input.query.as_deref();
        let screenshot = input.include_screenshot.unwrap_or(true);
        let (window, generation) = self
            .raw_window(id, invocation, cancellation, language)
            .await?;
        let mut result = Driver::observe_native_window(
            &self.native,
            platform_linux::atspi::native_observation::NativeObservationRequest {
                pid: window.pid.ok_or_else(|| failed("window has no process"))?,
                window_id: id,
                deadline: None,
            },
            cua_driver_sdk::NativeObservationOptions {
                include_screenshot: screenshot,
                max_image_dimension: Some(0),
            },
            self.epoch,
            cancellation,
            language,
        )
        .await?;
        let metadata = result
            .structured_content
            .as_mut()
            .and_then(Value::as_object_mut)
            .and_then(|output| output.remove("native_ax"))
            .ok_or_else(|| failed("native accessibility rows unavailable"))?;
        let snapshot: platform_linux::atspi::native_ax::NativeAxSnapshot =
            serde_json::from_value(metadata).map_err(failed)?;
        crate::linux_ax::validate_snapshot(&snapshot).map_err(failed)?;
        if snapshot
            .rows
            .iter()
            .filter(|row| row.parent.is_none())
            .count()
            != 1
        {
            return Err(failed("native AX observation must have exactly one root"));
        }
        let snapshot = crate::linux_ax::filter_snapshot(snapshot, query);
        let mut screenshots = Vec::new();
        if screenshot {
            for image in result
                .content
                .into_iter()
                .filter(|block| matches!(block, ContentBlock::Image { .. }))
            {
                screenshots.push(self.raw_computer.files.jpeg(image).await?);
            }
        }
        let (current_window, current) = self
            .raw_window(id, invocation, cancellation, language)
            .await?;
        if current != generation {
            return Err(failed("application changed during native observation"));
        }
        if screenshot && current_window.bounds != window.bounds {
            return Err(failed("window geometry changed during native capture"));
        }
        let windows = self.raw_linux_windows(cancellation, language).await?;
        let observed_window = windows
            .iter()
            .find(|window| window["id"].as_u64() == Some(id))
            .ok_or_else(|| failed("native window disappeared during observation"))?;
        // Original assigns public aliases only after its screenshot loads
        // succeed. Failed native/file reads must not advance that alias map.
        let public = self.linux_ids.assign(
            id,
            &snapshot,
            crate::linux_ax::ReadCoverage::for_query(query),
        );
        let tree = tree_from_rows(public.metadata().map_err(failed)?)?;
        Ok(
            json!({"window":public_linux_window(observed_window),"ax_tree":tree,"ax_tree_source":snapshot.source,"screenshots":screenshots}),
        )
    }
}

fn resolve_linux_selector(
    ids: &crate::linux_ax::ElementIds,
    value: &Value,
) -> Result<Value, ToolError> {
    let Some(selector) = value.get("element_id").filter(|value| !value.is_null()) else {
        return Ok(value.clone());
    };
    let text = match selector {
        Value::String(text) => text.clone(),
        Value::Number(_) => {
            maka_agent_facts::capability::json::stringify(selector).map_err(failed)?
        }
        _ => return Ok(value.clone()),
    };
    if !crate::linux_input::public_element_id(&text) {
        return Ok(value.clone());
    }
    // JS Map keys distinguish numeric windows from numeric strings; its
    // stored aliases are strings, so number5 never strictly equals "5".
    let id = value
        .get("window")
        .and_then(|window| window.get("id"))
        .filter(|id| id.is_number())
        .and_then(Value::as_f64)
        .filter(|id| {
            id.is_finite() && *id >= 0.0 && id.fract() == 0.0 && *id <= f64::from(u32::MAX)
        })
        .map(|id| id as u64);
    if !selector.is_string() || id.is_none() {
        return Err(failed(format!(
            "Unknown element ID {text} for this window; refresh get_window_state()"
        )));
    }
    let native = ids
        .resolve(id.unwrap(), Some(&text))
        .map_err(failed)?
        .ok_or_else(|| failed("native selector alias unavailable"))?;
    let mut value = value.clone();
    value["element_id"] = native.into();
    Ok(value)
}

fn window_action(
    window: &WindowInfo,
    action: NativeWindowAction,
) -> Result<NativeDesktopRequest, ToolError> {
    Ok(NativeDesktopRequest::Window {
        request: NativeWindowActionRequest {
            pid: window.pid.ok_or_else(|| failed("window has no process"))?,
            window_id: u32::try_from(window.window_id).map_err(failed)?,
            action,
        },
    })
}

#[derive(serde::Deserialize)]
struct NativePoint {
    x: i16,
    y: i16,
}
#[derive(serde::Deserialize)]
struct DesktopDrag {
    key: Option<String>,
    path: Vec<NativePoint>,
}

#[derive(serde::Deserialize)]
struct DesktopScroll {
    direction: crate::linux_input::NativeScrollDirection,
    element_id: Option<String>,
    key: Option<String>,
    pixels: Option<u16>,
    x: Option<i16>,
    y: Option<i16>,
}

#[derive(serde::Deserialize)]
struct DesktopText {
    text: String,
    element_id: Option<String>,
}

#[derive(serde::Deserialize)]
struct DesktopLaunch {
    app: String,
}

#[derive(serde::Deserialize)]
struct DesktopSecondary {
    element_id: String,
    action: String,
}

#[derive(serde::Deserialize)]
struct DesktopKey {
    key: String,
    duration: Option<u64>,
}

#[derive(serde::Deserialize)]
struct DesktopClick {
    element_id: Option<String>,
    click_count: Option<u32>,
    duration: Option<u64>,
    key: Option<String>,
    mouse_button: Option<cua_driver_contract::ClickButton>,
    x: Option<i16>,
    y: Option<i16>,
}

impl DesktopClick {
    fn desktop_point(&self) -> Result<[i16; 2], ToolError> {
        if self.element_id.is_some() {
            return Err(failed("element click requires window"));
        }
        match (self.x, self.y) {
            (Some(x), Some(y)) => Ok([x, y]),
            _ => Err(failed("coordinate click requires both x and y")),
        }
    }

    fn validate_window_target(&self) -> Result<(), ToolError> {
        if self.element_id.is_some() && (self.x.is_some() || self.y.is_some()) {
            return Err(failed("provide element_id or x/y, not both"));
        }
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct Absolute {
    x: i16,
    y: i16,
    key: Option<String>,
}
#[derive(serde::Deserialize)]
struct Relative {
    dx: i16,
    dy: i16,
    key: Option<String>,
}

#[derive(serde::Deserialize)]
struct WindowReference {
    id: u32,
}

#[derive(serde::Deserialize)]
struct WindowRead {
    window: WindowReference,
    query: Option<String>,
    include_screenshot: Option<bool>,
}

fn native_decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ToolError> {
    crate::linux_input::parse_command(value).map_err(failed)
}

fn public_linux_window(window: &Value) -> Value {
    let mut window = window.clone();
    if let Some(window) = window.as_object_mut() {
        window.remove("pid");
    }
    window
}

fn tree_from_rows(metadata: Value) -> Result<Value, ToolError> {
    let rows = metadata["rows"]
        .as_array()
        .ok_or_else(|| failed("native AX rows unavailable"))?;
    let mut nodes:Vec<_>=rows.iter().map(|row| {
        let mut node=json!({"id":row["id"],"native_id":row["native_id"],"role":row["role"],"children":[]});
        for key in ["name","description","value","states","actions"] {
            if let Some(value)=row.get(key).filter(|value|!value.is_null()) {node[key]=value.clone();}
        }
        node
    }).collect();
    let mut roots = Vec::new();
    for index in (0..nodes.len()).rev() {
        let mut node = std::mem::take(&mut nodes[index]);
        node["children"].as_array_mut().unwrap().reverse();
        if let Some(parent) = rows[index]["parent"].as_u64() {
            let parent = usize::try_from(parent).map_err(failed)?;
            if parent >= index {
                return Err(failed("invalid native AX parent"));
            }
            nodes[parent]["children"].as_array_mut().unwrap().push(node);
        } else {
            roots.push(node);
        }
    }
    if roots.len() != 1 {
        return Err(failed("native AX observation must have exactly one root"));
    }
    Ok(roots.pop().unwrap())
}

#[cfg(test)]
mod click_carrier_tests {
    use super::*;

    fn failed_message<T>(result: Result<T, ToolError>) -> String {
        match result {
            Err(ToolError::Failed(message)) => message,
            _ => panic!("the raw preflight must reject with the original failure text"),
        }
    }

    fn aliases() -> crate::linux_ax::ElementIds {
        let snapshot = serde_json::from_value(json!({
            "source":"at_spi",
            "rows":[{"native_id":":1.42:/org/cua/Fixture","role":"frame","depth":0,"parent":null}]
        }))
        .unwrap();
        let mut ids = crate::linux_ax::ElementIds::default();
        ids.assign(9, &snapshot, crate::linux_ax::ReadCoverage::Full);
        ids
    }

    #[test]
    fn raw_click_preserves_coordinates_through_real_alias_resolution_then_refuses_conflict() {
        let ids = aliases();
        for input in [
            json!({"window":{"id":9},"element_id":"0","x":0,"y":12}),
            json!({"window":{"id":9},"element_id":"0","x":0}),
            json!({"window":{"id":9},"element_id":"0","y":0}),
            json!({"window":{"id":9},"element_id":"0","x":0,"y":12,"click_count":0,"mouse_button":"middle","key":"ctrl","duration":0}),
            json!({"window":{"id":9},"element_id":":1.42:/org/cua/Fixture","x":0}),
            json!({"window":{"id":9},"element_id":"","y":0}),
        ] {
            let resolved = resolve_linux_selector(&ids, &input).unwrap();
            assert_eq!(resolved["x"], input["x"]);
            assert_eq!(resolved["y"], input["y"]);
            let click: DesktopClick = native_decode(resolved).unwrap();
            assert_eq!(
                failed_message(click.validate_window_target()),
                "provide element_id or x/y, not both"
            );
        }
        let unknown = json!({"window":{"id":9},"element_id":"99","x":"not an integer","y":12});
        assert_eq!(
            failed_message(resolve_linux_selector(&ids, &unknown)),
            "Unknown element ID 99 for this window; refresh get_window_state()"
        );
    }

    #[test]
    fn raw_click_requires_a_window_for_elements_before_considering_coordinate_completeness() {
        for input in [
            json!({"element_id":":1.42:/org/cua/Fixture"}),
            json!({"element_id":":1.42:/org/cua/Fixture","x":0}),
            json!({"element_id":":1.42:/org/cua/Fixture","x":0,"y":12}),
            json!({"element_id":"","x":0,"y":12,"click_count":0,"mouse_button":"middle","key":"ctrl","duration":0}),
        ] {
            let click: DesktopClick = native_decode(input).unwrap();
            assert_eq!(
                failed_message(click.desktop_point()),
                "element click requires window"
            );
        }
        let unknown = json!({"element_id":"99","x":0,"y":12});
        assert_eq!(
            failed_message(resolve_linux_selector(&aliases(), &unknown)),
            "Unknown element ID 99 for this window; refresh get_window_state()"
        );
        for input in [
            json!({"x":0,"y":12}),
            json!({"element_id":null,"x":0,"y":12}),
        ] {
            let click: DesktopClick = native_decode(input).unwrap();
            assert_eq!(click.desktop_point().unwrap(), [0, 12]);
            click.validate_window_target().unwrap();
        }
        let partial: DesktopClick = native_decode(json!({"x":0})).unwrap();
        assert_eq!(
            failed_message(partial.desktop_point()),
            "coordinate click requires both x and y"
        );
    }

    #[test]
    fn raw_click_native_types_are_checked_before_element_target_conflicts() {
        for input in [
            json!({"window":{"id":9},"element_id":"native","x":0.5,"y":12}),
            json!({"element_id":"native","x":0.5,"y":12}),
        ] {
            let message = failed_message(native_decode::<DesktopClick>(input));
            assert!(message.contains("floating point"), "{message}");
            assert!(message.contains("i16"), "{message}");
        }
    }
}
