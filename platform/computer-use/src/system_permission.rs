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

//! The operating system's privacy grants native Computer Use needs.
//!
//! On macOS these are Accessibility and Screen Recording, which belong to
//! the application responsible for the Host. Other platforms need none.

use crate::protocol::{Command, Handle, NativeComputerCall, NativeComputerMethod};
use maka_agent_facts::interaction::SystemPermissionGrant;

#[cfg(target_os = "macos")]
pub(crate) mod application_identity;
#[cfg(all(feature = "native-desktop", target_os = "macos"))]
pub(crate) mod process;

/// Register the installed Host bundle and verify macOS resolves its identity
/// back to that installation. This does not request any privacy permission.
#[cfg(target_os = "macos")]
pub fn register_application(bundle: &std::path::Path) -> Result<(), String> {
    application_identity::register(bundle)
}

/// macOS grants used by this command. Inventory, documentation and browser
/// work remain usable before the user grants native control or capture.
pub fn required(command: &Command) -> &'static [SystemPermissionGrant] {
    use SystemPermissionGrant::{Accessibility, ScreenRecording};
    match command {
        Command::GetApp { .. }
        | Command::Observe {
            handle: Handle::App(_),
            ..
        }
        | Command::NativeComputer {
            call:
                NativeComputerCall::Invoke {
                    operation: NativeComputerMethod::GetAppState,
                    ..
                },
        } => &[Accessibility, ScreenRecording],
        Command::StartAudioRecording { .. } => &[ScreenRecording],
        Command::NativeComputer {
            call:
                NativeComputerCall::Invoke {
                    operation: NativeComputerMethod::ListApps,
                    ..
                },
        } => &[],
        Command::NativeComputer {
            call: NativeComputerCall::Invoke { .. },
        }
        | Command::Action {
            handle: Handle::App(_),
            ..
        }
        | Command::ClipboardRead {
            handle: Handle::App(_),
        }
        | Command::ClipboardReadText {
            handle: Handle::App(_),
        }
        | Command::ClipboardWrite {
            handle: Handle::App(_),
            ..
        }
        | Command::ClipboardWriteText {
            handle: Handle::App(_),
            ..
        } => &[Accessibility],
        _ => &[],
    }
}

/// Whether this Host can observe and request macOS privacy grants.
pub const fn supported() -> bool {
    cfg!(all(feature = "native-desktop", target_os = "macos"))
}

/// The grants native desktop work needs that are not in effect now, checked
/// using non-prompting preflight checks. It can block on the OS, but must
/// never request authorization or enumerate screen content.
pub fn missing(required: &[SystemPermissionGrant]) -> Result<Vec<SystemPermissionGrant>, String> {
    #[cfg(all(feature = "native-desktop", target_os = "macos"))]
    {
        let started = std::time::Instant::now();
        let pid = std::process::id();
        tracing::debug!(pid, ?required, "Native system permission preflight started");
        let result = process::missing(required);
        tracing::debug!(
            pid,
            ?required,
            missing = ?result.as_ref().ok(),
            ok = result.is_ok(),
            elapsed_ms = started.elapsed().as_secs_f64() * 1000.0,
            "Native system permission preflight finished"
        );
        result
    }
    #[cfg(not(all(feature = "native-desktop", target_os = "macos")))]
    {
        let _ = required;
        Ok(Vec::new())
    }
}

/// Asks the operating system to show its own request for each grant, at
/// most once per grant for this Host.
pub fn request(
    grants: &[SystemPermissionGrant],
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<(), String> {
    #[cfg(all(feature = "native-desktop", target_os = "macos"))]
    {
        for grant in grants {
            crate::macos::tcc::ask((*grant).into(), cancelled)?;
        }
        Ok(())
    }
    #[cfg(not(all(feature = "native-desktop", target_os = "macos")))]
    {
        let _ = (grants, cancelled);
        Err("Native macOS system permission requests are unavailable in this Host".into())
    }
}

/// The name System Settings lists for the application the grants belong to.
pub fn application() -> (String, Option<std::path::PathBuf>) {
    #[cfg(all(feature = "native-desktop", target_os = "macos"))]
    {
        crate::macos::tcc::responsible_application()
    }
    #[cfg(not(all(feature = "native-desktop", target_os = "macos")))]
    (String::new(), None)
}

/// The tool failure for grants still missing: one `permission_required:`
/// line for each, naming the switch to turn on.
pub fn failure(grants: &[SystemPermissionGrant], application: &str) -> String {
    #[cfg(all(feature = "native-desktop", target_os = "macos"))]
    {
        grants
            .iter()
            .map(|grant| crate::macos::tcc::still_missing((*grant).into(), application))
            .collect::<Vec<_>>()
            .join("\n")
    }
    #[cfg(not(all(feature = "native-desktop", target_os = "macos")))]
    {
        let _ = (grants, application);
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::AppReference;

    #[test]
    fn browser_setup_and_documentation_do_not_require_native_grants() {
        for input in [
            r#"{"method":"readDocumentation","name":"browser"}"#,
            r#"{"method":"configureCursor","options":{"enabled":false}}"#,
            r#"{"method":"cursorState","options":{}}"#,
            r#"{"method":"listBrowsers","options":{}}"#,
            r#"{"method":"stopAudioRecording"}"#,
        ] {
            let command = serde_json::from_str(input).unwrap();
            assert_eq!(required(&command), &[], "{input}");
        }
        assert_eq!(
            required(&Command::GetApp {
                target: AppReference::Name("Notes".into())
            }),
            &[
                SystemPermissionGrant::Accessibility,
                SystemPermissionGrant::ScreenRecording
            ],
        );
        assert_eq!(
            required(&Command::StartAudioRecording {
                options: Default::default()
            }),
            &[SystemPermissionGrant::ScreenRecording],
        );
    }
}
