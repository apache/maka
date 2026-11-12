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

//! The desktop shell, started responsible for itself.
//!
//! macOS grants Screen Recording to the *responsible* process: the terminal
//! `maka desktop` ran in, unless the shell disclaims it. Disclaimed, the grant
//! belongs to `Maka.app` however the desktop was started, as it does when
//! Finder opens it.

use std::{
    ffi::{CString, OsStr},
    io,
    os::unix::{ffi::OsStrExt, process::ExitStatusExt},
    path::Path,
    process::ExitStatus,
};
use tokio::task::JoinHandle;

/// A running shell; dropping it kills the shell, as `kill_on_drop` does.
pub(super) struct Shell {
    pid: libc::pid_t,
    exit: JoinHandle<io::Result<ExitStatus>>,
}

impl Shell {
    /// Starts `executable` with this process's environment plus `variables`.
    pub(super) fn spawn(executable: &Path, variables: &[(&str, &OsStr)]) -> io::Result<Self> {
        let program = c_string(executable.as_os_str().as_bytes())?;
        let mut environment = Vec::new();
        for (name, value) in std::env::vars_os() {
            if !variables.iter().any(|(set, _)| OsStr::new(set) == name) {
                environment.push(c_string(
                    &[name.as_bytes(), b"=", value.as_bytes()].concat(),
                )?);
            }
        }
        for (name, value) in variables {
            environment.push(c_string(
                &[name.as_bytes(), b"=", value.as_bytes()].concat(),
            )?);
        }
        let argv = [program.as_ptr().cast_mut(), std::ptr::null_mut()];
        let mut envp: Vec<*mut libc::c_char> = environment
            .iter()
            .map(|entry| entry.as_ptr().cast_mut())
            .collect();
        envp.push(std::ptr::null_mut());
        let mut pid = 0;
        // SAFETY: the attributes are initialised before use and destroyed
        // before returning; the program, argv and envp outlive the call.
        unsafe {
            let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
            check(libc::posix_spawnattr_init(&mut attributes))?;
            let spawned = (|| {
                // Rust ignores SIGPIPE; the shell starts with the defaults.
                let mut defaults: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut defaults);
                libc::sigaddset(&mut defaults, libc::SIGPIPE);
                check(libc::posix_spawnattr_setsigdefault(
                    &mut attributes,
                    &defaults,
                ))?;
                check(libc::posix_spawnattr_setflags(
                    &mut attributes,
                    libc::POSIX_SPAWN_SETSIGDEF as libc::c_short,
                ))?;
                check(disclaim(&mut attributes))?;
                check(libc::posix_spawn(
                    &mut pid,
                    program.as_ptr(),
                    std::ptr::null(),
                    &attributes,
                    argv.as_ptr(),
                    envp.as_ptr(),
                ))
            })();
            libc::posix_spawnattr_destroy(&mut attributes);
            spawned?;
        }
        let exit = tokio::task::spawn_blocking(move || {
            let mut status = 0;
            loop {
                // SAFETY: waits for the child this process started.
                if unsafe { libc::waitpid(pid, &mut status, 0) } == pid {
                    return Ok(ExitStatus::from_raw(status));
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        });
        Ok(Self { pid, exit })
    }

    pub(super) async fn wait(&mut self) -> io::Result<ExitStatus> {
        (&mut self.exit).await.map_err(io::Error::other)?
    }

    pub(super) async fn kill(&mut self) -> io::Result<()> {
        self.signal_kill();
        self.wait().await.map(drop)
    }

    fn signal_kill(&self) {
        if !self.exit.is_finished() {
            // SAFETY: the child is not reaped until `exit` finishes, so the
            // pid still names it.
            unsafe { libc::kill(self.pid, libc::SIGKILL) };
        }
    }
}

impl Drop for Shell {
    fn drop(&mut self) {
        // The blocking wait reaps it.
        self.signal_kill();
    }
}

/// `responsibility_spawnattrs_setdisclaim`, a private libSystem function
/// looked up by name, as `maka-host-shell` does.
unsafe fn disclaim(attributes: *mut libc::posix_spawnattr_t) -> libc::c_int {
    type Disclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, libc::c_int) -> libc::c_int;
    // SAFETY: the symbol has this C signature; its absence is reported.
    unsafe {
        let symbol = libc::dlsym(
            libc::RTLD_DEFAULT,
            c"responsibility_spawnattrs_setdisclaim".as_ptr(),
        );
        if symbol.is_null() {
            return libc::ENOSYS;
        }
        std::mem::transmute::<*mut libc::c_void, Disclaim>(symbol)(attributes, 1)
    }
}

fn c_string(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(io::Error::other)
}

fn check(status: libc::c_int) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status))
    }
}
