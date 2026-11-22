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

use super::{LocalAllocation, checked};
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::{
    Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_NO_TOKEN},
    Security::{
        Authorization::ConvertSidToStringSidW, GetTokenInformation, PSID, TOKEN_QUERY, TOKEN_USER,
        TokenUser,
    },
    System::Threading::{GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken},
};

pub(super) fn token() -> io::Result<OwnedHandle> {
    let mut handle = ptr::null_mut();
    // Filesystem operations use the effective thread identity. An elevated
    // one-shot helper may be opening private state on behalf of its caller;
    // choosing the helper's primary account would create the wrong owner.
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut handle) } == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_NO_TOKEN as i32) {
            return Err(error);
        }
        checked(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) })?;
    }
    // SAFETY: the successful token query transfers a unique owned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

pub(super) struct AccountSid(Vec<usize>);
impl AccountSid {
    pub(super) fn current() -> io::Result<Self> {
        let token = token()?;
        let mut size = 0;
        // SAFETY: documented size-query call; no output buffer is supplied.
        unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                ptr::null_mut(),
                0,
                &mut size,
            )
        };
        if io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
            || size < size_of::<TOKEN_USER>() as u32
            || size > 65536
        {
            return Err(io::Error::other("invalid Windows account token size"));
        }
        // usize storage guarantees the pointer alignment required by TOKEN_USER.
        let mut bytes = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
        // SAFETY: buffer is aligned, bounded and has at least size bytes.
        checked(unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                bytes.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        })?;
        Ok(Self(bytes))
    }

    pub(super) fn as_ptr(&self) -> PSID {
        // SAFETY: successful TokenUser query initialized TOKEN_USER and its SID
        // within this buffer; moving the Vec does not move its allocation.
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }

    pub(super) fn text(&self) -> io::Result<String> {
        // SAFETY: this account owns the queried SID buffer.
        unsafe { sid_text(self.as_ptr()) }
    }
}

/// # Safety
/// `sid` must point to a valid SID for the duration of this call.
pub(super) unsafe fn sid_text(sid: PSID) -> io::Result<String> {
    let mut text = ptr::null_mut();
    // SAFETY: the caller keeps the SID valid; the API allocates the output.
    checked(unsafe { ConvertSidToStringSidW(sid, &mut text) })?;
    let allocation = LocalAllocation(text.cast());
    let mut length = 0;
    // SAFETY: successful API output is a NUL-terminated UTF-16 SID string.
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    let value = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|_| io::Error::other("invalid account SID string"));
    drop(allocation);
    value
}

/// SID of the effective filesystem identity, including an impersonated caller.
pub fn account_sid() -> io::Result<String> {
    AccountSid::current()?.text()
}
