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

//! Terminal-owned modes enter before the desktop's AppKit startup.

#[path = "../../cli/src/application/command_line.rs"]
mod command_line;

use clap::Parser;
use maka_host_runtime::HostError;
use std::{path::PathBuf, process::ExitCode};

pub(super) fn dispatch() -> Option<ExitCode> {
    let mut arguments = std::env::args_os().skip(1).peekable();
    let mode = arguments.peek()?.to_str()?;
    let result = match mode {
        "__maka-build-ui" => {
            build_ui(command_line::BuildUi::parse_from(arguments)).map_err(|error| {
                eprintln!("{}", command_line::sanitize_diagnostic(&error.to_string()));
            })
        }
        "__maka-terminal-shell" => {
            let args = maka_terminal_shell::entry::Args::parse_from(arguments);
            if let Err(error) = maka_terminal_shell::entry::initialize_terminal_interaction() {
                eprintln!("logging startup: {error}");
                return Some(ExitCode::FAILURE);
            }
            terminal(args)
                .map_err(|error| maka_terminal_shell::args::report_error(error.to_string()))
        }
        _ => return None,
    };
    Some(if result.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn terminal(args: maka_terminal_shell::entry::Args) -> Result<(), HostError> {
    let launcher = match std::env::var_os(super::LAUNCHER) {
        Some(path) => PathBuf::from(path),
        None => super::launcher_path(&std::env::current_exe()?.canonicalize()?)?,
    };
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("runtime startup: {error}"))?
        .block_on(args.run_with_launcher(launcher))?;
    Ok(())
}

fn build_ui(args: command_line::BuildUi) -> Result<(), HostError> {
    let manifest = maka_ui_build::compile(&args.entry, &args.output, args.asset_root.as_deref())?;
    println!("{}", serde_json::to_string_pretty(&manifest)?);
    Ok(())
}
