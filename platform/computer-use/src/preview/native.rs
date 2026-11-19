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

mod presentation;

#[derive(Clone)]
pub(crate) struct NativeCapture {
    pub driver: std::sync::Weak<tokio::sync::Mutex<crate::Driver>>,
    pub native_epoch: NativeEpochId,
    #[cfg(target_os = "windows")]
    pub windows_source: crate::desktop::worker::native_owner::NativePresentationSource,
    pub binding: crate::ComputerAppBinding,
    pub subject: PreviewSubject,
}
impl NativeCapture {
    fn verify(&self) -> Result<(), ToolError> {
        let binding = &self.binding;
        #[cfg(not(target_os = "windows"))]
        if crate::identity::process(binding.pid)? != binding.process_generation {
            return Err(failed("preview process generation changed"));
        }
        #[cfg(target_os = "macos")]
        objc2::rc::autoreleasepool(|_| {
            crate::macos::require_desktop_blocking()?;
            crate::macos::tcc::require(crate::macos::tcc::Grant::ScreenRecording)?;
            let PreviewSubject::Native { target, .. } = &self.subject else {
                unreachable!()
            };
            crate::macos::permission_subject::verify_window(
                target,
                binding.pid,
                binding.window_id,
                &binding.process_generation,
                maka_agent_facts::language::Language::En,
            )
        })?;
        #[cfg(target_os = "linux")]
        if !crate::Driver::linux_x11_selected()
            || !platform_linux::x11::window_belongs_to_pid(binding.window_id, binding.pid)
        {
            return Err(failed("preview requires the bound live X11 window"));
        }
        #[cfg(target_os = "windows")]
        match &self.subject {
            PreviewSubject::Native { target, .. } => {
                let observed = crate::windows_permission_subject::verify_window(
                    target,
                    binding.window_id,
                    maka_agent_facts::language::Language::En,
                )?;
                if observed != *binding {
                    return Err(failed("preview application binding changed"));
                }
            }
            PreviewSubject::NativeWindow { .. } => {
                crate::windows_permission_subject::verify_binding(binding)?;
            }
            _ => unreachable!("native capture retains a native subject"),
        }
        Ok(())
    }
}
impl Capture for NativeCapture {
    fn present(
        &self,
        authority: Arc<dyn ForegroundAuthority>,
        area: PresentationArea,
        stop: CancellationToken,
    ) -> PresentationFuture {
        presentation::present(self.clone(), authority, area, stop)
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn same_source(&self, other: &dyn Capture) -> bool {
        other.as_any().downcast_ref::<Self>().is_some_and(|other| {
            #[cfg(target_os = "windows")]
            if self.windows_source != other.windows_source {
                return false;
            }
            self.binding == other.binding
                && self.subject.native_execution() == other.subject.native_execution()
                && self.native_epoch == other.native_epoch
                && std::sync::Weak::ptr_eq(&self.driver, &other.driver)
        })
    }
    fn authorize(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> AuthorizationFuture {
        let capture = self.clone();
        Box::pin(async move {
            authority
                .authorize(capture.subject.clone(), stop.clone())
                .await?;
            let check_stop = stop.clone();
            tokio::task::spawn_blocking(move || {
                if check_stop.is_cancelled() {
                    return Err(failed("preview target retired"));
                }
                capture.verify()
            })
            .await
            .map_err(failed)??;
            if stop.is_cancelled() {
                return Err(failed("preview target retired"));
            }
            Ok(())
        })
    }
    fn capture(
        &self,
        authority: Arc<dyn PreviewAuthority>,
        stop: CancellationToken,
    ) -> CaptureFuture {
        let capture = self.clone();
        Box::pin(async move {
            authority
                .authorize(capture.subject.clone(), stop.clone())
                .await?;
            let subject = capture.subject.clone();
            let final_stop = stop.clone();
            let bytes = tokio::task::spawn_blocking(move || {
                capture.verify()?;
                if stop.is_cancelled() {
                    return Err(failed("preview capture cancelled"));
                }
                #[cfg(target_os = "macos")]
                let bytes = objc2::rc::autoreleasepool(|_| {
                    platform_macos::capture::screenshot_window_bytes(
                        u32::try_from(capture.binding.window_id).map_err(failed)?,
                    )
                    .map_err(failed)
                })?;
                #[cfg(target_os = "linux")]
                let bytes =
                    platform_linux::capture::screenshot_window_bytes(capture.binding.window_id)
                        .map_err(failed)?;
                #[cfg(target_os = "windows")]
                let bytes = window_pixels(capture.binding.window_id)?;
                capture.verify()?;
                if stop.is_cancelled() {
                    return Err(failed("preview capture cancelled"));
                }
                Ok::<_, ToolError>(bytes)
            })
            .await
            .map_err(failed)??;
            authority.authorize(subject, final_stop).await?;
            Ok(CapturedImage::Encoded(bytes))
        })
    }
}

#[cfg(target_os = "windows")]
fn window_pixels(id: u64) -> Result<Vec<u8>, ToolError> {
    // WGC is target-only. Never use the platform's screen-region BitBlt fallback.
    let (pixels, width, height) =
        platform_windows::wgc::screenshot_window_via_wgc(id).map_err(failed)?;
    cua_driver_core::image_utils::encode_bgra_to_png(&pixels, width, height).map_err(failed)
}
