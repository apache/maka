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

//! Original Unix process-group lifetime shared by pipe and PTY transports.
use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, waitid};
use std::{io, process::ExitStatus, time::Duration};

pub(crate) struct Group {
    child: tokio::process::Child,
    pid: Pid,
    status: Option<ExitStatus>,
    changed: tokio::signal::unix::Signal,
    cleaned: bool,
    signalled: bool,
    terminate_on_drop: bool,
}
impl Group {
    pub fn new(child: tokio::process::Child, changed: tokio::signal::unix::Signal) -> Self {
        let pid = Pid::from_raw(child.id().expect("spawned process has a PID") as i32)
            .expect("positive child PID");
        Self {
            child,
            pid,
            status: None,
            changed,
            cleaned: false,
            signalled: false,
            terminate_on_drop: true,
        }
    }
    /// An external owner outlives its observer; explicit wait/control remain live.
    pub(crate) fn detach_on_drop(&mut self) {
        self.terminate_on_drop = false;
    }

    pub fn pid(&self) -> Pid {
        self.pid
    }
    pub fn cleaned(&self) -> bool {
        self.cleaned
    }
    pub fn reaped(&self) -> bool {
        self.status.is_some()
    }
    pub fn interrupt(&mut self) -> io::Result<bool> {
        if self.status.is_some() {
            return Ok(false);
        }
        match rustix::process::kill_process_group(self.pid, Signal::TERM) {
            Ok(()) => Ok(true),
            Err(rustix::io::Errno::SRCH) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
    pub async fn root_exited(&mut self) -> io::Result<()> {
        if self.status.is_some() {
            return Ok(());
        }
        loop {
            match waitid(
                WaitId::Pid(self.pid),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            ) {
                Ok(Some(_)) => return Ok(()),
                Ok(None) | Err(rustix::io::Errno::INTR) => {}
                Err(error) => {
                    return Err(io::Error::new(
                        error.kind(),
                        format!("observe process exit: {error}"),
                    ));
                }
            }
            if self.changed.recv().await.is_none() {
                return Err(io::Error::other("process exit signal closed"));
            }
        }
    }
    /// Signal only while our unreaped child pins the group identity.
    pub fn terminate(&mut self) -> io::Result<bool> {
        if self.status.is_none() && !self.signalled {
            let applied = match rustix::process::kill_process_group(self.pid, Signal::KILL) {
                Ok(()) => true,
                Err(rustix::io::Errno::SRCH) => false,
                // macOS can reject signalling a group whose root is already a
                // zombie. This is only a signal result; wait still reaps the
                // root and independently confirms that every group member left.
                Err(rustix::io::Errno::PERM)
                    if matches!(
                        waitid(
                            WaitId::Pid(self.pid),
                            WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
                        ),
                        Ok(Some(_))
                    ) =>
                {
                    false
                }
                Err(error) => return Err(error.into()),
            };
            self.signalled = true;
            return Ok(applied);
        }
        Ok(false)
    }

    /// Root exit is observed without reaping, then remaining group members are
    /// signalled before releasing its PID. Escaped sessions are not a sandbox.
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        if self.status.is_none() {
            self.root_exited().await?;
            if let Err(error) = self.terminate()
                && error.raw_os_error() != Some(libc::EPERM)
            {
                return Err(io::Error::new(
                    error.kind(),
                    format!("terminate remaining process group: {error}"),
                ));
            }
            // macOS can report EPERM for a group containing only our zombie.
            // Reap the known-exited root, then still require the group to vanish.
            // A live unsignallable descendant is NOT treated as successful cleanup.
            self.status = Some(self.child.wait().await?);
        }
        if !self.cleaned {
            // Observation after reaping is harmless even if a group ID is reused:
            // it can conservatively fail cleanup, never signal an unrelated group.
            wait_group_closed(self.pid).await?;
            self.cleaned = true;
        }
        Ok(self.status.expect("root was reaped"))
    }
}
pub(crate) async fn wait_group_closed(pid: Pid) -> io::Result<()> {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            // SAFETY: pid is positive and signal zero only observes; a reused group can only delay closure.
            let result = unsafe { libc::kill(-pid.as_raw_nonzero().get(), 0) };
            if result != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    return Ok(());
                }
                if error.raw_os_error() != Some(libc::EPERM) {
                    return Err(io::Error::new(
                        error.kind(),
                        format!("observe process group cleanup: {error}"),
                    ));
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| io::Error::other("process group exit is unconfirmed"))?
}
impl Drop for Group {
    fn drop(&mut self) {
        // Emergency signal only; callers must await the real group-exit fence.
        if self.terminate_on_drop {
            let _ = self.terminate();
        }
    }
}
