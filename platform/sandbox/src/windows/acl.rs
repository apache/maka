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

//! Identity-scoped ACL changes on an already pinned object. The setup owner
//! serializes mutations and records their recovery intent. Removal edits only
//! that identity's explicit ACEs; it never restores an old whole-object DACL.

mod coordinator;
mod target;
pub use target::{Removal, Target};

use super::{LocalMemory, checked};
use crate::filesystem::Scope;
use std::{fs::File, io, os::windows::io::AsRawHandle, ptr};
use windows_sys::Win32::{
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION_DS, AddAce, Authorization::*,
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, EqualSid, GetAce,
        GetSecurityDescriptorControl, INHERIT_ONLY_ACE, INHERITED_ACE, InitializeAcl,
        InitializeSecurityDescriptor, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
        SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED, SECURITY_DESCRIPTOR,
        SetSecurityDescriptorControl, SetSecurityDescriptorDacl,
    },
    Storage::FileSystem::{
        DELETE, FILE_ALL_ACCESS, FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, READ_CONTROL, WRITE_DAC, WRITE_OWNER,
    },
    System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE},
};

/// ACL entries, not a complete filesystem policy. A readable execution account
/// and a write-restricting capability SID have distinct roles in token checks.
#[derive(Clone, Copy)]
pub enum Permission {
    Read,
    Write,
    /// Inheritable writes without permission to rename this boundary itself.
    /// Used for writable ancestors containing a more restrictive child.
    WritePreserve,
    DenyWrite,
    Deny,
}

/// Optional grants must remain manageable without administrator membership.
/// Windows profiles are often SYSTEM-owned but explicitly grant their user
/// full control. Accept ownership or a grant to that exact user, never infer
/// authority from an elevated token's Administrators membership.
pub fn manageable_by(file: &File, identity: &str) -> io::Result<bool> {
    let identity = super::sid(identity)?;
    let mut owner = ptr::null_mut();
    let mut acl = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: the handle is live and the returned owner is held by descriptor.
    checked(unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut acl,
            ptr::null_mut(),
            &mut descriptor,
        )
    })?;
    let _descriptor = LocalMemory(descriptor);
    if !owner.is_null() && unsafe { EqualSid(owner, identity.0) } != 0 {
        return Ok(true);
    }
    if acl.is_null() {
        return Ok(false);
    }
    let mut mask = 0;
    for index in 0..unsafe { (*acl).AceCount } {
        let mut ace = ptr::null_mut();
        success(unsafe { GetAce(acl, u32::from(index), &mut ace) })?;
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
            || header.AceFlags & INHERIT_ONLY_ACE as u8 != 0
        {
            continue;
        }
        let entry = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        if unsafe { EqualSid(ptr::addr_of!(entry.SidStart).cast_mut().cast(), identity.0) } != 0 {
            mask |= entry.Mask;
        }
    }
    let required = READ_CONTROL | WRITE_DAC;
    Ok(mask & windows_sys::Win32::Foundation::GENERIC_ALL != 0 || mask & required == required)
}

/// Observe an identity's existing read/execute grant without changing the DACL.
/// Used only to reuse completed preparation, not to publish partial propagation
/// as ready or to override a command's explicit deny policy.
pub fn allows_read(file: &File, identity: &str) -> io::Result<bool> {
    let sid = super::sid(identity)?;
    let mut acl = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    checked(unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut acl,
            ptr::null_mut(),
            &mut descriptor,
        )
    })?;
    let _descriptor = LocalMemory(descriptor);
    if acl.is_null() {
        return Ok(true);
    }
    let trustee = TRUSTEE_W {
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid.0.cast(),
        ..Default::default()
    };
    let mut mask = 0;
    checked(unsafe { GetEffectiveRightsFromAclW(acl, &trustee, &mut mask) })?;
    let read = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    Ok(mask & read == read)
}

/// Replace this identity's explicit standard allow/deny entries, preserving
/// other identities, inherited entries and other ACE types. None revokes those
/// standard entries. The file handle
/// must carry READ_CONTROL and WRITE_DAC and pin the authorized object.
pub fn set(
    file: &File,
    identity: &str,
    scope: Scope,
    permission: Option<Permission>,
) -> io::Result<()> {
    let _coordination = coordinator::Guard::acquire()?;
    let sid = super::sid(identity)?;
    let mut previous = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: live handle, writable outputs; descriptor owns the returned DACL.
    checked(unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut previous,
            ptr::null_mut(),
            &mut descriptor,
        )
    })?;
    let _descriptor = LocalMemory(descriptor);
    if previous.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "sandbox ACL mutation requires an explicit DACL",
        ));
    }
    // ACL buffers require DWORD alignment. Filtering first removes deny ACEs
    // too, without assuming REVOKE_ACCESS can reverse every ACE type we create.
    let mut storage = vec![0u32; unsafe { (*previous).AclSize as usize }.div_ceil(4)];
    let retained = storage.as_mut_ptr().cast::<ACL>();
    success(unsafe { InitializeAcl(retained, (storage.len() * 4) as u32, ACL_REVISION_DS) })?;
    let mut removed = false;
    // Recovery may resume a removal after the parent changed but before
    // Windows finished propagating it. Revisit descendants even if the
    // parent's own entry is already gone.
    let mut propagate = scope == Scope::Subtree;
    for index in 0..unsafe { (*previous).AceCount } {
        let mut ace = ptr::null_mut();
        success(unsafe { GetAce(previous, index as u32, &mut ace) })?;
        // SAFETY: GetSecurityInfo/GetAce return validated Windows ACL layouts.
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        let explicit = header.AceFlags & INHERITED_ACE as u8 == 0;
        let simple = matches!(
            u32::from(header.AceType),
            ACCESS_ALLOWED_ACE_TYPE | ACCESS_DENIED_ACE_TYPE
        );
        if explicit && simple {
            let entry = ace.cast::<ACCESS_ALLOWED_ACE>();
            let existing = unsafe { ptr::addr_of!((*entry).SidStart).cast_mut().cast() };
            if unsafe { EqualSid(existing, sid.0) } != 0 {
                removed = true;
                propagate |=
                    header.AceFlags & (CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE) as u8 != 0;
                continue;
            }
        }
        success(unsafe {
            AddAce(
                retained,
                ACL_REVISION_DS,
                u32::MAX,
                ace,
                header.AceSize as u32,
            )
        })?;
    }
    if !removed && permission.is_none() && !propagate {
        return Ok(());
    }
    let mut replacement = ptr::null_mut();
    let _replacement = if let Some(permission) = permission {
        let (mask, mode) = match permission {
            Permission::Read => (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, GRANT_ACCESS),
            Permission::Write | Permission::WritePreserve => (
                FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
                GRANT_ACCESS,
            ),
            Permission::DenyWrite => (
                (FILE_GENERIC_WRITE & !FILE_GENERIC_READ)
                    | DELETE
                    | FILE_DELETE_CHILD
                    | WRITE_DAC
                    | WRITE_OWNER,
                DENY_ACCESS,
            ),
            Permission::Deny => (FILE_ALL_ACCESS, DENY_ACCESS),
        };
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: mask,
            grfAccessMode: mode,
            grfInheritance: if scope == Scope::Subtree {
                CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
            } else {
                0
            },
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid.0.cast(),
                ..Default::default()
            },
        };
        let mut entries = vec![access];
        if matches!(permission, Permission::WritePreserve) {
            entries.push(EXPLICIT_ACCESS_W {
                grfAccessPermissions: DELETE | FILE_DELETE_CHILD,
                grfAccessMode: DENY_ACCESS,
                grfInheritance: 0,
                Trustee: TRUSTEE_W {
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_UNKNOWN,
                    ptstrName: sid.0.cast(),
                    ..Default::default()
                },
            });
        }
        checked(unsafe {
            SetEntriesInAclW(
                entries.len() as u32,
                entries.as_ptr(),
                retained,
                &mut replacement,
            )
        })?;
        Some(LocalMemory(replacement.cast()))
    } else {
        None
    };
    let applied = if replacement.is_null() {
        retained
    } else {
        replacement
    };
    if !propagate {
        // SetSecurityInfo also walks descendants for *unchanged* inheritable
        // ACEs. A single-object edit must not reapply the entire parent's ACL
        // tree. The native handle API changes only the pinned object.
        let mut control = 0;
        let mut revision = 0;
        success(unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) })?;
        let mut exact = SECURITY_DESCRIPTOR::default();
        let exact = (&mut exact as *mut SECURITY_DESCRIPTOR).cast();
        success(unsafe { InitializeSecurityDescriptor(exact, 1) })?;
        success(unsafe { SetSecurityDescriptorDacl(exact, 1, applied, 0) })?;
        let flags = SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ;
        success(unsafe { SetSecurityDescriptorControl(exact, flags, control & flags) })?;
        let status = unsafe {
            windows_sys::Wdk::Storage::FileSystem::NtSetSecurityObject(
                file.as_raw_handle(),
                DACL_SECURITY_INFORMATION,
                exact,
            )
        };
        return if status >= 0 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(unsafe {
                windows_sys::Win32::Foundation::RtlNtStatusToDosError(status)
            } as i32))
        };
    }
    // Windows propagates inheritance without overwriting children's explicit
    // entries. Do not change owner, SACL or the existing inheritance protection.
    checked(unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            applied,
            ptr::null_mut(),
        )
    })
}

fn success(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
