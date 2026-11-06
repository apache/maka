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

//! macOS TCC preflight using the production Host permission checks.
//! Only `--request-screen-recording` explicitly asks macOS for authorization.

use maka_agent_facts::interaction::SystemPermissionGrant::{Accessibility, ScreenRecording};
use maka_computer_use::system_permission;
use serde::Serialize;
use std::{
    error::Error,
    ffi::OsString,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const USAGE: &str = "Usage: system-permission-probe [host candidate] [--request-screen-recording] [--watch <output.jsonl>]";

#[derive(PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    supported: bool,
    application: String,
    bundle_path: Option<PathBuf>,
    accessibility: bool,
    screen_recording: bool,
}

impl Snapshot {
    fn read() -> Result<Self, String> {
        let supported = system_permission::supported();
        let (application, bundle_path) = system_permission::application();
        let missing = system_permission::missing(&[Accessibility, ScreenRecording])?;
        Ok(Self {
            supported,
            application,
            bundle_path,
            accessibility: supported && !missing.contains(&Accessibility),
            screen_recording: supported && !missing.contains(&ScreenRecording),
        })
    }

    fn write(&self, mut output: impl Write) -> Result<(), Box<dyn Error>> {
        #[derive(Serialize)]
        struct Observation<'a> {
            timestamp: u128,
            pid: u32,
            #[serde(flatten)]
            snapshot: &'a Snapshot,
        }
        let observation = Observation {
            timestamp: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
            pid: std::process::id(),
            snapshot: self,
        };
        serde_json::to_writer(&mut output, &observation)?;
        output.write_all(b"\n")?;
        output.flush()?;
        Ok(())
    }
}

fn observe(mut output: impl Write, request_screen_recording: bool) -> Result<(), Box<dyn Error>> {
    let mut previous = Snapshot::read()?;
    previous.write(&mut output)?;
    if request_screen_recording {
        system_permission::request(&[ScreenRecording], &|| false)?;
    }
    loop {
        let snapshot = Snapshot::read()?;
        if snapshot != previous {
            snapshot.write(&mut output)?;
            previous = snapshot;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    if let Some(exit) = maka_computer_use::desktop::bootstrap() {
        std::process::exit(if exit == std::process::ExitCode::SUCCESS {
            0
        } else {
            1
        });
    }
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let args = match args.as_slice() {
        [host, candidate, rest @ ..] if host == "host" && candidate == "candidate" => rest,
        args => args,
    };
    match args {
        [] => Snapshot::read()?.write(std::io::stdout().lock()),
        [help] if help == "--help" || help == "-h" => {
            println!("{USAGE}");
            Ok(())
        }
        [request] if request == "--request-screen-recording" => {
            observe(std::io::stdout().lock(), true)
        }
        [watch, path] if watch == "--watch" => {
            let output = OpenOptions::new().create(true).append(true).open(path)?;
            observe(output, false)
        }
        [request, watch, path] if request == "--request-screen-recording" && watch == "--watch" => {
            let output = OpenOptions::new().create(true).append(true).open(path)?;
            observe(output, true)
        }
        _ => Err(USAGE.into()),
    }
}
