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

use super::super::LocalMemory;
use std::{
    io,
    marker::PhantomData,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
    rc::Rc,
};
use windows_sys::Win32::{
    Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES,
    },
    System::Threading::{CreateMutexExW, ReleaseMutex, WaitForSingleObject},
};

/// ACL read/modify/write must not lose another execution's ACEs. The kernel
/// mutex coordinates all Maka Hosts and elevated helpers, including overlapping
/// parent/child targets. It confers no access to the files being changed.
pub(super) struct Guard {
    handle: OwnedHandle,
    _thread: PhantomData<Rc<()>>,
}
impl Guard {
    pub fn acquire() -> io::Result<Self> {
        // Peers may synchronize/release, not rewrite the coordinator's DACL.
        let sddl: Vec<_> = "D:P(A;;GA;;;OW)(A;;GA;;;SY)(A;;0x100001;;;AU)"
            .encode_utf16()
            .chain(Some(0))
            .collect();
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
        let descriptor = LocalMemory(descriptor);
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let name: Vec<_> = r"Global\MakaSandboxAcl"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let handle = unsafe { CreateMutexExW(&security, name.as_ptr(), 0, 0x100001) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        match unsafe { WaitForSingleObject(handle.as_raw_handle(), 15_000) } {
            // No cached DACL is reused after abandonment: the caller rereads the
            // current object and merges only its own SID. Its durable intent
            // still owns any interrupted mutation from the previous process.
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self {
                handle,
                _thread: PhantomData,
            }),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "sandbox ACL coordinator is busy",
            )),
            _ => Err(io::Error::last_os_error()),
        }
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        // !Send pins release to the thread that acquired ownership.
        if unsafe { ReleaseMutex(self.handle.as_raw_handle()) } == 0 {
            std::process::abort();
        }
    }
}
