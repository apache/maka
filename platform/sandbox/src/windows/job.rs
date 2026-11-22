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
    io,
    mem::size_of,
    os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, GetLastError},
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES,
    },
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, OpenJobObjectW,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    },
    System::SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE},
};

/// Each accepted execution gets one persistent recovery identity.
pub fn job_name(namespace: Uuid) -> String {
    format!(r"Global\MakaSandbox-{namespace}")
}

/// Stop an owned preparation helper, never an accepted user execution. Its
/// caller must retain the durable preparation intent until recovery completes.
pub fn stop_preparation(namespace: Uuid) -> io::Result<()> {
    let name: Vec<_> = preparation_name(namespace)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let handle =
        unsafe { OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, 0, name.as_ptr()) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) {
            Ok(())
        } else {
            Err(error)
        };
    }
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    if unsafe { TerminateJobObject(job.as_raw_handle(), 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match check_drained(&job) {
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "sandbox read preparation is still stopping",
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            result => return result,
        }
    }
}

fn preparation_name(namespace: Uuid) -> String {
    format!(r"Global\MakaSandboxRead-{namespace}")
}

/// One command tree, globally named for crash recovery. WithLogon runners may
/// already belong to distinct service-owned Job hierarchies; never try to put
/// multiple such runners in a shared parent Job. Never adopt an existing Job.
pub struct ExecutionJob(OwnedHandle);

impl ExecutionJob {
    pub fn create(namespace: Uuid) -> io::Result<Self> {
        Self::with_security(
            &job_name(namespace),
            "D:P(A;;GA;;;OW)(A;;GA;;;SY)(A;;0x4;;;BA)",
        )
    }

    /// Ordinary and elevated callers of one OS account share preparation.
    /// Explicit ownership avoids an elevated token's Administrators default.
    pub fn preparation(namespace: Uuid, owner: &str) -> io::Result<Self> {
        super::sid(owner)?;
        Self::with_security(
            &preparation_name(namespace),
            &format!("O:{owner}D:P(A;;GA;;;{owner})(A;;GA;;;SY)(A;;0x4;;;BA)"),
        )
    }

    fn with_security(name: &str, security: &str) -> io::Result<Self> {
        let name: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
        // Administrators may query drain state, not silently attach processes
        // or change this owner's kill-on-close contract through the DACL.
        let sddl: Vec<_> = security.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let descriptor = super::LocalMemory(descriptor);
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let handle = unsafe { CreateJobObjectW(&security, name.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let owner = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        if exists {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "previous sandbox owner is still draining",
            ));
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                owner.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(owner)
    }

    /// Attach only a suspended trusted runner. It must not receive a command
    /// until this succeeds; descendants then join by inheritance.
    pub fn assign(&self, process: BorrowedHandle<'_>) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process.as_raw_handle()) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
impl AsHandle for ExecutionJob {
    fn as_handle(&self) -> BorrowedHandle<'_> {
        self.0.as_handle()
    }
}

/// Called only after disabling the accounts and taking exclusive admission.
/// Does not kill work: any remaining tree retains network isolation until it exits.
pub fn ensure_drained(namespace: Uuid) -> io::Result<()> {
    let name: Vec<_> = job_name(namespace).encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, name.as_ptr()) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) {
            Ok(())
        } else {
            Err(error)
        };
    }
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    check_drained(&job)
}

fn check_drained(job: &OwnedHandle) -> io::Result<()> {
    let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    if unsafe {
        QueryInformationJobObject(
            job.as_raw_handle(),
            JobObjectBasicAccountingInformation,
            (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if info.ActiveProcesses != 0 {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "sandbox processes are still draining",
        ));
    }
    Ok(())
}
