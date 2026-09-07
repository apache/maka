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

use napi_derive::napi;

/// Returns an opaque identifier for one OS process lifetime. Unlike a command
/// line, this value cannot be forged accidentally by an argument or path.
#[napi]
pub fn read_process_start_identity(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    read_platform_process_start_identity(pid)
}

#[cfg(target_os = "linux")]
fn read_platform_process_start_identity(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let boot_id = boot_id.trim();
    if boot_id.is_empty()
        || !boot_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return None;
    }
    let start_ticks = linux_process_start_ticks(&stat)?;
    Some(format!("linux:{boot_id}:{start_ticks}"))
}

#[cfg(target_os = "linux")]
fn linux_process_start_ticks(stat: &str) -> Option<&str> {
    // `comm` (field 2) may contain spaces and parentheses. The final `)` is
    // the only safe boundary before field 3; starttime is field 22.
    let mut fields = stat.get(stat.rfind(')')? + 1..)?.split_ascii_whitespace();
    let start_ticks = fields.nth(19)?;
    (!start_ticks.is_empty() && start_ticks.bytes().all(|byte| byte.is_ascii_digit()))
        .then_some(start_ticks)
}

#[cfg(target_os = "macos")]
fn read_platform_process_start_identity(pid: u32) -> Option<String> {
    use std::mem::{MaybeUninit, size_of};

    const PROC_PIDTBSDINFO: i32 = 3;

    #[repr(C)]
    struct ProcBsdInfo {
        pbi_flags: u32,
        pbi_status: u32,
        pbi_xstatus: u32,
        pbi_pid: u32,
        pbi_ppid: u32,
        pbi_uid: u32,
        pbi_gid: u32,
        pbi_ruid: u32,
        pbi_rgid: u32,
        pbi_svuid: u32,
        pbi_svgid: u32,
        rfu_1: u32,
        pbi_comm: [u8; 16],
        pbi_name: [u8; 32],
        pbi_nfiles: u32,
        pbi_pgid: u32,
        pbi_pjobc: u32,
        e_tdev: u32,
        e_tpgid: u32,
        pbi_nice: i32,
        pbi_start_tvsec: u64,
        pbi_start_tvusec: u64,
    }

    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut core::ffi::c_void,
            buffer_size: i32,
        ) -> i32;
    }

    let mut info = MaybeUninit::<ProcBsdInfo>::zeroed();
    let expected_size = size_of::<ProcBsdInfo>();
    // SAFETY: `info` points to writable storage of exactly the size passed to
    // libproc. The value is read only when libproc reports a complete record.
    let read_size = unsafe {
        proc_pidinfo(
            pid as i32,
            PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected_size as i32,
        )
    };
    if read_size != expected_size as i32 {
        return None;
    }
    // SAFETY: the successful full-size call initialized every byte.
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid || info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1_000_000 {
        return None;
    }
    Some(format!(
        "darwin:{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}

#[cfg(target_os = "windows")]
fn read_platform_process_start_identity(pid: u32) -> Option<String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows::Win32::{
        Foundation::{FILETIME, HANDLE},
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    // SAFETY: the returned valid handle is immediately placed under RAII.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    // SAFETY: ownership of the newly opened handle is transferred exactly once.
    let owned = unsafe { OwnedHandle::from_raw_handle(handle.0) };
    let handle = HANDLE(owned.as_raw_handle());
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: the handle remains live and all four output pointers are valid.
    unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }.ok()?;
    let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    (ticks != 0).then(|| format!("windows:{ticks}"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn read_platform_process_start_identity(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod common_tests {
    use super::read_process_start_identity;

    #[test]
    fn current_process_identity_is_stable() {
        let first = read_process_start_identity(std::process::id());
        assert!(first.is_some());
        assert_eq!(read_process_start_identity(std::process::id()), first);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::linux_process_start_ticks;

    #[test]
    fn parses_start_ticks_after_a_hostile_process_name() {
        let stat = "42 (workspace --startup-attempt-id 00000000-0000-4000-8000-000000000001) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 98765 20";
        assert_eq!(linux_process_start_ticks(stat), Some("98765"));
    }
}
