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

//! Windowless Windows launcher for Maka scheduled tasks.
//!
//! Task Scheduler cannot pass `CREATE_NO_WINDOW` to a console PE without
//! flashing a console window. Keeping this GUI-subsystem shim separate from
//! `maka.exe` avoids shipping a second full copy of the Host binary on Windows.

#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

#[cfg(any(windows, test))]
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[cfg(any(windows, test))]
const SERVICE_SUFFIX: &str = ".service.exe";

/// Resolves the console executable paired with this launcher.
///
/// Staged deployment aliases (`maka-<sha256>.service.exe`) map to the sibling
/// `maka-<sha256>.exe`; install-directory invocations (`maka-service.exe`) map
/// to the sibling `maka.exe`.
#[cfg(any(windows, test))]
fn resolve_target(current_exe: &Path) -> Result<PathBuf, String> {
    let parent = current_exe
        .parent()
        .ok_or_else(|| "maka-service executable has no parent directory".to_owned())?;
    let name = current_exe
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "maka-service executable name is not valid UTF-8".to_owned())?;
    let target = if name.len() > SERVICE_SUFFIX.len()
        && name[name.len() - SERVICE_SUFFIX.len()..].eq_ignore_ascii_case(SERVICE_SUFFIX)
    {
        let stem = &name[..name.len() - SERVICE_SUFFIX.len()];
        parent.join(format!("{stem}.exe"))
    } else {
        parent.join("maka.exe")
    };
    if target
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(name))
    {
        return Err("maka-service resolved to itself".to_owned());
    }
    Ok(target)
}

#[cfg(windows)]
mod platform {
    use super::resolve_target;
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, ExitCode};
    use std::ptr;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, GetCurrentProcess};

    // Kept alive until process termination so the OS closes the Job handle
    // atomically when Task Scheduler stops this launcher, reaping the child
    // console process while still allowing explicit breakaway subprocesses.
    static LAUNCHER_JOB: OnceLock<OwnedHandle> = OnceLock::new();

    fn bind_launcher_job() -> io::Result<()> {
        if LAUNCHER_JOB.get().is_some() {
            return Ok(());
        }
        // SAFETY: anonymous non-inheritable Job handle initialized with a valid
        // struct pointer/size and bound to the current process pseudo-handle.
        let job = unsafe {
            let handle = CreateJobObjectW(ptr::null(), ptr::null());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = OwnedHandle::from_raw_handle(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            if SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(job.as_raw_handle(), GetCurrentProcess()) == 0
            {
                return Err(io::Error::last_os_error());
            }
            job
        };
        let _ = LAUNCHER_JOB.set(job);
        Ok(())
    }

    pub(super) fn run() -> ExitCode {
        match run_inner() {
            Ok(code) => std::process::exit(code),
            Err(message) => {
                eprintln!("maka-service: {message}");
                ExitCode::FAILURE
            }
        }
    }

    fn run_inner() -> Result<i32, String> {
        // Do not canonicalize: a staged `maka-<sha>.service.exe` is a hard link
        // to the content-addressed launcher, and GetFinalPathNameByHandleW may
        // resolve a hard link to another link name instead of `.service.exe`.
        let current = std::env::current_exe()
            .map_err(|error| format!("failed to locate current executable: {error}"))?;
        let target = resolve_target(&current)?;
        let metadata = target.symlink_metadata().map_err(|error| {
            format!(
                "missing sibling console executable {}: {error}",
                target.display()
            )
        })?;
        if !metadata.is_file() {
            return Err(format!(
                "sibling console executable {} must be a regular file",
                target.display()
            ));
        }
        bind_launcher_job().map_err(|error| format!("failed to bind launcher job: {error}"))?;
        let status = Command::new(&target)
            .args(std::env::args_os().skip(1))
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|error| format!("failed to start {}: {error}", target.display()))?;
        Ok(status.code().unwrap_or(1))
    }
}

#[cfg(windows)]
fn main() -> ExitCode {
    platform::run()
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    eprintln!("maka-service runs only on Windows");
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::resolve_target;
    use std::path::{Path, PathBuf};

    #[test]
    fn resolves_install_directory_sibling() {
        let current = Path::new("/opt/maka/maka-service.exe");
        assert_eq!(
            resolve_target(current).unwrap(),
            PathBuf::from("/opt/maka/maka.exe")
        );
    }

    #[test]
    fn resolves_staged_service_alias_case_insensitively() {
        let digest = "a".repeat(64);
        let lower = PathBuf::from(format!("/deployments/packages/maka-{digest}.service.exe"));
        assert_eq!(
            resolve_target(&lower).unwrap(),
            PathBuf::from(format!("/deployments/packages/maka-{digest}.exe"))
        );

        let upper = PathBuf::from(format!("/deployments/packages/maka-{digest}.SERVICE.EXE"));
        assert_eq!(
            resolve_target(&upper).unwrap(),
            PathBuf::from(format!("/deployments/packages/maka-{digest}.exe"))
        );
    }

    #[test]
    fn rejects_self_recursion() {
        assert!(resolve_target(Path::new("/opt/maka/maka.exe")).is_err());
        assert!(resolve_target(Path::new("/opt/maka/MAKA.EXE")).is_err());
    }
}
