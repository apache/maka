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

use super::checked;
mod visibility;
use serde::{Deserialize, Serialize};
use std::{io, ptr};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::LocalFree, NetworkManagement::NetManagement::*,
    Security::Authorization::ConvertSidToStringSidW,
};

/// Persist this identity before touching the account database. The full UUID in
/// the account comment distinguishes crash recovery from a name collision.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountId {
    id: Uuid,
    owner: String,
}

impl AccountId {
    pub fn new(id: Uuid, owner: &str) -> io::Result<Self> {
        super::sid(owner)?;
        Ok(Self {
            id,
            owner: owner.into(),
        })
    }

    pub fn owner(&self) -> &str {
        &self.owner
    }

    pub fn name(&self) -> String {
        format!("maka-s-{}", &self.id.simple().to_string()[..12])
    }

    fn marker(&self) -> String {
        format!("Maka sandbox {} owner {}", self.id, self.owner)
    }

    /// Administrative setup only. Existing matching accounts retain their
    /// enabled state; newly created accounts remain disabled until policy setup.
    pub fn ensure(&self, password: &[u16]) -> io::Result<Account> {
        if let Some(account) = self.resolve()? {
            visibility::hide(&self.name())?;
            return Ok(account);
        }
        if !(2..=257).contains(&password.len())
            || password.last() != Some(&0)
            || password[..password.len() - 1].contains(&0)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid account password",
            ));
        }
        let mut name = wide(&self.name());
        let mut comment = wide(&self.marker());
        let user = USER_INFO_1 {
            usri1_name: name.as_mut_ptr(),
            usri1_password: password.as_ptr().cast_mut(),
            usri1_comment: comment.as_mut_ptr(),
            usri1_priv: USER_PRIV_USER,
            usri1_flags: flags(false),
            ..Default::default()
        };
        let status = unsafe {
            NetUserAdd(
                ptr::null(),
                1,
                (&user as *const USER_INFO_1).cast(),
                ptr::null_mut(),
            )
        };
        if status != NERR_UserExists {
            checked(status)?;
        }
        let account = self
            .resolve()?
            .ok_or_else(|| io::Error::other("created account is missing"))?;
        visibility::hide(&self.name())?;
        Ok(account)
    }

    /// Recoverable even if account deletion committed before the hidden-user
    /// registry value was removed. Never touches another user's value or key.
    pub fn remove(&self) -> io::Result<()> {
        if let Some(account) = self.resolve()? {
            account.set_enabled(false)?;
            checked(unsafe { NetUserDel(ptr::null(), wide(&self.name()).as_ptr()) })?;
        }
        visibility::remove(&self.name())
    }

    pub fn resolve(&self) -> io::Result<Option<Account>> {
        let mut data = ptr::null_mut();
        let status =
            unsafe { NetUserGetInfo(ptr::null(), wide(&self.name()).as_ptr(), 23, &mut data) };
        if status == NERR_UserNotFound {
            return Ok(None);
        }
        checked(status)?;
        let owner = NetBuffer(data);
        let info = unsafe { &*owner.0.cast::<USER_INFO_23>() };
        if unsafe { string(info.usri23_comment) } != self.marker() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sandbox account name is owned by another installation",
            ));
        }
        let mut text = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(info.usri23_user_sid, &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let sid = unsafe { string(text) };
        unsafe { LocalFree(text.cast()) };
        Ok(Some(Account {
            id: self.clone(),
            sid,
            enabled: info.usri23_flags & UF_ACCOUNTDISABLE == 0,
        }))
    }
}

/// An observed OS account, not a credential or an execution authorization.
pub struct Account {
    id: AccountId,
    sid: String,
    enabled: bool,
}
impl Account {
    pub fn owner(&self) -> &str {
        self.id.owner()
    }
    pub fn name(&self) -> String {
        self.id.name()
    }
    pub fn sid(&self) -> &str {
        &self.sid
    }
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&self, enabled: bool) -> io::Result<()> {
        self.validate()?;
        let info = USER_INFO_1008 {
            usri1008_flags: flags(enabled),
        };
        checked(unsafe {
            NetUserSetInfo(
                ptr::null(),
                wide(&self.name()).as_ptr(),
                1008,
                (&info as *const USER_INFO_1008).cast(),
                ptr::null_mut(),
            )
        })
    }

    /// The installation owner must hold its exclusive lifecycle lease and drain
    /// accepted executions before deleting the account or its network rules.
    pub fn remove(&self) -> io::Result<()> {
        if self.id.resolve()?.is_none() {
            return self.id.remove();
        }
        self.validate()?;
        self.id.remove()
    }

    fn validate(&self) -> io::Result<()> {
        match self.id.resolve()? {
            Some(current) if current.sid == self.sid => Ok(()),
            _ => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sandbox account identity changed",
            )),
        }
    }
}

fn flags(enabled: bool) -> USER_ACCOUNT_FLAGS {
    UF_SCRIPT
        | UF_NORMAL_ACCOUNT
        | UF_PASSWD_CANT_CHANGE
        | UF_DONT_EXPIRE_PASSWD
        | if enabled { 0 } else { UF_ACCOUNTDISABLE }
}

pub(super) fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

// Inputs are NUL-terminated strings owned by NetUserGetInfo or LocalAlloc.
pub(super) unsafe fn string(value: *const u16) -> String {
    if value.is_null() {
        return String::new();
    }
    let mut len = 0;
    unsafe {
        while *value.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(value, len))
    }
}

pub(super) struct NetBuffer(pub(super) *mut u8);
impl Drop for NetBuffer {
    fn drop(&mut self) {
        unsafe { NetApiBufferFree(self.0.cast()) };
    }
}
