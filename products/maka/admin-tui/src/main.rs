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
use maka_admin_tui::{
    ControlPlane, ControlPlaneConfig, app_options, resolve_maka_binary, terminal,
};
use nsh_engine::HostChannel;
use std::{path::PathBuf, process::ExitCode, time::Duration};

#[derive(Parser)]
#[command(
    name = "maka-admin",
    version,
    about = "Maka Control Plane TUI — manage Hosts, Relays, Remote Access, Peers & Logs"
)]
struct Args {
    /// Additional or preferred State Root directory to focus.
    #[arg(long, value_name = "DIRECTORY")]
    root: Option<PathBuf>,
    /// Preferred 64-hex Root ID to select on startup.
    #[arg(long)]
    root_id: Option<String>,
    /// Path to the maka CLI executable used for managed deployment operations.
    #[arg(long, value_name = "EXECUTABLE")]
    maka: Option<PathBuf>,
    /// Leave mouse events to the terminal (enables native terminal text selection).
    #[arg(long)]
    no_mouse: bool,
    /// Periodic status refresh interval in milliseconds.
    #[arg(long, default_value_t = 3_000, value_parser = clap::value_parser!(u64).range(1_000..=60_000))]
    refresh_ms: u64,
}

fn main() -> ExitCode {
    let args = Args::parse();
    if let Err(error) = run(args) {
        eprintln!("maka-admin: {error}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

fn run(args: Args) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("maka-admin-rt")
        .build()
        .map_err(|e| format!("failed to start async runtime: {e}"))?;

    let host_channel = HostChannel::new();
    let control = ControlPlane::start(
        ControlPlaneConfig {
            extra_root: args.root,
            preferred_root_id: args.root_id,
            maka_binary: resolve_maka_binary(args.maka),
            refresh_interval: Duration::from_millis(args.refresh_ms),
        },
        host_channel.clone(),
        runtime.handle(),
    );

    let tui_result = terminal::run_tui(app_options(host_channel), args.no_mouse);

    // Ensure local RelayServer and log watchers shut down cleanly before exiting.
    runtime.block_on(control.shutdown());

    tui_result.map_err(|e| e.to_string())
}
