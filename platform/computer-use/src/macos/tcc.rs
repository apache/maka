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
//! The first time a grant is missing, the Host asks macOS to show its own
//! request. The Host is long-lived, which the request needs: macOS drops it
//! when the asking process exits. A grant takes effect in the running Host
//! as soon as the user turns it on, so the next call simply passes; see
//! [`Grant::observed`] for how that is observed.

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

    /// Whether the grant is in effect for this Host now, observed with a
    /// real call.
    ///
    /// `AXIsProcessTrusted` and `CGPreflightScreenCaptureAccess` keep their
    /// first answer in a process without a main run loop, such as the Host,
    /// while the APIs themselves follow the grant at once. So a real call
    /// decides: an AX query that macOS does not refuse with
    /// `kAXErrorAPIDisabled`, and a ScreenCaptureKit listing that succeeds.
    fn observed(self) -> bool {
        match self {
            Self::Accessibility => accessibility_enabled(),
            Self::ScreenRecording => screencapturekit::prelude::SCShareableContent::get().is_ok(),
        }
    }

    /// Whether a real call has shown the grant in effect. Later checks trust
    /// it, so native work does not pay for the probe each time; a failure
    /// that shows the grant revoked clears it (see [`explain`]).
    fn confirmed(self) -> &'static AtomicBool {
        static ACCESSIBILITY: AtomicBool = AtomicBool::new(false);
        static SCREEN_RECORDING: AtomicBool = AtomicBool::new(false);
        match self {
            Self::Accessibility => &ACCESSIBILITY,
            Self::ScreenRecording => &SCREEN_RECORDING,
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
                // macOS shows the Screen Recording request at most once; listing
                // shareable content is what enters the application in the
                // System Settings list afterwards. Its failure is the expected
                // answer while the grant is missing.
                let _ = screencapturekit::prelude::SCShareableContent::get();
            }
        }
    }
}

/// Asks the Dock, which always runs, for its role. Without the grant macOS
/// refuses with `kAXErrorAPIDisabled`; any other answer means it let the
/// call through. (The system-wide element is no use here: it answers
/// `kAXErrorCannotComplete` either way.)
fn accessibility_enabled() -> bool {
    use core_foundation::{
        base::{CFRelease, TCFType},
        string::CFString,
    };
    use platform_macos::ax::bindings::{
        AXUIElementCopyAttributeValue, AXUIElementCreateApplication,
        AXUIElementSetMessagingTimeout, kAXErrorAPIDisabled,
    };
    let Some(pid) = process_with_path(DOCK).or_else(|| process_with_path(FINDER)) else {
        return platform_macos::permissions::status::accessibility_granted();
    };
    let attribute = CFString::new("AXRole");
    // SAFETY: the application element and any copied value are owned here
    // and released before returning.
    unsafe {
        let application = AXUIElementCreateApplication(pid);
        if application.is_null() {
            return platform_macos::permissions::status::accessibility_granted();
        }
        // A hung or restarting Dock must not hold native work for the
        // default AX timeout.
        AXUIElementSetMessagingTimeout(application, 0.5);
        let mut value = std::ptr::null();
        let status =
            AXUIElementCopyAttributeValue(application, attribute.as_concrete_TypeRef(), &mut value);
        if !value.is_null() {
            CFRelease(value);
        }
        CFRelease(application.cast());
        status != kAXErrorAPIDisabled
    }
}

const DOCK: &str = "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock";
const FINDER: &str = "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder";

/// The pid of a process of this user running this executable. Each
/// logged-in user has their own Dock, and another session's would not
/// answer for this one.
fn process_with_path(executable: &str) -> Option<libc::pid_t> {
    // SAFETY: getuid cannot fail.
    let user = unsafe { libc::getuid() };
    // SAFETY: a null buffer asks for the count; the second call writes at
    // most the buffer's size in bytes.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return None;
    }
    let mut pids = vec![0 as libc::pid_t; count as usize + 64];
    let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
    // SAFETY: as above.
    let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    if count <= 0 {
        return None;
    }
    pids.truncate(count as usize);
    pids.into_iter()
        .filter(|pid| *pid > 0 && owner_of(*pid) == Some(user))
        .find(|pid| path_of(*pid).is_some_and(|path| path == executable))
}

fn owner_of(pid: libc::pid_t) -> Option<libc::uid_t> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the buffer holds one proc_bsdinfo, whose size is passed; the
    // value is read only when the call filled all of it.
    unsafe {
        let written = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        );
        (written == size).then(|| info.assume_init().pbi_uid)
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

pub(crate) fn require(grant: Grant) -> Result<(), ToolError> {
    if grant.confirmed().load(Ordering::Relaxed) {
        return Ok(());
    }
    if grant.observed() {
        grant.confirmed().store(true, Ordering::Relaxed);
        return Ok(());
    }
    let asked = !grant.asked().swap(true, Ordering::Relaxed);
    if asked {
        grant.request();
    }
    Err(ToolError::Failed(message(
        grant,
        &responsible_application(),
        asked,
    )))
}

/// An ordinary failure that a revoked grant can cause is checked again with
/// a real call and, when the grant is gone, reported as the missing grant.
/// Other errors, including unconfirmed effects and cleanup, keep their
/// meaning.
pub(crate) fn explain(error: ToolError) -> ToolError {
    let Some(grant) = suspect(&error) else {
        return error;
    };
    grant.confirmed().store(false, Ordering::Relaxed);
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
fn message(grant: Grant, application: &str, asked: bool) -> String {
    let request = if asked {
        "macOS is showing its permission request now. "
    } else {
        ""
    };
    format!(
        "permission_required: {code}; {request}Turn on \"{application}\" in System Settings > \
         Privacy & Security > {pane}, then retry. If it is not listed, reopen System Settings, \
         or add it with the + button.",
        code = grant.code(),
        pane = grant.pane(),
    )
}

/// The name macOS shows for the process that holds this Host's grants.
fn responsible_application() -> String {
    responsible_path()
        .map(|path| application_name(&path))
        .unwrap_or_else(|| "the application that started Maka".into())
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
    path.ancestors()
        .find(|ancestor| {
            ancestor
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
        .or(Some(path))
        .and_then(|path| path.file_stem())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "the application that started Maka".into())
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
    fn finds_a_running_process_by_its_executable() {
        let own = path_of(std::process::id() as libc::pid_t).expect("own path");
        assert_eq!(process_with_path(&own).map(path_of), Some(Some(own)));
        assert_eq!(process_with_path("/nonexistent/executable"), None);
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
