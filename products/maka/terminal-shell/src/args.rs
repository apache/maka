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

use std::{
    io::{self, IsTerminal},
    path::PathBuf,
};

const NO_PIXELS_ENV: &str = "MAKA_TERMINAL_NO_PIXELS";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresentationMode {
    Auto,
    Cells,
}

/// Options for the default `maka` entry and the `maka terminal-shell` command.
#[derive(clap::Parser, Default)]
#[command(version, about = "Maka terminal application using NSH")]
pub struct Args {
    /// Business Host Root (default: ~/.maka/application/host).
    #[arg(long)]
    pub root: Option<PathBuf>,
    /// Existing Agent session to display initially; otherwise open the session picker.
    #[arg(long)]
    pub session: Option<String>,
    /// Disable terminal pixel rendering and use the Unicode cell TUI
    /// (also configurable via MAKA_TERMINAL_NO_PIXELS=1).
    #[arg(long)]
    pub no_pixels: bool,
}

impl Args {
    pub fn validate(&self) -> Result<PresentationMode, String> {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            return Err("the terminal shell requires a terminal on stdin and stdout".into());
        }
        if self.session.as_ref().is_some_and(String::is_empty) {
            return Err("session must not be empty".into());
        }
        self.presentation_mode()
    }

    fn presentation_mode(&self) -> Result<PresentationMode, String> {
        if self.no_pixels {
            return Ok(PresentationMode::Cells);
        }
        let Some(value) = std::env::var_os(NO_PIXELS_ENV) else {
            return Ok(PresentationMode::Auto);
        };
        let value = value.to_str().map(str::trim).ok_or_else(|| {
            format!("{NO_PIXELS_ENV} must be valid UTF-8 (one of 1/0, true/false, yes/no, on/off)")
        })?;
        if value.is_empty()
            || value.eq_ignore_ascii_case("0")
            || value.eq_ignore_ascii_case("false")
            || value.eq_ignore_ascii_case("no")
            || value.eq_ignore_ascii_case("off")
        {
            Ok(PresentationMode::Auto)
        } else if value.eq_ignore_ascii_case("1")
            || value.eq_ignore_ascii_case("true")
            || value.eq_ignore_ascii_case("yes")
            || value.eq_ignore_ascii_case("on")
        {
            Ok(PresentationMode::Cells)
        } else {
            Err(format!(
                "{NO_PIXELS_ENV} must be one of 1/0, true/false, yes/no, on/off (got {value:?})"
            ))
        }
    }
}

pub fn report_error(error: String) {
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
