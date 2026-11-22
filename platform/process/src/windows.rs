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
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::ExitStatusExt,
    },
    process::ExitStatus,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{GetExitCodeProcess, WaitForSingleObject},
};

pub(crate) mod attributes;
pub(crate) mod job;
pub(crate) mod pipe;
pub(crate) mod spawn;

pub(crate) async fn wait_process(process: &OwnedHandle) -> io::Result<ExitStatus> {
    loop {
        if let Some(status) = try_wait_process(process)? {
            return Ok(status);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub(crate) fn try_wait_process(process: &OwnedHandle) -> io::Result<Option<ExitStatus>> {
    // SAFETY: the owned handle pins the exact process throughout this wait.
    match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => {
            let mut code = 0;
            // SAFETY: signalled process and valid output pointer.
            unsafe {
                checked(GetExitCodeProcess(process.as_raw_handle(), &mut code))?;
            }
            Ok(Some(ExitStatus::from_raw(code)))
        }
        WAIT_TIMEOUT => Ok(None),
        _ => Err(io::Error::last_os_error()),
    }
}

pub(crate) fn checked(success: i32) -> io::Result<()> {
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(crate) fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: callers transfer a successful Windows API result exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}
