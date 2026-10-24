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

//! One observation deadline, including blocking cleanup in a finite CLI command.
//! The worker is the command itself, not a controller or a second state authority.

use maka_host_runtime::HostError;
use serde::Serialize;
use std::{future::Future, io::Write, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::Instant,
};

tokio::task_local! {
    static DEADLINE: Instant;
    static QUIET_PROGRESS: ();
}

/// An interactive renderer owns its output; operator progress must not corrupt it.
pub(crate) async fn without_progress<T>(work: impl Future<Output = T>) -> T {
    QUIET_PROGRESS.scope((), work).await
}

pub(crate) async fn scope<T>(duration: Duration, work: impl Future<Output = T>) -> T {
    DEADLINE.scope(Instant::now() + duration, work).await
}

pub(crate) fn deadline() -> Option<Instant> {
    DEADLINE.try_with(|deadline| *deadline).ok()
}

pub(crate) fn remaining(limit: Duration) -> Duration {
    deadline()
        .map(|deadline| {
            deadline
                .saturating_duration_since(Instant::now())
                .min(limit)
        })
        .unwrap_or(limit)
}

pub(crate) fn check() -> Result<(), HostError> {
    if remaining(Duration::from_secs(1)).is_zero() {
        return Err("operation deadline reached; query deployment status before recovery".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Download,
    Verify,
    Stage,
    Retire,
    Activate,
    Cleanup,
    ConfirmationPending,
}

pub(crate) fn progress(phase: Phase, completed: Option<u64>, total: Option<u64>) {
    if QUIET_PROGRESS.try_with(|()| ()).is_ok() {
        return;
    }
    #[derive(Serialize)]
    struct Progress {
        phase: Phase,
        #[serde(skip_serializing_if = "Option::is_none")]
        completed: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
    }
    // A closed observer is not a failed mutation. Never panic on a broken pipe.
    if let Ok(value) = serde_json::to_string(&Progress {
        phase,
        completed,
        total,
    }) {
        let _ = writeln!(std::io::stderr().lock(), "MAKA_HOST_PROGRESS {value}");
    }
}

/// Detach only this finite command so the caller can leave while accepted
/// blocking work retains its existing leases. Never terminate a discovered Host.
pub(crate) async fn observe(timeout: Duration, settings_stdin: bool) -> Result<(), HostError> {
    // Leave a small part of the same budget for the timeout diagnostic.
    let deadline = Instant::now() + timeout.saturating_sub(Duration::from_millis(10));
    // Only this observer may be exited at the deadline: it owns no Root or
    // deployment lease. A blocked stdout consumer must not defeat the async
    // timer (or block main while printing its final diagnostic). Detached
    // accepted work keeps its own leases and recovery remains state-based.
    std::thread::Builder::new()
        .name("command-observer-deadline".into())
        .spawn(move || {
            std::thread::sleep(timeout);
            std::process::exit(70);
        })?;
    let result = tokio::time::timeout_at(deadline, async {
        // Read and validate bootstrap input before detaching any work. Incomplete
        // input cannot leave a worker waiting on the caller after this deadline.
        let input = if settings_stdin {
            let bytes = crate::initialize::settings_input().await?;
            crate::initialize::validate_settings_input(&bytes)?;
            Some(bytes)
        } else {
            None
        };
        let mut command = tokio::process::Command::new(std::env::current_exe()?);
        command
            .arg("--operation-worker")
            .args(std::env::args_os().skip(1))
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        #[cfg(unix)]
        // SAFETY: setsid is async-signal-safe and accesses no Rust state.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        #[cfg(windows)]
        command.creation_flags(
            windows_sys::Win32::System::Threading::DETACHED_PROCESS
                | windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP
                | windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB,
        );
        let child = command.spawn();
        #[cfg(windows)]
        let child = match child {
            Err(error) if error.raw_os_error() == Some(5) => {
                // A finite worker can remain in an enclosing Job: stopping this
                // observer does not close somebody else's Job. External Job
                // termination is ordinary crash recovery from committed state.
                // Long-lived Host activation still requires independent ownership
                // and refuses its own breakaway failure; do not weaken that rule.
                command.creation_flags(
                    windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
                        | windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP,
                );
                command.spawn()
            }
            result => result,
        };
        let mut child = child?;
        if let Some(input) = input {
            let mut stdin = child.stdin.take().ok_or("missing command stdin")?;
            stdin.write_all(&input).await?;
            // EOF marks the end of the complete, validated settings document.
            drop(stdin);
        }
        let stdout = child.stdout.take().ok_or("missing command stdout")?;
        let stderr = child.stderr.take().ok_or("missing command stderr")?;
        let (status, (), ()) =
            tokio::try_join!(child.wait(), forward(stdout, false), forward(stderr, true),)?;
        if !status.success() {
            return Err("Host command failed; consult its diagnostic and durable status".into());
        }
        Ok::<_, HostError>(())
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => {
            progress(Phase::ConfirmationPending, None, None);
            Err("Host command observation timed out; background cleanup may continue. Query host status, then reconcile a pending update. No lock was removed or process killed.".into())
        }
    }
}

async fn forward(
    mut input: impl tokio::io::AsyncRead + Unpin,
    stderr: bool,
) -> std::io::Result<()> {
    let mut bytes = [0; 8192];
    loop {
        let count = input.read(&mut bytes).await?;
        if count == 0 {
            return Ok(());
        }
        // Diagnostic consumers can disappear independently of command ownership.
        let result = if stderr {
            std::io::stderr().lock().write_all(&bytes[..count])
        } else {
            std::io::stdout().lock().write_all(&bytes[..count])
        };
        if let Err(error) = result {
            if error.kind() == std::io::ErrorKind::BrokenPipe {
                return Ok(());
            }
            return Err(error);
        }
    }
}
