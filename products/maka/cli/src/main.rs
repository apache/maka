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

use clap::Parser;
mod access;
mod acp;
mod application;
mod args;
mod candidate;
mod code;
mod deployment;
mod desktop;
mod distribution;
mod endpoint;
mod host_client;
mod initialize;
mod logging;
mod operation;
mod sandbox;
mod serve;
mod signals;
mod startup;
#[cfg(test)]
mod tests;
#[cfg(windows)]
mod windows;

fn main() -> std::process::ExitCode {
    if let Some(exit) = maka_computer_use::cursor::bootstrap() {
        return exit;
    }
    if let Some(exit) = maka_computer_use::desktop::bootstrap() {
        return exit;
    }
    maka_computer_use::desktop::register_windows_helper(distribution::windows_helper);
    #[cfg(target_os = "linux")]
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new(
            maka_process::network_namespace::HELPER,
        ))
    {
        let mut args = std::env::args_os().skip(2);
        let result = match (
            args.next()
                .and_then(|fd| fd.to_str().and_then(|fd| fd.parse().ok())),
            args.next(),
        ) {
            (Some(fd), Some(executable)) => {
                // This branch runs before the runtime or any worker thread.
                // The only inherited non-stdio fd belongs to trusted bootstrap.
                unsafe {
                    maka_process::network_namespace::enter(
                        fd,
                        std::path::Path::new(&executable),
                        args.collect(),
                    )
                }
            }
            _ => Err(std::io::Error::other("invalid network namespace bootstrap")),
        };
        if let Err(error) = result {
            eprintln!("sandbox network setup: {error}");
        }
        return std::process::ExitCode::FAILURE;
    }
    #[cfg(windows)]
    // Set once before threads or helpers start: native startup failures must
    // produce exit status, not a modal dialog that blocks a headless Host.
    unsafe {
        use windows_sys::Win32::System::Diagnostics::Debug::{
            SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SetErrorMode,
        };
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    }
    #[cfg(windows)]
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new(
            maka_host_runtime::sandbox::windows::READ_PREPARATION,
        ))
    {
        let mut args = std::env::args_os().skip(2);
        let result = match (args.next(), args.next()) {
            (Some(root), None) => maka_host_runtime::sandbox::windows::prepare_default_reads(
                std::path::Path::new(&root),
            ),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid read preparation root",
            )),
        };
        return match result {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("sandbox read preparation: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    #[cfg(windows)]
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new(
            maka_process::bootstrap::DESKTOP_BOOTSTRAP,
        ))
    {
        return match unsafe { maka_process::bootstrap::serve_desktop() } {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("desktop preparation: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    #[cfg(windows)]
    {
        let role = std::env::args_os().nth(1);
        let role = role.as_deref().and_then(std::ffi::OsStr::to_str);
        if let Some(
            role @ (maka_process::bootstrap::RUNNER
            | maka_process::bootstrap::MXC_HELPER
            | maka_process::bootstrap::ELEVATED_SETUP),
        ) = role
        {
            return match sandbox_helper(role) {
                Ok(()) => std::process::ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("sandbox helper: {error}");
                    std::process::ExitCode::FAILURE
                }
            };
        }
    }
    let cli = args::Cli::parse();
    #[cfg(target_os = "linux")]
    if cli.is_terminal_shell()
        && std::path::Path::new("/dev/dxg").exists()
        && [
            "GALLIUM_DRIVER",
            "MESA_LOADER_DRIVER_OVERRIDE",
            "LIBGL_ALWAYS_SOFTWARE",
            "LIBGL_ALWAYS_INDIRECT",
        ]
        .iter()
        .all(|name| std::env::var_os(name).is_none())
    {
        // WSL's GPU bridge is available; prefer it over Mesa's software default.
        // SAFETY: This synchronous entry precedes logging, Tokio and the UI/GPU.
        // Normal cursor/desktop bootstraps only register executable/resolver
        // state; their helper paths return from main instead of reaching here.
        // Terminal-shell argument parsing starts no workers. No other thread
        // can read the environment while this process-local default is set.
        unsafe { std::env::set_var("GALLIUM_DRIVER", "d3d12") };
    }
    let logging = if cli.logs_to_stderr() {
        logging::initialize()
    } else if cli.is_terminal_shell() {
        logging::initialize_terminal_interaction()
    } else {
        Ok(())
    };
    if let Err(error) = logging {
        eprintln!("logging startup: {error}");
        return std::process::ExitCode::FAILURE;
    }
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(run(cli)),
        Err(error) => {
            if cli.is_terminal_shell() {
                report_terminal_error(format!("runtime startup: {error}"));
            } else {
                eprintln!("runtime startup: {error}");
            }
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(windows)]
fn sandbox_helper(role: &str) -> std::io::Result<()> {
    let mut args = std::env::args().skip(2);
    let invalid =
        || std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid helper endpoint");
    let endpoint = args
        .next()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    let host = args
        .next()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    if args.next().is_some() {
        return Err(invalid());
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            if role == maka_process::bootstrap::RUNNER {
                return maka_process::bootstrap::serve_runner(endpoint, host).await;
            }
            if role == maka_process::bootstrap::MXC_HELPER {
                return maka_process::bootstrap::serve_mxc(endpoint, host).await;
            }
            let request = maka_process::bootstrap::receive_administrative::<
                maka_host_runtime::sandbox::windows::Provision,
            >(endpoint, host)
            .await?;
            // This single-purpose process owns accepted setup through its
            // durable commit, independently of the parent's connection.
            let response = request
                .value
                .apply(&request.caller)
                .map_err(|error| error.to_string());
            request.respond(&response).await
        })
}

fn report_terminal_error(error: String) {
    use std::io::Write;

    let (sent, received) = std::sync::mpsc::sync_channel(1);
    if std::thread::Builder::new()
        .name("maka-terminal-diagnostic".into())
        .spawn(move || {
            let result = writeln!(std::io::stderr().lock(), "maka terminal-shell: {error}");
            let _ = sent.send(result);
        })
        .is_ok()
    {
        // stderr can share the same blocked terminal as stdout. Diagnostic
        // delivery must not hold the already closed client scope alive.
        let _ = received.recv_timeout(std::time::Duration::from_millis(100));
    }
}

async fn run(cli: args::Cli) -> std::process::ExitCode {
    let error_exit = cli.error_exit_code();
    let terminal = cli.is_terminal_shell();
    let result = cli.run().await;
    match result {
        Err(error) => {
            if terminal {
                report_terminal_error(error.to_string());
            } else {
                eprintln!("{error}");
            }
            // Let Tokio wait for accepted blocking work to finish before the OS
            // releases its leases. A reported timeout does not cancel that work.
            std::process::ExitCode::from(error_exit)
        }
        Ok(exit) => exit,
    }
}
