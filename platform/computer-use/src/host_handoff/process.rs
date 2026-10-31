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

use cua_driver_core::browser::host_handoff::BrowserFamily;
use maka_agent_facts::tools::ToolError;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

mod browser;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub(super) use cua_driver_core::browser::host_handoff::NativeHostReceipt as HostProcess;

pub(super) fn find(
    executable: &Path,
    origin: &str,
    browser: BrowserFamily,
) -> Result<Vec<HostProcess>, ToolError> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        ProcessRefreshKind::new()
            .with_cmd(UpdateKind::Always)
            .with_exe(UpdateKind::Always)
            .with_user(UpdateKind::Always),
    );
    let own_pid = Pid::from_u32(std::process::id());
    let user = system
        .process(own_pid)
        .and_then(|process| process.user_id())
        .ok_or_else(|| failed("cannot identify the supervisor's user"))?;
    let mut targets = Vec::new();
    let mut browsers = HashMap::new();
    for (pid, process) in system.processes() {
        if process.user_id() != Some(user) {
            continue;
        }
        let Some(actual) = process.exe() else {
            continue;
        };
        if actual != executable && std::fs::canonicalize(actual).ok().as_deref() != Some(executable)
        {
            continue;
        }
        if process.cmd().is_empty() {
            return Err(failed("cannot inspect native host command line"));
        }
        if process.cmd().get(1).and_then(|arg| arg.to_str()) != Some(origin) {
            continue;
        }
        if !has_browser_parent(&system, process.parent(), browser, &mut browsers)? {
            continue;
        }
        let pid = pid.as_u32();
        if let Some(identity) = crate::identity::live_process(pid)? {
            targets.push(HostProcess {
                pid,
                identity,
                executable: executable.to_owned(),
            });
        }
    }
    Ok(targets)
}

pub(super) fn native_browser() -> Result<Option<BrowserFamily>, ToolError> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        ProcessRefreshKind::new().with_exe(UpdateKind::Always),
    );
    let parent = system
        .process(Pid::from_u32(std::process::id()))
        .and_then(|process| process.parent());
    let mut browsers = HashMap::new();
    for family in [BrowserFamily::Chrome, BrowserFamily::Chromium] {
        if has_browser_parent(&system, parent, family, &mut browsers)? {
            return Ok(Some(family));
        }
    }
    Ok(None)
}

fn has_browser_parent(
    system: &System,
    mut parent: Option<Pid>,
    selected: BrowserFamily,
    browsers: &mut HashMap<PathBuf, Option<BrowserFamily>>,
) -> Result<bool, ToolError> {
    let mut visited = HashSet::new();
    while let Some(pid) = parent {
        if !visited.insert(pid) {
            return Ok(false);
        }
        let Some(process) = system.process(pid) else {
            return Ok(false);
        };
        if let Some(executable) = process.exe() {
            let family = match browsers.get(executable) {
                Some(family) => *family,
                None => {
                    let family = browser::identify(executable)?;
                    browsers.insert(executable.to_owned(), family);
                    family
                }
            };
            if let Some(family) = family {
                return Ok(family == selected);
            }
        }
        parent = process.parent();
    }
    Ok(false)
}

pub(super) fn is_alive(host: &HostProcess) -> Result<bool, ToolError> {
    Ok(crate::identity::live_process(host.pid)?.is_some_and(|identity| identity == host.identity))
}

pub(super) fn stop(host: &HostProcess) -> Result<(), ToolError> {
    if !is_alive(host)? {
        return Ok(());
    }
    #[cfg(unix)]
    {
        // SAFETY: this exact PID/start generation was captured from the selected
        // native host executable, origin, user and browser ancestry above.
        if unsafe { libc::kill(host.pid as i32, libc::SIGTERM) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(failed(format!(
            "stopping {}: {error}",
            host.executable.display()
        )))
    }
    #[cfg(windows)]
    {
        stop_windows(host)
    }
}

#[cfg(windows)]
fn stop_windows(host: &HostProcess) -> Result<(), ToolError> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
            TerminateProcess,
        },
    };
    // SAFETY: a successful handle is kept until the same kernel process has
    // been identity-checked and terminated; no PID-based taskkill is used.
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            host.pid,
        );
        if handle.is_null() {
            if !is_alive(host)? {
                return Ok(());
            }
            return Err(failed(std::io::Error::last_os_error()));
        }
        let mut created: FILETIME = std::mem::zeroed();
        let mut exited: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let result =
            if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) == 0 {
                Err(failed(std::io::Error::last_os_error()))
            } else if host.identity
                != format!(
                    "{}:{}:{}",
                    host.pid, created.dwHighDateTime, created.dwLowDateTime
                )
            {
                Ok(())
            } else if TerminateProcess(handle, 0) == 0 {
                Err(failed(std::io::Error::last_os_error()))
            } else {
                Ok(())
            };
        CloseHandle(handle);
        result
    }
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
