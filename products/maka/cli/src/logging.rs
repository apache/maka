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

//! Process logging belongs to executable entry, before runtime/store startup.

pub(super) fn initialize() -> Result<(), maka_host_runtime::HostError> {
    tracing_subscriber::fmt()
        .with_max_level(tracing_subscriber::filter::LevelFilter::WARN)
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .try_init()
}

/// Task-owned passive extension RPC metadata only. The extension bootstrap precedes
/// normal logging, and stdout must remain the exact extension-message protocol.
pub(super) fn initialize_extension_browser_trace_if_requested() {
    if !extension_browser_trace_requested(
        std::env::var_os("MAKA_EXTENSION_RPC_TRACE").as_deref(),
        std::env::args_os().nth(1).as_deref(),
    ) {
        return;
    }
    if initialize_extension_browser_trace_subscriber().is_err() {
        // Collection failure invalidates the experiment, not extension behavior.
        eprintln!("extension RPC phase trace subscriber unavailable");
    }
}

fn initialize_extension_browser_trace_subscriber() -> Result<(), maka_host_runtime::HostError> {
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
    let targets = tracing_subscriber::filter::Targets::new().with_target(
        "maka::extension_rpc_phase",
        tracing_subscriber::filter::LevelFilter::TRACE,
    );
    tracing_subscriber::fmt()
        .with_max_level(tracing_subscriber::filter::LevelFilter::TRACE)
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .finish()
        .with(targets)
        .try_init()?;
    Ok(())
}

fn extension_browser_trace_requested(
    value: Option<&std::ffi::OsStr>,
    origin: Option<&std::ffi::OsStr>,
) -> bool {
    value == Some(std::ffi::OsStr::new("1"))
        && origin
            .and_then(std::ffi::OsStr::to_str)
            .is_some_and(|origin| origin.starts_with("chrome-extension://"))
}

/// Explicit terminal diagnostics stay in a file and include no text or keys.
pub(super) fn initialize_terminal_interaction() -> Result<(), maka_host_runtime::HostError> {
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

    let Some(path) = std::env::var_os("MAKA_TERMINAL_INTERACTION_LOG") else {
        return Ok(());
    };
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let level = tracing_subscriber::filter::LevelFilter::DEBUG;
    let targets = tracing_subscriber::filter::Targets::new()
        .with_target("nsh::interaction", level)
        .with_target("nsh::scroll", level);
    tracing_subscriber::fmt()
        .with_max_level(level)
        .with_ansi(false)
        .with_writer(std::sync::Mutex::new(file))
        .finish()
        .with(targets)
        .try_init()?;
    Ok(())
}

/// Dedicated Host processes keep stderr attached through final error reporting
/// and runtime shutdown. The caller supplies an already validated append file.
pub(super) fn capture(file: std::fs::File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::fd::{AsRawFd, IntoRawFd};
        // A caller may have started with stderr closed, so opening the capture
        // can itself allocate fd 2. Transfer that descriptor instead of closing
        // it when File drops, and give it ordinary stdio inheritance semantics.
        if file.as_raw_fd() == libc::STDERR_FILENO {
            // SAFETY: the owned file is the live stderr descriptor.
            if unsafe { libc::fcntl(libc::STDERR_FILENO, libc::F_SETFD, 0) } == -1 {
                return Err(std::io::Error::last_os_error());
            }
            let _ = file.into_raw_fd();
            return Ok(());
        }
        // SAFETY: both descriptors are valid; dup2 leaves stderr owning its own
        // reference after the original File is dropped.
        if unsafe { libc::dup2(file.as_raw_fd(), libc::STDERR_FILENO) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Console::{STD_ERROR_HANDLE, SetStdHandle};
        // SetStdHandle borrows the handle. Statics are not dropped at shutdown;
        // the OS closes it after the last process error has been written.
        static STDERR: std::sync::OnceLock<std::io::Result<std::fs::File>> =
            std::sync::OnceLock::new();
        STDERR
            .get_or_init(|| {
                // SAFETY: STDERR retains the owned file until process exit.
                if unsafe { SetStdHandle(STD_ERROR_HANDLE, file.as_raw_handle()) } == 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(file)
                }
            })
            .as_ref()
            .map(|_| ())
            .map_err(|error| std::io::Error::new(error.kind(), error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use sqlx::{ConnectOptions, Connection};
    use std::{process::Command, time::Duration};

    #[test]
    fn extension_rpc_phase_trace_reaches_stderr_without_other_targets_or_stdout() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "logging::tests::extension_rpc_trace_worker",
                "--nocapture",
            ])
            .env("MAKA_LOGGING_EXTENSION_RPC_PROBE", "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        let stdout = String::from_utf8(output.stdout).unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stdout.contains("stdout-protocol-guard"));
        assert!(!stdout.contains("EXTENSION_TRACE_SENTINEL"));
        assert!(stderr.contains("EXTENSION_TRACE_SENTINEL"), "{stderr}");
        assert!(!stderr.contains("UNRELATED_TRACE_SENTINEL"), "{stderr}");
        assert!(!stderr.contains('\u{1b}'), "{stderr}");
    }

    #[test]
    fn extension_rpc_trace_worker() {
        if std::env::var_os("MAKA_LOGGING_EXTENSION_RPC_PROBE").is_none() {
            return;
        }
        super::initialize_extension_browser_trace_subscriber().unwrap();
        log::trace!(target:"maka::extension_rpc_phase", "EXTENSION_TRACE_SENTINEL");
        log::trace!(target:"unrelated_extension_trace_target", "UNRELATED_TRACE_SENTINEL");
        println!("stdout-protocol-guard");
    }

    #[test]
    fn extension_rpc_trace_is_exact_opt_in_and_extension_bootstrap_only() {
        use std::ffi::OsStr;
        for (value, origin, expected) in [
            (None, Some("chrome-extension://fixture/"), false),
            (Some("0"), Some("chrome-extension://fixture/"), false),
            (Some("true"), Some("chrome-extension://fixture/"), false),
            (Some("1"), None, false),
            (Some("1"), Some("run"), false),
            (Some("1"), Some("https://fixture.invalid/"), false),
            (Some("1"), Some("chrome-extension://fixture/"), true),
        ] {
            assert_eq!(
                super::extension_browser_trace_requested(
                    value.map(OsStr::new),
                    origin.map(OsStr::new)
                ),
                expected,
                "value={value:?}, origin={origin:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn capture_keeps_the_file_open_when_stderr_started_closed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("stderr.log");
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "logging::tests::closed_stderr_worker",
                "--nocapture",
            ])
            .env("MAKA_LOGGING_CLOSED_STDERR", &path)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            std::fs::read(path).unwrap(),
            b"captured after closed stderr\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn closed_stderr_worker() {
        use std::os::fd::AsRawFd;
        let Some(path) = std::env::var_os("MAKA_LOGGING_CLOSED_STDERR") else {
            return;
        };
        // SAFETY: this dedicated subprocess owns its standard descriptors.
        assert_eq!(unsafe { libc::close(libc::STDERR_FILENO) }, 0);
        let file = std::fs::File::create(path).unwrap();
        assert_eq!(file.as_raw_fd(), libc::STDERR_FILENO);
        super::capture(file).unwrap();
        eprintln!("captured after closed stderr");
    }

    #[test]
    fn sqlx_warnings_reach_stderr_without_debug_queries() {
        for (mode, expected) in [("slow", true), ("ordinary", false)] {
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "logging::tests::sqlx_worker", "--nocapture"])
                .env("MAKA_LOGGING_SQLX_PROBE", mode)
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            let stdout = String::from_utf8(output.stdout).unwrap();
            assert!(stdout.contains("query completed"));
            assert!(!stdout.contains("WARN") && !stdout.contains("host-log-sqlx-probe"));
            let stderr = String::from_utf8(output.stderr).unwrap();
            assert_eq!(
                stderr.contains("host-log-sqlx-probe"),
                expected,
                "{stderr:?}"
            );
            if expected {
                assert!(
                    stderr.contains("WARN") && stderr.contains("sqlx::query"),
                    "{stderr}"
                );
            }
            assert!(
                !stderr.contains('\u{1b}'),
                "log output must not contain ANSI styling"
            );
        }
    }

    #[test]
    fn sqlx_worker() {
        let Ok(mode) = std::env::var("MAKA_LOGGING_SQLX_PROBE") else {
            return;
        };
        super::initialize().unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let options = sqlx::sqlite::SqliteConnectOptions::new()
                    .in_memory(true)
                    .log_statements(log::LevelFilter::Debug)
                    .log_slow_statements(
                        log::LevelFilter::Warn,
                        if mode == "slow" {
                            Duration::ZERO
                        } else {
                            Duration::MAX
                        },
                    );
                let mut connection = sqlx::SqliteConnection::connect_with(&options)
                    .await
                    .unwrap();
                let value: String = sqlx::query_scalar("SELECT 'host-log-sqlx-probe'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
                assert_eq!(value, "host-log-sqlx-probe");
                connection.close().await.unwrap();
            });
        println!("query completed");
    }
}
