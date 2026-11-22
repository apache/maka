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

use super::{
    Account,
    account::{NetBuffer, string, wide},
    checked,
};
use std::{io, ptr};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{ERROR_ALIAS_EXISTS, ERROR_MEMBER_IN_ALIAS, ERROR_NO_SUCH_ALIAS},
    NetworkManagement::NetManagement::*,
    Security::{Authorization::ConvertSidToStringSidW, LookupAccountNameW, SidTypeAlias},
};

/// Installation-owned read identity. Membership never confers write capability.
pub struct ReadGroup {
    id: Uuid,
    owner: String,
}

impl ReadGroup {
    pub fn new(id: Uuid, owner: &str) -> io::Result<Self> {
        super::sid(owner)?;
        Ok(Self {
            id,
            owner: owner.into(),
        })
    }

    fn name(&self) -> String {
        format!("maka-r-{}", self.id.simple())
    }

    fn marker(&self) -> String {
        format!("Maka sandbox reads {} owner {}", self.id, self.owner)
    }

    /// Administrative provisioning; verify the marker before adopting a name.
    pub fn ensure(&self, accounts: &[&Account]) -> io::Result<String> {
        if self.resolve()?.is_none() {
            let mut name = wide(&self.name());
            let mut comment = wide(&self.marker());
            let info = LOCALGROUP_INFO_1 {
                lgrpi1_name: name.as_mut_ptr(),
                lgrpi1_comment: comment.as_mut_ptr(),
            };
            let status = unsafe {
                NetLocalGroupAdd(
                    ptr::null(),
                    1,
                    (&info as *const LOCALGROUP_INFO_1).cast(),
                    ptr::null_mut(),
                )
            };
            if status != ERROR_ALIAS_EXISTS && status != NERR_GroupExists {
                checked(status)?;
            }
        }
        let sid = self
            .resolve()?
            .ok_or_else(|| io::Error::other("sandbox read group disappeared"))?;
        for account in accounts {
            if account.owner() != self.owner {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "foreign sandbox group member",
                ));
            }
            let member = super::sid(account.sid())?;
            let info = LOCALGROUP_MEMBERS_INFO_0 {
                lgrmi0_sid: member.0,
            };
            let status = unsafe {
                NetLocalGroupAddMembers(
                    ptr::null(),
                    wide(&self.name()).as_ptr(),
                    0,
                    (&info as *const LOCALGROUP_MEMBERS_INFO_0).cast(),
                    1,
                )
            };
            if status != ERROR_MEMBER_IN_ALIAS {
                checked(status)?;
            }
        }
        Ok(sid)
    }

    pub fn resolve(&self) -> io::Result<Option<String>> {
        let name = wide(&self.name());
        let mut data = ptr::null_mut();
        let status = unsafe { NetLocalGroupGetInfo(ptr::null(), name.as_ptr(), 1, &mut data) };
        if status == NERR_GroupNotFound || status == ERROR_NO_SUCH_ALIAS {
            return Ok(None);
        }
        checked(status)?;
        let buffer = NetBuffer(data);
        let info = unsafe { &*buffer.0.cast::<LOCALGROUP_INFO_1>() };
        if unsafe { string(info.lgrpi1_comment) } != self.marker() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sandbox read group belongs to another installation",
            ));
        }
        let mut bytes = 0;
        let mut length = 0;
        let mut kind = 0;
        unsafe {
            LookupAccountNameW(
                ptr::null(),
                name.as_ptr(),
                ptr::null_mut(),
                &mut bytes,
                ptr::null_mut(),
                &mut length,
                &mut kind,
            );
        }
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut sid = vec![0u32; (bytes as usize).div_ceil(4)];
        let mut domain = vec![0u16; length as usize];
        if unsafe {
            LookupAccountNameW(
                ptr::null(),
                name.as_ptr(),
                sid.as_mut_ptr().cast(),
                &mut bytes,
                domain.as_mut_ptr(),
                &mut length,
                &mut kind,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if kind != SidTypeAlias {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sandbox read identity is not a local group",
            ));
        }
        let mut text = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid.as_mut_ptr().cast(), &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let _text = super::LocalMemory(text.cast());
        Ok(Some(unsafe { string(text) }))
    }

    pub fn remove(&self) -> io::Result<()> {
        if self.resolve()?.is_some() {
            checked(unsafe { NetLocalGroupDel(ptr::null(), wide(&self.name()).as_ptr()) })?;
        }
        Ok(())
    }
}
