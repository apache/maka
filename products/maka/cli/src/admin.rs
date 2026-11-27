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

use clap::Args as ClapArgs;
use maka_host_runtime::HostError;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(ClapArgs)]
pub(super) struct Args {
    /// Additional or preferred State Root directory to focus.
    #[arg(long, value_name = "DIRECTORY")]
    root: Option<PathBuf>,
    /// Preferred 64-hex Root ID to select on startup.
    #[arg(long)]
    root_id: Option<String>,
    /// Leave mouse events to the terminal (enables native text selection).
    #[arg(long)]
    no_mouse: bool,
    /// Periodic status refresh interval in milliseconds.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1_000..=60_000))]
    refresh_ms: Option<u64>,
}

impl Args {
    pub(super) async fn run(self) -> Result<ExitCode, HostError> {
        let launcher = std::env::current_exe()?.canonicalize()?;
        let binary = resolve_admin_binary(&launcher);
        let mut command = std::process::Command::new(&binary);
        push_kv(&mut command, "--maka", launcher.as_os_str());
        if let Some(root) = &self.root {
            push_kv(&mut command, "--root", root.as_os_str());
        }
        if let Some(root_id) = &self.root_id {
            push_kv(&mut command, "--root-id", root_id.as_ref());
        }
        if self.no_mouse {
            command.arg("--no-mouse");
        }
        if let Some(refresh_ms) = self.refresh_ms {
            command.arg(format!("--refresh-ms={refresh_ms}"));
        }

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let error = command.exec();
            Err(format!(
                "could not launch {}: {error} (build maka-admin with cargo build -p maka-admin-tui)",
                binary.display()
            )
            .into())
        }
        #[cfg(not(unix))]
        {
            let status = command.status().map_err(|error| {
                format!(
                    "could not launch {}: {error} (build maka-admin with cargo build -p maka-admin-tui)",
                    binary.display()
                )
            })?;
            Ok(ExitCode::from(status.code().unwrap_or(1) as u8))
        }
    }
}

fn push_kv(command: &mut std::process::Command, flag: &str, value: &std::ffi::OsStr) {
    let mut arg = OsString::from(flag);
    arg.push("=");
    arg.push(value);
    command.arg(arg);
}

fn resolve_admin_binary(launcher: &Path) -> PathBuf {
    let bin = if cfg!(windows) {
        "maka-admin.exe"
    } else {
        "maka-admin"
    };
    let sibling = launcher.with_file_name(bin);
    if sibling.is_file() {
        return sibling;
    }
    #[cfg(target_os = "macos")]
    {
        let bundled = launcher.with_file_name("Maka.app/Contents/MacOS/maka-admin");
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from(bin)
}
