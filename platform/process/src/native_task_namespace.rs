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

use std::{
    ffi::OsString,
    fs, io,
    os::{fd::AsRawFd, unix::process::ExitStatusExt},
    path::Path,
    process::Command,
};

pub const HELPER: &str = "__maka-native-task-namespace";

/// Run a live provider in a PID namespace with the original account identity.
/// The supervisor and namespace init remain in the transport's process group;
/// the kernel destroys the provider's descendants when namespace init exits.
///
/// # Safety
/// Call only at the trusted, single-threaded CLI entry point, before a runtime
/// or any other thread starts. The namespace init runs Rust after fork.
pub unsafe fn run(owner: u32, executable: &Path, args: Vec<OsString>) -> io::Result<i32> {
    if owner == 0 || !executable.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid native task bootstrap",
        ));
    }
    guard_owner(owner)?;
    let uid = rustix::process::geteuid().as_raw();
    let gid = rustix::process::getegid().as_raw();
    // SAFETY: unshare only changes the calling thread's namespaces. Fork below
    // creates their first child; the supervisor stays in the parent PID view.
    check(unsafe { libc::unshare(libc::CLONE_NEWUSER | libc::CLONE_NEWPID) })?;
    fs::write("/proc/self/uid_map", format!("{uid} {uid} 1\n"))?;
    fs::write("/proc/self/setgroups", b"deny")?;
    fs::write("/proc/self/gid_map", format!("{gid} {gid} 1\n"))?;
    guard_owner(owner)?;
    // SAFETY: mark only non-stdio descriptors close-on-exec; Rust keeps
    // ownership of its descriptors and can still report launch errors.
    if unsafe {
        libc::syscall(
            libc::SYS_close_range,
            3u32,
            u32::MAX,
            libc::CLOSE_RANGE_CLOEXEC,
        )
    } == -1
    {
        return Err(io::Error::last_os_error());
    }
    let supervisor = rustix::process::pidfd_open(
        rustix::process::getpid(),
        rustix::process::PidfdFlags::empty(),
    )?;

    // SAFETY: the caller guarantees this is still the single-threaded CLI.
    let init = unsafe { libc::fork() };
    check(init)?;
    if init == 0 {
        let result = run_init(supervisor, executable, args);
        std::process::exit(match result {
            Ok(code) => code,
            Err(error) => {
                eprintln!("native task namespace init: {error}");
                1
            }
        });
    }
    drop(supervisor);
    wait_for(init, init)
}

fn run_init(
    supervisor: std::os::fd::OwnedFd,
    executable: &Path,
    args: Vec<OsString>,
) -> io::Result<i32> {
    install_death_signal()?;
    // This parent has no PID in the child's namespace. The pidfd is inherited
    // from the original parent and closes the race before PR_SET_PDEATHSIG.
    let mut watch = libc::pollfd {
        fd: supervisor.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        // SAFETY: the pidfd is live and watch names exactly one pollfd.
        match unsafe { libc::poll(&mut watch, 1, 0) } {
            0 => break,
            1 => return Err(io::Error::other("native task supervisor already exited")),
            _ => {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }
    drop(supervisor);
    let provider = Command::new(executable).args(args).spawn()?;
    // Namespace init inherits orphans. Reap them while the provider is alive,
    // but end the namespace only when the original provider exits.
    wait_for(-1, provider.id() as libc::pid_t)
}

fn wait_for(child: libc::pid_t, original: libc::pid_t) -> io::Result<i32> {
    let mut status = 0;
    loop {
        // SAFETY: waitpid selects only our children and status points to writable storage.
        let result = unsafe { libc::waitpid(child, &mut status, 0) };
        match check(result) {
            Ok(()) if result == original => {
                return Ok(exit_code(std::process::ExitStatus::from_raw(status)));
            }
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

fn install_death_signal() -> io::Result<()> {
    // SAFETY: set the calling process's parent-death signal, with no pointers.
    check(unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) })
}

fn guard_owner(owner: u32) -> io::Result<()> {
    install_death_signal()?;
    if rustix::process::getppid().is_some_and(|pid| pid.as_raw_nonzero().get() as u32 == owner) {
        Ok(())
    } else {
        Err(io::Error::other("native task owner already exited"))
    }
}

fn check(result: libc::c_int) -> io::Result<()> {
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().expect("waited process exited"))
}
