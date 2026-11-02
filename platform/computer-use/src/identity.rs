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

use maka_agent_facts::tools::ToolError;

/// A PID alone is reusable. Bind to the kernel's process start identity as well.
pub(crate) fn process(pid: u32) -> Result<String, ToolError> {
    identity(pid)
        .map_err(|error| ToolError::Failed(format!("process identity unavailable: {error}")))
}

pub(crate) fn live_process(pid: u32) -> Result<Option<String>, ToolError> {
    match identity(pid) {
        Ok(identity) => Ok(Some(identity)),
        Err(error) => {
            #[cfg(unix)]
            let absent = error.kind() == std::io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ESRCH);
            #[cfg(windows)]
            let absent = error.raw_os_error() == Some(87);
            if absent {
                Ok(None)
            } else {
                Err(ToolError::Failed(format!(
                    "process identity unavailable: {error}"
                )))
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn identity(pid: u32) -> Result<String, std::io::Error> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    // SAFETY: the kernel writes exactly this C record; read only on a full result.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if written != size as i32 {
        return Err(std::io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok(format!(
        "{pid}:{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}
#[cfg(target_os = "linux")]
fn identity(pid: u32) -> Result<String, std::io::Error> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let start = stat
        .rsplit_once(')')
        .and_then(|(_, tail)| tail.split_whitespace().nth(19))
        .ok_or_else(|| std::io::Error::other("invalid process stat"))?;
    Ok(format!("{pid}:{start}"))
}
#[cfg(target_os = "windows")]
fn identity(pid: u32) -> Result<String, std::io::Error> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    // SAFETY: query-only process handle; all out-pointers are initialized C records.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut created: FILETIME = std::mem::zeroed();
        let mut exited: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
        let error = std::io::Error::last_os_error();
        CloseHandle(handle);
        if ok == 0 {
            return Err(error);
        }
        Ok(format!(
            "{pid}:{}:{}",
            created.dwHighDateTime, created.dwLowDateTime
        ))
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn identity(_: u32) -> Result<String, std::io::Error> {
    Err(std::io::Error::other(
        "native process generation is not implemented on this platform",
    ))
}
