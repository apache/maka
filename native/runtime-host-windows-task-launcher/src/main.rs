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

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::{
    env,
    path::Path,
    process::{Command, Stdio},
    thread::sleep,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

#[cfg(target_os = "windows")]
use std::{
    mem::size_of,
    os::windows::{
        io::{AsRawHandle, FromRawHandle},
        process::CommandExt,
    },
};
#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HANDLE,
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
        Threading::{CREATE_NO_WINDOW, GetCurrentProcess},
    },
};
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;

const RESTART_DELAY: Duration = Duration::from_secs(2);

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let mut arguments = env::args_os();
    let _executable = arguments.next();
    let Some(mode) = arguments.next().and_then(|value| value.into_string().ok()) else {
        return 1;
    };
    let Some(command) = arguments
        .map(|value| value.into_string().ok().and_then(decode_argument))
        .collect::<Option<Vec<_>>>()
    else {
        return 1;
    };
    if !valid_command(&mode, &command) {
        return 1;
    }
    let Ok(_owner) = own_process_tree() else {
        return 1;
    };
    if mode == "--once" {
        return run_child(&command).unwrap_or(1);
    }
    loop {
        if run_child(&command) == Some(0) {
            return 0;
        }
        sleep(RESTART_DELAY);
    }
}

fn decode_argument(argument: String) -> Option<String> {
    let decoded = URL_SAFE_NO_PAD.decode(&argument).ok()?;
    if URL_SAFE_NO_PAD.encode(&decoded) != argument {
        return None;
    }
    String::from_utf8(decoded).ok()
}

fn valid_command(mode: &str, command: &[String]) -> bool {
    (mode == "--once" || mode == "--supervise")
        && command
            .first()
            .is_some_and(|path| Path::new(path).is_absolute())
        && (mode != "--supervise"
            || (command.len() >= 4 && command[2] == "runtime-host" && command[3] == "serve"))
}

fn run_child(command: &[String]) -> Option<i32> {
    let mut child = Command::new(&command[0]);
    child
        .args(&command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    child.creation_flags(CREATE_NO_WINDOW.0);
    child.status().ok()?.code()
}

#[cfg(target_os = "windows")]
fn own_process_tree() -> windows::core::Result<std::os::windows::io::OwnedHandle> {
    // SAFETY: the returned handle remains owned until the launcher exits, the initialized
    // structure matches the selected information class, and GetCurrentProcess is valid here.
    unsafe {
        let created = CreateJobObjectW(None, PCWSTR::null())?;
        let owned = std::os::windows::io::OwnedHandle::from_raw_handle(created.0);
        let handle = HANDLE(owned.as_raw_handle());
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&raw const information).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )?;
        AssignProcessToJobObject(handle, GetCurrentProcess())?;
        Ok(owned)
    }
}

#[cfg(not(target_os = "windows"))]
fn own_process_tree() -> Result<(), ()> {
    Ok(())
}
