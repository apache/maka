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

//! Finite metadata/privacy roles. None initializes the parent's native runtime.

use super::{ENTRY, PROTOCOL};
use maka_agent_facts::{
    capability::CallResult, interaction::SystemPermissionGrant, tools::ToolError,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    ffi::OsString,
    io::{self, Read, Write},
    process::{ExitCode, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, Copy)]
pub(crate) enum MacRole {
    PermissionStatus,
    PermissionRequest(SystemPermissionGrant),
    ListApps,
    ListWindows { pid: Option<u32> },
}

impl MacRole {
    fn arguments(self) -> Vec<OsString> {
        let arguments = match self {
            Self::PermissionStatus => vec!["--macos-permission-status"],
            Self::PermissionRequest(SystemPermissionGrant::Accessibility) => {
                vec!["--macos-permission-request", "accessibility"]
            }
            Self::PermissionRequest(SystemPermissionGrant::ScreenRecording) => {
                vec!["--macos-permission-request", "screen_recording"]
            }
            Self::ListApps => vec!["--macos-list-apps"],
            Self::ListWindows { .. } => vec!["--macos-list-windows"],
        };
        let mut arguments: Vec<OsString> = arguments.into_iter().map(OsString::from).collect();
        if let Self::ListWindows { pid: Some(pid) } = self {
            arguments.push(pid.to_string().into());
        }
        arguments
    }

    fn parse(arguments: &[OsString]) -> Option<Result<Self, String>> {
        let first = arguments.first()?.to_str()?;
        let role = match first {
            "--macos-permission-status" if arguments.len() == 1 => Self::PermissionStatus,
            "--macos-list-apps" if arguments.len() == 1 => Self::ListApps,
            "--macos-list-windows" if arguments.len() == 1 => Self::ListWindows { pid: None },
            "--macos-list-windows" if arguments.len() == 2 => {
                let Some(Ok(pid)) = arguments[1].to_str().map(str::parse::<u32>) else {
                    return Some(Err("macOS window inventory requires a valid PID".into()));
                };
                Self::ListWindows { pid: Some(pid) }
            }
            "--macos-permission-request" if arguments.len() == 2 => match arguments[1].to_str() {
                Some("accessibility") => {
                    Self::PermissionRequest(SystemPermissionGrant::Accessibility)
                }
                Some("screen_recording") => {
                    Self::PermissionRequest(SystemPermissionGrant::ScreenRecording)
                }
                _ => {
                    return Some(Err(
                        "macOS permission request requires one supported grant".into()
                    ));
                }
            },
            name if name.starts_with("--macos-") => {
                return Some(Err("invalid finite macOS desktop role arguments".into()));
            }
            _ => return None,
        };
        Some(Ok(role))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    protocol: u32,
    result: Result<Value, String>,
}

/// Blocking owned-child I/O: async callers must use spawn_blocking. Every call
/// observes a fresh process; no observation is cached or treated as execution.
pub(crate) fn macos_finite(
    role: MacRole,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<Value, ToolError> {
    if cancelled() {
        return Err(failed("finite macOS operation cancelled before dispatch"));
    }
    let request = matches!(role, MacRole::PermissionRequest(_));
    let mut child = std::process::Command::new(std::env::current_exe().map_err(failed)?)
        .arg(ENTRY)
        .args(role.arguments())
        .stdin(if request {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(failed)?;
    // Keep the request's liveness writer out of Child: wait() closes Child.stdin.
    // Only this invocation owns it; parent death closes it in the kernel.
    let _liveness = child.stdin.take();
    let stdout = child.stdout.take().expect("piped finite worker stdout");
    let stderr = child.stderr.take().expect("piped finite worker stderr");
    std::thread::scope(|scope| {
        let stdout = scope.spawn(move || read_output(stdout, 16 * 1024 * 1024));
        let stderr = scope.spawn(move || read_output(stderr, 64 * 1024));
        // An explicit request can be waiting on the human's native OS dialog.
        let deadline = (!request).then(|| Instant::now() + Duration::from_secs(30));
        let status = loop {
            let cancelled = cancelled();
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None)
                    if !cancelled && deadline.is_none_or(|deadline| Instant::now() < deadline) =>
                {
                    std::thread::sleep(Duration::from_millis(10))
                }
                observation => {
                    let reason = match observation {
                        Err(error) => format!("observe finite macOS worker exit: {error}"),
                        _ if cancelled => "finite macOS operation cancelled".into(),
                        _ => "finite macOS worker timed out".into(),
                    };
                    let killed = child.kill();
                    let reaped = child.wait();
                    break Err(failed(format!(
                        "{reason}; termination={killed:?}; reap={reaped:?}"
                    )));
                }
            }
        };
        let stdout = stdout
            .join()
            .map_err(|_| failed("finite macOS stdout reader panicked"))?
            .map_err(failed)?;
        let stderr = stderr
            .join()
            .map_err(|_| failed("finite macOS stderr reader panicked"))?
            .map_err(failed)?;
        let status = status?;
        if !status.success() {
            return Err(failed(format!(
                "finite macOS worker exited with {status}: {}",
                String::from_utf8_lossy(&stderr).trim()
            )));
        }
        let reply: Reply = serde_json::from_slice(&stdout)
            .map_err(|error| failed(format!("invalid finite macOS worker reply: {error}")))?;
        if reply.protocol != PROTOCOL {
            return Err(failed("finite macOS worker protocol mismatch"));
        }
        reply.result.map_err(failed)
    })
    .map_err(|error| {
        if request {
            failed(format!(
                "system_permission_request_outcome_unknown: {error}"
            ))
        } else {
            error
        }
    })
}

fn failed(message: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(message.to_string())
}

fn read_output(mut input: impl Read, limit: usize) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            return Ok(result);
        }
        if result.len() + count > limit {
            return Err(io::Error::other(
                "finite macOS worker output exceeds its bound",
            ));
        }
        result.extend_from_slice(&buffer[..count]);
    }
}

pub(super) fn bootstrap(arguments: &[OsString]) -> Option<ExitCode> {
    let role = MacRole::parse(arguments)?;
    let result = role.and_then(|role| match role {
        MacRole::PermissionStatus => crate::system_permission::process::finite_status(),
        MacRole::PermissionRequest(grant) => {
            watch_request_owner()?;
            crate::system_permission::process::finite_request(grant)
        }
        MacRole::ListApps | MacRole::ListWindows { .. } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?;
            runtime.block_on(inventory(role))
        }
    });
    let response = Reply {
        protocol: PROTOCOL,
        result,
    };
    let output = std::io::stdout();
    let mut output = output.lock();
    let written = serde_json::to_writer(&mut output, &response)
        .map_err(io::Error::other)
        .and_then(|_| output.flush());
    Some(match written {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Maka finite macOS worker: {error}");
            ExitCode::FAILURE
        }
    })
}

fn watch_request_owner() -> Result<(), String> {
    std::thread::Builder::new()
        .name("maka-permission-owner".into())
        .spawn(|| {
            // No commands are accepted. EOF, I/O failure or unexpected data all
            // end this child, even when its main thread is inside an OS modal.
            let _ = std::io::stdin().lock().read(&mut [0]);
            // SAFETY: this single-purpose child owns no parent resources. Avoid
            // exit handlers that could wait on the blocked native main thread.
            unsafe { libc::_exit(1) }
        })
        .map(|_| ())
        .map_err(|error| format!("Cannot watch system permission request owner: {error}"))
}

async fn inventory(role: MacRole) -> Result<Value, String> {
    use cua_driver_sdk::{CuaDriver, HostSessionOptions, SessionPermissionMode};
    let (name, input) = match role {
        MacRole::ListApps => ("list_apps", serde_json::json!({})),
        MacRole::ListWindows { pid } => (
            "list_windows",
            pid.map_or_else(
                || serde_json::json!({}),
                |pid| serde_json::json!({"pid": pid}),
            ),
        ),
        _ => unreachable!(),
    };
    // Deliberately call the SDK, not Maka's Driver::invoke inventory route:
    // this finite process may query CG/AX but must never recursively fork.
    let driver = CuaDriver::create_configured(crate::driver::native_configuration(false))
        .map_err(|error| error.to_string())?;
    let session = driver
        .create_host_session(HostSessionOptions {
            public_session: format!("maka-inventory-{}", uuid::Uuid::new_v4()),
            mode: SessionPermissionMode::Standard,
            capability_manifest_path: None,
        })
        .map_err(|error| error.to_string())?;
    let result = async {
        session
            .start_session(cua_driver_contract::StartSessionInput {
                session: None,
                capture_scope: None,
                cursor_theme: None,
                cursor_motion: None,
            })
            .await
            .map_err(|error| error.to_string())?;
        let result = session
            .call_tool(name.into(), input.to_string())
            .await
            .map_err(|error| error.to_string())?;
        if result.is_error {
            return Err(format!(
                "{}: {}",
                result.error_code.as_deref().unwrap_or("inventory_failed"),
                result.text
            ));
        }
        let result: CallResult =
            serde_json::from_str(&result.raw_json).map_err(|error| error.to_string())?;
        let value = result
            .structured_content
            .ok_or("finite inventory returned no metadata")?;
        // Keep the finite protocol limited to the SDK's inventory contracts.
        match role {
            MacRole::ListApps => serde_json::to_value(
                serde_json::from_value::<cua_driver_contract::ListAppsOutput>(value)
                    .map_err(|error| error.to_string())?,
            ),
            MacRole::ListWindows { .. } => serde_json::to_value(
                serde_json::from_value::<cua_driver_contract::ListWindowsOutput>(value)
                    .map_err(|error| error.to_string())?,
            ),
            _ => unreachable!(),
        }
        .map_err(|error| error.to_string())
    }
    .await;
    let ended = session
        .end_session(cua_driver_contract::EndSessionInput { session: None })
        .await;
    session.close();
    let stopped = driver.shutdown().await;
    if let Err(error) = ended {
        return Err(format!(
            "finite inventory result={result:?}; end session: {error}"
        ));
    }
    if let Err(error) = stopped {
        return Err(format!(
            "finite inventory result={result:?}; shutdown: {error}"
        ));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn system_permission_owner_eof_exits_owned_child() {
        use std::io::BufRead;
        const CHILD: &str = "MAKA_TEST_SYSTEM_PERMISSION_OWNER_EOF";
        const READY: &str = "maka-system-permission-owner-ready";
        if std::env::var_os(CHILD).is_some() {
            watch_request_owner().unwrap();
            println!("{READY}");
            std::io::stdout().flush().unwrap();
            // Keep this test-only process alive for EOF, with a failsafe if the
            // observer itself crashes while testing a broken owner guard.
            std::thread::sleep(Duration::from_secs(30));
            std::process::exit(99);
        }

        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let module = module_path!().split_once("::").unwrap().1;
        let mut child = OwnedChild(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    &format!("{module}::system_permission_owner_eof_exits_owned_child"),
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let liveness = child.0.stdin.take().unwrap();
        let stdout = child.0.stdout.take().unwrap();
        let (ready, receive) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines() {
                if line.unwrap().contains(READY) {
                    ready.send(()).unwrap();
                    return;
                }
            }
        });
        receive
            .recv_timeout(Duration::from_secs(10))
            .expect("owned child must install its guard before EOF");
        reader.join().unwrap();
        assert!(child.0.try_wait().unwrap().is_none());
        drop(liveness);
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "owner EOF must stop its child");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(status.code(), Some(1));
    }
}
