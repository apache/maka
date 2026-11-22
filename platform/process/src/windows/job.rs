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

use super::{checked, owned};
use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::System::JobObjects::*;

pub(crate) struct Job(pub OwnedHandle);
impl Job {
    pub fn new() -> io::Result<Self> {
        // SAFETY: anonymous, non-inheritable Job owned by this invocation.
        let job = Self(owned(unsafe {
            CreateJobObjectW(ptr::null(), ptr::null())
        })?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: correctly sized initialized input and live owned handle.
        unsafe {
            checked(SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ))?;
        }
        Ok(job)
    }

    pub fn terminate(&self, code: u32) -> io::Result<()> {
        // SAFETY: targets only this invocation's Job, never a PID lookup.
        unsafe { checked(TerminateJobObject(self.0.as_raw_handle(), code)) }
    }

    pub fn preserve_descendants(&self) -> io::Result<()> {
        let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // SAFETY: clear only this Job's kill-on-close flag after confirmed normal
        // root exit. This matches foreground shell behavior on Unix.
        unsafe {
            checked(SetInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ))
        }
    }

    pub fn is_empty(&self) -> io::Result<bool> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: correctly sized output and live owned handle.
        unsafe {
            checked(QueryInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                ptr::null_mut(),
            ))?;
        }
        Ok(info.ActiveProcesses == 0)
    }
}
