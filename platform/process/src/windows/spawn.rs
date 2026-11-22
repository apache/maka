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

use super::{attributes::Attributes, checked, job::Job, owned};
use std::{
    fs::File,
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation},
    System::Threading::*,
};

pub(crate) enum Console {
    None,
    Inherited,
}

/// Shared by foreground commands, duplex pipes and the account runner. Native
/// ownership and the exact inheritance whitelist are established atomically.
pub(crate) fn launch(
    plan: &crate::command::Prepared,
    job: &Job,
    stdio: [&File; 3],
    console: Console,
) -> io::Result<(OwnedHandle, u32)> {
    let jobs = [job.0.as_raw_handle()];
    let handles = stdio.map(AsRawHandle::as_raw_handle);
    for handle in handles {
        unsafe {
            checked(SetHandleInformation(
                handle,
                HANDLE_FLAG_INHERIT,
                HANDLE_FLAG_INHERIT,
            ))?;
        }
    }
    let mut attributes = Attributes::stdio(&handles, &jobs)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes.as_ptr();
    let flags = match console {
        Console::None => CREATE_NO_WINDOW,
        Console::Inherited => 0,
    };
    let process = unsafe { plan.spawn_windows(&startup, true, flags) }?;
    let handle = owned(process.hProcess)?;
    let _thread = owned(process.hThread)?;
    Ok((handle, process.dwProcessId))
}
