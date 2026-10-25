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

//! Native PTY handles. The resource owner supplies a captured command, persists
//! startup before calling spawn, and drains output before publishing its exit fence.
//! These handles do not create a second resource owner or perform recovery.

use super::{PtyCommand, stream};
use crate::group::Group;
use maka_agent_facts::terminal::TerminalSize;
use rustix::{
    fd::OwnedFd,
    fs::{Mode, OFlags},
    process::{Pid, Signal},
};
use std::{
    io,
    os::fd::AsRawFd,
    process::{ExitStatus, Stdio},
    sync::Arc,
};
use tokio::{
    io::unix::AsyncFd,
    signal::unix::{SignalKind, signal as observe_signal},
};

pub use stream::PtyIo;

/// The unreaped root pins its group through descendant termination and reaping.
/// The current foreground group is also signalled while this terminal still
/// belongs to that Session. Arbitrarily escaped groups are not an OS sandbox.
pub struct PtyChild {
    group: Group,
    master: Arc<AsyncFd<OwnedFd>>,
    proxy: Option<maka_network::proxy::Proxy>,
    #[cfg(target_os = "linux")]
    mount_cleanup: crate::command::Cleanup,
}

pub async fn spawn(
    plan: PtyCommand,
    size: TerminalSize,
) -> Result<(PtyChild, PtyIo), maka_agent_facts::tools::ToolError> {
    let mut plan = plan.prepare().await?;
    let spawned = (|| -> io::Result<_> {
        let changed = observe_signal(SignalKind::child())?;
        let mut command = plan.unix();
        // Open the multiplexor with CLOEXEC atomically: openpty + a later fcntl
        // leaves a descriptor-inheritance window when other sessions spawn.
        let master = rustix::fs::open(
            c"/dev/ptmx",
            OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        rustix::pty::grantpt(&master)?;
        rustix::pty::unlockpt(&master)?;
        #[cfg(target_os = "linux")]
        let slave = rustix::pty::ioctl_tiocgptpeer(
            &master,
            rustix::pty::OpenptFlags::RDWR
                | rustix::pty::OpenptFlags::NOCTTY
                | rustix::pty::OpenptFlags::CLOEXEC,
        )?;
        #[cfg(target_os = "macos")]
        let slave = rustix::fs::open(
            rustix::pty::ptsname(&master, Vec::new())?,
            OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?;
        stream::resize(&master, size)?;
        let flags = rustix::fs::fcntl_getfl(&master)?;
        rustix::fs::fcntl_setfl(&master, flags | OFlags::NONBLOCK)?;
        // SAFETY: AsyncFd owns this OwnedFd, whose descriptor stays open and
        // unchanged until it is dropped or returned by into_inner.
        let master = Arc::new(unsafe { AsyncFd::register(master)? });
        command
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave));
        command.kill_on_drop(true);
        // SAFETY: pre_exec performs only async-signal-safe syscalls and creates no
        // allocations/locks. std has already installed the owned slave on fd 0..2.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                for signal in [
                    libc::SIGCHLD,
                    libc::SIGHUP,
                    libc::SIGINT,
                    libc::SIGQUIT,
                    libc::SIGTERM,
                    libc::SIGALRM,
                    libc::SIGTSTP,
                    libc::SIGTTIN,
                    libc::SIGTTOU,
                ] {
                    libc::signal(signal, libc::SIG_DFL);
                }
                let mut set = std::mem::zeroed();
                if libc::sigemptyset(&mut set) != 0
                    || libc::sigprocmask(libc::SIG_SETMASK, &set, std::ptr::null_mut()) != 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn()?;
        Ok((child, master, changed))
    })();
    let (child, master, changed) = match spawned {
        Ok(spawned) => spawned,
        Err(error) => {
            plan.abort().await?;
            return Err(crate::failed(error));
        }
    };
    // Drop the Command's parent copies of the slave before returning the master.
    Ok((
        PtyChild {
            group: Group::new(child, changed),
            master: master.clone(),
            proxy: plan.take_proxy(),
            #[cfg(target_os = "linux")]
            mount_cleanup: plan.take_mount_lease().into(),
        },
        PtyIo { master },
    ))
}

impl PtyChild {
    pub async fn resize(&mut self, size: TerminalSize) -> io::Result<()> {
        stream::resize(self.master.get_ref(), size)
    }

    /// Unix has no separate console server. EOF/drain remains the caller's job.
    pub async fn close(&mut self) -> io::Result<()> {
        if !self.group.cleaned() {
            return Err(io::Error::other("wait for the PTY group before closing"));
        }
        #[cfg(target_os = "linux")]
        self.mount_cleanup.finish().await?;
        if let Some(proxy) = &mut self.proxy {
            proxy.close().await?;
        }
        Ok(())
    }

    pub fn id(&self) -> u32 {
        self.group.pid().as_raw_nonzero().get() as u32
    }

    /// Keep the root unreaped while terminating its owned group and the
    /// terminal's current foreground job. Output drain is still a separate fence.
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        if !self.group.reaped() {
            self.group.root_exited().await?;
            self.terminate()?;
        }
        let status = self.group.wait().await?;
        #[cfg(target_os = "linux")]
        self.mount_cleanup.finish().await?;
        Ok(status)
    }

    /// Signal while the root remains unreaped. Foreground group signalling is
    /// best-effort: a numeric tcgetpgrp snapshot is not a stable process handle.
    /// Caller must still wait and drain before treating termination as complete.
    pub fn terminate(&mut self) -> io::Result<bool> {
        if self.group.reaped() {
            return Ok(false);
        }
        let mut foreground_result = Ok(false);
        // macOS returns 0 after terminal session exit. Do not feed that
        // sentinel into a wrapper requiring a positive process-group identity.
        let fd = self.master.get_ref().as_raw_fd();
        let foreground = unsafe { libc::tcgetpgrp(fd) };
        if foreground > 0
            && let Some(group) = Pid::from_raw(foreground)
            && group != self.group.pid()
            && unsafe { libc::tcgetsid(fd) } == self.group.pid().as_raw_nonzero().get()
        {
            // Only use the foreground snapshot while the terminal still belongs
            // to our session. This is not an atomic group-identity guarantee.
            foreground_result = signal(group);
        }
        // A privileged foreground job may reject our signal; that must not
        // prevent cleanup of the root that we can still terminate.
        let root_result = self.group.terminate();
        Ok(foreground_result? | root_result?)
    }
}

impl Drop for PtyChild {
    fn drop(&mut self) {
        // Emergency cleanup only. Normal resource shutdown calls terminate,
        // awaits wait(), and drains the master so it can persist real evidence.
        let _ = self.terminate();
        // Tokio's kill-on-drop / orphan reaper owns the unreaped root after drop.
    }
}

fn signal(group: Pid) -> io::Result<bool> {
    match rustix::process::kill_process_group(group, Signal::KILL) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::SRCH) => Ok(false),
        Err(error) => Err(error.into()),
    }
}
