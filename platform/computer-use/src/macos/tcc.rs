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
//! poll permissions. Negative observations and explicit requests run in finite
//! workers; the serving Host confirms only fresh positive observations.

use maka_agent_facts::tools::ToolError;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy)]
pub(crate) enum Grant {
    Accessibility,
    ScreenRecording,
}

impl Grant {
    pub(crate) fn code(self) -> &'static str {
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

    pub(crate) fn request(self) {
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

/// A denial is observed only in a finite worker. The Host calls this only
/// after a fresh positive result for the same responsible subject.
pub(crate) fn raw_present(grant: Grant) -> bool {
    use platform_macos::permissions::status;
    match grant {
        Grant::Accessibility => status::accessibility_granted(),
        Grant::ScreenRecording => status::screen_recording_granted(),
    }
}

/// Requests one grant in a finite process; the budget belongs to this Host.
pub(crate) fn ask(grant: Grant, cancelled: &(dyn Fn() -> bool + Sync)) -> Result<(), String> {
    let subject = crate::system_permission::process::Subject::current()?;
    subject.require_application()?;
    request_once(grant.asked(), || {
        crate::system_permission::process::request(&subject, grant.into(), cancelled)
    })
}

fn request_once(
    asked: &AtomicBool,
    request: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !asked.swap(true, Ordering::Relaxed) {
        request()?;
    }
    Ok(())
}

impl From<Grant> for maka_agent_facts::interaction::SystemPermissionGrant {
    fn from(grant: Grant) -> Self {
        match grant {
            Grant::Accessibility => Self::Accessibility,
            Grant::ScreenRecording => Self::ScreenRecording,
        }
    }
}

pub(crate) fn require(grant: Grant) -> Result<(), ToolError> {
    let missing = crate::system_permission::missing(&[grant.into()]).map_err(ToolError::Failed)?;
    if missing.is_empty() {
        return Ok(());
    }
    Err(ToolError::Failed(still_missing(
        grant,
        &responsible_application().0,
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

/// The tool error for a missing grant. `permission_required:` is the stable
/// prefix; the rest tells the user which switch to turn on.
pub(crate) fn still_missing(grant: Grant, application: &str) -> String {
    format!(
        "permission_required: {code}; Turn on \"{application}\" in System Settings > \
         Privacy & Security > {pane} before using native Computer Use.",
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
    responsible_process(unsafe { libc::getpid() })
        .ok()
        .map(|(_, path)| path)
}

pub(crate) fn responsible_process(
    process: libc::pid_t,
) -> Result<(libc::pid_t, std::path::PathBuf), String> {
    type Responsible = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    // SAFETY: the private libSystem symbol has this C signature and only observes responsibility.
    let pid = unsafe {
        let symbol = libc::dlsym(
            libc::RTLD_DEFAULT,
            c"responsibility_get_pid_responsible_for_pid".as_ptr(),
        );
        if symbol.is_null() {
            return Err("macOS responsible-process lookup is unavailable".into());
        }
        std::mem::transmute::<*mut libc::c_void, Responsible>(symbol)(process)
    };
    if pid <= 0 {
        return Err(format!(
            "macOS has no responsible process for PID {process}"
        ));
    }
    let path = path_of(pid).ok_or_else(|| format!("Cannot read responsible process PID {pid}"))?;
    Ok((pid, path.into()))
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

pub(crate) fn application_bundle(path: &std::path::Path) -> Option<&std::path::Path> {
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
    fn failed_finite_request_preserves_the_parent_budget_without_retrying() {
        let asked = AtomicBool::new(false);
        let error = request_once(&asked, || Err("finite request reply lost".into())).unwrap_err();
        assert_eq!(error, "finite request reply lost");
        assert!(asked.load(Ordering::Relaxed));
        request_once(&asked, || {
            panic!("a failed request must not be dispatched twice")
        })
        .unwrap();
    }

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
        let text = still_missing(Grant::Accessibility, "Terminal");
        assert!(text.starts_with("permission_required: accessibility; Turn on"));
        assert!(text.contains("Turn on \"Terminal\""));
        assert!(text.contains("Privacy & Security > Accessibility"));
        let text = still_missing(Grant::ScreenRecording, "Maka");
        assert!(text.starts_with("permission_required: screen_recording; Turn on \"Maka\""));
        assert!(text.contains("Screen & System Audio Recording"));
    }
}
