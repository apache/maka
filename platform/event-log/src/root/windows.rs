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

//! Windows primitives for root ownership and its private control namespace.

mod account;
mod filesystem;
mod security;

pub use account::{account_home, account_sid};
pub use filesystem::publish_file;
pub use filesystem::{
    FileIdentity, create_private_directory, create_private_file, file_identity, open_nofollow,
    private_directory,
};
pub use security::{PrivateSecurity, validate_private};

use std::{ffi::c_void, io, os::windows::ffi::OsStrExt};
use windows_sys::Win32::Foundation::LocalFree;

pub(super) fn checked(success: i32) -> io::Result<()> {
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(super) fn wide(value: &std::ffi::OsStr) -> io::Result<Vec<u16>> {
    let mut units: Vec<_> = value.encode_wide().collect();
    if units.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "NUL in Windows name",
        ));
    }
    units.push(0);
    Ok(units)
}

/// Owns only allocations returned by Windows APIs that require LocalFree.
pub(super) struct LocalAllocation(pub(super) *mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: constructors below receive LocalAlloc-owned API output.
        unsafe { LocalFree(self.0) };
    }
}
