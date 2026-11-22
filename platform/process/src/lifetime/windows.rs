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

use super::{Instance, ProcessIdentity, Status, unobservable};
use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::{ERROR_INVALID_PARAMETER, FILETIME, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        WaitForSingleObject,
    },
};

pub(super) fn capture(pid: u32) -> io::Result<ProcessIdentity> {
    let origin = boot_identifier()?;
    let handle =
        open(pid)?.ok_or_else(|| io::Error::from_raw_os_error(ERROR_INVALID_PARAMETER as i32))?;
    let creation_time = creation_time(&handle)?;
    if exited(&handle)? || boot_identifier()? != origin {
        return Err(unobservable(
            "process or boot origin changed during capture",
        ));
    }
    Ok(ProcessIdentity {
        pid,
        instance: Instance::Windows {
            boot_identifier: origin,
            creation_time,
        },
    })
}

pub(super) fn observe(identity: &ProcessIdentity) -> io::Result<Status> {
    let Instance::Windows {
        boot_identifier: expected_origin,
        creation_time: expected_start,
    } = &identity.instance
    else {
        return Err(unobservable("process identity belongs to another platform"));
    };
    if boot_identifier()? != *expected_origin {
        return Err(unobservable(
            "process identity belongs to another boot origin",
        ));
    }
    let result = inspect(identity.pid, *expected_start);
    if boot_identifier()? != *expected_origin {
        return Err(unobservable("boot origin changed during observation"));
    }
    result
}

fn inspect(pid: u32, expected: u64) -> io::Result<Status> {
    let Some(handle) = open(pid)? else {
        return Ok(Status::Gone);
    };
    // A process handle pins the particular kernel object despite PID reuse.
    if creation_time(&handle)? != expected || exited(&handle)? {
        return Ok(Status::Gone);
    }
    Ok(Status::Alive)
}

fn open(pid: u32) -> io::Result<Option<OwnedHandle>> {
    // SAFETY: only query/synchronize access; no inheritance or process mutation.
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        // PID 0 was rejected by the public boundary. For a nonzero PID,
        // INVALID_PARAMETER means no such process; ACCESS_DENIED stays an error.
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    // SAFETY: successful OpenProcess transfers this fresh handle exactly once.
    Ok(Some(unsafe { OwnedHandle::from_raw_handle(handle) }))
}

fn creation_time(handle: &OwnedHandle) -> io::Result<u64> {
    let mut created = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    // SAFETY: query-only live handle and correctly sized initialized C outputs.
    if unsafe {
        GetProcessTimes(
            handle.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

fn exited(handle: &OwnedHandle) -> io::Result<bool> {
    // SAFETY: owned synchronize handle, zero timeout, no process mutation.
    match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}

// Windows' kernel boot GUID, not a wall-clock boot-time estimate or machine name.
// SYSTEM_BOOT_ENVIRONMENT_INFORMATION is the fixed class-90 ntdll C ABI.
#[repr(C)]
struct BootEnvironment {
    identifier: [u8; 16],
    firmware_type: u32,
    boot_flags: u64,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQuerySystemInformation(
        class: u32,
        information: *mut std::ffi::c_void,
        length: u32,
        returned: *mut u32,
    ) -> i32;
}

fn boot_identifier() -> io::Result<[u8; 16]> {
    let mut info = BootEnvironment {
        identifier: [0; 16],
        firmware_type: 0,
        boot_flags: 0,
    };
    let mut returned = 0;
    // SAFETY: read-only query, fixed C ABI record and exact output size.
    let status = unsafe {
        NtQuerySystemInformation(
            90,
            (&mut info as *mut BootEnvironment).cast(),
            size_of::<BootEnvironment>() as u32,
            &mut returned,
        )
    };
    if status < 0 || returned != size_of::<BootEnvironment>() as u32 || info.identifier == [0; 16] {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("kernel boot origin unavailable: NTSTATUS {status:#x}, bytes {returned}"),
        ));
    }
    Ok(info.identifier)
}
