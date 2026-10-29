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
            // Invalidate old observation identities before the read. A failed
            // newer read cannot leave an older screenshot as current.
            self.raw_computer.windows.remove(&id);
            let include_text = input::truthy(&input["include_text"]);
            let include_screenshot = input::truthy(&input["include_screenshot"]);
            let result = self
                .raw_tool(
                    RawTool::GetWindowState,
                    json!({"pid":binding.pid,"window_id":id,
                "include_accessibility_tree":include_text,"include_screenshot":include_screenshot,
                "tree_format":"both","max_image_dimension":0,"full_output":true}),
                    false,
                    cancellation,
                    language,
                )
                .await?;
            let capture = result
                .structured_content
                .as_ref()
                .and_then(|value| value["capture_id"].as_str())
                .map(str::to_owned);
            let state: WindowStateOutput = decode(result.clone())?;
            if state.pid != binding.pid || state.window_id != id {
                return Err(failed("observation target changed"));
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
            self.raw_computer.windows.insert(
                id,
                WindowsObservation {
                    binding,
                    generation,
                    state,
                    capture,
                },
            );
            return Ok(
                json!({"window":input["window"],"screenshots":screenshots,"accessibility":accessibility}),
            );
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
                // Original scrollX/scrollY are a simultaneous two-axis native
                // wheel request. Do not split into two independent operations
                // or silently discard one nonzero axis.
                return Err(failed(
                    "native two-axis Windows scroll actuator is not yet connected",
                ));
            }
            PerformSecondaryAction => {
                arguments = json!({"pid":binding.pid,"window_id":id,"action":input["action"],
                    "element_token":self.raw_windows_element(id,&binding,input["element_index"].as_u64().unwrap())?});
                RawTool::SecondaryAction
            }
            _ => return Err(failed("native method is not installed for Windows")),
        };
        let coordinate = matches!(operation, Click | Drag) && input.get("element_index").is_none();
        let without_capture = coordinate && input.get("screenshotId").is_none();
        if without_capture {
            // NativeWindowPixels is explicitly physical. Original's no-ID
            // logical/DPI mapping is still a separate native evidence seam.
            return Err(failed(
                "native Windows logical window-coordinate actuator is not yet connected",
            ));
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
        if let Some(observation) = self.raw_computer.windows.get_mut(&id) {
            observation.capture = None;
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
            .elements
            .as_ref()
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
