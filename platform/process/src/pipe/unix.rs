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
use crate::group::Group;
use std::{
    io,
    process::{ExitStatus, Stdio},
};
use tokio::signal::unix::{SignalKind, signal};

pub struct Child {
    external: Option<crate::isolated::ExternalOwner>,
    group: Group,
    local_status: Option<ExitStatus>,
    proxy: Option<maka_network::proxy::Proxy>,
    #[cfg(target_os = "linux")]
    mount_cleanup: crate::command::Cleanup,
}

pub async fn spawn(plan: Command) -> Result<Spawned, maka_agent_facts::tools::ToolError> {
    if !plan.cwd.is_absolute() || !plan.executable.is_absolute() {
        return Err(crate::failed(
            "pipe processes require captured absolute executable and cwd",
        ));
    }
    spawn_prepared(plan.prepare().await?).await
}

pub(crate) async fn spawn_prepared(
    mut plan: crate::command::Prepared,
) -> Result<Spawned, maka_agent_facts::tools::ToolError> {
    let external = plan.take_external_owner();
    let spawned = (|| -> io::Result<_> {
        // Subscribe before spawn/check so an immediate exit cannot lose its wake.
        let changed = signal(SignalKind::child())?;
        let mut command = plan.unix();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(external.is_none());
        plan.isolate_stdio(&mut command)?;
        let child = command.spawn()?;
        Ok((child, changed))
    })();
    let (mut child, changed) = match spawned {
        Ok(spawned) => spawned,
        Err(error) => {
            plan.abort().await?;
            return Err(crate::failed(error));
        }
    };
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let mut group = Group::new(child, changed);
    if external.is_some() {
        group.detach_on_drop();
    }
    Ok(Spawned {
        stdin,
        stdout,
        stderr,
        child: Child {
            external: external.map(crate::isolated::ExternalOwner::new),
            group,
            local_status: None,
            proxy: plan.take_proxy(),
            #[cfg(target_os = "linux")]
            mount_cleanup: plan.take_mount_lease().into(),
        },
    })
}
impl Child {
    /// Observe this original child without reaping or confirming its group.
    pub(crate) async fn root_exited(&mut self) -> io::Result<()> {
        self.group.root_exited().await
    }
    pub fn id(&self) -> u32 {
        self.group.pid().as_raw_nonzero().get() as u32
    }
    pub async fn terminate(&mut self) -> io::Result<()> {
        if let Some(owner) = &mut self.external {
            if self.group.reaped() {
                return Ok(());
            }
            return owner.control(false).await;
        }
        self.group.terminate().map(|_| ())
    }
    pub(crate) async fn interrupt(&mut self) -> io::Result<bool> {
        if let Some(owner) = &mut self.external {
            owner.control(false).await?;
            return Ok(true);
        }
        self.group.interrupt()
    }
    /// Send SIGINT only while this unreaped child pins its original process group.
    pub async fn interrupt_group(&mut self) -> io::Result<bool> {
        if let Some(owner) = &mut self.external {
            owner.control(true).await?;
            return Ok(true);
        }
        if self.group.reaped() {
            return Ok(false);
        }
        match rustix::process::kill_process_group(self.group.pid(), rustix::process::Signal::INT) {
            Ok(()) => Ok(true),
            Err(rustix::io::Errno::SRCH) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = match self.local_status {
            Some(status) => status,
            None => {
                let status = self.group.wait().await?;
                #[cfg(target_os = "linux")]
                self.mount_cleanup.finish().await?;
                if let Some(proxy) = &mut self.proxy {
                    proxy.close().await?;
                }
                self.local_status = Some(status);
                status
            }
        };
        if let Some(owner) = &mut self.external {
            let confirmed = owner.confirm().await;
            owner.settle_control().await?;
            confirmed?;
        }
        Ok(status)
    }
    /// Local child/group, proxy, mount and owner-I/O fences; not the private Task closure.
    pub fn local_resources_closed(&self) -> bool {
        self.local_status.is_some()
            && self
                .external
                .as_ref()
                .is_none_or(|owner| owner.io_settled())
    }
}
