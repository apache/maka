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

use super::{checked, wide};
use std::{io, ptr};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND},
    System::Registry::*,
};

const PATH: &str =
    r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList";
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

pub(super) fn hide(name: &str) -> io::Result<()> {
    let mut key = ptr::null_mut();
    checked(unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(PATH).as_ptr(),
            0,
            ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE | KEY_WOW64_64KEY,
            ptr::null(),
            &mut key,
            ptr::null_mut(),
        )
    })?;
    let key = Key(key);
    let value = 0u32.to_le_bytes();
    checked(unsafe {
        RegSetValueExW(
            key.0,
            wide(name).as_ptr(),
            0,
            REG_DWORD,
            value.as_ptr(),
            value.len() as u32,
        )
    })
}

pub(super) fn remove(name: &str) -> io::Result<()> {
    let mut key = ptr::null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(PATH).as_ptr(),
            0,
            KEY_SET_VALUE | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        return Ok(());
    }
    checked(status)?;
    let key = Key(key);
    let status = unsafe { RegDeleteValueW(key.0, wide(name).as_ptr()) };
    if status == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        checked(status)
    }
}
