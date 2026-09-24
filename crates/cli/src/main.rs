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
mod args;
mod candidate;
mod code;
mod deployment;
mod distribution;
mod endpoint;
mod host_client;
mod initialize;
mod operation;
mod sandbox;
mod serve;
mod signals;
mod stdio;
#[cfg(windows)]
mod windows;

fn main() -> std::process::ExitCode {
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
            maka_runtime_host::sandbox::windows::READ_PREPARATION,
        ))
    {
        let mut args = std::env::args_os().skip(2);
        let result = match (args.next(), args.next()) {
            (Some(root), None) => maka_runtime_host::sandbox::windows::prepare_default_reads(
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
            role @ (maka_process::bootstrap::RUNNER | maka_process::bootstrap::ELEVATED_SETUP),
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
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(run()),
        Err(error) => {
            eprintln!("runtime startup: {error}");
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
            let request = maka_process::bootstrap::receive_administrative::<
                maka_runtime_host::sandbox::windows::Provision,
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

async fn run() -> std::process::ExitCode {
    let cli = args::Cli::parse();
    let error_exit = cli.error_exit_code();
    let result = cli.run().await;
    match result {
        Err(error) => {
            eprintln!("{error}");
            // Let Tokio wait for accepted blocking work to finish before the OS
            // releases its leases. A reported timeout does not cancel that work.
            std::process::ExitCode::from(error_exit)
        }
        Ok(exit) => exit,
    }
}
