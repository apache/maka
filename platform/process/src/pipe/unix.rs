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
    group: Group,
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
    let spawned = (|| -> io::Result<_> {
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
            plan.abort().await?;
            return Err(crate::failed(error));
        }
    };
    Ok(Spawned {
        stdin: child.stdin.take().expect("piped stdin"),
        stdout: child.stdout.take().expect("piped stdout"),
        stderr: child.stderr.take().expect("piped stderr"),
        child: Child {
            group: Group::new(child, changed),
            proxy: plan.take_proxy(),
            #[cfg(target_os = "linux")]
            mount_cleanup: plan.take_mount_lease().into(),
        },
    })
}
impl Child {
    pub fn id(&self) -> u32 {
        self.group.pid().as_raw_nonzero().get() as u32
    }
    pub fn terminate(&mut self) -> io::Result<()> {
        self.group.terminate().map(|_| ())
    }
    pub(crate) fn interrupt(&mut self) -> io::Result<bool> {
        self.group.interrupt()
    }
    /// Send SIGINT only while this unreaped child pins its original process group.
    pub fn interrupt_group(&mut self) -> io::Result<bool> {
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
        let status = self.group.wait().await?;
        #[cfg(target_os = "linux")]
        self.mount_cleanup.finish().await?;
        if let Some(proxy) = &mut self.proxy {
            proxy.close().await?;
        }
        Ok(status)
    }
}
