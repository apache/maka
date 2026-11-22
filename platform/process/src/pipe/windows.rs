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
use crate::{
    Command,
    windows::{job::Job, pipe, wait_process},
};
use std::{io, os::windows::io::OwnedHandle, process::ExitStatus, time::Duration};

pub struct Child {
    process: OwnedHandle,
    job: Job,
    pid: u32,
    status: Option<ExitStatus>,
    tree: TreeState,
    isolation: Isolation,
}
enum TreeState {
    Owned,
    Terminated,
    Settled,
}
enum Isolation {
    Unmanaged,
    Account(crate::bootstrap::Runner),
    Mxc(crate::bootstrap::mxc::Owner),
}
pub async fn spawn(plan: Command) -> Result<Spawned, maka_agent_facts::tools::ToolError> {
    spawn_prepared(plan.prepare().await?).await
}
pub(crate) async fn spawn_prepared(
    mut plan: crate::command::Prepared,
) -> Result<Spawned, maka_agent_facts::tools::ToolError> {
    if let Some(launch) = plan.take_launch() {
        return launch.pipes(plan).await.map_err(crate::launch_error);
    }
    let result: io::Result<_> = async {
        let (stdin, stdin_peer) = pipe::input().await?;
        let (stdout, stdout_peer) = pipe::output().await?;
        let (stderr, stderr_peer) = pipe::output().await?;
        let job = Job::new()?;
        let (process, pid) = crate::windows::spawn::launch(
            &plan,
            &job,
            [&stdin_peer, &stdout_peer, &stderr_peer],
            crate::windows::spawn::Console::None,
        )?;
        Ok(Spawned {
            stdin,
            stdout,
            stderr,
            child: Child {
                process,
                job,
                pid,
                status: None,
                tree: TreeState::Owned,
                isolation: Isolation::Unmanaged,
            },
        })
    }
    .await;
    result.map_err(crate::failed)
}
impl Child {
    pub(crate) fn from_runner(
        process: OwnedHandle,
        pid: u32,
        job: Job,
        runner: crate::bootstrap::Runner,
    ) -> Self {
        Self {
            process,
            pid,
            job,
            status: None,
            tree: TreeState::Owned,
            isolation: Isolation::Account(runner),
        }
    }

    pub(crate) fn from_mxc(
        process: OwnedHandle,
        pid: u32,
        job: Job,
        owner: crate::bootstrap::mxc::Owner,
    ) -> Self {
        Self {
            process,
            pid,
            job,
            status: None,
            tree: TreeState::Owned,
            isolation: Isolation::Mxc(owner),
        }
    }

    pub fn id(&self) -> u32 {
        self.pid
    }
    pub async fn terminate(&mut self) -> io::Result<()> {
        if let Isolation::Mxc(owner) = &mut self.isolation {
            owner.terminate();
        }
        self.job.terminate(130)?;
        self.tree = TreeState::Terminated;
        Ok(())
    }

    /// A normal unsandboxed shell may intentionally start background services.
    /// Protocol pipes still use wait(), which drains their complete tree. A
    /// managed tree always settles with its policy owner and cannot detach here.
    pub(crate) async fn wait_foreground(&mut self) -> io::Result<ExitStatus> {
        if matches!(self.isolation, Isolation::Unmanaged) && matches!(self.tree, TreeState::Owned) {
            if self.status.is_none() {
                self.status = Some(wait_process(&self.process).await?);
            }
            self.job.preserve_descendants()?;
            self.tree = TreeState::Settled;
            return Ok(self.status.expect("foreground root exited"));
        }
        self.wait().await
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        if self.status.is_none() {
            self.status = Some(wait_process(&self.process).await?);
        }
        if !matches!(self.tree, TreeState::Settled) {
            if let Isolation::Mxc(owner) = &mut self.isolation {
                owner.finish().await?;
            }
            self.terminate().await?;
            while !self.job.is_empty()? {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            self.tree = TreeState::Settled;
        }
        if let Isolation::Account(runner) = &mut self.isolation {
            runner.finish().await?;
        }
        Ok(self.status.expect("root exited"))
    }
}
// Job's kill-on-close is emergency cleanup. Only wait() confirms tree exit.
