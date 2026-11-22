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

use super::{LocalMemory, Password, sid};
use serde::{Deserialize, Serialize};
use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::{
    Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, GENERIC_ALL, HANDLE},
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
        ImpersonateLoggedOnUser, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, LogonUserW,
        RevertToSelf, SECURITY_ATTRIBUTES,
    },
    System::{StationsAndDesktops::*, Threading::GetCurrentProcess},
    UI::WindowsAndMessaging::CWF_CREATE_ONLY,
};

/// A private station and desktop retained by the execution owner. A fresh
/// account logon lets Windows name the station without administrative rights.
pub struct Desktop {
    station: HWINSTA,
    desktop: HDESK,
    name: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopTransfer {
    station: usize,
    desktop: usize,
    name: String,
}

// Handles are retained/closed, never selected on a receiving thread.
unsafe impl Send for Desktop {}
unsafe impl Sync for Desktop {}

impl Desktop {
    /// # Safety
    /// Only a dedicated single-threaded bootstrap may temporarily select a
    /// different process window station. No user command runs in this helper.
    pub unsafe fn create(
        account: &str,
        password: &Password,
        owner: &str,
        participants: &[String],
    ) -> io::Result<Self> {
        if account.contains('\0') || participants.is_empty() || participants.len() > 32 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid desktop identity",
            ));
        }
        let station_security = security(owner, participants, 0x0002_037f)?;
        let desktop_security = security(owner, participants, 0x0002_01ff)?;
        let attributes = |descriptor: &LocalMemory| SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let original = unsafe { GetProcessWindowStation() };
        if original.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut token = ptr::null_mut();
        check(unsafe {
            LogonUserW(
                wide(account).as_ptr(),
                wide(".").as_ptr(),
                password.as_wide().as_ptr(),
                LOGON32_LOGON_INTERACTIVE,
                LOGON32_PROVIDER_DEFAULT,
                &mut token,
            )
        })?;
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        check(unsafe { ImpersonateLoggedOnUser(token.as_raw_handle()) })?;
        let impersonation = Impersonation;
        // A supplied name requires administrator membership. NULL uses the
        // fresh logon's identity; CREATE_ONLY cannot adopt an existing station.
        let station = unsafe {
            CreateWindowStationW(
                ptr::null(),
                CWF_CREATE_ONLY,
                0x0002_037f,
                &attributes(&station_security),
            )
        };
        let error = io::Error::last_os_error();
        drop(impersonation);
        if station.is_null() {
            return Err(error);
        }
        let mut result = Self {
            station,
            desktop: ptr::null_mut(),
            name: String::new(),
        };
        let station_name = object_name(station)?;
        check(unsafe { SetProcessWindowStation(station) })?;
        let name = format!("maka-{}", uuid::Uuid::new_v4().simple());
        result.desktop = unsafe {
            CreateDesktopW(
                wide(&name).as_ptr(),
                ptr::null(),
                ptr::null(),
                0,
                GENERIC_ALL,
                &attributes(&desktop_security),
            )
        };
        let error = io::Error::last_os_error();
        if unsafe { SetProcessWindowStation(original) } == 0 {
            std::process::abort();
        }
        if result.desktop.is_null() {
            return Err(error);
        }
        result.name = format!(r"{station_name}\{name}");
        Ok(result)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn transfer(&self) -> DesktopTransfer {
        DesktopTransfer {
            station: self.station as usize,
            desktop: self.desktop as usize,
            name: self.name.clone(),
        }
    }

    /// # Safety
    /// The pinned, trusted bootstrap must own these handles and keep them alive
    /// until the receiver acknowledges duplication.
    pub unsafe fn receive(
        source: BorrowedHandle<'_>,
        transfer: DesktopTransfer,
    ) -> io::Result<Self> {
        let duplicate = |handle: usize| -> io::Result<HANDLE> {
            let mut target = ptr::null_mut();
            check(unsafe {
                DuplicateHandle(
                    source.as_raw_handle(),
                    handle as HANDLE,
                    GetCurrentProcess(),
                    &mut target,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            })?;
            Ok(target)
        };
        let mut result = Self {
            station: duplicate(transfer.station)?,
            desktop: ptr::null_mut(),
            name: transfer.name,
        };
        result.desktop = duplicate(transfer.desktop)?;
        Ok(result)
    }
}
impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe {
            if !self.desktop.is_null() {
                CloseDesktop(self.desktop);
            }
            if !self.station.is_null() {
                CloseWindowStation(self.station);
            }
        }
    }
}
struct Impersonation;
impl Drop for Impersonation {
    fn drop(&mut self) {
        if unsafe { RevertToSelf() } == 0 {
            std::process::abort();
        }
    }
}
fn security(owner: &str, participants: &[String], access: u32) -> io::Result<LocalMemory> {
    let validate = |identity: &str| -> io::Result<()> {
        let _sid = sid(identity)?;
        if !identity.starts_with("S-1-")
            || !identity
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'-' || b == b'S')
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid desktop SID",
            ));
        }
        Ok(())
    };
    validate(owner)?;
    // An account owning its new station must not gain implicit WRITE_DAC.
    // Host user SID, not shared logon SID, owns administrative access.
    let mut sddl = format!("D:P(A;;RC;;;OW)(A;;GA;;;SY)(A;;GA;;;{owner})");
    for participant in participants {
        validate(participant)?;
        sddl.push_str(&format!("(A;;0x{access:x};;;{participant})"));
    }
    let mut descriptor = ptr::null_mut();
    check(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(&sddl).as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    })?;
    Ok(LocalMemory(descriptor))
}
fn object_name(handle: HANDLE) -> io::Result<String> {
    let mut bytes = 0;
    unsafe {
        GetUserObjectInformationW(handle, UOI_NAME, ptr::null_mut(), 0, &mut bytes);
    }
    if bytes == 0 || bytes > 65536 {
        return Err(io::Error::last_os_error());
    }
    let mut name = vec![0u16; (bytes as usize).div_ceil(2)];
    check(unsafe {
        GetUserObjectInformationW(
            handle,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    })?;
    let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
    String::from_utf16(&name[..end]).map_err(io::Error::other)
}
fn check(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
