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
    pid: u32,
    status: Option<ExitStatus>,
    owner: Owner,
}
enum Owner {
    External(crate::isolated::ExternalOwner),
    Job(OwnedJob),
}
struct OwnedJob {
    job: Job,
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
        let streams = [&stdin_peer, &stdout_peer, &stderr_peer];
        let ((process, pid), owner) = if let Some(resource) = plan.take_external_owner() {
            (
                crate::detached::spawn_helper(&plan, streams)?,
                Owner::External(crate::isolated::ExternalOwner::new(resource)),
            )
        } else {
            let job = Job::new()?;
            let process = crate::windows::spawn::launch(
                &plan,
                &job,
                streams,
                crate::windows::spawn::Console::None,
            )?;
            (
                process,
                Owner::Job(OwnedJob {
                    job,
                    tree: TreeState::Owned,
                    isolation: Isolation::Unmanaged,
                }),
            )
        };
        Ok(Spawned {
            stdin,
            stdout,
            stderr,
            child: Child {
                process,
                owner,
                pid,
                status: None,
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
            status: None,
            owner: Owner::Job(OwnedJob {
                job,
                tree: TreeState::Owned,
                isolation: Isolation::Account(runner),
            }),
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
            status: None,
            owner: Owner::Job(OwnedJob {
                job,
                tree: TreeState::Owned,
                isolation: Isolation::Mxc(owner),
            }),
        }
    }

    pub fn id(&self) -> u32 {
        self.pid
    }
    pub async fn terminate(&mut self) -> io::Result<()> {
        match &mut self.owner {
            Owner::External(owner) => owner.control(false).await,
            Owner::Job(job) => job.terminate(),
        }
    }
    pub(crate) async fn root_exited(&self) -> io::Result<()> {
        wait_process(&self.process).await.map(|_| ())
    }
    pub async fn interrupt_group(&mut self) -> io::Result<bool> {
        match &mut self.owner {
            Owner::External(owner) => owner.control(true).await.map(|()| true),
            Owner::Job(_) => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Windows background pipes have no console interrupt",
            )),
        }
    }
    pub fn local_resources_closed(&self) -> bool {
        self.status.is_some()
            && match &self.owner {
                Owner::External(owner) => owner.io_settled(),
                Owner::Job(job) => matches!(job.tree, TreeState::Settled),
            }
    }
    /// A normal unsandboxed shell may intentionally start background services.
    /// Protocol pipes still use wait(), which drains their complete tree. A
    /// managed tree always settles with its policy owner and cannot detach here.
    pub(crate) async fn wait_foreground(&mut self) -> io::Result<ExitStatus> {
        if let Owner::Job(job) = &mut self.owner
            && matches!(job.isolation, Isolation::Unmanaged)
            && matches!(job.tree, TreeState::Owned)
        {
            if self.status.is_none() {
                self.status = Some(wait_process(&self.process).await?);
            }
            job.job.preserve_descendants()?;
            job.tree = TreeState::Settled;
            return Ok(self.status.expect("foreground root exited"));
        }
        self.wait().await
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        if self.status.is_none() {
            self.status = Some(wait_process(&self.process).await?);
        }
        match &mut self.owner {
            Owner::External(owner) => {
                let result = owner.confirm().await;
                owner.settle_control().await?;
                result?;
            }
            Owner::Job(job) => job.finish().await?,
        }
        Ok(self.status.expect("root exited"))
    }
}
// Job's kill-on-close is emergency cleanup. Only wait() confirms tree exit.

impl OwnedJob {
    fn terminate(&mut self) -> io::Result<()> {
        if let Isolation::Mxc(owner) = &mut self.isolation {
            owner.terminate();
        }
        self.job.terminate(130)?;
        self.tree = TreeState::Terminated;
        Ok(())
    }

    async fn finish(&mut self) -> io::Result<()> {
        if matches!(self.tree, TreeState::Settled) {
            return Ok(());
        }
        if let Isolation::Mxc(owner) = &mut self.isolation {
            owner.finish().await?;
        }
        self.tree
            .drain(&self.job, async {
                if let Isolation::Account(runner) = &mut self.isolation {
                    runner.finish().await?;
                }
                Ok(())
            })
            .await
    }
}

impl TreeState {
    async fn drain(
        &mut self,
        job: &Job,
        cleanup: impl Future<Output = io::Result<()>>,
    ) -> io::Result<()> {
        job.terminate(130)?;
        *self = Self::Terminated;
        while !job.is_empty()? {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        cleanup.await?;
        *self = Self::Settled;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn drained_job_with_failed_cleanup_keeps_local_resources_open() -> io::Result<()> {
        let mut root = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "exit 0"])
            .spawn()?;
        let status = root.wait()?;
        let mut child = Child {
            pid: root.id(),
            process: root.into(),
            status: Some(status),
            owner: Owner::Job(OwnedJob {
                job: Job::new()?,
                tree: TreeState::Owned,
                isolation: Isolation::Unmanaged,
            }),
        };
        let Owner::Job(owner) = &mut child.owner else {
            unreachable!()
        };
        let failure = owner
            .tree
            .drain(&owner.job, async {
                Err(io::Error::other("account cleanup failed"))
            })
            .await
            .unwrap_err();
        assert_eq!(failure.to_string(), "account cleanup failed");
        assert!(!child.local_resources_closed());
        Ok(())
    }
}
