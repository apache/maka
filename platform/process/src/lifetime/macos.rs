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
use std::{ffi::CStr, io, mem::size_of};

pub(super) fn capture(pid: u32) -> io::Result<ProcessIdentity> {
    let origin = boot_session()?;
    let first = start(pid)?;
    let second = start(pid)?;
    if first != second || boot_session()? != origin {
        return Err(unobservable(
            "process or boot origin changed during capture",
        ));
    }
    Ok(ProcessIdentity {
        pid,
        instance: Instance::MacOs {
            boot_session_uuid: origin,
            start_seconds: first.0,
            start_microseconds: first.1,
        },
    })
}

pub(super) fn observe(identity: &ProcessIdentity) -> io::Result<Status> {
    let Instance::MacOs {
        boot_session_uuid,
        start_seconds,
        start_microseconds,
    } = &identity.instance
    else {
        return Err(unobservable("process identity belongs to another platform"));
    };
    if boot_session()? != *boot_session_uuid {
        return Err(unobservable(
            "process identity belongs to another boot origin",
        ));
    }
    let result = inspect(identity.pid, (*start_seconds, *start_microseconds));
    if boot_session()? != *boot_session_uuid {
        return Err(unobservable("boot origin changed during observation"));
    }
    result
}

fn inspect(pid: u32, expected: (u64, u64)) -> io::Result<Status> {
    for _ in 0..2 {
        match start(pid) {
            Ok(actual) if actual != expected => return Ok(Status::Gone),
            Ok(_) => {}
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(Status::Gone),
            Err(error) => return Err(error),
        }
    }
    Ok(Status::Alive)
}

fn start(pid: u32) -> io::Result<(u64, u64)> {
    // SAFETY: proc_bsdinfo is an all-integer C record, zero is valid for every
    // field. The kernel receives its exact buffer size; only full records are read.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let expected = size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: __error is this thread's errno slot; clear it so a short successful
    // read can never inherit an old ESRCH and masquerade as absence.
    let written = unsafe {
        *libc::__error() = 0;
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            expected,
        )
    };
    if written <= 0 {
        let error = io::Error::last_os_error();
        return Err(if error.raw_os_error() == Some(0) {
            unobservable("proc_pidinfo returned no record and no errno")
        } else {
            error
        });
    }
    if written != expected || info.pbi_pid != pid || info.pbi_start_tvusec >= 1_000_000 {
        return Err(unobservable(
            "proc_pidinfo returned a truncated or invalid record",
        ));
    }
    Ok((info.pbi_start_tvsec, info.pbi_start_tvusec))
}

fn boot_session() -> io::Result<String> {
    let mut bytes = [0u8; 128];
    let mut size = bytes.len();
    // SAFETY: NUL-terminated static name, valid output buffer and size pointer;
    // null newp with zero length performs a read-only sysctl query.
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            bytes.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    let value = bytes
        .get(..size)
        .and_then(|bytes| CStr::from_bytes_with_nul(bytes).ok())
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            value.len() == 36
                && value.bytes().enumerate().all(|(i, b)| {
                    if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_hexdigit()
                    }
                })
        })
        .ok_or_else(|| unobservable("invalid kernel boot session UUID"))?;
    Ok(value.to_owned())
}
