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
use crate::preview::{ForegroundAuthority, PresentationArea, PresentationResult, PreviewSubject};
use serde_json::json;

impl NativeOwner {
    async fn presentation_slot(
        &self,
        source: &NativePresentationSource,
    ) -> Result<Arc<Slot>, ToolError> {
        let slot = self
            .current
            .lock()
            .await
            .as_ref()
            .filter(|slot| slot.generation == source.generation && slot.key() == source.key)
            .cloned()
            .ok_or_else(|| failed("native presentation source changed"))?;
        if let Some(NativeExit::WaitFailed(reason)) = slot.exit.borrow().as_ref() {
            return Err(ToolError::CleanupUnconfirmed(reason.clone()));
        }
        if slot.hard_stop.is_cancelled()
            || slot.exit.borrow().is_some()
            || slot.observation.borrow().interrupted
            || slot.observation.borrow().retired.is_some()
        {
            return Err(failed("native presentation source retired"));
        }
        Ok(slot)
    }

    async fn present_step(
        &self,
        source: &NativePresentationSource,
        binding: &crate::ComputerAppBinding,
        step: NativePresentStep,
        cancellation: CancellationToken,
    ) -> Result<NativePresentReply, ToolError> {
        if cancellation.is_cancelled() {
            return Err(failed("native presentation cancelled"));
        }
        let slot = self.presentation_slot(source).await?;
        let admission = slot
            .requests
            .clone()
            .try_lock_owned()
            .map_err(|_| failed("native owner has an active request"))?;
        let reply = slot
            .connection
            .invoke_native_present(
                Request::NativePresent {
                    key: source.key.clone(),
                    generation: source.generation.observed(),
                    binding: binding.clone(),
                    step,
                },
                cancellation,
                admission,
            )
            .await?;
        serde_json::from_value(reply.value).map_err(|error| {
            ToolError::OutcomeUnknown(format!("invalid native presentation result: {error}"))
        })
    }

    pub(crate) async fn present(
        &self,
        source: &NativePresentationSource,
        binding: &crate::ComputerAppBinding,
        subject: PreviewSubject,
        authority: Arc<dyn ForegroundAuthority>,
        area: PresentationArea,
        cancellation: CancellationToken,
    ) -> Result<PresentationResult, ToolError> {
        let checkpoint = || async {
            authority
                .authorize(subject.clone(), cancellation.clone())
                .await?;
            self.presentation_slot(source).await.map(|_| ())
        };
        checkpoint().await?;
        let NativePresentReply::Frame(frame) = self
            .present_step(
                source,
                binding,
                NativePresentStep::ReadFrame,
                cancellation.clone(),
            )
            .await?
        else {
            return Err(ToolError::OutcomeUnknown(
                "native frame query returned an effect".into(),
            ));
        };
        let width = frame.width.min(area.width);
        let height = frame.height.min(area.height);
        checkpoint().await?;
        let NativePresentReply::Effect(placed) = self
            .present_step(
                source,
                binding,
                NativePresentStep::SetFrame {
                    x: area.x + (area.width - width) / 2.0,
                    y: area.y + (area.height - height) / 2.0,
                    width,
                    height,
                },
                cancellation.clone(),
            )
            .await?
        else {
            return Err(ToolError::OutcomeUnknown(
                "native placement returned no effect".into(),
            ));
        };
        let mut details =
            json!({"placement": serde_json::from_str::<Value>(&placed.raw_json).map_err(failed)?});
        if placed.is_error {
            return Ok(PresentationResult::Partial {
                message: placed.text,
                details,
            });
        }
        let call: maka_agent_facts::capability::CallResult =
            serde_json::from_str(&placed.raw_json).map_err(failed)?;
        let action: cua_driver_contract::ActionResult = serde_json::from_value(
            call.structured_content
                .ok_or_else(|| failed("native placement omitted its action result"))?,
        )
        .map_err(failed)?;
        if action.effect != cua_driver_contract::ActionEffect::Confirmed {
            return Ok(PresentationResult::Partial {
                message: "native placement was not verified".into(),
                details,
            });
        }
        if let Err(error) = checkpoint().await {
            return crate::preview::presentation_failure(error, details);
        }
        let raised = match self
            .present_step(
                source,
                binding,
                NativePresentStep::Raise,
                cancellation.clone(),
            )
            .await
        {
            Ok(NativePresentReply::Effect(result)) => result,
            Ok(_) => {
                return Err(ToolError::OutcomeUnknown(format!(
                    "native activation returned no effect; completed placement: {details}"
                )));
            }
            Err(ToolError::OutcomeUnknown(message)) => {
                return Err(ToolError::OutcomeUnknown(format!(
                    "{message}; completed placement: {details}"
                )));
            }
            Err(error) => {
                return crate::preview::presentation_failure(error, details);
            }
        };
        details["activation"] = serde_json::from_str::<Value>(&raised.raw_json).map_err(failed)?;
        if let Err(error) = checkpoint().await {
            return crate::preview::presentation_failure(error, details);
        }
        if raised.is_error {
            return Ok(PresentationResult::Partial {
                message: raised.text,
                details,
            });
        }
        #[derive(Deserialize)]
        struct Activated {
            target_hwnd: String,
            now_fg_hwnd: String,
            landed_on_target: bool,
        }
        let call: maka_agent_facts::capability::CallResult =
            serde_json::from_str(&raised.raw_json).map_err(failed)?;
        let result: Activated = serde_json::from_value(
            call.structured_content
                .ok_or_else(|| failed("native activation omitted its result"))?,
        )
        .map_err(failed)?;
        let exact = format!("0x{:x}", binding.window_id);
        if result.landed_on_target && result.target_hwnd == exact && result.now_fg_hwnd == exact {
            Ok(PresentationResult::Presented { details })
        } else {
            Ok(PresentationResult::Partial {
                message: "native foreground activation was not verified".into(),
                details,
            })
        }
    }
}

async fn verify_binding(binding: crate::ComputerAppBinding) -> Result<(), ToolError> {
    tokio::task::spawn_blocking(move || {
        if crate::identity::process(binding.pid)? != binding.process_generation
            || platform_windows::win32::windows::window_owner_pid(binding.window_id)
                != Some(binding.pid)
        {
            return Err(failed("native presentation window identity changed"));
        }
        Ok(())
    })
    .await
    .map_err(failed)?
}

pub(super) async fn execute(
    session: Arc<CuaDriverSession>,
    binding: crate::ComputerAppBinding,
    step: NativePresentStep,
    cancellation: CancellationToken,
) -> Result<NativePresentReply, ToolError> {
    if cancellation.is_cancelled() {
        return Err(failed("native presentation cancelled before dispatch"));
    }
    verify_binding(binding.clone()).await?;
    if cancellation.is_cancelled() {
        return Err(failed("native presentation cancelled before dispatch"));
    }
    let result = match step {
        NativePresentStep::ReadFrame => {
            let window = session
                .list_windows(cua_driver_contract::ListWindowsInput {
                    pid: Some(binding.pid),
                    on_screen_only: Some(false),
                })
                .await
                .map_err(|error| crate::driver::native_error(&error, Language::En))?
                .windows
                .into_iter()
                .find(|window| {
                    window.window_id == binding.window_id && window.pid == Some(binding.pid)
                })
                .ok_or_else(|| failed("native bound window closed"))?;
            NativePresentReply::Frame(window.bounds)
        }
        NativePresentStep::SetFrame {
            x,
            y,
            width,
            height,
        } => NativePresentReply::Effect(
            session
                .set_window_frame(cua_driver_contract::SetWindowFrameInput {
                    pid: binding.pid,
                    window_id: binding.window_id,
                    x,
                    y,
                    width,
                    height,
                    session: None,
                })
                .await
                .map_err(|error| crate::driver::native_error(&error, Language::En))?
                .into(),
        ),
        NativePresentStep::Raise => NativePresentReply::Effect(
            session
                .call_tool(
                    "bring_to_front".into(),
                    json!({"pid":binding.pid,"window_id":binding.window_id}).to_string(),
                )
                .await
                .map_err(|error| crate::driver::native_error(&error, Language::En))?
                .into(),
        ),
    };
    if let Err(error) = verify_binding(binding).await {
        return Err(ToolError::OutcomeUnknown(format!(
            "{error}; native result: {}",
            serde_json::to_string(&result).map_err(failed)?
        )));
    }
    Ok(result)
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
