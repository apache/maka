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

//! macOS privacy grants (TCC) that native Computer Use needs.
//!
//! macOS grants Accessibility and Screen Recording to the *responsible*
//! process: the application that started the Host (Maka, or the terminal a
//! CLI ran in), not the Host binary. A missing grant is reported before any
//! native work, naming that application, instead of surfacing later as an
//! opaque AX error.
//!
//! Status checks use only macOS preflight APIs. ScreenCaptureKit content
//! enumeration can show an authorization dialog and must never be used to
//! poll permissions. A grant may require restarting the Host to take effect;
//! requesting it explicitly is separate from observing its status.

use maka_agent_facts::tools::ToolError;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy)]
pub(crate) enum Grant {
    Accessibility,
    ScreenRecording,
}

impl Grant {
    fn code(self) -> &'static str {
        match self {
            Self::Accessibility => "accessibility",
            Self::ScreenRecording => "screen_recording",
        }
    }

    fn pane(self) -> &'static str {
        match self {
            Self::Accessibility => "Accessibility",
            Self::ScreenRecording => "Screen & System Audio Recording",
        }
    }

    /// Whether this Host has already asked macOS to show the request.
    fn asked(self) -> &'static AtomicBool {
        static ACCESSIBILITY: AtomicBool = AtomicBool::new(false);
        static SCREEN_RECORDING: AtomicBool = AtomicBool::new(false);
        match self {
            Self::Accessibility => &ACCESSIBILITY,
            Self::ScreenRecording => &SCREEN_RECORDING,
        }
    }

    fn request(self) {
        use platform_macos::permissions::status;
        match self {
            Self::Accessibility => {
                status::request_accessibility();
            }
            Self::ScreenRecording => {
                status::request_screen_recording();
            }
        }
    }
}

fn path_of(pid: libc::pid_t) -> Option<String> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is writable for the length passed.
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    String::from_utf8(buffer).ok()
}

impl From<maka_agent_facts::interaction::SystemPermissionGrant> for Grant {
    fn from(grant: maka_agent_facts::interaction::SystemPermissionGrant) -> Self {
        use maka_agent_facts::interaction::SystemPermissionGrant;
        match grant {
            SystemPermissionGrant::Accessibility => Self::Accessibility,
            SystemPermissionGrant::ScreenRecording => Self::ScreenRecording,
        }
    }
}

/// Non-prompting status only. This is also called while a permission card
/// is open; it must not enumerate screen content or ask for authorization.
pub(crate) fn present(grant: Grant) -> bool {
    use platform_macos::permissions::status;
    match grant {
        Grant::Accessibility => status::accessibility_granted(),
        Grant::ScreenRecording => status::screen_recording_granted(),
    }
}

/// Asks macOS to show its request for the grant, once per Host. Returns
/// whether this call asked.
pub(crate) fn ask(grant: Grant) -> bool {
    let asked = !grant.asked().swap(true, Ordering::Relaxed);
    if asked {
        grant.request();
    }
    asked
}

pub(crate) fn require(grant: Grant) -> Result<(), ToolError> {
    if present(grant) {
        return Ok(());
    }
    let asked = ask(grant);
    Err(ToolError::Failed(message(
        grant,
        &responsible_application().0,
        asked,
    )))
}

/// An ordinary failure that a revoked grant can cause is checked again with
/// preflight and, when the grant is gone, reported as the missing grant.
/// Other errors, including unconfirmed effects and cleanup, keep their
/// meaning.
pub(crate) fn explain(error: ToolError) -> ToolError {
    let Some(grant) = suspect(&error) else {
        return error;
    };
    match require(grant) {
        Err(missing) => missing,
        Ok(()) => error,
    }
}

/// The grant whose absence this failure can be a symptom of.
fn suspect(error: &ToolError) -> Option<Grant> {
    let ToolError::Failed(text) = error else {
        return None;
    };
    if text.contains("AX error -25211") || text.contains("(-25211)") {
        Some(Grant::Accessibility)
    } else if text.contains("SCShareableContent::get failed") {
        Some(Grant::ScreenRecording)
    } else {
        None
    }
}

/// The failure for a grant still missing after the user was asked.
pub(crate) fn still_missing(grant: Grant, application: &str) -> String {
    message(grant, application, false)
}

/// The tool error for a missing grant. `permission_required:` is the stable
/// prefix; the rest tells the user which switch to turn on.
fn message(grant: Grant, application: &str, asked: bool) -> String {
    let request = if asked {
        "macOS is showing its permission request now. "
    } else {
        ""
    };
    format!(
        "permission_required: {code}; {request}Turn on \"{application}\" in System Settings > \
         Privacy & Security > {pane}, then retry. If it is not listed, reopen System Settings, \
         or add it with the + button. If access is still denied after an update, remove the old \
         application entry and add the current app again. macOS may also require restarting \
         the Host, not just reopening the conversation window.",
        code = grant.code(),
        pane = grant.pane(),
    )
}

/// The name macOS shows for the process that holds this Host's grants.
pub(crate) fn responsible_application() -> (String, Option<std::path::PathBuf>) {
    match responsible_path() {
        Some(path) => (
            application_name(&path),
            application_bundle(&path).map(ToOwned::to_owned),
        ),
        None => ("the application that started Maka".into(), None),
    }
}

fn responsible_path() -> Option<std::path::PathBuf> {
    type Responsible = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    // SAFETY: a private libSystem function with this C signature; it is
    // looked up by name and its absence is handled.
    let pid = unsafe {
        let symbol = libc::dlsym(
            libc::RTLD_DEFAULT,
            c"responsibility_get_pid_responsible_for_pid".as_ptr(),
        );
        if symbol.is_null() {
            return None;
        }
        std::mem::transmute::<*mut libc::c_void, Responsible>(symbol)(libc::getpid())
    };
    if pid <= 0 {
        return None;
    }
    path_of(pid).map(Into::into)
}

/// The name of the `.app` bundle the executable belongs to (the innermost,
/// as System Settings lists a nested helper under its own name), or the
/// executable's file name.
fn application_name(path: &std::path::Path) -> String {
    application_bundle(path)
        .or(Some(path))
        .and_then(|path| path.file_stem())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "the application that started Maka".into())
}

fn application_bundle(path: &std::path::Path) -> Option<&std::path::Path> {
    path.ancestors().find(|ancestor| {
        ancestor
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn names_the_innermost_application_bundle() {
        assert_eq!(
            application_name(Path::new(
                "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
            )),
            "Terminal"
        );
        assert_eq!(
            application_name(Path::new(
                "/Applications/Maka.app/Contents/Helpers/Maka Host.app/Contents/MacOS/launcher"
            )),
            "Maka Host"
        );
        assert_eq!(application_name(Path::new("/usr/local/bin/maka")), "maka");
    }

    #[test]
    fn polling_permissions_does_not_enumerate_screen_content() {
        const CHILD: &str = "MAKA_TEST_PERMISSION_POLL_CHILD";
        const TEST: &str =
            "macos::tcc::tests::polling_permissions_does_not_enumerate_screen_content";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        use objc2::{
            runtime::{AnyClass, AnyObject, Bool, Imp, Sel},
            sel,
        };
        unsafe extern "C-unwind" fn content_requested(
            _: *mut AnyObject,
            _: Sel,
            _: Bool,
            _: Bool,
            _: *mut AnyObject,
        ) {
            eprintln!("permission polling attempted screen-content enumeration, which can prompt");
            std::process::exit(1);
        }
        // SAFETY: load Apple's framework for this child process's lifetime.
        let framework = unsafe {
            libc::dlopen(
                c"/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit".as_ptr(),
                libc::RTLD_NOW,
            )
        };
        assert!(!framework.is_null());
        let method = AnyClass::get(c"SCShareableContent").unwrap()
            .class_method(sel!(getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:)).unwrap();
        type Request = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, Bool, Bool, *mut AnyObject);
        // SAFETY: the replacement has this selector's exact C ABI and exits
        // before any prompt. Only this isolated child runs with it installed.
        unsafe {
            method.set_implementation(std::mem::transmute::<Request, Imp>(content_requested));
        }
        use maka_agent_facts::interaction::SystemPermissionGrant::{
            Accessibility, ScreenRecording,
        };
        let _ = crate::system_permission::missing(&[Accessibility, ScreenRecording]);
        let _ = crate::system_permission::missing(&[Accessibility, ScreenRecording]);
    }

    #[test]
    fn suspects_only_failures_a_missing_grant_explains() {
        let failed = |text: &str| suspect(&ToolError::Failed(text.into()));
        assert!(matches!(
            failed("native page target AXFocusedWindow failed with AX error -25211"),
            Some(Grant::Accessibility)
        ));
        assert!(matches!(
            failed("AX operation refused (-25211)"),
            Some(Grant::Accessibility)
        ));
        assert!(matches!(
            failed("SCShareableContent::get failed: user declined"),
            Some(Grant::ScreenRecording)
        ));
        assert!(failed("application has multiple open windows").is_none());
        assert!(suspect(&ToolError::OutcomeUnknown("AX error -25211".into())).is_none());
    }

    #[test]
    fn message_names_the_switch_and_keeps_its_prefix() {
        let text = message(Grant::Accessibility, "Terminal", true);
        assert!(text.starts_with("permission_required: accessibility; macOS is showing"));
        assert!(text.contains("Turn on \"Terminal\""));
        assert!(text.contains("Privacy & Security > Accessibility"));
        let text = message(Grant::ScreenRecording, "Maka", false);
        assert!(text.starts_with("permission_required: screen_recording; Turn on \"Maka\""));
        assert!(text.contains("Screen & System Audio Recording"));
    }
}
