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

//! The executable of `Maka Host.app`, the identity the Maka Host runs under
//! on macOS.
//!
//! macOS grants Accessibility and Screen Recording to the *responsible*
//! process, which is normally the application that started a process: Maka,
//! or the terminal a CLI ran in. Started as `maka-host-shell <maka> <args>`,
//! this executable starts itself again with responsibility disclaimed, so
//! that copy is responsible for itself and the grants belong to
//! `Maka Host.app`. That copy runs `<maka> <args>` and waits for it.
//!
//! Both copies pass stdin, stdout and stderr through, forward termination
//! signals, and exit with the Host's status, so whoever started the shell
//! sees the Host itself. If the shell is killed outright, the Host still
//! ends with its owner: an interactive Host when its owner closes stdin,
//! and a launchd service with the process group launchd removes.
//!
//! The shell starts only a program named `maka` with `host candidate` or
//! `host service-run`. That keeps it from being a general way to borrow the
//! grants, but a process of the same account can still change what `maka`
//! is, so the grants protect no more than the account itself does. macOS ties a grant to the bytes of this executable,
//! so it changes only together with the bundle version (see
//! `products/maka/cli/src/deployment/host_identity.rs`).

#[cfg(target_os = "macos")]
fn main() {
    std::process::exit(macos::run());
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("maka-host-shell runs only on macOS");
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{CString, OsString};
    use std::os::unix::ffi::OsStringExt;
    use std::sync::atomic::{AtomicI32, Ordering};

    /// Set in the copy that runs with responsibility disclaimed.
    const DISCLAIMED: &str = "MAKA_HOST_SHELL_DISCLAIMED";
    const SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

    static CHILD: AtomicI32 = AtomicI32::new(0);

    pub fn run() -> i32 {
        let arguments: Vec<OsString> = std::env::args_os().collect();
        if !permitted(&arguments[1.min(arguments.len())..]) {
            eprintln!("usage: maka-host-shell <maka> host candidate|service-run [arguments...]");
            return 2;
        }
        // Termination signals stay pending until the child is known, so
        // none of them can end the shell and leave the child behind.
        let previous = block();
        let disclaimed = std::env::var_os(DISCLAIMED).is_some();
        // SAFETY: removing a variable before any other thread exists.
        unsafe { std::env::remove_var(DISCLAIMED) };
        if !disclaimed && let Some(code) = again(&arguments, &previous) {
            return code;
        }
        // Disclaimed, or disclaiming is unavailable: run the Host here.
        match spawn(&arguments[1..], false, &previous) {
            Ok(child) => wait(child, &previous),
            Err(error) => {
                eprintln!("maka-host-shell: cannot start {:?}: {error}", arguments[1]);
                127
            }
        }
    }

    /// Whether `command` runs the Host: `<dir>/maka host candidate|service-run ...`.
    fn permitted(command: &[OsString]) -> bool {
        let [program, host, role, ..] = command else {
            return false;
        };
        std::path::Path::new(program).file_name() == Some("maka".as_ref())
            && host == "host"
            && (role == "candidate" || role == "service-run")
    }

    /// Blocks the termination signals, returning the previous mask.
    fn block() -> libc::sigset_t {
        // SAFETY: both sets are initialised by the calls that fill them.
        unsafe {
            let mut blocked: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut blocked);
            for signal in SIGNALS {
                libc::sigaddset(&mut blocked, signal);
            }
            let mut previous: libc::sigset_t = std::mem::zeroed();
            libc::sigprocmask(libc::SIG_BLOCK, &blocked, &mut previous);
            previous
        }
    }

    /// Runs this executable again, responsible for itself. `None` when that
    /// is not possible.
    fn again(arguments: &[OsString], previous: &libc::sigset_t) -> Option<i32> {
        let mut argv = vec![std::env::current_exe().ok()?.into_os_string()];
        argv.extend(arguments[1..].iter().cloned());
        // SAFETY: setting a variable before any other thread exists; the
        // spawned copy inherits it, and this one exits after it.
        unsafe { std::env::set_var(DISCLAIMED, "1") };
        let spawned = spawn(&argv, true, previous);
        // SAFETY: as above.
        unsafe { std::env::remove_var(DISCLAIMED) };
        spawned.ok().map(|child| wait(child, previous))
    }

    /// Starts `argv` with the signal mask the shell started with.
    fn spawn(
        argv: &[OsString],
        disclaim: bool,
        mask: &libc::sigset_t,
    ) -> std::io::Result<libc::pid_t> {
        let argv: Vec<CString> = argv
            .iter()
            .map(|argument| CString::new(argument.clone().into_vec()))
            .collect::<Result<_, _>>()?;
        let mut pointers: Vec<*mut libc::c_char> = argv
            .iter()
            .map(|argument| argument.as_ptr().cast_mut())
            .collect();
        pointers.push(std::ptr::null_mut());
        unsafe extern "C" {
            static environ: *const *mut libc::c_char;
        }
        // SAFETY: the attributes are initialised before use and destroyed
        // before returning; argv outlives the call; environ is the
        // process's own environment.
        unsafe {
            let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
            check(libc::posix_spawnattr_init(&mut attributes))?;
            let result = (|| {
                check(libc::posix_spawnattr_setsigmask(&mut attributes, mask))?;
                check(libc::posix_spawnattr_setflags(
                    &mut attributes,
                    libc::POSIX_SPAWN_SETSIGMASK as libc::c_short,
                ))?;
                if disclaim {
                    check(disclaim_responsibility(&mut attributes))?;
                }
                let mut pid = 0;
                check(libc::posix_spawn(
                    &mut pid,
                    argv[0].as_ptr(),
                    std::ptr::null(),
                    &attributes,
                    pointers.as_ptr(),
                    environ,
                ))?;
                Ok(pid)
            })();
            libc::posix_spawnattr_destroy(&mut attributes);
            result
        }
    }

    /// `responsibility_spawnattrs_setdisclaim`, a private libSystem function
    /// looked up by name.
    unsafe fn disclaim_responsibility(attributes: *mut libc::posix_spawnattr_t) -> libc::c_int {
        type Disclaim =
            unsafe extern "C" fn(*mut libc::posix_spawnattr_t, libc::c_int) -> libc::c_int;
        // SAFETY: the symbol has this C signature; its absence is handled.
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

    fn check(status: libc::c_int) -> std::io::Result<()> {
        if status == 0 {
            Ok(())
        } else {
            Err(std::io::Error::from_raw_os_error(status))
        }
    }

    extern "C" fn forward(signal: libc::c_int) {
        let child = CHILD.load(Ordering::Relaxed);
        if child > 0 {
            // SAFETY: kill is async-signal-safe.
            unsafe { libc::kill(child, signal) };
        }
    }

    /// Waits for the child, forwarding termination signals to it, and
    /// returns the status to exit with. Unblocks the signals that arrived
    /// meanwhile, so they reach the child.
    fn wait(child: libc::pid_t, previous: &libc::sigset_t) -> i32 {
        CHILD.store(child, Ordering::Relaxed);
        // SAFETY: the handler only calls kill; the action is initialised
        // before use.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = forward as extern "C" fn(libc::c_int) as libc::sighandler_t;
            libc::sigemptyset(&mut action.sa_mask);
            for signal in SIGNALS {
                libc::sigaction(signal, &action, std::ptr::null_mut());
            }
            libc::sigprocmask(libc::SIG_SETMASK, previous, std::ptr::null_mut());
        }
        let mut status = 0;
        loop {
            // SAFETY: status is a valid out pointer.
            let waited = unsafe { libc::waitpid(child, &mut status, 0) };
            if waited == child {
                break;
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                return 1;
            }
        }
        if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else if libc::WIFSIGNALED(status) {
            128 + libc::WTERMSIG(status)
        } else {
            1
        }
    }
}
