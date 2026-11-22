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

use super::PtyCommand;
use crate::windows::{job::Job, pipe, wait_process};
use maka_plugin_core::terminal::TerminalSize;
use std::{io, os::windows::io::OwnedHandle, process::ExitStatus, sync::Arc, time::Duration};
use tokio::{net::windows::named_pipe::NamedPipeServer, task::JoinHandle};

pub(crate) mod console;
pub(crate) mod spawn;
use console::Console;

pub struct PtyChild {
    process: OwnedHandle,
    job: Job,
    pid: u32,
    output: Arc<NamedPipeServer>,
    console: ConsoleState,
    status: Option<ExitStatus>,
    terminated: bool,
}

enum ConsoleState {
    Open(ConsoleOwner),
    Closing(JoinHandle<io::Result<()>>),
    Closed,
    Failed(String),
}

enum ConsoleOwner {
    Native(Console),
    Runner(crate::bootstrap::terminal::Remote),
    Mxc {
        console: Console,
        owner: crate::bootstrap::mxc::Owner,
    },
}
impl ConsoleOwner {
    async fn close(self, terminated: bool) -> io::Result<()> {
        match self {
            Self::Native(console) => tokio::task::spawn_blocking(move || drop(console))
                .await
                .map_err(io::Error::other),
            Self::Runner(console) => console.close(terminated).await,
            Self::Mxc { console, mut owner } => {
                let result = owner.finish().await;
                tokio::task::spawn_blocking(move || drop(console))
                    .await
                    .map_err(io::Error::other)?;
                result
            }
        }
    }
}

pub struct PtyIo {
    output: Arc<NamedPipeServer>,
    input: NamedPipeServer,
}

pub async fn spawn(
    mut plan: PtyCommand,
    size: TerminalSize,
) -> Result<(PtyChild, PtyIo), maka_agent_facts::tools::ToolError> {
    plan.env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor");
    let mut plan = plan.prepare().await?;
    if let Some(launch) = plan.take_launch() {
        return launch
            .terminal(plan, size)
            .await
            .map_err(crate::launch_error);
    }
    let result: io::Result<_> = async {
        let (output, output_peer) = pipe::pty_output().await?;
        let (input, input_peer) = pipe::pty_input().await?;
        let output = Arc::new(output);
        let job = Job::new()?;
        let console = Console::new(size, &input_peer, &output_peer)?;
        let spawned = spawn::launch(&plan, &console, &job);
        let (process, pid) = match spawned {
            Ok(value) => value,
            Err(error) => {
                // Startup has no consumer to drain; break output before closing.
                let _ = output.disconnect();
                drop(console);
                return Err(error);
            }
        };
        // ConPTY owns its peer references after creation. Parent copies close now.
        drop(input_peer);
        drop(output_peer);
        Ok((
            PtyChild {
                process,
                job,
                pid,
                output: output.clone(),
                console: ConsoleState::Open(ConsoleOwner::Native(console)),
                status: None,
                terminated: false,
            },
            PtyIo { output, input },
        ))
    }
    .await;
    result.map_err(crate::failed)
}

pub(crate) fn from_runner(
    process: OwnedHandle,
    pid: u32,
    job: Job,
    input: NamedPipeServer,
    output: NamedPipeServer,
    console: crate::bootstrap::terminal::Remote,
) -> (PtyChild, PtyIo) {
    let output = Arc::new(output);
    (
        PtyChild {
            process,
            job,
            pid,
            output: output.clone(),
            console: ConsoleState::Open(ConsoleOwner::Runner(console)),
            status: None,
            terminated: false,
        },
        PtyIo { output, input },
    )
}

pub(crate) fn from_mxc(
    process: OwnedHandle,
    pid: u32,
    job: Job,
    input: NamedPipeServer,
    output: NamedPipeServer,
    console: Console,
    owner: crate::bootstrap::mxc::Owner,
) -> (PtyChild, PtyIo) {
    let output = Arc::new(output);
    (
        PtyChild {
            process,
            job,
            pid,
            output: output.clone(),
            console: ConsoleState::Open(ConsoleOwner::Mxc { console, owner }),
            status: None,
            terminated: false,
        },
        PtyIo { output, input },
    )
}

impl PtyChild {
    pub fn id(&self) -> u32 {
        self.pid
    }

    pub async fn resize(&mut self, size: TerminalSize) -> io::Result<()> {
        match &self.console {
            ConsoleState::Open(
                ConsoleOwner::Native(console) | ConsoleOwner::Mxc { console, .. },
            ) => console.resize(size),
            ConsoleState::Open(ConsoleOwner::Runner(console)) => console.resize(size).await,
            _ => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "console is closing",
            )),
        }
    }

    pub fn terminate(&mut self) -> io::Result<bool> {
        if self.status.is_some()
            && !matches!(self.console, ConsoleState::Open(ConsoleOwner::Mxc { .. }))
        {
            return Ok(false);
        }
        if let ConsoleState::Open(ConsoleOwner::Mxc { owner, .. }) = &mut self.console {
            owner.terminate();
        }
        self.job.terminate(130)?;
        self.terminated = true;
        Ok(true)
    }

    /// Cancellation-safe wait; exit code 259 is valid after the handle signals.
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        if let Some(status) = self.status {
            return Ok(status);
        }
        let status = wait_process(&self.process).await?;
        if matches!(self.console, ConsoleState::Open(ConsoleOwner::Native(_))) {
            self.job.terminate(130)?;
            while !self.job.is_empty()? {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        self.status = Some(status);
        Ok(status)
    }

    /// Call after root exit and keep reading PtyIo concurrently until EOF.
    /// Cancelling this wait never drops the closing task or loses its completion.
    pub async fn close(&mut self) -> io::Result<()> {
        if self.status.is_none() {
            return Err(io::Error::other("wait for the PTY root before closing"));
        }
        if matches!(self.console, ConsoleState::Open(_))
            && let ConsoleState::Open(console) =
                std::mem::replace(&mut self.console, ConsoleState::Closed)
        {
            self.console = ConsoleState::Closing(tokio::spawn(console.close(self.terminated)));
        }
        if let ConsoleState::Closing(closing) = &mut self.console {
            self.console = match closing.await {
                Ok(Ok(())) => ConsoleState::Closed,
                Ok(Err(error)) => {
                    ConsoleState::Failed(format!("console close outcome unknown: {error}"))
                }
                Err(error) => {
                    ConsoleState::Failed(format!("console close outcome unknown: {error}"))
                }
            };
        }
        match &self.console {
            ConsoleState::Failed(error) => Err(io::Error::other(error.clone())),
            _ => Ok(()),
        }
    }
}

impl Drop for PtyChild {
    fn drop(&mut self) {
        if self.status.is_none()
            || matches!(self.console, ConsoleState::Open(ConsoleOwner::Mxc { .. }))
        {
            let _ = self.job.terminate(130);
        }
        // A Drop fallback cannot preserve unread frames. Break the output peer
        // so ClosePseudoConsole cannot deadlock on backpressure on older Windows.
        let _ = self.output.disconnect();
        if let ConsoleState::Open(console) =
            std::mem::replace(&mut self.console, ConsoleState::Closed)
        {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn_blocking(move || drop(console));
            } else {
                drop(console);
            }
        }
        // A previously started close task continues even if its awaiter drops.
    }
}

impl PtyIo {
    /// Explicitly lossy fallback after a failed/bounded drain. Disconnect before
    /// awaiting console close so its final output cannot deadlock shutdown.
    pub fn discard_output(&self) -> io::Result<()> {
        self.output.disconnect()
    }

    pub async fn read(&self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            self.output.readable().await?;
            match self.output.try_read(buffer) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => return Ok(0),
                result => return result,
            }
        }
    }

    /// Reports the prefix accepted by the async pipe, not application consumption.
    pub async fn write(&self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            self.input.writable().await?;
            match self.input.try_write(buffer) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                result => return result,
            }
        }
    }
}
