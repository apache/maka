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

//! Windows raw selectors are resolved by the Host, never treated as grants.
//!
//! The original selected native-pipe profile delegates approval to its host;
//! the helper profile is a distinct runtime mode. Maka uses its existing
//! canonical ComputerApp interaction/authority for its own Host adaptation.

use crate::permission_subject::{ComputerAppBinding, ComputerAppTarget};
use maka_agent_facts::{
    interaction::{ComputerAppDisplay, ComputerAppIdentity, ComputerAppPlatform},
    language::Language,
    tools::ToolError,
};

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

pub(crate) fn resolve_window(
    window_id: u64,
    language: Language,
) -> Result<ComputerAppTarget, ToolError> {
    let pid = platform_windows::win32::window_owner_pid(window_id)
        .ok_or_else(|| failed("stale_target: native window has no live owner"))?;
    let generation = crate::identity::process(pid)?;
    // Query-only existing Cua identity primitive; no AX, activation, capture,
    // input, or caller-supplied process identity is involved.
    let owner_path = platform_windows::history::process_executable_path(pid)
        .ok_or_else(|| failed("application permission requires a resolved executable path"))?;
    let frame_host = owner_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("ApplicationFrameHost.exe"));
    // Reuse the same actual UWP child resolver as Cua's existing application
    // identity provider. Never grant every packaged app as FrameHost.exe.
    let application_pid = if frame_host {
        platform_windows::win32::resolve_uwp_app_pid(pid, window_id).ok_or_else(|| {
            failed("application permission requires the actual packaged-app process")
        })?
    } else {
        pid
    };
    let application_generation = crate::identity::process(application_pid)?;
    let path = if application_pid == pid {
        owner_path
    } else {
        platform_windows::history::process_executable_path(application_pid)
            .ok_or_else(|| failed("packaged application executable path unavailable"))?
    };
    let image = path
        .to_str()
        .ok_or_else(|| failed("application executable path is not Unicode"))?
        .to_owned();
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| failed("application executable name is unavailable"))?
        .to_owned();
    if platform_windows::win32::window_owner_pid(window_id) != Some(pid)
        || crate::identity::process(pid)? != generation
        || crate::identity::process(application_pid)? != application_generation
        || (frame_host
            && platform_windows::win32::resolve_uwp_app_pid(pid, window_id)
                != Some(application_pid))
    {
        return Err(failed(
            "stale_target: native window owner changed during app resolution",
        ));
    }
    let warning = match language {
        Language::En => {
            "This app's risk classification has not been established. Approve access only if you trust the app and the requested work."
        }
        Language::ZhCn => "此应用的风险分类尚未确定。请仅在信任该应用和请求的操作时授权。",
        Language::ZhTw => "此應用程式的風險分類尚未確定。請僅在信任此應用程式和要求的操作時授權。",
    };
    let subject = ComputerAppTarget {
        identity: ComputerAppIdentity {
            platform: ComputerAppPlatform::Windows,
            application_id: image.clone(),
        },
        display: ComputerAppDisplay {
            name,
            app_path: image,
            risk: None,
            warning: Some(warning.into()),
        },
        // No original Windows persistence/risk classifier has been established.
        // The existing Once/Session decisions remain fully functional.
        allow_always: false,
        binding: Some(ComputerAppBinding {
            pid,
            window_id,
            // The binding's pid remains the actual HWND owner for the native
            // exact-window guard; its opaque provenance also fences the real
            // packaged app process behind that owner.
            process_generation: format!(
                "{generation}|app:{application_pid}:{application_generation}"
            ),
        }),
    };
    subject.identity.validate().map_err(failed)?;
    subject
        .display
        .validate(ComputerAppPlatform::Windows)
        .map_err(failed)?;
    Ok(subject)
}

/// Validate a captured owner-only or permission-bound stamp against the real HWND.
pub(crate) fn verify_binding(binding: &ComputerAppBinding) -> Result<(), ToolError> {
    if platform_windows::win32::windows::window_owner_pid(binding.window_id) != Some(binding.pid) {
        return Err(failed("native window owner changed"));
    }
    let generation = crate::identity::process(binding.pid)?;
    if binding.process_generation == generation {
        if platform_windows::win32::windows::window_owner_pid(binding.window_id)
            != Some(binding.pid)
            || crate::identity::process(binding.pid)? != generation
        {
            return Err(failed("native window identity changed"));
        }
        return Ok(());
    }
    // Permission-bound observations also fence the packaged app behind the HWND owner.
    let observed = resolve_window(binding.window_id, Language::En)?;
    if observed.binding.as_ref() != Some(binding) {
        return Err(failed("native application binding changed"));
    }
    Ok(())
}

/// Requery immediately before dispatch after the real app consent completed.
pub(crate) fn verify_window(
    approved: &ComputerAppTarget,
    window_id: u64,
    language: Language,
) -> Result<ComputerAppBinding, ToolError> {
    let current = resolve_window(window_id, language)?;
    approved.check_observed(&current)?;
    if !approved.matches_resolved(&current) {
        return Err(failed("application identity changed after approval"));
    }
    current
        .binding
        .ok_or_else(|| failed("approved native window has no live binding"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_OVERLAPPEDWINDOW},
    };

    #[test]
    fn preview_windows_bindings_require_current_owner_and_full_application_stamp() {
        struct Window(HWND);
        impl Drop for Window {
            fn drop(&mut self) {
                // SAFETY: this test owns the live HWND and destroys it on its creating thread.
                assert_ne!(unsafe { DestroyWindow(self.0) }, 0);
            }
        }
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "Maka preview binding contract\0".encode_utf16().collect();
        // SAFETY: STATIC is a system class; both strings remain valid for this synchronous call.
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                240,
                160,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null(), "{}", std::io::Error::last_os_error());
        let window = Window(hwnd);
        let resolved = resolve_window(window.0 as usize as u64, Language::En).unwrap();
        let composite = resolved.binding.unwrap();
        let generation = crate::identity::process(std::process::id()).unwrap();
        let raw = ComputerAppBinding {
            process_generation: generation.clone(),
            ..composite.clone()
        };
        verify_binding(&raw).unwrap();
        verify_binding(&composite).unwrap();

        for stamp in [
            format!("{generation}:changed"),
            format!("{generation}|app:0:{generation}"),
            format!("{generation}|app:{}:{generation}:changed", composite.pid),
            format!("{}|unexpected", composite.process_generation),
        ] {
            let changed = ComputerAppBinding {
                process_generation: stamp,
                ..composite.clone()
            };
            assert!(verify_binding(&changed).is_err());
        }
        let changed = ComputerAppBinding {
            pid: 0,
            ..raw.clone()
        };
        assert!(verify_binding(&changed).is_err());
        let changed = ComputerAppBinding {
            window_id: 0,
            ..raw.clone()
        };
        assert!(verify_binding(&changed).is_err());
        drop(window);
        assert!(verify_binding(&raw).is_err());
        assert!(verify_binding(&composite).is_err());
    }
}
