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

use std::ffi::{OsStr, c_void};
use std::iter;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{
    CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE, LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{
    CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, DuplicateTokenEx, EqualSid, FreeSid,
    GetTokenInformation, IsTokenRestricted, LUA_TOKEN, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    SECURITY_CAPABILITIES, SecurityImpersonation, TOKEN_ALL_ACCESS, TOKEN_APPCONTAINER_INFORMATION,
    TOKEN_DUPLICATE, TOKEN_QUERY, TOKEN_USER, TokenAppContainerSid, TokenIsAppContainer,
    TokenPrimary, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, CreateDesktopExW, DESKTOP_CREATEMENU, DESKTOP_CREATEWINDOW, DESKTOP_ENUMERATE,
    DESKTOP_HOOKCONTROL, DESKTOP_JOURNALPLAYBACK, DESKTOP_JOURNALRECORD, DESKTOP_READOBJECTS,
    DESKTOP_SWITCHDESKTOP, DESKTOP_WRITEOBJECTS, HDESK,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW,
    CreateProcessW, CreateProcessWithTokenW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetExitCodeProcess, GetProcessId,
    InitializeProcThreadAttributeList, OpenProcessToken, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};

use crate::acl_ledger::{
    LaunchFailure, LedgerLock, READINESS_MUTEX_TIMEOUT_MS, readiness_mutex_name, with_acl_grants,
};
use crate::protocol::{
    DEFAULT_LAUNCH_TIMEOUT_MS, LaunchRequest, NetworkMode, RESERVED_READINESS_REQUEST_ID,
};

pub fn self_probe() -> Result<u8, String> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error("OpenProcessToken(self-probe)"));
        }
        let restricted = IsTokenRestricted(token) != 0;
        let app_container = token_is_appcontainer(token)?;
        CloseHandle(token);
        let mut in_job = 0;
        if IsProcessInJob(GetCurrentProcess(), null_mut(), &mut in_job) == 0 {
            return Err(last_error("IsProcessInJob"));
        }
        println!(
            "{{\"restrictedToken\":{restricted},\"appContainer\":{app_container},\"inJob\":{}}}",
            in_job != 0,
        );
        Ok(0)
    }
}

pub fn launch(request: &LaunchRequest) -> Result<u8, String> {
    validate_unimplemented_policy(request)?;

    unsafe {
        let primary = duplicate_primary_token()?;
        let restricted = create_restricted_token(primary)?;
        CloseHandle(primary);
        let job = create_kill_on_close_job()?;
        let result = create_child(request, restricted, job);
        CloseHandle(restricted);
        CloseHandle(job);
        result
    }
}

pub fn launch_atomic(request: &LaunchRequest) -> Result<u8, String> {
    validate_unimplemented_policy(request)?;

    unsafe {
        let primary = duplicate_primary_token()?;
        let restricted = create_restricted_token(primary)?;
        CloseHandle(primary);
        let job = create_kill_on_close_job()?;
        let result = create_child_atomic(request, restricted, job);
        CloseHandle(restricted);
        CloseHandle(job);
        result
    }
}

pub fn launch_appcontainer(request: &LaunchRequest) -> Result<u8, String> {
    validate_appcontainer_policy(request)?;
    unsafe {
        let job = create_kill_on_close_job()?;
        let profile = match AppContainerProfile::create(&request.request_id) {
            Ok(profile) => profile,
            Err(error) => {
                CloseHandle(job);
                return Err(error);
            }
        };
        let sid = match sid_string(profile.sid) {
            Ok(sid) => sid,
            Err(error) => {
                CloseHandle(job);
                return Err(error);
            }
        };
        let result = with_acl_grants(request, &sid, || {
            create_appcontainer_child(request, job, profile.sid)
        });
        // The kill-on-close Job is the kernel backstop either way: closing the
        // last handle terminates whatever the settlement pass could not prove
        // drained.
        CloseHandle(job);
        match result {
            Ok(value) => Ok(value),
            Err(LaunchFailure::Settled(message)) => Err(message),
            Err(failure @ LaunchFailure::Unsettled(_)) => {
                // Processes may still carry this AppContainer identity, and
                // its quarantined ledger still names the profile. Deleting
                // the profile now would strip the only remaining handle on
                // that authority, so it is preserved alongside the ledger.
                std::mem::forget(profile);
                Err(failure.into_message())
            }
        }
    }
}

/// Bound on the throwaway readiness child. It only runs `cmd.exe /c exit 0`,
/// so anything beyond a couple of seconds means the machine cannot stand up the
/// boundary and the probe must fail closed rather than hang availability.
const READINESS_PROBE_TIMEOUT_MS: u64 = 10_000;

/// Production-identity readiness probe (RFC §6.4).
///
/// Availability is not just "the packaged binary exists on disk". This builds
/// the real production identity — a kill-on-close Job plus a per-launch
/// AppContainer profile and SID — and launches a throwaway child
/// (`cmd.exe /c exit 0`) under that AppContainer token inside the Job, proving
/// the OS can actually create and account the sandbox boundary on this machine
/// before any workload is admitted. Anything short of a child that is both
/// AppContainer-confined and Job-accounted, and that exits cleanly, fails
/// closed so a restricted managed profile is never selected on a host that
/// cannot enforce it.
pub fn readiness_probe() -> Result<u8, String> {
    let system_root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .ok_or_else(|| "readiness probe: SystemRoot is not set".to_owned())?;
    let mut cmd_path = std::path::PathBuf::from(system_root);
    cmd_path.push("System32");
    cmd_path.push("cmd.exe");
    let cmd_path = cmd_path.to_string_lossy().into_owned();

    // Serialize the whole readiness profile lifecycle across processes. The
    // profile name is fixed and the registration is per-user machine-wide, so
    // two concurrent probes — side-by-side installs, or a direct
    // `--readiness-probe` racing the memoized availability gate — would
    // otherwise delete→create→drop each other's live profile. The lease is the
    // same DACL-hardened named mutex the ACL ledger uses, scoped to a distinct
    // readiness name, held (RAII) across the entire
    // delete→create→probe→settle→drop window and failing closed on timeout so
    // the lifecycle never runs unlocked.
    let user_sid = current_user_sid_string()?;
    let _lease = LedgerLock::acquire(
        &readiness_mutex_name(&user_sid),
        &user_sid,
        READINESS_MUTEX_TIMEOUT_MS,
    )?;

    unsafe {
        let job = create_kill_on_close_job()?;
        // Deterministic, retryable profile lifecycle. The readiness child is a
        // throwaway `cmd.exe /c exit 0` granted no filesystem roots, so — unlike
        // a production launch, which must never reuse a profile lest it inherit
        // stale filesystem ACEs — it can use a fixed, self-reconciling name.
        // `create_readiness` reclaims any registration leaked by a previously
        // killed probe (e.g. the Node-side timeout firing before `Drop` runs)
        // before creating a fresh one, so at most one readiness profile ever
        // exists and it is always the current probe's. This bounds cleanup
        // without a persistent ledger and without relying on process
        // destruction to run `Drop`. The lease above makes this reclaim safe:
        // no other process can hold the profile while we delete and recreate it.
        let profile = match AppContainerProfile::create_readiness() {
            Ok(profile) => profile,
            Err(error) => {
                CloseHandle(job);
                return Err(error);
            }
        };
        let probe_sid = match sid_string(profile.sid) {
            Ok(sid) => sid,
            Err(error) => {
                CloseHandle(job);
                return Err(error);
            }
        };
        let result = probe_appcontainer_child(&cmd_path, job, profile.sid);
        // Closing the last Job handle is the kernel backstop after the probe has
        // already explicitly terminated and drained its child (see
        // `probe_appcontainer_child`); it terminates any straggler the drain
        // did not reap. When the child cannot be proven drained the probe
        // returns an error, so availability fails closed for this cycle. The
        // fixed readiness identity is not durably quarantined: cleanup relies on
        // the kill-on-close Job's tree termination, and because the probe grants
        // zero filesystem roots a hypothetically-surviving child inherits no ACE
        // authority. Durable quarantine of an unsettled identity — or unique
        // probe identities plus a reconciliation ledger — is a deferred gate
        // (RFC §6.5).
        CloseHandle(job);
        drop(profile);
        let desktop = result?;
        // Attest what the probe actually verified, not just that it exited 0:
        // release evidence asserts these fields, so removing the exact-SID
        // match, the specific-Job membership check, the settlement drain, or
        // the private-desktop placement would turn the smoke red instead of
        // leaving a hollow exit-0 gate green. `appContainerSidVerified`,
        // `jobVerified`, and `settled` report the parent-side checks above
        // (each fails closed before this line otherwise); `desktop` is the
        // parent-side `lpDesktop` placement fact (RFC §6.3 placement, not
        // escape-proof confinement — the throwaway cmd child cannot
        // self-report).
        println!(
            "{{\"appContainerSidVerified\":true,\"jobVerified\":true,\"settled\":true,\"appContainerSid\":{},\"desktop\":{},\"desktopPrivatePlacement\":{}}}",
            crate::json_string(&probe_sid),
            crate::json_string(&desktop),
            crate::desktop_is_private_placement(&desktop),
        );
        Ok(0)
    }
}

/// Command line for the throwaway readiness child: `"<cmd>" /d /c exit 0`.
///
/// `/d` is load-bearing, not cosmetic. Without it cmd.exe runs the
/// `HKLM`/`HKCU\Software\Microsoft\Command Processor\AutoRun` value before the
/// `/c` payload. A machine whose AutoRun exits non-zero would make every probe
/// report failure; one whose AutoRun blocks would hang the child until the Job
/// drain times out — either way the sandbox fails closed on *every* startup,
/// because AutoRun is machine-constant. `/d` disables AutoRun so the probe
/// measures the sandbox boundary, not the host's shell customization. The
/// production launch path already passes `/d` before `/c`; this keeps the
/// diagnostic probe on the same contract.
pub(crate) fn readiness_probe_command_line(cmd_path: &str) -> String {
    format!("\"{cmd_path}\" /d /c exit 0")
}

/// Launch the throwaway readiness child under the AppContainer token and Job.
/// Mirrors `create_appcontainer_child` but carries no stdio/handle inheritance
/// (nothing is relayed) and inherits the parent environment, since the child
/// only needs to reach `exit 0`.
unsafe fn probe_appcontainer_child(
    cmd_path: &str,
    job: HANDLE,
    app_container_sid: *mut c_void,
) -> Result<String, String> {
    let executable = wide(cmd_path);
    // Build the command line directly: cmd.exe's `/d`/`/c` switches must stay
    // unquoted, so the per-token quoting used for arbitrary workloads would
    // make cmd treat "/c" as a program to run and exit non-zero.
    let mut command = wide(&readiness_probe_command_line(cmd_path));
    // Run from System32 rather than inheriting the launcher's cwd: the probe
    // grants no filesystem roots, so an inherited working directory would be
    // default-denied and cmd.exe would fail to initialize. System32 is readable
    // by ALL APPLICATION PACKAGES, so the AppContainer child can start there.
    let cwd = std::path::Path::new(cmd_path)
        .parent()
        .map(|parent| wide(&parent.to_string_lossy()));
    let cwd_ptr = cwd.as_ref().map_or(null(), |value| value.as_ptr());

    // Readiness must exercise the same controls production launches apply, so
    // the throwaway child is placed on a private desktop too (RFC §6.4). Held
    // until the child is reaped below.
    let desktop = unsafe { create_confined_desktop(app_container_sid) }?;

    let mut attribute_size = 0usize;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut attribute_size) };
    if attribute_size == 0 {
        return Err(last_error(
            "InitializeProcThreadAttributeList(readiness size)",
        ));
    }
    let words = attribute_size.div_ceil(size_of::<usize>());
    let mut attribute_storage = vec![0usize; words];
    let attribute_list = attribute_storage.as_mut_ptr() as *mut c_void;
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 2, 0, &mut attribute_size) } == 0
    {
        return Err(last_error("InitializeProcThreadAttributeList(readiness)"));
    }

    let mut job_value = job;
    let mut capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: app_container_sid,
        Capabilities: null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let attributes = (|| -> Result<(), String> {
        if unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                &mut job_value as *mut HANDLE as *const c_void,
                size_of::<HANDLE>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error("UpdateProcThreadAttribute(readiness JOB_LIST)"));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                &mut capabilities as *mut SECURITY_CAPABILITIES as *const c_void,
                size_of::<SECURITY_CAPABILITIES>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error(
                "UpdateProcThreadAttribute(readiness SECURITY_CAPABILITIES)",
            ));
        }
        Ok(())
    })();
    if let Err(error) = attributes {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(error);
    }

    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attribute_list;
    startup.StartupInfo.lpDesktop = desktop.name.as_ptr() as *mut u16;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    let creation_flags = CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
    let created = unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            // No handle list is declared, so no handles are inherited.
            0,
            creation_flags,
            // Inherit the parent environment: a readiness check needs no
            // sanitized block, only enough to reach `exit 0`.
            null(),
            cwd_ptr,
            &startup.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list) };
    if created == 0 {
        return Err(last_error("CreateProcessW(readiness appcontainer)"));
    }

    let verify = (|| -> Result<u8, String> {
        if unsafe { ResumeThread(process.hThread) } == u32::MAX {
            return Err(last_error("ResumeThread(readiness)"));
        }
        // Verify the *requested* boundary, not just any confinement: match the
        // child's AppContainer SID against the profile we created (a non-null
        // match also proves it is an AppContainer token), and confirm membership
        // in this probe's Job specifically rather than any ambient Job.
        let child_sid_matches =
            unsafe { child_token_appcontainer_sid_matches(process.hProcess, app_container_sid) }?;
        let child_in_job = unsafe { child_process_is_in_specific_job(process.hProcess, job) }?;
        if !(child_sid_matches && child_in_job) {
            return Err(
                "readiness probe child did not run under the requested AppContainer SID and Job"
                    .to_owned(),
            );
        }
        let exit = unsafe { wait_for_child(process.hProcess, Some(READINESS_PROBE_TIMEOUT_MS)) }?;
        if exit != 0 {
            return Err(format!("readiness probe child exited with status {exit}"));
        }
        Ok(0)
    })();

    // Route *every* post-resume outcome — clean exit, verification failure, or
    // timeout — through explicit termination and a Job drain before releasing
    // the identity. Closing the Job alone is only a kernel backstop, and it
    // misses the exact failure the verification guards against: a child found
    // *outside* this Job. Terminating the throwaway child directly reaps that
    // case, then terminate-and-drain the Job so no descendant outlives the probe.
    let settled = unsafe { settle_probe_child(job, process.hProcess) };

    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }

    // A verification/exit failure is the primary diagnosis; a settlement failure
    // is itself a fail-closed signal (the Job was not confirmed empty, so a
    // descendant may still hold this AppContainer identity), so it is surfaced
    // when the probe otherwise succeeded. Either outcome reports unavailable
    // rather than claiming a clean boundary; the readiness identity is not
    // preserved for reuse — its profile carries no filesystem roots, so a
    // surviving child inherits no ACE authority, and the kill-on-close Job is the
    // cleanup backstop. Durable quarantine of an unsettled identity is a deferred
    // gate (RFC §6.5). Success reports the private desktop the child was placed
    // on so the caller can emit a machine-readable attestation of the verified
    // facts instead of a bare success bit.
    let desktop_name = desktop.name_string();
    match (verify, settled) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(cleanup)) => Err(cleanup),
        (Ok(_), Ok(())) => Ok(desktop_name),
    }
}

/// Deterministically reap the throwaway readiness child. The child is a
/// disposable `cmd.exe /c exit 0`, so terminate it outright before draining:
/// `TerminateProcess` reaches a child that escaped this Job (the exact case the
/// Job-close backstop cannot), and `terminate_and_drain_job` — the same
/// settlement primitive the production launch path uses — then kills any
/// Job-accounted descendant and confirms the Job is empty. An already-exited
/// child makes `TerminateProcess` fail with `ERROR_ACCESS_DENIED`, which is
/// benign here and intentionally ignored.
unsafe fn settle_probe_child(job: HANDLE, child: HANDLE) -> Result<(), String> {
    unsafe { TerminateProcess(child, 124) };
    unsafe { terminate_and_drain_job(job, child) }
}

pub fn appcontainer_sid_string(request_id: &str) -> Result<String, String> {
    unsafe {
        let name = appcontainer_profile_name(request_id);
        let mut sid = null_mut();
        let derived = DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid);
        if derived < 0 {
            return Err(format!(
                "DeriveAppContainerSidFromAppContainerName failed: HRESULT 0x{:08x}",
                derived as u32
            ));
        }
        let result = sid_string(sid);
        FreeSid(sid);
        result
    }
}

pub fn current_user_sid_string() -> Result<String, String> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error("OpenProcessToken(current user SID)"));
        }
        let mut required = 0;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut required);
        if required == 0 {
            CloseHandle(token);
            return Err(last_error("GetTokenInformation(TokenUser size)"));
        }
        let words = (required as usize).div_ceil(size_of::<usize>());
        let mut storage = vec![0usize; words];
        if GetTokenInformation(
            token,
            TokenUser,
            storage.as_mut_ptr() as *mut c_void,
            required,
            &mut required,
        ) == 0
        {
            CloseHandle(token);
            return Err(last_error("GetTokenInformation(TokenUser)"));
        }
        CloseHandle(token);
        let user = &*(storage.as_ptr() as *const TOKEN_USER);
        sid_string(user.User.Sid)
    }
}

pub(crate) unsafe fn sid_string(sid: *mut c_void) -> Result<String, String> {
    let mut value = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut value) } == 0 {
        return Err(last_error("ConvertSidToStringSidW(AppContainer)"));
    }
    let length = (0..)
        .take_while(|&index| unsafe { *value.add(index) != 0 })
        .count();
    let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, length) });
    unsafe { LocalFree(value as *mut c_void) };
    Ok(result)
}

struct AppContainerProfile {
    sid: *mut c_void,
    name: Vec<u16>,
}

impl AppContainerProfile {
    unsafe fn create(request_id: &str) -> Result<Self, String> {
        let name = appcontainer_profile_name(request_id);
        let display_name = wide("Maka Windows Sandbox");
        let description = wide("Per-launch AppContainer profile for Maka sandbox execution");
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                display_name.as_ptr(),
                description.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result < 0 {
            // Never derive and reuse an existing profile. A leftover profile
            // means a previous launch with this identity did not complete its
            // lifecycle, so reusing it could also reuse stale filesystem ACEs.
            return Err(format!(
                "CreateAppContainerProfile failed closed: HRESULT 0x{:08x}",
                result as u32
            ));
        }
        Ok(Self { sid, name })
    }

    /// Create the throwaway readiness profile under a fixed, self-reconciling
    /// name. The readiness child is granted no filesystem roots and does no
    /// filesystem work, so — unlike `create`, which fails closed on a leftover
    /// to avoid inheriting stale ACEs — it is safe to reclaim a leaked
    /// registration under this stable name first. That makes the profile
    /// lifecycle deterministic and retryable: a profile leaked by an
    /// externally-killed probe is reclaimed by the next probe rather than
    /// accumulating under an unrecoverable unique name.
    unsafe fn create_readiness() -> Result<Self, String> {
        let name = appcontainer_readiness_profile_name();
        // Best-effort reclaim of a profile leaked by a previously killed probe.
        // The name is fixed, so this is the only registration that can exist
        // under it; a missing profile makes this a no-op. The caller holds the
        // readiness lease, so no concurrent probe can be mid-lifecycle here.
        unsafe { DeleteAppContainerProfile(name.as_ptr()) };
        let display_name = wide("Maka Windows Sandbox Readiness");
        let description =
            wide("Throwaway AppContainer profile for the Maka sandbox readiness probe");
        let mut sid = null_mut();
        let result = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                display_name.as_ptr(),
                description.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        };
        if result < 0 {
            return Err(format!(
                "CreateAppContainerProfile(readiness) failed closed: HRESULT 0x{:08x}",
                result as u32
            ));
        }
        Ok(Self { sid, name })
    }
}

/// Fixed request identity for the readiness profile. Unlike production launches
/// this carries no PID or nonce: a leaked profile is deterministically
/// reclaimed by the next probe (see `AppContainerProfile::create_readiness`),
/// which also removes any PID-reuse collision by construction, and the readiness
/// lease serializes that reclaim across processes. This is the single source
/// shared with `protocol::RESERVED_READINESS_REQUEST_ID`, which
/// `LaunchRequest::validate` rejects so no production launch can ever carry the
/// readiness identity.
pub(crate) const READINESS_PROFILE_REQUEST_ID: &str = RESERVED_READINESS_REQUEST_ID;

impl Drop for AppContainerProfile {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.sid);
            // The request-derived name is never reused by another live launch.
            // Best-effort deletion keeps the user profile store bounded; a crash
            // can leave this registration behind, but a future request has a
            // different SID and cannot inherit its ACL authority. The readiness
            // probe instead uses a fixed name and reclaims it under a lease on
            // the next cycle (`create_readiness`); an unsettled probe fails
            // closed rather than durably quarantining its identity — that
            // quarantine is a deferred gate (RFC §6.5).
            DeleteAppContainerProfile(self.name.as_ptr());
        }
    }
}

pub(crate) fn appcontainer_profile_name(request_id: &str) -> Vec<u16> {
    let digest = format!("{:x}", Sha256::digest(request_id.as_bytes()));
    wide(&format!("maka.sandbox.{}", &digest[..32]))
}

/// The readiness probe's AppContainer profile name. It lives under a distinct
/// `maka.readiness.` prefix, structurally disjoint from the production
/// `maka.sandbox.` namespace [`appcontainer_profile_name`] derives, so even if
/// `validate` were somehow bypassed no production launch could resolve to the
/// profile the probe deletes and recreates — the two namespaces can never
/// collide by construction.
pub(crate) fn appcontainer_readiness_profile_name() -> Vec<u16> {
    let digest = format!(
        "{:x}",
        Sha256::digest(READINESS_PROFILE_REQUEST_ID.as_bytes())
    );
    wide(&format!("maka.readiness.{}", &digest[..32]))
}

/// Minimal desktop rights the confined child needs to run non-interactively:
/// read the desktop object, create its own windows and menus, write back, and
/// enumerate. Deliberately excludes `DESKTOP_SWITCHDESKTOP` (the worker can
/// never bring itself to the foreground), `DESKTOP_HOOKCONTROL`, and
/// `DESKTOP_JOURNALRECORD`/`DESKTOP_JOURNALPLAYBACK`, so even on its own desktop
/// the worker cannot install the global-hook / input-journaling GUI attack
/// surface RFC §6.3 forbids.
const CONFINED_DESKTOP_APP_MASK: u32 = DESKTOP_READOBJECTS
    | DESKTOP_CREATEWINDOW
    | DESKTOP_CREATEMENU
    | DESKTOP_WRITEOBJECTS
    | DESKTOP_ENUMERATE;

/// Interactive-control desktop rights no sandboxed principal may hold on the
/// private desktop: desktop switching, hook control, and input-journal
/// record/playback (0x138). Denied to the launching-user SID explicitly because
/// the AppContainer child's token still carries that SID as an *effective* SID —
/// without the deny ACE, the owner `GA` allow below would name the child as a
/// grantee of these rights, and "never SWITCHDESKTOP/HOOKCONTROL/journal" would
/// rest solely on the lowbox dual access check (user grant ∩ package grant)
/// rather than on the DACL itself.
const DENIED_DESKTOP_INTERACTIVE_MASK: u32 =
    DESKTOP_SWITCHDESKTOP | DESKTOP_HOOKCONTROL | DESKTOP_JOURNALRECORD | DESKTOP_JOURNALPLAYBACK;

/// Desktop-heap budget (KiB) for each per-launch private desktop, passed to
/// `CreateDesktopExW`. A plain `CreateDesktopW` desktop takes the default
/// interactive allocation (3,072 KiB against a documented 48 MiB system
/// desktop-heap limit), so ten live launches — a supported concurrency — would
/// consume ~30 MiB before counting `Default`, `Winlogon`, screensaver, or other
/// software's desktops, and further launches would start failing. The confined
/// worker is a no-GUI workload: the heap only backs the desktop object itself
/// plus any hidden windows/menus the child creates, so 512 KiB (a sixth of the
/// default; ten live launches ≈ 5 MiB) leaves an order of magnitude of
/// system-wide headroom. `ten_confined_desktops_can_be_held_live` proves the
/// supported maximum can be held live simultaneously within this budget.
pub(crate) const CONFINED_DESKTOP_HEAP_KB: u32 = 512;

/// Security descriptor for the per-launch private desktop. A leading deny ACE
/// strips the interactive-control rights from the launching-user SID (which the
/// AppContainer child carries effectively); the launching user and Local System
/// otherwise keep full control so the desktop can always be managed and cleaned
/// up — the launcher itself only ever requests the minimal app mask, which the
/// deny does not intersect. The per-launch AppContainer package SID gets only
/// the minimal non-interactive rights above. `P` blocks inherited ACEs so the
/// confined child shares this desktop with nothing else on the window station.
/// The `S:(ML;;NW;;;LW)` mandatory label pins the desktop at Low integrity with
/// No-Write-Up: without it the desktop would inherit the creator's Medium
/// level, and — because Mandatory Integrity Control is evaluated *before* the
/// DACL — the Low-IL AppContainer child's granted create-window/write rights
/// would be unusable. Labeling at Low (no privilege needed: it is below the
/// creator's own level) makes the granted rights real for the child while
/// higher-integrity access is unaffected.
pub(crate) fn desktop_sddl(owner_sid: &str, app_container_sid: &str) -> String {
    format!(
        "D:P(D;;0x{DENIED_DESKTOP_INTERACTIVE_MASK:x};;;{owner_sid})(A;;GA;;;{owner_sid})(A;;GA;;;SY)(A;;0x{CONFINED_DESKTOP_APP_MASK:x};;;{app_container_sid})S:(ML;;NW;;;LW)"
    )
}

/// Per-launch private desktop for the confined child. The open handle keeps the
/// desktop alive; `Drop` closes it after the child has settled, at which point
/// the kernel reclaims the now-unreferenced desktop.
pub(crate) struct ConfinedDesktop {
    handle: HDESK,
    /// NUL-terminated wide name, handed to `STARTUPINFOW::lpDesktop`.
    name: Vec<u16>,
}

impl ConfinedDesktop {
    /// The desktop's name without the trailing NUL, for attestation and tests.
    pub(crate) fn name_string(&self) -> String {
        String::from_utf16_lossy(&self.name[..self.name.len().saturating_sub(1)])
    }
}

impl Drop for ConfinedDesktop {
    fn drop(&mut self) {
        unsafe {
            CloseDesktop(self.handle);
        }
    }
}

/// Create an alternate desktop on the current window station whose DACL grants
/// only the launching user, Local System, and this launch's AppContainer SID
/// (RFC §6.3). This is initial-desktop *placement* plus a DACL-protected
/// desktop, not an escape-proof confinement boundary: `STARTUPINFOW::lpDesktop`
/// only selects where the child *starts*, and nothing structural stops
/// in-process code from calling `OpenDesktopW("Default")` +
/// `SetThreadDesktop` to rejoin the interactive desktop — the escape-proof
/// gates (a no-Win32k mitigation, a dedicated window station, a token
/// boundary) are deferred (§6.5). What placement does buy: the child starts
/// off the interactive desktop, so code that never re-attaches cannot
/// enumerate or post messages to the user's windows, and the DACL keeps every
/// *other* principal off this private desktop. It does NOT isolate the
/// clipboard — the clipboard belongs to the window station, which this desktop
/// still shares with `Default`. The desktop carries an explicit Low
/// no-write-up mandatory label so the DACL's create-window/write grants pass
/// MIC for the Low-IL AppContainer child, but those rights are still not
/// relied upon — no probe creates a window in-child, so the shipped guarantee
/// remains placement, not GUI capability (an in-child window-creation check is
/// deferred, §6.5). The desktop heap is bounded per launch
/// (`CONFINED_DESKTOP_HEAP_KB`) so supported concurrency cannot exhaust the
/// system desktop heap. Fails closed: if the desktop or its security
/// descriptor cannot be built, the caller aborts the launch rather than fall
/// back to the interactive desktop.
/// 128-bit nonce from the OS CSPRNG for per-launch desktop names. Fails closed:
/// no fallback to a predictable value when the RNG is unavailable.
fn desktop_name_nonce() -> Result<u128, String> {
    let mut bytes = [0u8; 16];
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(format!(
            "BCryptGenRandom(desktop nonce) failed with NTSTATUS 0x{:08x}",
            status as u32
        ));
    }
    Ok(u128::from_le_bytes(bytes))
}

pub(crate) unsafe fn create_confined_desktop(
    app_container_sid: *mut c_void,
) -> Result<ConfinedDesktop, String> {
    let owner_sid = current_user_sid_string()?;
    let package_sid = unsafe { sid_string(app_container_sid) }?;
    // A per-launch name so concurrent sandboxes never share a desktop, and a
    // name leaked by a killed launch never collides with a live one. The nonce
    // must be unforgeable-by-accident: `CreateDesktopExW` *opens* an existing
    // desktop when the name already exists — the supplied security descriptor
    // and heap size are then silently ignored — so a predictable nonce (wall
    // clock, PID) would let PID reuse, clock rollback, or same-tick calls
    // reopen an older desktop while the prefix attestation still passed. A
    // 128-bit CSPRNG nonce makes collision cryptographically negligible, and
    // an RNG failure fails the launch closed instead of collapsing to a
    // constant name.
    let nonce = desktop_name_nonce()?;
    let name = wide(&format!(
        "maka-sandbox-desktop.{}.{nonce:032x}",
        std::process::id()
    ));

    let sddl = wide(&desktop_sddl(&owner_sid, &package_sid));
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(last_error(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW(private desktop)",
        ));
    }
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor as *mut c_void,
        bInheritHandle: 0,
    };
    // The launching user holds GA minus the denied interactive-control bits in
    // the DACL above, so requesting the minimal app mask (enough to keep a live
    // handle and later close it; disjoint from the deny mask) always succeeds.
    // No `DESKTOP_SWITCHDESKTOP`: the launcher never foregrounds it.
    let handle = unsafe {
        CreateDesktopExW(
            name.as_ptr(),
            null(),
            null(),
            0,
            CONFINED_DESKTOP_APP_MASK,
            &security,
            CONFINED_DESKTOP_HEAP_KB,
            null_mut(),
        )
    };
    unsafe { LocalFree(descriptor as *mut c_void) };
    if handle.is_null() {
        return Err(last_error("CreateDesktopW(private desktop)"));
    }
    Ok(ConfinedDesktop { handle, name })
}

fn validate_appcontainer_policy(request: &LaunchRequest) -> Result<(), String> {
    if !matches!(request.network, NetworkMode::Restricted) {
        return Err("AppContainer backend only implements restricted networking".to_owned());
    }
    Ok(())
}

fn validate_unimplemented_policy(request: &LaunchRequest) -> Result<(), String> {
    if matches!(request.network, NetworkMode::Restricted) {
        return Err("network.restricted is not implemented by the W0 process prototype".to_owned());
    }
    if !request.read_roots.is_empty() || !request.write_roots.is_empty() {
        return Err("filesystem roots require the W0 identity/ACL prototype".to_owned());
    }
    Ok(())
}

unsafe fn duplicate_primary_token() -> Result<HANDLE, String> {
    let mut current = null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut current,
        )
    } == 0
    {
        return Err(last_error("OpenProcessToken"));
    }
    let mut token = null_mut();
    let result = unsafe {
        DuplicateTokenEx(
            current,
            TOKEN_ALL_ACCESS,
            null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut token,
        )
    };
    unsafe { CloseHandle(current) };
    if result == 0 {
        return Err(last_error("DuplicateTokenEx"));
    }
    Ok(token)
}

unsafe fn create_restricted_token(primary: HANDLE) -> Result<HANDLE, String> {
    let mut restricted = null_mut();
    if unsafe {
        CreateRestrictedToken(
            primary,
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
            0,
            null(),
            0,
            null(),
            0,
            null(),
            &mut restricted,
        )
    } == 0
    {
        return Err(last_error("CreateRestrictedToken"));
    }
    Ok(restricted)
}

unsafe fn create_kill_on_close_job() -> Result<HANDLE, String> {
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(last_error("CreateJobObjectW"));
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        unsafe { CloseHandle(job) };
        return Err(last_error("SetInformationJobObject"));
    }
    Ok(job)
}

/// W0 restricted-token diagnostic path. NOT production: the packaged broker
/// routes exclusively through `launch_appcontainer`. Children here run on the
/// creator's interactive desktop — no private-desktop placement (RFC §6.3);
/// reusing `create_confined_desktop` for these diagnostics is deliberately
/// out of scope while they remain negative-evidence prototypes.
unsafe fn create_child(request: &LaunchRequest, token: HANDLE, job: HANDLE) -> Result<u8, String> {
    let mut command = quote_command(&request.executable, &request.arguments);
    let mut executable = wide(&request.executable);
    let mut cwd = wide(&request.cwd);
    let environment = environment_block(&request.environment);
    let environment_ptr = environment.as_ptr() as *const c_void;
    let creation_flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };

    let created = unsafe {
        CreateProcessWithTokenW(
            token,
            0,
            executable.as_mut_ptr(),
            command.as_mut_ptr(),
            creation_flags,
            environment_ptr,
            cwd.as_mut_ptr(),
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        return Err(last_error("CreateProcessWithTokenW"));
    }

    let result = if unsafe {
        windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(job, process.hProcess)
    } == 0
    {
        Err(last_error("AssignProcessToJobObject"))
    } else if unsafe { ResumeThread(process.hThread) } == u32::MAX {
        Err(last_error("ResumeThread"))
    } else {
        let child_restricted = unsafe { child_token_is_restricted(process.hProcess) }?;
        let child_in_job = unsafe { child_process_is_in_job(process.hProcess) }?;
        println!("{{\"restrictedToken\":{child_restricted},\"inJob\":{child_in_job}}}");
        let wait = unsafe { WaitForSingleObject(process.hProcess, 30_000) };
        if wait == WAIT_TIMEOUT {
            unsafe { TerminateProcess(process.hProcess, 124) };
            Err("child exceeded the 30 second W0 timeout".to_owned())
        } else if wait != WAIT_OBJECT_0 {
            Err(last_error("WaitForSingleObject"))
        } else {
            let mut exit_code = 1;
            if unsafe { GetExitCodeProcess(process.hProcess, &mut exit_code) } == 0 {
                Err(last_error("GetExitCodeProcess"))
            } else if exit_code > u8::MAX as u32 {
                Err(format!(
                    "child {} returned unsupported exit code {exit_code}",
                    unsafe { GetProcessId(process.hProcess) }
                ))
            } else {
                Ok(exit_code as u8)
            }
        }
    };
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    result
}

/// W0 restricted-token diagnostic path (atomic-Job variant). NOT production —
/// same interactive-desktop caveat as `create_child` above (RFC §6.3).
unsafe fn create_child_atomic(
    request: &LaunchRequest,
    token: HANDLE,
    job: HANDLE,
) -> Result<u8, String> {
    let mut command = quote_command(&request.executable, &request.arguments);
    let mut executable = wide(&request.executable);
    let mut cwd = wide(&request.cwd);
    let environment = environment_block(&request.environment);
    let environment_ptr = environment.as_ptr() as *const c_void;

    let mut attribute_size = 0usize;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size) };
    if attribute_size == 0 {
        return Err(last_error("InitializeProcThreadAttributeList(size)"));
    }
    let words = attribute_size.div_ceil(size_of::<usize>());
    let mut attribute_storage = vec![0usize; words];
    let attribute_list = attribute_storage.as_mut_ptr() as *mut c_void;
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) } == 0
    {
        return Err(last_error("InitializeProcThreadAttributeList"));
    }

    let mut job_value = job;
    if unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            &mut job_value as *mut HANDLE as *const c_void,
            size_of::<HANDLE>(),
            null_mut(),
            null(),
        )
    } == 0
    {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(last_error("UpdateProcThreadAttribute(JOB_LIST)"));
    }

    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attribute_list;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    let creation_flags =
        CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
    let created = unsafe {
        CreateProcessAsUserW(
            token,
            executable.as_mut_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            creation_flags,
            environment_ptr,
            cwd.as_mut_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list) };
    if created == 0 {
        return Err(last_error("CreateProcessAsUserW(atomic-job)"));
    }

    let result = (|| -> Result<u8, String> {
        if unsafe { ResumeThread(process.hThread) } == u32::MAX {
            return Err(last_error("ResumeThread"));
        }
        let child_restricted = unsafe { child_token_is_restricted(process.hProcess) }?;
        let child_in_job = unsafe { child_process_is_in_job(process.hProcess) }?;
        if child_restricted && child_in_job {
            println!("{{\"restrictedToken\":true,\"inJob\":true,\"atomicJob\":true}}");
            unsafe { wait_for_child(process.hProcess, request.timeout_ms) }
        } else {
            Err("atomic launch did not establish the required token and Job boundary".to_owned())
        }
    })();
    // The atomic candidate probe holds no ACL grants, so a settled/unsettled
    // distinction carries no recovery state; the outcome is flattened.
    let result = unsafe { settle_job(result, job, process.hProcess) }
        .map_err(|failure| failure.into_message());
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    result
}

/// Launches the filesystem-worker child with the broker's standard streams
/// relayed through: the worker request arrives on the child's stdin, the
/// worker response leaves on the child's stdout, and diagnostics stay on
/// stderr. Handle inheritance is restricted to exactly the three duplicated
/// std handles via PROC_THREAD_ATTRIBUTE_HANDLE_LIST so no job, manifest or
/// pipe handles leak into the AppContainer.
unsafe fn create_appcontainer_child(
    request: &LaunchRequest,
    job: HANDLE,
    app_container_sid: *mut c_void,
) -> Result<u8, LaunchFailure> {
    let mut command = quote_command(&request.executable, &request.arguments);
    let executable = wide(&request.executable);
    let cwd = wide(&request.cwd);
    let environment = environment_block(&request.environment);
    let environment_ptr = environment.as_ptr() as *const c_void;
    // Place the child on a private desktop (RFC §6.3). Held for the whole
    // function so the desktop outlives the child; if its DACL never grants the
    // AppContainer SID, CreateProcessW below fails ACCESS_DENIED — fail closed.
    let desktop = unsafe { create_confined_desktop(app_container_sid) }?;
    let stdio = unsafe { InheritableStdio::capture() }?;

    let mut attribute_size = 0usize;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 3, 0, &mut attribute_size) };
    if attribute_size == 0 {
        return Err(last_error("InitializeProcThreadAttributeList(appcontainer size)").into());
    }
    let words = attribute_size.div_ceil(size_of::<usize>());
    let mut attribute_storage = vec![0usize; words];
    let attribute_list = attribute_storage.as_mut_ptr() as *mut c_void;
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 3, 0, &mut attribute_size) } == 0
    {
        return Err(last_error("InitializeProcThreadAttributeList(appcontainer)").into());
    }

    let mut job_value = job;
    let mut capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: app_container_sid,
        Capabilities: null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let attributes = (|| -> Result<(), String> {
        if unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                &mut job_value as *mut HANDLE as *const c_void,
                size_of::<HANDLE>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error(
                "UpdateProcThreadAttribute(APP_CONTAINER_JOB_LIST)",
            ));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                &mut capabilities as *mut SECURITY_CAPABILITIES as *const c_void,
                size_of::<SECURITY_CAPABILITIES>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error(
                "UpdateProcThreadAttribute(SECURITY_CAPABILITIES)",
            ));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                stdio.handles.as_ptr() as *const c_void,
                size_of::<[HANDLE; 3]>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error("UpdateProcThreadAttribute(HANDLE_LIST)"));
        }
        Ok(())
    })();
    if let Err(error) = attributes {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Err(error.into());
    }

    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attribute_list;
    startup.StartupInfo.lpDesktop = desktop.name.as_ptr() as *mut u16;
    startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdio.handles[0];
    startup.StartupInfo.hStdOutput = stdio.handles[1];
    startup.StartupInfo.hStdError = stdio.handles[2];
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    let creation_flags =
        CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
    let created = unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            creation_flags,
            environment_ptr,
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    unsafe { DeleteProcThreadAttributeList(attribute_list) };
    // Close the parent's inheritable duplicates immediately: the child then
    // owns the only remaining copies, so closing the client side of stdin
    // reaches the child as EOF and the child closing stdout ends the
    // response stream.
    drop(stdio);
    if created == 0 {
        return Err(last_error("CreateProcessW(appcontainer atomic-job)").into());
    }

    let result = (|| -> Result<u8, String> {
        if unsafe { ResumeThread(process.hThread) } == u32::MAX {
            return Err(last_error("ResumeThread(appcontainer)"));
        }
        let child_app_container = unsafe { child_token_is_appcontainer(process.hProcess) }?;
        let child_in_job = unsafe { child_process_is_in_job(process.hProcess) }?;
        if child_app_container && child_in_job {
            // Diagnostics go to stderr: stdout is reserved for the child's
            // relayed worker response.
            eprintln!("{{\"appContainer\":true,\"inJob\":true,\"atomicJob\":true}}");
            unsafe { wait_for_child(process.hProcess, request.timeout_ms) }
        } else {
            Err(
                "AppContainer launch did not establish the required token and Job boundary"
                    .to_owned(),
            )
        }
    })();
    let result = unsafe { settle_job(result, job, process.hProcess) };
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    result
}

struct InheritableStdio {
    handles: [HANDLE; 3],
}

impl InheritableStdio {
    /// Duplicates the broker's std handles as inheritable copies so the
    /// AppContainer child reads the worker request from the real stdin and
    /// writes the worker response to the real stdout. A missing std handle
    /// (fully detached parent) falls back to an inheritable NUL handle so the
    /// child always receives a complete set. Only the remote named-pipe broker
    /// would want detached stdio; it currently reuses the serving process's
    /// console, which keeps behavior deterministic.
    unsafe fn capture() -> Result<Self, String> {
        let mut handles: [HANDLE; 3] = [null_mut(); 3];
        for (index, id) in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE]
            .into_iter()
            .enumerate()
        {
            let duplicated = (|| {
                let source = unsafe { GetStdHandle(id) };
                if source.is_null() || source == INVALID_HANDLE_VALUE {
                    return unsafe { open_inheritable_nul(id == STD_INPUT_HANDLE) };
                }
                let mut duplicate = null_mut();
                if unsafe {
                    DuplicateHandle(
                        GetCurrentProcess(),
                        source,
                        GetCurrentProcess(),
                        &mut duplicate,
                        0,
                        1,
                        DUPLICATE_SAME_ACCESS,
                    )
                } == 0
                {
                    return Err(last_error("DuplicateHandle(stdio)"));
                }
                Ok(duplicate)
            })();
            match duplicated {
                Ok(handle) => handles[index] = handle,
                Err(error) => {
                    for handle in &handles[..index] {
                        unsafe { CloseHandle(*handle) };
                    }
                    return Err(error);
                }
            }
        }
        Ok(Self { handles })
    }
}

impl Drop for InheritableStdio {
    fn drop(&mut self) {
        for handle in self.handles {
            unsafe {
                CloseHandle(handle);
            }
        }
    }
}

unsafe fn open_inheritable_nul(readable: bool) -> Result<HANDLE, String> {
    let name = wide("NUL");
    let mut security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let access = if readable {
        GENERIC_READ
    } else {
        GENERIC_WRITE
    };
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &mut security,
            OPEN_EXISTING,
            0,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error("CreateFileW(NUL stdio)"));
    }
    Ok(handle)
}

unsafe fn wait_for_child(process: HANDLE, timeout_ms: Option<u64>) -> Result<u8, String> {
    let timeout_ms = timeout_ms.unwrap_or(DEFAULT_LAUNCH_TIMEOUT_MS);
    let wait = unsafe { WaitForSingleObject(process, timeout_ms as u32) };
    if wait == WAIT_TIMEOUT {
        return Err(format!("child exceeded the {timeout_ms} ms launch timeout"));
    }
    if wait != WAIT_OBJECT_0 {
        return Err(last_error("WaitForSingleObject"));
    }
    let mut exit_code = 1;
    if unsafe { GetExitCodeProcess(process, &mut exit_code) } == 0 {
        return Err(last_error("GetExitCodeProcess"));
    }
    if exit_code > u8::MAX as u32 {
        return Err(format!(
            "child {} returned unsupported exit code {exit_code}",
            unsafe { GetProcessId(process) }
        ));
    }
    Ok(exit_code as u8)
}

unsafe fn terminate_and_drain_job(job: HANDLE, root_process: HANDLE) -> Result<(), String> {
    if unsafe { TerminateJobObject(job, 124) } == 0 {
        return Err(last_error("TerminateJobObject"));
    }
    let root_wait = unsafe { WaitForSingleObject(root_process, 5_000) };
    if root_wait != WAIT_OBJECT_0 {
        return Err(if root_wait == WAIT_TIMEOUT {
            "timed out waiting for terminated root process".to_owned()
        } else {
            last_error("WaitForSingleObject(terminated root)")
        });
    }

    unsafe { wait_for_empty_job(job, Duration::from_secs(5)) }
}

/// Do not return control to ACL cleanup while any process can still be using
/// the launch identity. Error paths terminate the entire Job; successful root
/// exits get a bounded grace period for Job accounting and descendants to
/// drain, then fail closed and terminate any process tree that remains.
///
/// The outcome distinguishes settled from unsettled failures: only when the
/// Job is proven empty (directly, or after a successful terminate-and-drain)
/// may the caller run normal ACL/ledger cleanup. When termination or Job
/// accounting itself fails, processes may still hold the launch identity and
/// the recovery state must be preserved instead.
unsafe fn settle_job(
    result: Result<u8, String>,
    job: HANDLE,
    root_process: HANDLE,
) -> Result<u8, LaunchFailure> {
    match result {
        Ok(exit_code) => match unsafe { wait_for_empty_job(job, Duration::from_secs(5)) } {
            Ok(()) => Ok(exit_code),
            Err(drain) => match unsafe { terminate_and_drain_job(job, root_process) } {
                Ok(()) => Err(LaunchFailure::Settled(format!(
                    "child exited while its Job still contained processes: {drain}"
                ))),
                Err(cleanup) => Err(LaunchFailure::Unsettled(format!(
                    "{drain}; Job cleanup also failed: {cleanup}"
                ))),
            },
        },
        Err(error) => match unsafe { terminate_and_drain_job(job, root_process) } {
            Ok(()) => Err(LaunchFailure::Settled(error)),
            Err(cleanup) => Err(LaunchFailure::Unsettled(format!(
                "{error}; Job cleanup also failed: {cleanup}"
            ))),
        },
    }
}

unsafe fn wait_for_empty_job(job: HANDLE, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        if unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("QueryInformationJobObject(active processes)"));
        }
        if accounting.ActiveProcesses == 0 {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "timed out draining {} Job processes",
                accounting.ActiveProcesses
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

unsafe fn child_token_is_restricted(process: HANDLE) -> Result<bool, String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error("OpenProcessToken(child)"));
    }
    let result = unsafe { IsTokenRestricted(token) != 0 };
    unsafe { CloseHandle(token) };
    Ok(result)
}

unsafe fn child_token_is_appcontainer(process: HANDLE) -> Result<bool, String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error("OpenProcessToken(appcontainer child)"));
    }
    let result = unsafe { token_is_appcontainer(token) };
    unsafe { CloseHandle(token) };
    result
}

unsafe fn token_is_appcontainer(token: HANDLE) -> Result<bool, String> {
    let mut value = 0u32;
    let mut returned = 0u32;
    if unsafe {
        GetTokenInformation(
            token,
            TokenIsAppContainer,
            &mut value as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(last_error("GetTokenInformation(TokenIsAppContainer)"));
    }
    Ok(value != 0)
}

unsafe fn child_process_is_in_job(process: HANDLE) -> Result<bool, String> {
    let mut in_job = 0;
    if unsafe { IsProcessInJob(process, null_mut(), &mut in_job) } == 0 {
        return Err(last_error("IsProcessInJob(child)"));
    }
    Ok(in_job != 0)
}

/// Confirm the child belongs to `job` specifically. `IsProcessInJob` with a
/// non-null Job handle answers "is the process in *this* Job", unlike the
/// null-handle form which accepts membership in any ambient Job.
unsafe fn child_process_is_in_specific_job(process: HANDLE, job: HANDLE) -> Result<bool, String> {
    let mut in_job = 0;
    if unsafe { IsProcessInJob(process, job, &mut in_job) } == 0 {
        return Err(last_error("IsProcessInJob(child specific)"));
    }
    Ok(in_job != 0)
}

/// Confirm the child's token carries the exact AppContainer SID we created,
/// proving the requested identity was applied rather than some other
/// AppContainer. A non-null matching SID also implies the token is an
/// AppContainer token, so this subsumes the `TokenIsAppContainer` check.
unsafe fn child_token_appcontainer_sid_matches(
    process: HANDLE,
    expected_sid: *mut c_void,
) -> Result<bool, String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error("OpenProcessToken(appcontainer sid)"));
    }
    let result = unsafe { token_appcontainer_sid_matches(token, expected_sid) };
    unsafe { CloseHandle(token) };
    result
}

unsafe fn token_appcontainer_sid_matches(
    token: HANDLE,
    expected_sid: *mut c_void,
) -> Result<bool, String> {
    // First call sizes the buffer; TokenAppContainerSid returns a variable-size
    // TOKEN_APPCONTAINER_INFORMATION whose SID data trails the struct.
    let mut needed = 0u32;
    unsafe { GetTokenInformation(token, TokenAppContainerSid, null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(last_error("GetTokenInformation(TokenAppContainerSid size)"));
    }
    // `TOKEN_APPCONTAINER_INFORMATION` starts with a pointer field, so the
    // buffer must be pointer-aligned: a `Vec<u8>` only guarantees byte
    // alignment and reading the struct through it would be UB. Size the buffer
    // in `usize` words instead (same pattern as `current_user_sid_string`).
    let words = needed as usize / size_of::<usize>() + 1;
    let mut buffer = vec![0usize; words];
    if unsafe {
        GetTokenInformation(
            token,
            TokenAppContainerSid,
            buffer.as_mut_ptr() as *mut c_void,
            (buffer.len() * size_of::<usize>()) as u32,
            &mut needed,
        )
    } == 0
    {
        return Err(last_error("GetTokenInformation(TokenAppContainerSid)"));
    }
    let info = buffer.as_ptr() as *const TOKEN_APPCONTAINER_INFORMATION;
    let sid = unsafe { (*info).TokenAppContainer };
    if sid.is_null() {
        // A non-AppContainer token reports a null SID: the boundary was not
        // applied, so fail the match rather than erroring.
        return Ok(false);
    }
    Ok(unsafe { EqualSid(sid, expected_sid) } != 0)
}

fn quote_command(executable: &str, arguments: &[String]) -> Vec<u16> {
    let command = iter::once(executable)
        .chain(arguments.iter().map(String::as_str))
        .map(quote_argument)
        .collect::<Vec<_>>()
        .join(" ");
    wide(&command)
}

fn quote_argument(value: &str) -> String {
    let mut result = String::with_capacity(value.len() + 2);
    result.push('"');
    let mut backslashes = 0usize;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                result.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                backslashes = 0;
                result.push('"');
            }
            _ => {
                result.extend(std::iter::repeat_n('\\', backslashes));
                backslashes = 0;
                result.push(character);
            }
        }
    }
    result.extend(std::iter::repeat_n('\\', backslashes * 2));
    result.push('"');
    result
}

/// Environment variables the Windows process-creation substrate itself
/// requires. AppContainer creation resolves the package directory under
/// %LOCALAPPDATA% and CreateProcessW fails with ERROR_ENVVAR_NOT_FOUND
/// (os error 203) when it is missing from an explicit block; the loader
/// similarly relies on SystemRoot/SystemDrive. These are fixed, non-secret
/// machine paths, so filling gaps from the broker's own environment keeps
/// minimal manifests launchable without re-opening the ambient-environment
/// inheritance hole a null block used to create.
const SUBSTRATE_ENVIRONMENT: [&str; 3] = ["SystemRoot", "SystemDrive", "LOCALAPPDATA"];

/// Builds an explicit CreateProcess environment block from the allowlist,
/// with substrate variables filled in from the broker when the manifest does
/// not set them (a manifest-provided value always wins, compared
/// case-insensitively). Passing a null environment pointer would make the
/// child inherit the broker's entire ambient environment, silently bypassing
/// the allowlisted-environment boundary, so even an empty allowlist yields an
/// explicit block.
pub(crate) fn environment_block(
    environment: &std::collections::BTreeMap<String, String>,
) -> Vec<u16> {
    let mut entries = environment.clone();
    for name in SUBSTRATE_ENVIRONMENT {
        if entries.keys().any(|key| key.eq_ignore_ascii_case(name)) {
            continue;
        }
        if let Ok(value) = std::env::var(name) {
            entries.insert(name.to_owned(), value);
        }
    }
    let mut block = Vec::new();
    for (name, value) in &entries {
        block.extend(OsStr::new(&format!("{name}={value}")).encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
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
