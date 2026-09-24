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

use super::Spawned;
use crate::Command;
use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, waitid};
use std::{
    io,
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::signal::unix::{SignalKind, signal};

pub struct Child {
    child: tokio::process::Child,
    pid: Pid,
    status: Option<ExitStatus>,
    changed: tokio::signal::unix::Signal,
    cleaned: bool,
    signalled: bool,
    proxy: Option<maka_network::proxy::Proxy>,
    #[cfg(target_os = "linux")]
    mount_cleanup: crate::command::Cleanup,
}

pub async fn spawn(plan: Command) -> io::Result<Spawned> {
    if !plan.cwd.is_absolute() || !plan.executable.is_absolute() {
        return Err(io::Error::other(
            "pipe processes require captured absolute executable and cwd",
        ));
    }
    let mut plan = plan.prepare().await?;
    let mut proxy = plan.take_proxy();
    #[cfg(target_os = "linux")]
    let mount_lease = plan.take_mount_lease();
    let spawned = (|| {
        // Subscribe before spawn/check so an immediate exit cannot lose its wake.
        let changed = signal(SignalKind::child())?;
        let child = plan
            .unix()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()?;
        Ok((child, changed))
    })();
    let (mut child, changed) = match spawned {
        Ok(spawned) => spawned,
        Err(error) => {
            if let Some(proxy) = &mut proxy {
                proxy.close().await?;
            }
            #[cfg(target_os = "linux")]
            crate::command::Cleanup::from(mount_lease).finish().await?;
            return Err(error);
        }
    };
    let pid = Pid::from_raw(child.id().expect("spawned process has a PID") as i32)
        .expect("positive child PID");
    Ok(Spawned {
        stdin: child.stdin.take().expect("piped stdin"),
        stdout: child.stdout.take().expect("piped stdout"),
        stderr: child.stderr.take().expect("piped stderr"),
        child: Child {
            child,
            pid,
            changed,
            status: None,
            cleaned: false,
            signalled: false,
            proxy,
            #[cfg(target_os = "linux")]
            mount_cleanup: mount_lease.into(),
        },
    })
}
impl Child {
    pub fn id(&self) -> u32 {
        self.pid.as_raw_nonzero().get() as u32
    }

    /// Signal only while our unreaped child pins the group identity.
    pub fn terminate(&mut self) -> io::Result<()> {
        if self.status.is_none() && !self.signalled {
            match rustix::process::kill_process_group(self.pid, Signal::KILL) {
                Ok(()) | Err(rustix::io::Errno::SRCH) => {}
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
                    ) => {}
                Err(error) => return Err(error.into()),
            }
            self.signalled = true;
        }
        Ok(())
    }

    /// Root exit is observed without reaping, then remaining group members are
    /// signalled before releasing its PID. Escaped sessions are not a sandbox.
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        if self.status.is_none() {
            loop {
                match waitid(
                    WaitId::Pid(self.pid),
                    WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
                ) {
                    Ok(Some(_)) => break,
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
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let result = unsafe { libc::kill(-self.pid.as_raw_nonzero().get(), 0) };
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
            .map_err(|_| io::Error::other("process group exit is unconfirmed"))??;
            self.cleaned = true;
        }
        #[cfg(target_os = "linux")]
        self.mount_cleanup.finish().await?;
        if let Some(proxy) = &mut self.proxy {
            proxy.close().await?;
        }
        Ok(self.status.expect("root was reaped"))
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        // Emergency signal; Tokio owns root reaping. A caller must await wait()
        // to claim cleanup, not treat Drop as confirmation.
        let _ = self.terminate();
    }
}
