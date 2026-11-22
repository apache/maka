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

use super::LocalMemory;
use serde::{Deserialize, Serialize};
use std::{
    io, ptr,
    sync::atomic::{Ordering, compiler_fence},
};
use windows_sys::Win32::Security::Cryptography::*;

/// Machine-bound DPAPI ciphertext. Its containing file must be private to the
/// Host account and administrators: machine scope allows elevated setup under
/// a different administrator, but is not an authorization boundary by itself.
#[derive(Serialize, Deserialize)]
#[serde(transparent)]
pub struct Credential(Vec<u8>);

/// Never serialized, formatted or passed through argv/environment.
pub struct Password(Vec<u16>);
impl Password {
    pub fn generate() -> Self {
        let mut units = Vec::with_capacity(69);
        for _ in 0..2 {
            for byte in uuid::Uuid::new_v4().as_bytes() {
                units.push(b"0123456789abcdef"[(byte >> 4) as usize] as u16);
                units.push(b"0123456789abcdef"[(byte & 15) as usize] as u16);
            }
        }
        units.extend("aA9!".encode_utf16());
        units.push(0);
        Self(units)
    }

    pub fn as_wide(&self) -> &[u16] {
        &self.0
    }

    pub fn protect(&self) -> io::Result<Credential> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: (self.0.len() * 2).try_into().map_err(io::Error::other)?,
            pbData: self.0.as_ptr().cast_mut().cast(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        if unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let _owner = LocalMemory(output.pbData.cast());
        if output.cbData == 0 {
            return Err(io::Error::other("empty DPAPI ciphertext"));
        }
        Ok(Credential(unsafe {
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
        }))
    }
}
impl Drop for Password {
    fn drop(&mut self) {
        for unit in &mut self.0 {
            unsafe { ptr::write_volatile(unit, 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}
impl Credential {
    pub fn unprotect(&self) -> io::Result<Password> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: self.0.len().try_into().map_err(io::Error::other)?,
            pbData: self.0.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        if unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let _owner = Plaintext(LocalMemory(output.pbData.cast()), output.cbData as usize);
        if output.cbData < 4 || output.cbData % 2 != 0 || output.cbData > 514 {
            return Err(io::Error::other("invalid sandbox credential"));
        }
        let password = Password(unsafe {
            std::slice::from_raw_parts(output.pbData.cast::<u16>(), output.cbData as usize / 2)
                .to_vec()
        });
        if password.0.last() != Some(&0) || password.0[..password.0.len() - 1].contains(&0) {
            return Err(io::Error::other("invalid sandbox credential"));
        }
        Ok(password)
    }
}

struct Plaintext(LocalMemory, usize);
impl Drop for Plaintext {
    fn drop(&mut self) {
        for offset in 0..self.1 {
            unsafe { ptr::write_volatile(self.0.0.cast::<u8>().add(offset), 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}
