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
#[cfg(not(target_os = "windows"))]
use maka_agent_facts::language::Language;
#[cfg(not(target_os = "windows"))]
use serde_json::{Value, json};

async fn verify(
    capture: &NativeCapture,
    authority: &Arc<dyn ForegroundAuthority>,
    stop: &CancellationToken,
) -> Result<(), ToolError> {
    authority
        .authorize(capture.subject.clone(), stop.clone())
        .await?;
    let capture = capture.clone();
    let cancellation = stop.clone();
    tokio::task::spawn_blocking(move || {
        if cancellation.is_cancelled() {
            return Err(failed("Computer presentation cancelled"));
        }
        capture.verify()
    })
    .await
    .map_err(failed)??;
    if stop.is_cancelled() {
        return Err(failed("Computer presentation cancelled"));
    }
    Ok(())
}

pub(super) fn present(
    capture: NativeCapture,
    authority: Arc<dyn ForegroundAuthority>,
    area: PresentationArea,
    stop: CancellationToken,
) -> PresentationFuture {
    Box::pin(async move {
        verify(&capture, &authority, &stop).await?;
        let driver = capture
            .driver
            .upgrade()
            .ok_or_else(|| failed("Computer presentation owner retired"))?;
        #[cfg(target_os = "windows")]
        {
            crate::Driver::present_native_window(&driver, &capture, authority, area, stop).await
        }
        #[cfg(not(target_os = "windows"))]
        {
            let sdk =
                crate::Driver::presentation_session(&driver, capture.native_epoch, &stop).await?;
            let checkpoint = || async {
                crate::Driver::check_presentation_session(&driver, capture.native_epoch, &sdk)
                    .await?;
                verify(&capture, &authority, &stop).await
            };
            checkpoint().await?;
            let window = sdk
                .list_windows(cua_driver_contract::ListWindowsInput {
                    pid: Some(capture.binding.pid),
                    on_screen_only: Some(false),
                })
                .await
                .map_err(|error| crate::driver::native_error(&error, Language::EN))?
                .windows
                .into_iter()
                .find(|window| {
                    window.window_id == capture.binding.window_id
                        && window.pid == Some(capture.binding.pid)
                })
                .ok_or_else(|| failed("Computer bound window is no longer available"))?;
            let width = window.bounds.width.min(area.width);
            let height = window.bounds.height.min(area.height);
            checkpoint().await?;
            let frame = sdk
                .set_window_frame(cua_driver_contract::SetWindowFrameInput {
                    pid: capture.binding.pid,
                    window_id: capture.binding.window_id,
                    x: area.x + (area.width - width) / 2.0,
                    y: area.y + (area.height - height) / 2.0,
                    width,
                    height,
                    session: None,
                })
                .await
                .map_err(|error| crate::driver::native_error(&error, Language::EN))?;
            let mut details = json!({"placement": serde_json::from_str::<Value>(&frame.raw_json).map_err(failed)?});
            if frame.is_error
                || !matches!(
                    frame.action.as_ref().map(|action| action.effect),
                    Some(cua_driver_contract::ActionEffect::Confirmed)
                )
            {
                return Ok(PresentationResult::Partial {
                    message: frame.text,
                    details,
                });
            }
            if let Err(error) = checkpoint().await {
                return crate::preview::presentation_failure(error, details);
            }
            let raise = match sdk
                .call_tool(
                    "bring_to_front".into(),
                    json!({
                        "pid": capture.binding.pid, "window_id": capture.binding.window_id,
                    })
                    .to_string(),
                )
                .await
            {
                Ok(result) => result,
                Err(error) => {
                    let error = crate::driver::native_error(&error, Language::EN);
                    return crate::preview::presentation_failure(error, details);
                }
            };
            details["activation"] =
                serde_json::from_str::<Value>(&raise.raw_json).map_err(failed)?;
            if let Err(error) = checkpoint().await {
                return crate::preview::presentation_failure(error, details);
            }
            if raise.is_error {
                return Ok(PresentationResult::Partial {
                    message: raise.text,
                    details,
                });
            }
            #[cfg(target_os = "macos")]
            let verified = {
                #[derive(Deserialize)]
                struct Exact {
                    verified: bool,
                }
                #[derive(Deserialize)]
                struct Activated {
                    pid: u32,
                    window_id: u64,
                    status: String,
                    activated: bool,
                    exact_window_effect: Exact,
                }
                let result: Activated =
                    serde_json::from_str(raise.structured_json.as_deref().ok_or_else(|| {
                        failed("Computer activation returned no structured result")
                    })?)
                    .map_err(failed)?;
                if result.pid != capture.binding.pid
                    || result.window_id != capture.binding.window_id
                {
                    return Err(failed(
                        "Computer activation result belongs to another window",
                    ));
                }
                result.status == "activated"
                    && result.activated
                    && result.exact_window_effect.verified
            };
            #[cfg(target_os = "linux")]
            let verified = {
                let window_id = capture.binding.window_id;
                tokio::task::spawn_blocking(move || {
                    platform_linux::x11::active_window() == Some(window_id)
                })
                .await
                .map_err(failed)?
            };
            if verified {
                Ok(PresentationResult::Presented { details })
            } else {
                Ok(PresentationResult::Partial {
                    message: "Computer foreground activation was not verified".into(),
                    details,
                })
            }
        }
    })
}
