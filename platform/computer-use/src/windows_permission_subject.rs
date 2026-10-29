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
