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

//! Native observations; no dependency on an installed shell or utility.

#[cfg(unix)]
pub fn os_release() -> std::io::Result<String> {
    let mut info = std::mem::MaybeUninit::<libc::utsname>::uninit();
    // SAFETY: uname initializes the complete structure on success, including
    // the NUL-terminated release array. Nothing is read on failure.
    unsafe {
        if libc::uname(info.as_mut_ptr()) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let info = info.assume_init();
        Ok(std::ffi::CStr::from_ptr(info.release.as_ptr())
            .to_string_lossy()
            .into_owned())
    }
}

#[cfg(windows)]
pub fn os_release() -> std::io::Result<String> {
    use windows_sys::{
        Wdk::System::SystemServices::RtlGetVersion,
        Win32::System::SystemInformation::OSVERSIONINFOW,
    };
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // SAFETY: a writable, correctly sized OSVERSIONINFOW lives through the call.
    // Unlike GetVersionEx, this observation is not altered by the app manifest.
    let status = unsafe { RtlGetVersion(&mut info) };
    if status < 0 {
        return Err(std::io::Error::other(format!(
            "RtlGetVersion failed: {status:#x}"
        )));
    }
    Ok(format!(
        "{}.{}.{}",
        info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
    ))
}
