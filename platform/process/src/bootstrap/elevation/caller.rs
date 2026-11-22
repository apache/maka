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

use crate::windows::{checked, owned};
use std::{
    io,
    os::windows::io::{AsRawHandle, BorrowedHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::{
    Foundation::{ERROR_NO_TOKEN, ERROR_NOT_ALL_ASSIGNED, GetLastError, LUID},
    Security::*,
    System::Threading::{
        GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken, SetThreadToken,
    },
};

/// The authenticated caller's effective filesystem identity. The elevated
/// helper keeps OS provisioning privileges only outside these synchronous scopes.
pub struct Caller(OwnedHandle);
impl Caller {
    pub(super) fn capture(process: BorrowedHandle<'_>) -> io::Result<Self> {
        let open = || {
            let mut token = ptr::null_mut();
            checked(unsafe {
                OpenProcessToken(
                    process.as_raw_handle(),
                    TOKEN_QUERY | TOKEN_DUPLICATE,
                    &mut token,
                )
            })?;
            owned(token).map(Self)
        };
        match open() {
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                // Alternate-credential UAC: query only this already authenticated
                // process, then immediately restore the helper's privilege state.
                let _privilege = DebugPrivilege::acquire()?;
                open()
            }
            result => result,
        }
    }

    pub fn run<T>(&self, action: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        let mut previous = ptr::null_mut();
        let previous = if unsafe {
            OpenThreadToken(
                GetCurrentThread(),
                TOKEN_QUERY | TOKEN_IMPERSONATE,
                1,
                &mut previous,
            )
        } != 0
        {
            Some(owned(previous)?)
        } else {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_TOKEN as i32) {
                return Err(error);
            }
            None
        };
        checked(unsafe { ImpersonateLoggedOnUser(self.0.as_raw_handle()) })?;
        struct Restore(Option<OwnedHandle>);
        impl Drop for Restore {
            fn drop(&mut self) {
                let result = match &self.0 {
                    Some(token) => unsafe { SetThreadToken(ptr::null(), token.as_raw_handle()) },
                    None => unsafe { RevertToSelf() },
                };
                if result == 0 {
                    std::process::abort();
                }
            }
        }
        let _restore = Restore(previous);
        action()
    }
}

struct DebugPrivilege {
    token: OwnedHandle,
    previous: TOKEN_PRIVILEGES,
}
impl DebugPrivilege {
    fn acquire() -> io::Result<Self> {
        let mut token = ptr::null_mut();
        checked(unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES,
                &mut token,
            )
        })?;
        let token = owned(token)?;
        let name: Vec<_> = "SeDebugPrivilege".encode_utf16().chain(Some(0)).collect();
        let mut luid = LUID::default();
        checked(unsafe { LookupPrivilegeValueW(ptr::null(), name.as_ptr(), &mut luid) })?;
        let desired = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        let mut previous = TOKEN_PRIVILEGES::default();
        let mut size = 0;
        checked(unsafe {
            AdjustTokenPrivileges(
                token.as_raw_handle(),
                0,
                &desired,
                size_of::<TOKEN_PRIVILEGES>() as u32,
                &mut previous,
                &mut size,
            )
        })?;
        let result = Self { token, previous };
        if unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "setup helper cannot access its authenticated caller token",
            ));
        }
        Ok(result)
    }
}
impl Drop for DebugPrivilege {
    fn drop(&mut self) {
        if unsafe {
            AdjustTokenPrivileges(
                self.token.as_raw_handle(),
                0,
                &self.previous,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        } == 0
        {
            std::process::abort();
        }
    }
}
