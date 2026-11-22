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

//! Windows account, ACL and token isolation primitives. They do not authorize
//! execution; provisioning and native launch must share one resource owner.
mod account;
mod group;
pub use group::ReadGroup;
mod credential;
mod desktop;
pub use desktop::{Desktop, DesktopTransfer};
mod job;
pub use job::{ExecutionJob, ensure_drained, job_name, stop_preparation};
mod network;
pub use account::{Account, AccountId};
pub use credential::{Credential, Password};
mod token;
pub use network::{AccountNetwork, NetworkRules};
pub use token::{WriteCapability, WriteToken};
pub mod acl;
pub mod mxc;

use std::{ffi::c_void, io};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;

fn sid(text: &str) -> io::Result<LocalMemory> {
    if text.contains('\0') {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid SID"));
    }
    let text: Vec<_> = text.encode_utf16().chain(Some(0)).collect();
    let mut value = std::ptr::null_mut();
    // SAFETY: terminated input and writable output; Windows validates the SID.
    if unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut value) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(LocalMemory(value))
}

fn checked(status: u32) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

struct LocalMemory(*mut c_void);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        // SAFETY: this allocation came from a LocalAlloc-backed Windows API.
        unsafe {
            LocalFree(self.0);
        }
    }
}
