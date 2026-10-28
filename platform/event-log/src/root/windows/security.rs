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
    LocalAllocation,
    account::{AccountSid, sid_text},
    checked, wide,
};
use std::{fs::File, io, os::windows::io::AsRawHandle, ptr};
use windows_sys::Win32::{
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
            SE_FILE_OBJECT, SetSecurityInfo,
        },
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetSecurityDescriptorDacl, IsWellKnownSid,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
        WinLocalSystemSid,
    },
    System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE},
};

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "object must be private to the current account and SYSTEM",
    )
}

fn validate_owner(info: &SecurityInfo, account: &AccountSid) -> io::Result<()> {
    // SAFETY: both SID pointers remain owned by account/info.
    if unsafe { EqualSid(info.owner, account.as_ptr()) } != 0 {
        return Ok(());
    }
    // SAFETY: SecurityInfo owns the SID returned by GetSecurityInfo.
    let owner = unsafe { sid_text(info.owner) }?;
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!(
            "object owner {owner} differs from current account {}; existing state was not adopted",
            account.text()?
        ),
    ))
}

/// Current-account owner, protected DACL, inheritable full access only for that
/// account and SYSTEM. Use at object creation, before any credential is written.
pub struct PrivateSecurity(LocalAllocation);
impl PrivateSecurity {
    pub fn current_account() -> io::Result<Self> {
        let sid = AccountSid::current()?.text()?;
        let sddl = wide(format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)").as_ref())?;
        let mut descriptor = ptr::null_mut();
        // SAFETY: NUL-terminated input and valid output pointer. Windows owns
        // descriptor layout and returns a LocalFree allocation.
        checked(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        })?;
        Ok(Self(LocalAllocation(descriptor)))
    }

    /// The returned raw descriptor pointer is valid only while self is alive.
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.0,
            bInheritHandle: 0,
        }
    }

    pub(super) fn restrict(&self, file: &File) -> io::Result<()> {
        let account = AccountSid::current()?;
        let current = SecurityInfo::read(file)?;
        validate_owner(&current, &account)?;
        let (mut present, mut defaulted, mut dacl) = (0, 0, ptr::null_mut());
        // SAFETY: descriptor was produced from a valid SDDL string.
        checked(unsafe {
            GetSecurityDescriptorDacl(self.0.0, &mut present, &mut dacl, &mut defaulted)
        })?;
        if present == 0 || dacl.is_null() {
            return Err(denied());
        }
        // SAFETY: borrowed handle and descriptor stay alive throughout the call.
        let status = unsafe {
            SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                dacl,
                ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        validate_private(file)
    }
}

struct SecurityInfo {
    _allocation: LocalAllocation,
    owner: windows_sys::Win32::Security::PSID,
    dacl: *mut ACL,
}
impl SecurityInfo {
    fn read(file: &File) -> io::Result<Self> {
        let (mut owner, mut dacl, mut descriptor) =
            (ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
        // SAFETY: handle remains open; returned SID/ACL are owned by descriptor.
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let info = Self {
            _allocation: LocalAllocation(descriptor),
            owner,
            dacl,
        };
        if info.owner.is_null() || info.dacl.is_null() {
            return Err(denied());
        }
        Ok(info)
    }
}

/// Validate the held object, not a separately resolved pathname. Unknown ACE
/// forms fail closed; inherited account/SYSTEM entries are valid for child files.
pub fn validate_private(file: &File) -> io::Result<()> {
    let info = SecurityInfo::read(file)?;
    let account = AccountSid::current()?;
    validate_owner(&info, &account)?;
    // SAFETY: Windows returned a valid ACL and owns its structural validation.
    for index in 0..unsafe { (*info.dacl).AceCount } {
        let mut ace = ptr::null_mut();
        checked(unsafe { GetAce(info.dacl, index as u32, &mut ace) })?;
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        // Standard denies only remove authority. Sandbox account exclusions
        // must not make an otherwise private recovery journal unreadable to its
        // own validator. Unknown ACE forms still fail closed below.
        if u32::from(header.AceType) == ACCESS_DENIED_ACE_TYPE
            && usize::from(header.AceSize) >= size_of::<ACCESS_ALLOWED_ACE>()
        {
            continue;
        }
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
            || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>()
        {
            return Err(denied());
        }
        // SAFETY: the validated ACE type identifies the SidStart field; the SID
        // extends within the OS-owned ACE and is valid for these SID APIs.
        let sid = unsafe { ptr::addr_of!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart) }
            .cast_mut()
            .cast();
        if unsafe { EqualSid(sid, account.as_ptr()) } == 0
            && unsafe { IsWellKnownSid(sid, WinLocalSystemSid) } == 0
        {
            return Err(denied());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, READ_CONTROL, WRITE_DAC,
    };

    fn descriptor(file: &File) -> String {
        use windows_sys::Win32::Security::Authorization::ConvertSecurityDescriptorToStringSecurityDescriptorW;
        let info = SecurityInfo::read(file).unwrap();
        let mut text = ptr::null_mut();
        // SAFETY: the queried descriptor remains owned by info; Windows allocates the output.
        checked(unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                info._allocation.0,
                SDDL_REVISION_1,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut text,
                ptr::null_mut(),
            )
        })
        .unwrap();
        let _allocation = LocalAllocation(text.cast());
        let mut length = 0;
        // SAFETY: successful conversion returns a NUL-terminated UTF-16 string.
        while unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).unwrap()
    }

    #[test]
    fn prepared_root_is_private_before_initialization_and_can_be_reopened() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("nested/root");
        let canonical = crate::root::prepare_directory(&path).unwrap();
        let directory = super::super::open_nofollow(&canonical, false).unwrap();
        validate_private(&directory).unwrap();
        let before = descriptor(&directory);
        assert_eq!(crate::root::prepare_directory(&path).unwrap(), canonical);
        assert_eq!(descriptor(&directory), before);
        let namespaces = crate::root::RootNamespaces {
            ownership: temporary.path().join("owners"),
            control: temporary.path().join("control"),
        };
        let owner = crate::root::RootOwner::create(&path, &namespaces).unwrap();
        let id = owner.root_id().to_owned();
        drop(owner);
        assert_eq!(
            crate::root::RootOwner::open(&path, &namespaces)
                .unwrap()
                .root_id(),
            id
        );
    }

    #[test]
    fn preparing_an_existing_directory_preserves_security_and_contents() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("existing");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("keep"), b"existing state").unwrap();
        let directory = super::super::open_nofollow(&path, false).unwrap();
        let before = descriptor(&directory);
        assert_eq!(
            crate::root::windows::create_private_directory(&path)
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists,
        );
        crate::root::prepare_directory(&path).unwrap();
        let namespaces = crate::root::RootNamespaces {
            ownership: temporary.path().join("owners"),
            control: temporary.path().join("control"),
        };
        assert!(crate::root::RootOwner::create(&path, &namespaces).is_err());
        assert_eq!(descriptor(&directory), before);
        assert_eq!(std::fs::read(path.join("keep")).unwrap(), b"existing state");
        assert!(!namespaces.ownership.exists());

        // Elevated Windows tokens can default newly created objects to Administrators.
        let info = SecurityInfo::read(&directory).unwrap();
        let account = AccountSid::current().unwrap();
        // SAFETY: the descriptor and account keep both SID pointers valid.
        if unsafe { EqualSid(info.owner, account.as_ptr()) } == 0 {
            let error = crate::root::windows::private_directory(&path).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            let message = error.to_string();
            assert!(message.contains(&path.display().to_string()), "{message}");
            assert!(message.contains(&account.text().unwrap()), "{message}");
            assert!(
                message.contains(&unsafe { sid_text(info.owner) }.unwrap()),
                "{message}"
            );
            assert_eq!(descriptor(&directory), before);
        }
    }

    #[test]
    fn private_objects_reject_public_access_and_preserve_owner_when_tightened() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private");
        crate::root::windows::private_directory(&path).unwrap();
        let directory = OpenOptions::new()
            .access_mode(READ_CONTROL | WRITE_DAC)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&path)
            .unwrap();
        validate_private(&directory).unwrap();
        let child = path.join("credential");
        let mut file = crate::root::windows::create_private_file(&child).unwrap();
        std::io::Write::write_all(&mut file, b"test-only").unwrap();
        assert_eq!(
            crate::root::windows::create_private_file(&child)
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(&child).unwrap(), b"test-only");
        validate_private(&File::open(&child).unwrap()).unwrap();

        let account = AccountSid::current().unwrap().text().unwrap();
        for (sddl, private) in [
            ("D:P(A;OICI;FA;;;WD)".to_owned(), false),
            (
                format!("D:P(D;;FR;;;S-1-5-21-1-2-3-4567)(A;OICI;FA;;;{account})(A;OICI;FA;;;SY)"),
                true,
            ),
        ] {
            let public = wide(sddl.as_ref()).unwrap();
            let mut descriptor = ptr::null_mut();
            // SAFETY: this test grants Everyone access only to its temporary directory.
            checked(unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    public.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    ptr::null_mut(),
                )
            })
            .unwrap();
            let allocation = LocalAllocation(descriptor);
            let (mut present, mut defaulted, mut dacl) = (0, 0, ptr::null_mut());
            checked(unsafe {
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
            })
            .unwrap();
            assert_ne!(present, 0);
            assert_eq!(
                unsafe {
                    SetSecurityInfo(
                        directory.as_raw_handle(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        dacl,
                        ptr::null_mut(),
                    )
                },
                0
            );
            drop(allocation);
            let result = validate_private(&directory);
            if private {
                result.unwrap();
            } else {
                assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
            }
        }
        crate::root::windows::private_directory(&path).unwrap();
        validate_private(&directory).unwrap();
        validate_private(&File::open(child).unwrap()).unwrap();
    }
}
