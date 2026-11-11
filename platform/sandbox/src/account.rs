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

use std::{io, path::PathBuf};

#[cfg(unix)]
pub fn is_private_account_directory(path: &std::path::Path) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    let owner = unsafe { libc::geteuid() };
    Ok(metadata.is_dir() && metadata.uid() == owner && metadata.mode() & 0o077 == 0)
}

/// The effective OS account's HOME, independent of HOME/USERPROFILE/XDG
/// environment overrides. Native lookup can block; call off the async executor.
pub fn account_home() -> io::Result<PathBuf> {
    #[cfg(unix)]
    {
        use std::{ffi::CStr, os::unix::ffi::OsStrExt};
        let mut buffer = vec![0_u8; 65536];
        // SAFETY: passwd is a C record valid when zero-initialized. The writable
        // record/buffer/result pointer remain live throughout getpwuid_r.
        let mut record: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result = std::ptr::null_mut();
        let error = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                &mut record,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
        if result.is_null() || record.pw_dir.is_null() {
            return Err(io::Error::other("OS account home is unavailable"));
        }
        // SAFETY: a successful lookup returned this NUL-terminated field in
        // the still-live caller-owned buffer.
        let bytes = unsafe { CStr::from_ptr(record.pw_dir) }.to_bytes();
        let path = PathBuf::from(std::ffi::OsStr::from_bytes(bytes));
        if !path.is_absolute() {
            return Err(io::Error::other("OS account home must be absolute"));
        }
        Ok(path)
    }
    #[cfg(windows)]
    {
        use std::{
            ffi::OsString,
            os::windows::{
                ffi::OsStringExt,
                io::{AsRawHandle, FromRawHandle, OwnedHandle},
            },
            ptr,
        };
        use windows_sys::Win32::{
            Foundation::ERROR_NO_TOKEN,
            Security::TOKEN_QUERY,
            System::Threading::{
                GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
            },
            UI::Shell::GetUserProfileDirectoryW,
        };
        let mut handle = ptr::null_mut();
        // SAFETY: current-process/thread pseudo-handles are valid; successful
        // queries initialize the output with one owned token handle. Match the
        // filesystem identity, including an impersonated caller.
        if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut handle) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_TOKEN as i32) {
                return Err(error);
            }
            if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        // SAFETY: the successful query transferred this unique owned handle.
        let token = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        // SAFETY: writable UTF-16 buffer and its exact capacity are supplied.
        if unsafe {
            GetUserProfileDirectoryW(token.as_raw_handle(), buffer.as_mut_ptr(), &mut size)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if size == 0 || size as usize > buffer.len() || buffer[size as usize - 1] != 0 {
            return Err(io::Error::other("invalid OS account profile path"));
        }
        let path = PathBuf::from(OsString::from_wide(&buffer[..size as usize - 1]));
        if !path.is_absolute() {
            return Err(io::Error::other("OS account profile must be absolute"));
        }
        Ok(path)
    }
}
