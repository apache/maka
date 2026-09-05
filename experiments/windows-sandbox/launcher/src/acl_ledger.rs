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
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
    OPEN_EXISTING,
};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

use crate::broker_pipe_security::pipe_security_sddl;
use crate::protocol::LaunchRequest;
use crate::windows_launcher::{appcontainer_profile_name, current_user_sid_string, sid_string};

pub(crate) const LEDGER_VERSION: u8 = 2;
const ACL_MUTEX_TIMEOUT_MS: u32 = 30_000;
const MAX_NON_FOLLOWING_READ_GRANTS: usize = 4_096;
const MAX_NON_FOLLOWING_READ_ENTRIES: usize = 100_000;
const MAX_NON_FOLLOWING_READ_DEPTH: usize = 256;

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
    if let Some(non_following_root) = request.non_following_read_root.as_deref() {
        if !contains_path(&request.read_roots, non_following_root)
            || contains_path(&request.exact_read_roots, non_following_root)
        {
            return Err("nonFollowingReadRoot must name a declared recursive readRoot".to_owned());
        }
        if !request.write_roots.is_empty() || !request.exact_write_roots.is_empty() {
            return Err("nonFollowingReadRoot requires a read-only launch".to_owned());
        }
        let source = request
            .non_following_read_root_source
            .as_deref()
            .ok_or_else(|| "nonFollowingReadRoot requires nonFollowingReadRootSource".to_owned())?;
        validate_non_following_read_root_source(Path::new(source), Path::new(non_following_root))?;
    } else if request.non_following_read_root_source.is_some() {
        return Err("nonFollowingReadRootSource requires nonFollowingReadRoot".to_owned());
    } else if request.non_following_read_root_max_depth.is_some() {
        return Err("nonFollowingReadRootMaxDepth requires nonFollowingReadRoot".to_owned());
    }
    for path in request.read_roots.iter().chain(&request.write_roots) {
        if request
            .non_following_read_root
            .as_deref()
            .is_some_and(|root| root.eq_ignore_ascii_case(path))
        {
            let partitioned = partition_non_following_read_root(
                Path::new(path),
                request
                    .non_following_read_root_max_depth
                    .map(|depth| depth as usize),
            )?;
            for root in partitioned {
                upsert_ledger_root(&mut roots, root);
            }
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
        upsert_ledger_root(
            &mut roots,
            LedgerRoot {
                path: path.clone(),
                read: contains_path(&request.read_roots, path),
                write: contains_path(&request.write_roots, path),
                read_recursive: metadata.is_dir() && recursive_read,
                write_recursive: metadata.is_dir() && recursive_write,
                backup_path: None,
            },
        );
    }
    Ok(roots)
}

fn contains_path(paths: &[String], path: &str) -> bool {
    paths.iter().any(|entry| entry.eq_ignore_ascii_case(path))
}

fn upsert_ledger_root(roots: &mut Vec<LedgerRoot>, root: LedgerRoot) {
    if let Some(existing) = roots
        .iter_mut()
        .find(|entry| entry.path.eq_ignore_ascii_case(&root.path))
    {
        existing.read |= root.read;
        existing.write |= root.write;
        existing.read_recursive |= root.read_recursive;
        existing.write_recursive |= root.write_recursive;
        return;
    }
    roots.push(root);
}

struct DirectoryReadPlan {
    clean: bool,
    roots: Vec<LedgerRoot>,
}

struct NonFollowingDirectoryBudget {
    remaining: usize,
    limit: usize,
}

impl NonFollowingDirectoryBudget {
    fn new(limit: usize) -> Self {
        Self {
            remaining: limit,
            limit,
        }
    }

    fn consume(&mut self) -> Result<(), String> {
        if self.remaining == 0 {
            return Err(format!(
                "nonFollowingReadRoot exceeds the safe directory scan limit of {} entries",
                self.limit
            ));
        }
        self.remaining -= 1;
        Ok(())
    }
}

/// Decomposes one read-only recursive root into physical grants that let a
/// non-following operation enumerate ordinary entries without granting or
/// traversing nested Windows reparse points. The root itself remains strict:
/// a reparse root is rejected instead of silently changing its meaning.
fn partition_non_following_read_root(
    path: &Path,
    traversal_depth: Option<usize>,
) -> Result<Vec<LedgerRoot>, String> {
    partition_non_following_read_root_with_options(
        path,
        MAX_NON_FOLLOWING_READ_GRANTS,
        MAX_NON_FOLLOWING_READ_ENTRIES,
        MAX_NON_FOLLOWING_READ_DEPTH,
        traversal_depth,
    )
}

pub(crate) fn partition_non_following_read_root_with_limit(
    path: &Path,
    max_grants: usize,
) -> Result<Vec<LedgerRoot>, String> {
    partition_non_following_read_root_with_options(
        path,
        max_grants,
        MAX_NON_FOLLOWING_READ_ENTRIES,
        MAX_NON_FOLLOWING_READ_DEPTH,
        None,
    )
}

pub(crate) fn partition_non_following_read_root_with_limits(
    path: &Path,
    max_grants: usize,
    max_entries: usize,
    max_depth: usize,
) -> Result<Vec<LedgerRoot>, String> {
    partition_non_following_read_root_with_options(path, max_grants, max_entries, max_depth, None)
}

pub(crate) fn partition_non_following_read_root_with_options(
    path: &Path,
    max_grants: usize,
    max_entries: usize,
    max_depth: usize,
    traversal_depth: Option<usize>,
) -> Result<Vec<LedgerRoot>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(format!(
                    "ACL root contains a reparse point: {}",
                    path.display()
                ));
            }
            if !metadata.is_dir() {
                return Err(format!(
                    "nonFollowingReadRoot must be a directory: {}",
                    path.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "inspect ACL root {} failed: {error}",
                path.display()
            ));
        }
    }
    if let Some(traversal_depth) = traversal_depth {
        let mut scan_budget = NonFollowingDirectoryBudget::new(max_entries);
        let roots = plan_bounded_non_following_directories(
            path,
            max_grants,
            &mut scan_budget,
            0,
            max_depth,
            traversal_depth,
        )?;
        ensure_non_following_grant_limit(roots.len(), max_grants)?;
        return Ok(roots);
    }
    let mut scan_budget = NonFollowingDirectoryBudget::new(max_entries);
    let roots =
        plan_non_following_directory(path, max_grants, &mut scan_budget, 0, max_depth)?.roots;
    ensure_non_following_grant_limit(roots.len(), max_grants)?;
    Ok(roots)
}

fn plan_bounded_non_following_directories(
    path: &Path,
    max_grants: usize,
    scan_budget: &mut NonFollowingDirectoryBudget,
    depth: usize,
    max_depth: usize,
    remaining_depth: usize,
) -> Result<Vec<LedgerRoot>, String> {
    if depth > max_depth {
        return Err(format!(
            "nonFollowingReadRoot exceeds the safe nested-directory limit of {max_depth} below the root"
        ));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect ACL root {} failed: {error}", path.display()))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(Vec::new());
    }
    if !metadata.is_dir() {
        return Err(format!(
            "expected a directory while partitioning ACL root: {}",
            path.display()
        ));
    }

    let mut roots = vec![read_root(path, false)?];
    ensure_non_following_grant_limit(roots.len(), max_grants)?;
    if remaining_depth == 0 {
        return Ok(roots);
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(path)
        .map_err(|error| format!("scan ACL root {} failed: {error}", path.display()))?
    {
        let entry =
            entry.map_err(|error| format!("scan ACL root {} failed: {error}", path.display()))?;
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "inspect ACL root {} failed: {error}",
                entry.path().display()
            )
        })?;
        if !file_type.is_file() {
            entries.push(entry);
        }
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let child = entry.path();
        let child_metadata = fs::symlink_metadata(&child)
            .map_err(|error| format!("inspect ACL root {} failed: {error}", child.display()))?;
        if child_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            scan_budget.consume()?;
            continue;
        }
        if child_metadata.is_dir() {
            scan_budget.consume()?;
            let child_roots = plan_bounded_non_following_directories(
                &child,
                max_grants,
                scan_budget,
                depth.saturating_add(1),
                max_depth,
                remaining_depth.saturating_sub(1),
            )?;
            append_partitioned_roots(&mut roots, child_roots, max_grants)?;
        }
    }
    Ok(roots)
}

fn plan_non_following_directory(
    path: &Path,
    max_grants: usize,
    scan_budget: &mut NonFollowingDirectoryBudget,
    depth: usize,
    max_depth: usize,
) -> Result<DirectoryReadPlan, String> {
    if depth > max_depth {
        return Err(format!(
            "nonFollowingReadRoot exceeds the safe nested-directory limit of {max_depth} below the root"
        ));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect ACL root {} failed: {error}", path.display()))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(DirectoryReadPlan {
            clean: false,
            roots: Vec::new(),
        });
    }
    if !metadata.is_dir() {
        return Err(format!(
            "expected a directory while partitioning ACL root: {}",
            path.display()
        ));
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(path)
        .map_err(|error| format!("scan ACL root {} failed: {error}", path.display()))?
    {
        entries.push(
            entry.map_err(|error| format!("scan ACL root {} failed: {error}", path.display()))?,
        );
    }
    entries.sort_by_key(|entry| entry.file_name());

    let mut clean = true;
    let mut directory_plans: Vec<DirectoryReadPlan> = Vec::new();
    for entry in entries {
        let child = entry.path();
        let child_metadata = fs::symlink_metadata(&child)
            .map_err(|error| format!("inspect ACL root {} failed: {error}", child.display()))?;
        if child_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            scan_budget.consume()?;
            clean = false;
            let child_grants = directory_plans
                .iter()
                .fold(0usize, |count, plan| count.saturating_add(plan.roots.len()));
            ensure_non_following_grant_limit(1usize.saturating_add(child_grants), max_grants)?;
            continue;
        }
        if child_metadata.is_dir() {
            scan_budget.consume()?;
            let child_plan = plan_non_following_directory(
                &child,
                max_grants,
                scan_budget,
                depth.saturating_add(1),
                max_depth,
            )?;
            clean &= child_plan.clean;
            directory_plans.push(child_plan);
            if !clean {
                let child_grants = directory_plans
                    .iter()
                    .fold(0usize, |count, plan| count.saturating_add(plan.roots.len()));
                ensure_non_following_grant_limit(1usize.saturating_add(child_grants), max_grants)?;
            }
            continue;
        }
        if child_metadata.is_file() {
            reject_multi_link_file(&child)?;
            continue;
        }
        return Err(format!(
            "ACL root contains an unsupported filesystem entry: {}",
            child.display()
        ));
    }

    if clean {
        return Ok(DirectoryReadPlan {
            clean: true,
            roots: vec![read_root(path, true)?],
        });
    }

    let mut roots = vec![read_root(path, false)?];
    for child_plan in directory_plans {
        append_partitioned_roots(&mut roots, child_plan.roots, max_grants)?;
    }
    Ok(DirectoryReadPlan {
        clean: false,
        roots,
    })
}

fn append_partitioned_roots(
    roots: &mut Vec<LedgerRoot>,
    additions: Vec<LedgerRoot>,
    max_grants: usize,
) -> Result<(), String> {
    if roots.len().saturating_add(additions.len()) > max_grants {
        return Err(format!(
            "nonFollowingReadRoot exceeds the safe limit of {max_grants} physical ACL grants"
        ));
    }
    roots.extend(additions);
    Ok(())
}

fn ensure_non_following_grant_limit(grants: usize, max_grants: usize) -> Result<(), String> {
    if grants > max_grants {
        return Err(format!(
            "nonFollowingReadRoot exceeds the safe limit of {max_grants} physical ACL grants"
        ));
    }
    Ok(())
}

fn read_root(path: &Path, recursive: bool) -> Result<LedgerRoot, String> {
    let path = path
        .to_str()
        .ok_or_else(|| format!("ACL root path is not valid Unicode: {}", path.display()))?;
    Ok(LedgerRoot {
        path: path.to_owned(),
        read: true,
        write: false,
        read_recursive: recursive,
        write_recursive: false,
        backup_path: None,
    })
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
    let information = path_entry_information(path)?;
    if information.nNumberOfLinks > 1 {
        return Err(format!(
            "ACL root contains a multi-link file: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_non_following_read_root_source(
    source: &Path,
    enforcement: &Path,
) -> Result<(), String> {
    let source_information = path_entry_information(source)?;
    if source_information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!(
            "nonFollowingReadRootSource contains a reparse point: {}",
            source.display()
        ));
    }
    if source_information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(format!(
            "nonFollowingReadRootSource must be a directory: {}",
            source.display()
        ));
    }

    let enforcement_information = path_entry_information(enforcement)?;
    if enforcement_information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || enforcement_information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(format!(
            "nonFollowingReadRoot must be an ordinary directory: {}",
            enforcement.display()
        ));
    }
    if source_information.dwVolumeSerialNumber != enforcement_information.dwVolumeSerialNumber
        || source_information.nFileIndexHigh != enforcement_information.nFileIndexHigh
        || source_information.nFileIndexLow != enforcement_information.nFileIndexLow
    {
        return Err(format!(
            "nonFollowingReadRootSource does not identify nonFollowingReadRoot: {}",
            source.display()
        ));
    }
    Ok(())
}

fn path_entry_information(path: &Path) -> Result<BY_HANDLE_FILE_INFORMATION, String> {
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
    Ok(information)
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
