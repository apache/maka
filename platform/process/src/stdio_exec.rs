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

//! Darwin's atomic close-on-exec-default, restricted to the isolated owner role.
use std::{ffi::CString, io, os::unix::ffi::OsStrExt, ptr};

unsafe extern "C" {
    fn posix_spawn_file_actions_addinherit_np(
        actions: *mut libc::posix_spawn_file_actions_t,
        fd: libc::c_int,
    ) -> libc::c_int;
}

pub(crate) fn install(command: &mut tokio::process::Command) -> io::Result<()> {
    let executable = command.as_std().get_program();
    let program = string(executable.as_bytes())?;
    let args = std::iter::once(Ok(program.clone()))
        .chain(
            command
                .as_std()
                .get_args()
                .map(|arg| string(arg.as_bytes())),
        )
        .collect::<io::Result<Vec<_>>>()?;
    // Prepared::unix always clears the environment and supplies captured values.
    let env = command
        .as_std()
        .get_envs()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .map(|(key, value)| {
            let mut entry = key.to_os_string();
            entry.push("=");
            entry.push(value);
            string(entry.as_bytes())
        })
        .collect::<io::Result<Vec<_>>>()?;
    let attributes = Attributes::new()?;
    let actions = Actions::new()?;
    let exec = Exec {
        program,
        argv: pointers(&args),
        envp: pointers(&env),
        _args: args,
        _env: env,
        attributes,
        actions,
    };
    // SAFETY: every allocation and native action construction happens above in
    // the parent. This final callback only invokes Darwin's SETEXEC kernel path
    // with immutable, live C buffers. No FD snapshot, iteration, allocation or
    // closefrom runs after fork. Failed exec leaves Rust's error pipe intact;
    // successful exec atomically closes everything except the actual 0/1/2.
    unsafe {
        command.pre_exec(move || exec.replace());
    }
    Ok(())
}
fn string(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}
fn pointers(strings: &[CString]) -> Vec<*mut libc::c_char> {
    strings
        .iter()
        .map(|value| value.as_ptr().cast_mut())
        .chain(std::iter::once(ptr::null_mut()))
        .collect()
}
struct Exec {
    program: CString,
    argv: Vec<*mut libc::c_char>,
    envp: Vec<*mut libc::c_char>,
    _args: Vec<CString>,
    _env: Vec<CString>,
    attributes: Attributes,
    actions: Actions,
}
// SAFETY: pointers refer only to the immutable owned buffers/opaque native
// actions in this object. It moves with Command, is never mutated by callbacks,
// and is destroyed in the parent only after the spawn/exec handshake finishes.
unsafe impl Send for Exec {}
unsafe impl Sync for Exec {}
impl Exec {
    fn replace(&self) -> io::Result<()> {
        // SAFETY: SETEXEC replaces this same child, preserving its PID/PGID and
        // the transport's already installed cwd, stdio and PTY setup. On error,
        // no successful replacement occurred; return its original errno through
        // std's untouched CLOEXEC error pipe, never report a fabricated spawn.
        let error = unsafe {
            libc::posix_spawn(
                ptr::null_mut(),
                self.program.as_ptr(),
                &self.actions.0,
                &self.attributes.0,
                self.argv.as_ptr(),
                self.envp.as_ptr(),
            )
        };
        Err(io::Error::from_raw_os_error(if error == 0 {
            libc::EIO
        } else {
            error
        }))
    }
}
struct Attributes(libc::posix_spawnattr_t);
impl Attributes {
    fn new() -> io::Result<Self> {
        let mut value = std::mem::MaybeUninit::uninit();
        // SAFETY: native init writes one attribute object, owned until destroy.
        unsafe {
            check(libc::posix_spawnattr_init(value.as_mut_ptr()))?;
            let mut value = Self(value.assume_init());
            check(libc::posix_spawnattr_setflags(
                &mut value.0,
                (libc::POSIX_SPAWN_SETEXEC | libc::POSIX_SPAWN_CLOEXEC_DEFAULT) as _,
            ))?;
            Ok(value)
        }
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            libc::posix_spawnattr_destroy(&mut self.0);
        }
    }
}
struct Actions(libc::posix_spawn_file_actions_t);
impl Actions {
    fn new() -> io::Result<Self> {
        let mut value = std::mem::MaybeUninit::uninit();
        // SAFETY: only the transport's three actual stdio slots are retained.
        // No caller-supplied FD number or Root handle is an inheritance grant.
        unsafe {
            check(libc::posix_spawn_file_actions_init(value.as_mut_ptr()))?;
            let mut value = Self(value.assume_init());
            for fd in 0..=2 {
                check(posix_spawn_file_actions_addinherit_np(&mut value.0, fd))?;
            }
            Ok(value)
        }
    }
}
impl Drop for Actions {
    fn drop(&mut self) {
        unsafe {
            libc::posix_spawn_file_actions_destroy(&mut self.0);
        }
    }
}
fn check(error: libc::c_int) -> io::Result<()> {
    if error == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(error))
    }
}
