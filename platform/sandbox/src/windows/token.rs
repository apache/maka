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

use super::{LocalMemory, checked, sid};
use std::{
    io,
    mem::size_of,
    os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::GENERIC_ALL,
    Security::{Authorization::*, *},
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

/// A write scope's unregistered SID. Persist its UUID with the ACL recovery
/// intent; possession of its text is not authority to enter an execution.
#[derive(Clone)]
pub struct WriteCapability(String);

impl WriteCapability {
    pub fn new(id: Uuid) -> Self {
        let (parts, _) = id.as_bytes().as_chunks::<4>();
        let [a, b, c, d] = std::array::from_fn(|i| u32::from_be_bytes(parts[i]));
        Self(format!("S-1-5-21-{a}-{b}-{c}-{d}"))
    }

    pub fn sid(&self) -> &str {
        &self.0
    }
}

/// The write-restriction layer of a Windows sandbox, not its complete boundary.
/// The base must belong to the dedicated execution account: its ACLs supply
/// read restrictions, and account-scoped network rules supply network denial.
/// Logon/world-writable OS objects remain usable; the account SID is deliberately
/// not a restricting SID, so its accumulated workspace grants do not confer writes.
pub struct WriteToken(OwnedHandle);

impl WriteToken {
    /// Restrict the runner's own primary token. The runner must already be
    /// running as the provisioned execution account, not the Host identity.
    pub fn current(capabilities: &[WriteCapability]) -> io::Result<Self> {
        let mut handle = ptr::null_mut();
        success(unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
                &mut handle,
            )
        })?;
        let base = unsafe { OwnedHandle::from_raw_handle(handle) };
        Self::new(base.as_handle(), capabilities)
    }

    /// The base needs TOKEN_QUERY, TOKEN_DUPLICATE and TOKEN_ADJUST_DEFAULT;
    /// process launch additionally needs TOKEN_ASSIGN_PRIMARY. A read-only
    /// execution still uses a capability, but grants it no workspace writes.
    pub fn new(base: BorrowedHandle<'_>, capabilities: &[WriteCapability]) -> io::Result<Self> {
        if capabilities.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a restricted token requires a write capability",
            ));
        }
        let caps = capabilities
            .iter()
            .map(|cap| sid(cap.sid()))
            .collect::<io::Result<Vec<_>>>()?;
        let logon = information(base, TokenLogonSid)?;
        let user = information(base, TokenUser)?;
        if logon.len() * size_of::<usize>() < size_of::<TOKEN_GROUPS>()
            || user.len() * size_of::<usize>() < size_of::<TOKEN_USER>()
        {
            return Err(io::Error::other("truncated token identity"));
        }
        // SAFETY: successful kernel query, aligned buffers containing the full
        // structures and their SIDs; both allocations stay live below.
        let groups = unsafe { &*logon.as_ptr().cast::<TOKEN_GROUPS>() };
        if groups.GroupCount != 1 {
            return Err(io::Error::other("execution token requires one logon SID"));
        }
        let logon_sid = groups.Groups[0].Sid;
        let user_sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        let world = sid("S-1-1-0")?;
        let restrictions: Vec<_> = caps
            .iter()
            .map(|cap| cap.0)
            .chain([logon_sid, world.0])
            .map(|sid| SID_AND_ATTRIBUTES {
                Sid: sid,
                Attributes: 0,
            })
            .collect();
        let mut handle = ptr::null_mut();
        // SAFETY: borrowed live token, initialized SID array and output handle.
        success(unsafe {
            CreateRestrictedToken(
                base.as_raw_handle(),
                DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
                0,
                ptr::null(),
                0,
                ptr::null(),
                restrictions.len().try_into().map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "too many write capabilities")
                })?,
                restrictions.as_ptr(),
                &mut handle,
            )
        })?;
        let token = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        // Newly created IPC objects must pass both normal and restricting SID
        // checks. Do not grant all users access through a world default DACL.
        let entries: Vec<_> = [user_sid, logon_sid]
            .into_iter()
            .chain(caps.iter().map(|cap| cap.0))
            .map(|identity| EXPLICIT_ACCESS_W {
                grfAccessPermissions: GENERIC_ALL,
                grfAccessMode: GRANT_ACCESS,
                Trustee: TRUSTEE_W {
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_UNKNOWN,
                    ptstrName: identity.cast(),
                    ..Default::default()
                },
                ..Default::default()
            })
            .collect();
        let mut acl = ptr::null_mut();
        checked(unsafe {
            SetEntriesInAclW(
                entries.len() as u32,
                entries.as_ptr(),
                ptr::null(),
                &mut acl,
            )
        })?;
        let _acl = LocalMemory(acl.cast());
        let default = TOKEN_DEFAULT_DACL { DefaultDacl: acl };
        success(unsafe {
            SetTokenInformation(
                token.0.as_raw_handle(),
                TokenDefaultDacl,
                (&default as *const TOKEN_DEFAULT_DACL).cast(),
                size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )
        })?;
        Ok(token)
    }
}

impl AsHandle for WriteToken {
    fn as_handle(&self) -> BorrowedHandle<'_> {
        self.0.as_handle()
    }
}

fn information(
    token: BorrowedHandle<'_>,
    class: TOKEN_INFORMATION_CLASS,
) -> io::Result<Vec<usize>> {
    let mut bytes = 0;
    unsafe {
        GetTokenInformation(token.as_raw_handle(), class, ptr::null_mut(), 0, &mut bytes);
    }
    if bytes == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    success(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            class,
            buffer.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    })?;
    Ok(buffer)
}

fn success(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
