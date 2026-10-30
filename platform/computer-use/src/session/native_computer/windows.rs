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

impl Session {
    pub(super) async fn raw_windows(
        &mut self,
        call: NativeComputerCall,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let NativeComputerCall::Invoke { operation, args } = call else {
            return Err(failed("drag_handle is not installed for Windows"));
        };
        let input = input::windows(operation, input::first(&args))?;
        use NativeComputerMethod::*;
        match operation {
            ListApps => {
                // Preserve the source-provided installed identity. Neither a
                // display name nor a caller-selected pid becomes an app ID.
                let apps: ListAppsOutput = decode(
                    self.raw_tool(RawTool::ListApps, json!({}), false, cancellation, language)
                        .await?,
                )?;
                return Ok(json!(
                    apps.apps
                        .iter()
                        .filter_map(|app| {
                            let id = app.bundle_id.as_ref().or(app.launch_path.as_ref())?;
                            Some(json!({"id":id,"name":app.name}))
                        })
                        .collect::<Vec<_>>()
                ));
            }
            ListWindows | GetWindow => {
                let windows = self
                    .windows(invocation.session(), cancellation, language)
                    .await?;
                if matches!(operation, ListWindows) {
                    return Ok(json!(
                        windows
                            .iter()
                            .map(public_windows_window)
                            .collect::<Vec<_>>()
                    ));
                }
                let id = input["id"].as_u64().unwrap();
                let window = windows
                    .iter()
                    .find(|window| window.window_id == id)
                    .ok_or_else(|| failed("window was not found"))?;
                return Ok(public_windows_window(window));
            }
            LaunchApp => {
                // Original accepts explicit executable identifiers. The
                // actual Cua launcher still validates and records this value;
                // it is never interpolated into a shell command here.
                self.raw_tool(
                    RawTool::LaunchApp,
                    json!({"launch_path":input["app"]}),
                    false,
                    cancellation,
                    language,
                )
                .await?;
                return Ok(Value::Null);
            }
            _ => {}
        }
        let id = window_id(&input)?;
        let (window, generation) = self
            .raw_window(id, invocation, cancellation, language)
            .await?;
        let binding = invocation
            .app_target()
            .and_then(|target| target.binding.clone())
            .ok_or_else(|| failed("raw window requires current app consent"))?;
        if binding.pid != window.pid.ok_or_else(|| failed("window has no process"))?
            || binding.process_generation != generation
        {
            return Err(failed("native app consent binding changed"));
        }
        if matches!(operation, GetWindowState) {
            // A newer observation replaces the cached handle only at native
            // success. The registry owns exact ID commit/retirement facts.
            let include_text = input::truthy(&input["include_text"]);
            let include_screenshot = input::truthy(&input["include_screenshot"]);
            let expected = Driver::windows_native_generation(&self.native, self.epoch).await?;
            let observed = Driver::observe_raw_windows_in_generation(
                &self.native,
                json!({"pid":binding.pid,"window_id":id,
                "include_accessibility_tree":include_text,"include_screenshot":include_screenshot,
                "tree_format":"both","max_image_dimension":0,"full_output":true}),
                self.epoch,
                expected,
                cancellation,
                language,
            )
            .await?;
            // Fold the exact native commit before decoding, formatting,
            // permission rechecks or any later fallible response work.
            if let Some(committed) = observed.commit {
                if committed.frame.pid() != binding.pid || committed.frame.window_id() != id {
                    return Err(failed("native observation commit target changed"));
                }
                let previous = self.raw_computer.windows.remove(&id).filter(|previous| {
                    previous.binding == binding && previous.generation == expected
                });
                let (
                    previous_state,
                    previous_size,
                    previous_capture,
                    previous_image_bounds,
                    previous_target,
                ) = match previous {
                    Some(previous) => {
                        let capture = (previous.frame == committed.frame)
                            .then_some(previous.capture)
                            .flatten();
                        let image_bounds = capture.as_ref().and(previous.image_bounds);
                        (
                            previous.state,
                            previous.logical_size,
                            capture,
                            image_bounds,
                            previous.target_observed,
                        )
                    }
                    None => (None, None, None, None, false),
                };
                let logical_size = committed.logical_size.or_else(|| {
                    (!matches!(
                        committed.captures,
                        crate::driver::WindowsCaptureCommit::Cleared
                    ) || previous_target)
                        .then_some(previous_size)
                        .flatten()
                });
                let (capture, image_bounds) = match committed.captures {
                    crate::driver::WindowsCaptureCommit::Unchanged => {
                        (previous_capture, previous_image_bounds)
                    }
                    crate::driver::WindowsCaptureCommit::Cleared => (None, None),
                    crate::driver::WindowsCaptureCommit::Replaced { id } => {
                        (Some(id), committed.image_bounds)
                    }
                };
                self.raw_computer.windows.insert(
                    id,
                    WindowsObservation {
                        binding: binding.clone(),
                        generation: expected,
                        frame: committed.frame,
                        state: previous_state,
                        logical_size,
                        capture,
                        image_bounds,
                        target_observed: previous_target || committed.target_committed,
                    },
                );
            }
            let result = observed.result?;
            let capture = self
                .raw_computer
                .windows
                .get(&id)
                .filter(|record| record.binding == binding && record.generation == expected)
                .and_then(|record| record.capture.clone());
            let state: WindowStateOutput = decode(result.clone())?;
            if state.pid != binding.pid || state.window_id != id {
                return Err(failed("observation target changed"));
            }
            if let Some(record) = self
                .raw_computer
                .windows
                .get_mut(&id)
                .filter(|record| record.binding == binding && record.generation == expected)
            {
                record.state = Some(state.clone());
            }
            let mut screenshots = Vec::new();
            for image in result
                .content
                .iter()
                .filter(|block| matches!(block, ContentBlock::Image { .. }))
            {
                let capture = capture
                    .as_ref()
                    .ok_or_else(|| failed("native screenshot has no capture identity"))?;
                let z = window
                    .z_index
                    .ok_or_else(|| failed("native screenshot stacking order is unavailable"))?;
                screenshots.push(json!({"id":capture,"zIndex":z,"url":data_url(image)?}));
            }
            if include_screenshot && screenshots.is_empty() {
                return Err(failed(
                    "screenshot_unavailable: native provider returned no image",
                ));
            }
            let accessibility = if include_text {
                Some(
                    json!({"tree":state.tree_markdown.clone().ok_or_else(||failed("native accessibility text unavailable"))?}),
                )
            } else {
                None
            };
            crate::windows_permission_subject::verify_window(
                invocation.app_target().unwrap(),
                id,
                language,
            )?;
            let generation = Driver::windows_native_generation(&self.native, self.epoch).await?;
            if generation != expected {
                return Err(failed(
                    "native observation belongs to a retired Windows owner",
                ));
            }
            let _observation = self
                .raw_computer
                .windows
                .get_mut(&id)
                .filter(|record| record.binding == binding && record.generation == expected)
                .ok_or_else(|| failed("native observation omitted its commit"))?;
            return Ok(
                json!({"window":input["window"],"screenshots":screenshots,"accessibility":accessibility}),
            );
        }
        if let Some(observation) = self.raw_computer.windows.get_mut(&id) {
            if observation.binding != binding {
                self.raw_computer.windows.remove(&id);
            } else {
                let frame = raw_windows_native_frame(binding.pid, id, &window.bounds)?;
                if observation.frame != frame {
                    // The native resolver retires IDs on rectangle changes,
                    // while the same target keeps its last logical viewport.
                    observation.capture = None;
                    observation.image_bounds = None;
                    observation.frame = frame;
                }
            }
        }
        let bound = json!({"kind":"window","pid":binding.pid,"window_id":id});
        let mut arguments = json!({"target":bound,"delivery_mode":"foreground"});
        let tool = match operation {
            ActivateWindow => {
                arguments = json!({"pid":binding.pid,"window_id":id});
                RawTool::ActivateWindow
            }
            Click => {
                arguments["button"] = input["mouse_button"].clone();
                arguments["count"] = input["click_count"].clone();
                if let Some(index) = input["element_index"].as_u64() {
                    arguments["element_token"] =
                        self.raw_windows_element(id, &binding, index)?.into();
                } else {
                    self.raw_windows_capture(id, &binding, &input, &mut arguments)?;
                    arguments["x"] = input["x"].clone();
                    arguments["y"] = input["y"].clone();
                }
                RawTool::Click
            }
            TypeText => {
                arguments["text"] = input["text"].clone();
                RawTool::TypeText
            }
            PressKey => {
                let key = input["key"].as_str().unwrap();
                let mut parts = key.split('+').collect::<Vec<_>>();
                let key = parts.pop().ok_or_else(|| failed("key is required"))?;
                arguments["key"] = key.into();
                arguments["modifiers"] = json!(parts);
                RawTool::PressKey
            }
            SetValue => {
                arguments = json!({"pid":binding.pid,"window_id":id,"value":input["value"],
                    "element_token":self.raw_windows_element(id,&binding,input["element_index"].as_u64().unwrap())?});
                RawTool::SetValue
            }
            Drag => {
                self.raw_windows_capture(id, &binding, &input, &mut arguments)?;
                for name in ["from_x", "from_y", "to_x", "to_y"] {
                    arguments[name] = input[name].clone();
                }
                RawTool::Drag
            }
            Scroll => {
                self.raw_windows_capture(id, &binding, &input, &mut arguments)?;
                arguments["x"] = input["x"].clone();
                arguments["y"] = input["y"].clone();
                arguments["scroll_x"] = input["scrollX"].clone();
                arguments["scroll_y"] = input["scrollY"].clone();
                RawTool::Scroll
            }
            PerformSecondaryAction => {
                arguments = json!({"pid":binding.pid,"window_id":id,"action":input["action"],
                    "element_token":self.raw_windows_element(id,&binding,input["element_index"].as_u64().unwrap())?});
                RawTool::SecondaryAction
            }
            _ => return Err(failed("native method is not installed for Windows")),
        };
        let coordinate =
            matches!(operation, Click | Drag | Scroll) && input.get("element_index").is_none();
        let without_capture = coordinate && input.get("screenshotId").is_none();
        if without_capture {
            let generation = Driver::windows_native_generation(&self.native, self.epoch).await?;
            let logical_size = self
                .raw_computer
                .windows
                .get(&id)
                .filter(|observation| {
                    observation.binding == binding && observation.generation == generation
                })
                .and_then(|observation| observation.logical_size);
            let frame = raw_windows_native_frame(binding.pid, id, &window.bounds)?;
            let [_, _, width, height] = frame.bounds();
            let logical_size = logical_size.unwrap_or([width as u32, height as u32]);
            let pairs: &[(&str, &str)] = if matches!(operation, Drag) {
                &[("from_x", "from_y"), ("to_x", "to_y")]
            } else {
                &[("x", "y")]
            };
            for &(x, y) in pairs {
                let mapped = raw_windows_logical_point(
                    arguments[x].as_f64().unwrap(),
                    arguments[y].as_f64().unwrap(),
                    logical_size,
                    [width, height],
                )?;
                arguments[x] = mapped.0.into();
                arguments[y] = mapped.1.into();
            }
            Driver::invoke_native_window_frame_in_generation(
                &self.native,
                tool.name(),
                arguments,
                self.epoch,
                (generation, frame),
                cancellation,
                language,
            )
            .await?;
            return Ok(Value::Null);
        }
        let expected = if input.get("element_index").is_some()
            || input.get("screenshotId").is_some()
        {
            let generation = self
                .raw_computer
                .windows
                .get(&id)
                .filter(|record| record.binding == binding)
                .map(|record| record.generation)
                .ok_or_else(|| failed("native observation is no longer current"))?;
            if Driver::windows_native_generation(&self.native, self.epoch).await? != generation {
                return Err(failed(
                    "native observation belongs to a retired Windows owner",
                ));
            }
            Some(generation)
        } else {
            None
        };
        if let Some(generation) = expected {
            // NativeOwner compares this opaque expected generation under the
            // same slot lock that selects its actual child. It retains that
            // exact Arc<Slot>, with no replacement spawn/reroute/replay.
            Driver::invoke_in_generation(
                &self.native,
                tool.name(),
                arguments,
                self.epoch,
                generation,
                cancellation,
                language,
            )
            .await?;
        } else {
            self.raw_tool(tool, arguments, false, cancellation, language)
                .await?;
        }
        Ok(Value::Null)
    }

    fn raw_windows_element(
        &self,
        id: u64,
        binding: &crate::ComputerAppBinding,
        index: u64,
    ) -> Result<String, ToolError> {
        let observation = self
            .raw_computer
            .windows
            .get(&id)
            .filter(|record| record.binding == *binding)
            .ok_or_else(|| {
                failed("stale_target: read this window's current accessibility state")
            })?;
        observation
            .state
            .as_ref()
            .and_then(|state| state.elements.as_ref())
            .and_then(|elements| {
                elements
                    .iter()
                    .find(|element| element.element_index == index)
            })
            .and_then(|element| element.element_token.clone())
            .ok_or_else(|| failed("element is not in the current window snapshot"))
    }

    fn raw_windows_capture(
        &self,
        id: u64,
        binding: &crate::ComputerAppBinding,
        input: &Value,
        args: &mut Value,
    ) -> Result<(), ToolError> {
        if let Some(capture) = input.get("screenshotId").filter(|value| !value.is_null()) {
            let capture = capture
                .as_str()
                .ok_or_else(|| failed("screenshotId must be a string"))?;
            let observation = self
                .raw_computer
                .windows
                .get(&id)
                .filter(|record| record.binding == *binding)
                .ok_or_else(|| failed("screenshot does not belong to this window"))?;
            if observation.capture.as_deref() != Some(capture) {
                return Err(failed("screenshot is not current for this window"));
            }
            args["capture_id"] = capture.into();
        }
        Ok(())
    }
}

fn public_windows_window(window: &WindowInfo) -> Value {
    let mut result = json!({"id":window.window_id,"app":window.app_name});
    if !window.title.is_empty() {
        result["title"] = window.title.clone().into();
    }
    result
}

fn raw_windows_native_frame(
    pid: u32,
    id: u64,
    bounds: &cua_driver_contract::WindowBounds,
) -> Result<cua_driver_sdk::NativeWindowFrame, ToolError> {
    fn integer(value: f64) -> Result<i32, ToolError> {
        if !value.is_finite()
            || value.fract() != 0.0
            || value < f64::from(i32::MIN)
            || value > f64::from(i32::MAX)
        {
            return Err(failed(
                "native window bounds are not representable integer pixels",
            ));
        }
        Ok(value as i32)
    }
    cua_driver_sdk::NativeWindowFrame::try_new(
        pid,
        id,
        [
            integer(bounds.x)?,
            integer(bounds.y)?,
            integer(bounds.width)?,
            integer(bounds.height)?,
        ],
    )
    .map_err(failed)
}

fn raw_windows_logical_point(
    x: f64,
    y: f64,
    logical: [u32; 2],
    native: [i32; 2],
) -> Result<(i32, i32), ToolError> {
    fn axis(point: f64, logical: u32, native: i32) -> Result<i32, ToolError> {
        if logical == 0
            || logical > i32::MAX as u32
            || native <= 0
            || !point.is_finite()
            || point.fract() != 0.0
            || point < 0.0
            || point >= f64::from(logical)
        {
            return Err(failed("coordinate is outside the logical window viewport"));
        }
        i32::try_from((point as i64) * i64::from(native) / i64::from(logical))
            .map_err(|_| failed("native window point is not representable"))
    }
    Ok((
        axis(x, logical[0], native[0])?,
        axis(y, logical[1], native[1])?,
    ))
}
