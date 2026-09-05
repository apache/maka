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

use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::iter;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
    WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile;
use windows_sys::Win32::Security::{
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, GetFileInformationByHandle, OPEN_EXISTING,
};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

use crate::broker_pipe_security::pipe_security_sddl;
use crate::protocol::LaunchRequest;
use crate::windows_launcher::{appcontainer_profile_name, current_user_sid_string, sid_string};

pub(crate) const LEDGER_VERSION: u8 = 2;
const ACL_MUTEX_TIMEOUT_MS: u32 = 30_000;

/// The ledger directory, the icacls grants and the AppContainer profiles are
/// all shared across every session of the user, so the locks that arbitrate
/// them must be machine-wide too. A `Local\` object would be private to one
/// Terminal Services session: a concurrent console/RDP session could not see
/// a live lease and would recover grants that are still in use. The names are
/// scoped by the owning user's SID and the objects carry an explicit
/// SYSTEM+user-only DACL, so another user can neither open them nor learn
/// anything from them. A squatted name fails closed at acquisition: a
/// restrictive squat is rejected by its own DACL, and a permissive squat is
/// rejected by the pre-existing-owner check in `LedgerLock::try_acquire`
/// (the DACL we pass is ignored for an object that already exists).
pub(crate) fn acl_mutex_name(user_sid: &str) -> String {
    format!(r"Global\Maka.WindowsSandbox.AclLedger.v2.{user_sid}")
}

/// Serializes the readiness probe's AppContainer profile lifecycle. The probe
/// profile (`maka.readiness.<hash>`) is a per-user, machine-wide registration
/// just like the ledger's objects, so two concurrent probes in different
/// sessions would otherwise delete→create→drop each other's live profile. The
/// lease is scoped by SID and carries the same SYSTEM+owner-only DACL as the
/// ledger mutex (see [`acl_mutex_name`]), so it is `Global\` for the identical
/// cross-session reason and fails closed against a squatted name.
pub(crate) fn readiness_mutex_name(user_sid: &str) -> String {
    format!(r"Global\Maka.WindowsSandbox.ReadinessProfile.v1.{user_sid}")
}

/// Timeout for acquiring the readiness profile lease. The readiness probe is a
/// short throwaway `cmd.exe /c exit 0`, so a same-user contender releases the
/// lease well within this bound; exceeding it means a stuck holder and the
/// probe fails closed rather than racing the profile lifecycle unlocked.
pub(crate) const READINESS_MUTEX_TIMEOUT_MS: u32 = 30_000;

/// Distinguishes launch failures by whether the Job was proven empty.
/// Cleanup semantics differ: a settled failure may release grants and
/// ledger normally, while an unsettled one must preserve its recovery
/// state because processes may still hold the launch identity.
#[derive(Debug)]
pub enum LaunchFailure {
    /// The failure completed with the Job proven empty.
    Settled(String),
    /// Termination, waiting or Job accounting failed: the Job could not be
    /// proven empty.
    Unsettled(String),
}

impl From<String> for LaunchFailure {
    fn from(message: String) -> Self {
        Self::Settled(message)
    }
}

impl LaunchFailure {
    pub fn into_message(self) -> String {
        match self {
            Self::Settled(message) => message,
            Self::Unsettled(message) => format!("launch left an unsettled Job: {message}"),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Ledger {
    pub(crate) version: u8,
    pub(crate) request_id: String,
    pub(crate) app_container_sid: String,
    pub(crate) roots: Vec<LedgerRoot>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LedgerRoot {
    pub(crate) path: String,
    pub(crate) read: bool,
    pub(crate) write: bool,
    pub(crate) read_recursive: bool,
    pub(crate) write_recursive: bool,
    /// Absent in ledgers written before ACL backups existed; recovery then
    /// falls back to removing this ledger's AppContainer SID grants.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) backup_path: Option<String>,
}

pub fn with_acl_grants<T>(
    request: &LaunchRequest,
    app_container_sid: &str,
    launch: impl FnOnce() -> Result<T, LaunchFailure>,
) -> Result<T, LaunchFailure> {
    if request.read_roots.is_empty() && request.write_roots.is_empty() {
        return launch();
    }
    let user_sid = current_user_sid_string()?;
    let ledger_root = std::env::temp_dir().join("maka-sandbox-acl-ledgers");
    fs::create_dir_all(&ledger_root)
        .map_err(|error| format!("create ACL ledger directory failed: {error}"))?;
    let roots = collect_roots(request)?;
    let ledger = Ledger {
        version: LEDGER_VERSION,
        request_id: request.request_id.clone(),
        app_container_sid: app_container_sid.to_owned(),
        roots,
    };
    let ledger_name = format!("{:x}.json", Sha256::digest(request.request_id.as_bytes()));
    let ledger_path = ledger_root.join(ledger_name);
    // The per-request lease stays owned through child execution and cleanup.
    // Recovery can therefore distinguish a live ledger from one abandoned by
    // a crashed process without serializing unrelated launches.
    let _lease = LedgerLock::acquire(
        &ledger_lease_name(&user_sid, &request.request_id),
        &user_sid,
        ACL_MUTEX_TIMEOUT_MS,
    )?;
    {
        // The OS owns mutex recovery: a crashed process abandons the mutex and
        // the next waiter acquires it without parsing a PID file. It protects
        // only ACL/ledger mutation, never the child lifetime, so independent
        // per-launch AppContainer identities can execute concurrently.
        let _lock =
            LedgerLock::acquire(&acl_mutex_name(&user_sid), &user_sid, ACL_MUTEX_TIMEOUT_MS)?;
        recover_stale(&ledger_root, &user_sid)?;
        write_ledger(&ledger_path, &ledger)?;
        if let Err(error) = grant_roots(app_container_sid, &ledger.roots) {
            let restore = remove_grants(&ledger);
            if restore.is_ok() {
                let _ = fs::remove_file(&ledger_path);
            }
            return Err(LaunchFailure::Settled(match restore {
                Ok(()) => error,
                Err(restore) => format!("{error}; ACL cleanup also failed: {restore}"),
            }));
        }
    }

    // Only a launch whose Job is proven empty may enter normal cleanup. An
    // unsettled Job may still contain processes holding this launch identity,
    // so its grants stay in place and the ledger is quarantined — preserving
    // the recovery record for inspection instead of erasing it while the
    // boundary might still be live. Recovery never interprets quarantined
    // ledgers, and every launch uses a fresh AppContainer identity, so no
    // later child can inherit this authority.
    let launch_result = match launch() {
        Err(LaunchFailure::Unsettled(error)) => {
            let quarantine = {
                let _lock = LedgerLock::acquire(
                    &acl_mutex_name(&user_sid),
                    &user_sid,
                    ACL_MUTEX_TIMEOUT_MS,
                )?;
                quarantine_ledger(
                    &ledger_path,
                    &format!("launch left an unsettled Job: {error}"),
                )
            };
            return Err(LaunchFailure::Unsettled(match quarantine {
                Ok(()) => format!("{error}; recovery state preserved for inspection"),
                Err(quarantine) => {
                    format!("{error}; quarantining recovery state also failed: {quarantine}")
                }
            }));
        }
        other => other,
    };
    let restore_result = {
        let _lock =
            LedgerLock::acquire(&acl_mutex_name(&user_sid), &user_sid, ACL_MUTEX_TIMEOUT_MS)?;
        let result = remove_grants(&ledger);
        if result.is_ok() {
            fs::remove_file(&ledger_path)
                .map_err(|error| format!("remove completed ACL ledger failed: {error}"))?;
        }
        result
    };
    match (launch_result, restore_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(restore)) => Err(LaunchFailure::Settled(restore)),
        (Err(error), Err(restore)) => Err(LaunchFailure::Settled(format!(
            "{}; ACL cleanup also failed: {restore}",
            error.into_message()
        ))),
    }
}

pub(crate) struct LedgerLock {
    handle: HANDLE,
}

impl LedgerLock {
    pub(crate) fn acquire(name: &str, user_sid: &str, timeout_ms: u32) -> Result<Self, String> {
        Self::try_acquire(name, user_sid, timeout_ms)?.ok_or_else(|| {
            if name.contains(".AclLease.") {
                "acquire ACL ledger lease timed out".to_owned()
            } else if name.contains(".ReadinessProfile.") {
                "acquire readiness profile lease timed out".to_owned()
            } else {
                "acquire ACL ledger mutex timed out".to_owned()
            }
        })
    }

    fn try_acquire(name: &str, user_sid: &str, timeout_ms: u32) -> Result<Option<Self>, String> {
        // Machine-wide named objects are creatable by any local user, so the
        // lock is born with an explicit SYSTEM+owner-only DACL instead of the
        // default token DACL. That DACL only protects a mutex *we* created:
        // `CreateMutexW` ignores the supplied security descriptor when the name
        // already exists and simply opens the existing object. A restrictive
        // squatter is rejected by its own DACL (open fails, we fail closed),
        // but a *permissive* squatter would hand us an attacker-owned
        // arbitration object we would then block on. So when the object
        // pre-existed (`ERROR_ALREADY_EXISTS` — also the normal same-user
        // contention path), the owner is verified to be the current user or
        // SYSTEM before any wait; anything else fails closed.
        let sddl = lock_sddl(user_sid)?;
        let descriptor = lock_security_descriptor(&sddl)?;
        let mut attributes: SECURITY_ATTRIBUTES = unsafe { std::mem::zeroed() };
        attributes.nLength = size_of::<SECURITY_ATTRIBUTES>() as u32;
        attributes.lpSecurityDescriptor = descriptor as *mut std::ffi::c_void;
        attributes.bInheritHandle = 0;
        let name = wide(name);
        let handle = unsafe { CreateMutexW(&attributes, 0, name.as_ptr()) };
        // Read the last error before any other call can clobber it.
        let already_exists = !handle.is_null() && unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let create_error = if handle.is_null() {
            Some(last_error("CreateMutexW(ACL ledger mutex)"))
        } else {
            None
        };
        unsafe { LocalFree(descriptor as *mut std::ffi::c_void) };
        if let Some(error) = create_error {
            return Err(error);
        }
        if already_exists {
            if let Err(error) = validate_existing_lock_owner(handle, user_sid) {
                unsafe { CloseHandle(handle) };
                return Err(error);
            }
        }
        let wait = unsafe { WaitForSingleObject(handle, timeout_ms) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            return Ok(Some(Self { handle }));
        }
        unsafe { CloseHandle(handle) };
        if wait == WAIT_TIMEOUT {
            return Ok(None);
        }
        Err(last_error("WaitForSingleObject(ACL ledger mutex)"))
    }
}

/// Security descriptor for a named lock. Beyond the SYSTEM+user-only DACL, the
/// owner is pinned explicitly to the user SID: without `O:`, the object owner
/// comes from the creating token's *default* owner, which is the user SID for a
/// standard token but `BUILTIN\Administrators` for an elevated one — so the
/// same user's elevated and non-elevated processes would create locks with
/// different owners and each reject the other's legitimate lock. Pinning the
/// owner makes the lock's identity elevation-independent (the user SID is
/// always an assignable owner for the user's own token, elevated or not).
pub(crate) fn lock_sddl(user_sid: &str) -> Result<String, String> {
    let dacl = pipe_security_sddl(user_sid)
        .map_err(|error| format!("invalid ACL lock owner SID: {error:?}"))?;
    Ok(format!("O:{user_sid}{dacl}"))
}

/// Owner check for a named lock that existed before this process created it.
/// The pre-existing object keeps whatever security descriptor its creator gave
/// it, so ownership is the one property a permissive squatter cannot forge:
/// re-owning an object to another SID requires SeTakeOwnership/SeRestore, which
/// standard users do not hold. Legitimate owners are exactly three: the current
/// user SID (what `lock_sddl` pins at creation, in any elevation state),
/// SYSTEM, and `BUILTIN\Administrators` — the last because locks created by
/// builds that predate the owner pinning (or by other elevated tooling of this
/// user) carry the elevated token's default owner, and whoever can create
/// Administrators-owned objects is an elevated administrator, which RFC §1/§5
/// explicitly does not defend against. Any other owner means the name was
/// squatted and arbitration must fail closed instead of blocking on an
/// attacker-held mutex.
fn validate_existing_lock_owner(handle: HANDLE, user_sid: &str) -> Result<(), String> {
    const SYSTEM_SID: &str = "S-1-5-18";
    const ADMINISTRATORS_SID: &str = "S-1-5-32-544";
    let mut owner: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(format!(
            "GetSecurityInfo(pre-existing lock owner) failed with error {status}"
        ));
    }
    let rendered = unsafe { sid_string(owner) };
    unsafe { LocalFree(descriptor as *mut std::ffi::c_void) };
    let rendered = rendered?;
    if rendered.eq_ignore_ascii_case(user_sid)
        || rendered == SYSTEM_SID
        || rendered == ADMINISTRATORS_SID
    {
        return Ok(());
    }
    Err(format!(
        "pre-existing lock is owned by {rendered}, not the current user \
         ({user_sid}), SYSTEM, or Administrators; refusing to arbitrate on a \
         squatted mutex"
    ))
}

fn lock_security_descriptor(sddl: &str) -> Result<PSECURITY_DESCRIPTOR, String> {
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let sddl_wide = wide(sddl);
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(last_error(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW(ACL lock)",
        ));
    }
    Ok(descriptor)
}

impl Drop for LedgerLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
    }
}

pub(crate) fn collect_roots(request: &LaunchRequest) -> Result<Vec<LedgerRoot>, String> {
    let mut roots = Vec::new();
    for path in request.read_roots.iter().chain(&request.write_roots) {
        if roots
            .iter()
            .any(|entry: &LedgerRoot| entry.path.eq_ignore_ascii_case(path))
        {
            continue;
        }
        // A root that does not exist yet (e.g. the exact target of a write
        // that will create the file) has nothing to grant; access to it is
        // governed by its existing ancestor's grants. Skipping keeps the
        // default-deny posture rather than failing the launch.
        let metadata = match fs::symlink_metadata(Path::new(path)) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("inspect ACL root {path} failed: {error}"));
            }
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("ACL root contains a reparse point: {path}"));
        }
        // An icacls grant lands on the file object, not the name: every NTFS
        // hard link — including aliases outside the declared root — shares the
        // DACL that the grant mutates. Path-keyed admission cannot enumerate
        // those aliases, so multi-link files fail closed here; handle/file-ID
        // keyed admission is follow-up work. Directories cannot be
        // hard-linked on NTFS, so only files need the check.
        if !metadata.is_dir() {
            reject_multi_link_file(Path::new(path))?;
        }
        // Only a recursive grant extends into the tree, so only a recursive
        // grant requires the tree to be alias-free. Exact roots (e.g. the
        // cwd metadata anchor) may legitimately contain junctions deeper in
        // the workspace that the sandbox never grants.
        let recursive_read = contains_path(&request.read_roots, path)
            && !contains_path(&request.exact_read_roots, path);
        let recursive_write = contains_path(&request.write_roots, path)
            && !contains_path(&request.exact_write_roots, path);
        if metadata.is_dir() && (recursive_read || recursive_write) {
            reject_aliased_entries(Path::new(path))?;
        }
        roots.push(LedgerRoot {
            path: path.clone(),
            read: contains_path(&request.read_roots, path),
            write: contains_path(&request.write_roots, path),
            read_recursive: metadata.is_dir() && recursive_read,
            write_recursive: metadata.is_dir() && recursive_write,
            backup_path: None,
        });
    }
    Ok(roots)
}

fn contains_path(paths: &[String], path: &str) -> bool {
    paths.iter().any(|entry| entry.eq_ignore_ascii_case(path))
}

/// Rejects reparse points and multi-link files anywhere in a recursively
/// granted tree. An `(OI)(CI)` grant propagates inherited ACEs onto the
/// existing children at grant time, so a file inside the tree that also has a
/// hard link outside it would carry the grant past the declared root.
fn reject_aliased_entries(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect ACL root {} failed: {error}", path.display()))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!(
            "ACL root contains a reparse point: {}",
            path.display()
        ));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)
            .map_err(|error| format!("scan ACL root {} failed: {error}", path.display()))?
        {
            let entry = entry.map_err(|error| format!("scan ACL root failed: {error}"))?;
            reject_aliased_entries(&entry.path())?;
        }
    } else {
        reject_multi_link_file(path)?;
    }
    Ok(metadata)
}

/// Fails closed on files whose kernel link count exceeds one. The DACL that a
/// grant mutates belongs to the file object shared by every hard link, so a
/// path-keyed admission that only sees one alias must not grant through it.
fn reject_multi_link_file(path: &Path) -> Result<(), String> {
    let wide_path = wide(&path.to_string_lossy());
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error(&format!(
            "CreateFileW(inspect ACL root {})",
            path.display()
        )));
    }
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let queried = unsafe { GetFileInformationByHandle(handle, &mut information) };
    unsafe { CloseHandle(handle) };
    if queried == 0 {
        return Err(last_error(&format!(
            "GetFileInformationByHandle(ACL root {})",
            path.display()
        )));
    }
    if information.nNumberOfLinks > 1 {
        return Err(format!(
            "ACL root contains a multi-link file: {}",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn write_ledger(path: &Path, ledger: &Ledger) -> Result<(), String> {
    let bytes = serde_json::to_vec(ledger).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("create ACL ledger failed: {error}"))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("persist ACL ledger failed: {error}"))
}

pub(crate) fn recover_stale(root: &Path, user_sid: &str) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| format!("read ACL ledgers failed: {error}"))? {
        let path = entry
            .map_err(|error| format!("read ACL ledger entry failed: {error}"))?
            .path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let source = fs::read(&path)
            .map_err(|error| format!("read stale ACL ledger {} failed: {error}", path.display()))?;
        let ledger: Ledger = match serde_json::from_slice(&source) {
            Ok(ledger) => ledger,
            Err(error) => {
                quarantine_ledger(&path, &format!("invalid stale ACL ledger: {error}"))?;
                continue;
            }
        };
        if ledger.version != LEDGER_VERSION {
            quarantine_ledger(
                &path,
                &format!("unsupported ACL ledger version {}", ledger.version),
            )?;
            continue;
        }
        let lease_name = ledger_lease_name(user_sid, &ledger.request_id);
        let Some(_stale_lease) = LedgerLock::try_acquire(&lease_name, user_sid, 0)? else {
            // The owner keeps this request-specific mutex for the entire child
            // and cleanup lifetime. A busy lease means this is an active
            // ledger, not stale recovery work.
            continue;
        };
        // A root the user could grant but cannot un-grant (e.g. an ACL-locked
        // file deep in the tree) must not brick every future launch. This is
        // safe only because every request has a fresh AppContainer identity:
        // no later child can receive the quarantined ledger's SID.
        if let Err(error) = remove_grants(&ledger) {
            quarantine_ledger(&path, &format!("stale ACL ledger recovery failed: {error}"))?;
            continue;
        }
        let profile_name = appcontainer_profile_name(&ledger.request_id);
        unsafe { DeleteAppContainerProfile(profile_name.as_ptr()) };
        fs::remove_file(&path).map_err(|error| {
            format!("remove stale ACL ledger {} failed: {error}", path.display())
        })?;
    }
    Ok(())
}

fn grant_roots(sid: &str, ledger_roots: &[LedgerRoot]) -> Result<(), String> {
    for root in ledger_roots {
        if root.read {
            grant(&root.path, sid, "RX", root.read_recursive)?;
        }
        if root.write {
            grant(&root.path, sid, "M", root.write_recursive)?;
        }
    }
    Ok(())
}

pub(crate) fn ledger_lease_name(user_sid: &str, request_id: &str) -> String {
    format!(
        r"Global\Maka.WindowsSandbox.AclLease.{user_sid}.{:x}",
        Sha256::digest(request_id.as_bytes())
    )
}

fn grant(path: &str, sid: &str, access: &str, recursive: bool) -> Result<(), String> {
    let permission = if recursive {
        format!("*{sid}:(OI)(CI){access}")
    } else {
        format!("*{sid}:{access}")
    };
    let mut args = vec![path, "/grant", &permission, "/L", "/Q"];
    if recursive {
        args.push("/T");
    }
    run_icacls(&args, "grant")
}

/// Undo the grants recorded by a ledger by removing exactly this
/// AppContainer SID's ACEs. The broker's only ACL mutation is adding grants
/// for its own per-app SID, so targeted removal restores the prior state while
/// preserving every pre-existing ACE. `icacls /save`+`/restore` is not usable
/// here: `/restore` requires SeRestorePrivilege (fails in the non-elevated
/// desktop process) and saved entries are relative to the saved path's parent.
fn remove_grants(ledger: &Ledger) -> Result<(), String> {
    for root in &ledger.roots {
        // Backups written by older broker builds are obsolete; drop them.
        if let Some(backup) = root.backup_path.as_deref() {
            let _ = fs::remove_file(backup);
        }
        if !Path::new(&root.path).exists() {
            continue;
        }
        remove_sid_grants(
            &root.path,
            &ledger.app_container_sid,
            root.read_recursive || root.write_recursive,
        )?;
    }
    Ok(())
}

fn remove_sid_grants(path: &str, sid: &str, recursive: bool) -> Result<(), String> {
    let principal = format!("*{sid}");
    let mut args = vec![path, "/remove", &principal, "/L", "/Q"];
    if recursive {
        args.push("/T");
    }
    run_icacls(&args, "remove")
}

/// Preserve an unreadable ledger for inspection instead of letting one corrupt
/// file permanently block every future sandbox launch. The rename keeps the
/// evidence (`*.json.quarantined` no longer matches the recovery scan) and the
/// warning keeps the failure loud on stderr.
fn quarantine_ledger(path: &Path, reason: &str) -> Result<(), String> {
    let mut quarantined = path.as_os_str().to_owned();
    quarantined.push(".quarantined");
    let quarantined = PathBuf::from(quarantined);
    let _ = fs::remove_file(&quarantined);
    fs::rename(path, &quarantined)
        .map_err(|error| format!("quarantine ACL ledger {} failed: {error}", path.display()))?;
    eprintln!(
        "maka-windows-sandbox: {reason}; quarantined {} to {}",
        path.display(),
        quarantined.display()
    );
    Ok(())
}

fn run_icacls(args: &[&str], operation: &str) -> Result<(), String> {
    let executable = system_icacls()?;
    let output = Command::new(&executable)
        .args(args)
        .output()
        .map_err(|error| format!("start {} failed: {error}", executable.display()))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "icacls {operation} failed with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn system_icacls() -> Result<PathBuf, String> {
    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| "SystemRoot is unavailable to the broker".to_owned())?;
    let path = PathBuf::from(system_root)
        .join("System32")
        .join("icacls.exe");
    if !path.is_file() {
        return Err(format!("system icacls is unavailable: {}", path.display()));
    }
    Ok(path)
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(iter::once(0))
        .collect()
}

fn last_error(operation: &str) -> String {
    format!("{operation} failed: {}", std::io::Error::last_os_error())
}
