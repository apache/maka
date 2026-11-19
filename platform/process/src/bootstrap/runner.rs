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

use super::{
    Channel, Endpoint, Runner, channel,
    protocol::{Control, Controlled, Start, Started, Transport},
};
use crate::{
    Command, pipe, pty,
    windows::{checked, job::Job, owned},
};
use maka_plugin_core::terminal::TerminalSize;
use maka_sandbox::windows::{WriteCapability, WriteToken};
use std::{
    fs::File,
    io,
    os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
    sync::Arc,
    time::Duration,
};
use tokio::net::windows::named_pipe::ClientOptions;
use windows_sys::Win32::{
    Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle},
    System::{Pipes::GetNamedPipeServerProcessId, Threading::GetCurrentProcess},
};

impl Runner {
    /// The caller owns authorization and ACL lifetime. Capability UUIDs must
    /// match this execution's grants. This transport grants no filesystem access.
    pub async fn spawn_pipes(
        mut self,
        endpoint: Endpoint,
        command: Command,
        capabilities: Vec<uuid::Uuid>,
    ) -> io::Result<pipe::Spawned> {
        let plan = match command.prepare().await {
            Ok(plan) => plan,
            Err(error) => {
                self.finish().await.map_err(cleanup_error)?;
                return Err(io::Error::other(error));
            }
        };
        self.pipes(endpoint, plan, capabilities).await
    }

    pub(crate) async fn pipes(
        mut self,
        endpoint: Endpoint,
        command: crate::command::Prepared,
        capabilities: Vec<uuid::Uuid>,
    ) -> io::Result<pipe::Spawned> {
        let _directory = command.directory();
        let cancellation = command.startup_cancellation();
        let plan = command.runner_plan();
        let result: io::Result<_> = async {
            let (stdin, input_peer) = crate::windows::pipe::input().await?;
            let (stdout, output_peer) = crate::windows::pipe::output().await?;
            let (stderr, error_peer) = crate::windows::pipe::output().await?;
            let mut channel = endpoint.accept(self.as_handle(), &cancellation).await?;
            let stdio = [
                self.copy_file(&input_peer)?,
                self.copy_file(&output_peer)?,
                self.copy_file(&error_peer)?,
            ];
            let (process, pid) = self
                .admit(
                    &mut channel,
                    &Start {
                        plan,
                        capabilities,
                        io: Transport::Pipe { stdio },
                    },
                    &cancellation,
                )
                .await?;
            let job = Job(self.job.0.try_clone()?);
            Ok((process, pid, job, stdin, stdout, stderr))
        }
        .await;
        let (process, pid, job, stdin, stdout, stderr) = match result {
            Ok(value) => value,
            Err(error) => {
                self.finish().await.map_err(cleanup_error)?;
                return Err(error);
            }
        };
        Ok(pipe::Spawned {
            child: pipe::Child::from_runner(process, pid, job, self),
            stdin,
            stdout,
            stderr,
        })
    }

    pub async fn spawn_pty(
        mut self,
        endpoint: Endpoint,
        mut command: Command,
        capabilities: Vec<uuid::Uuid>,
        size: TerminalSize,
    ) -> io::Result<(pty::PtyChild, pty::PtyIo)> {
        command
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor");
        let plan = match command.prepare().await {
            Ok(plan) => plan,
            Err(error) => {
                self.finish().await.map_err(cleanup_error)?;
                return Err(io::Error::other(error));
            }
        };
        self.terminal(endpoint, plan, capabilities, size).await
    }

    pub(crate) async fn terminal(
        mut self,
        endpoint: Endpoint,
        command: crate::command::Prepared,
        capabilities: Vec<uuid::Uuid>,
        size: TerminalSize,
    ) -> io::Result<(pty::PtyChild, pty::PtyIo)> {
        let _directory = command.directory();
        let cancellation = command.startup_cancellation();
        let plan = command.runner_plan();
        let result: io::Result<_> = async {
            let (output, output_peer) = crate::windows::pipe::pty_output().await?;
            let (input, input_peer) = crate::windows::pipe::pty_input().await?;
            let mut channel = endpoint.accept(self.as_handle(), &cancellation).await?;
            let io = Transport::Terminal {
                input: self.copy_file(&input_peer)?,
                output: self.copy_file(&output_peer)?,
                size,
            };
            let (process, pid) = self
                .admit(
                    &mut channel,
                    &Start {
                        plan,
                        capabilities,
                        io,
                    },
                    &cancellation,
                )
                .await?;
            let job = Job(self.job.0.try_clone()?);
            Ok((process, pid, job, input, output, channel))
        }
        .await;
        let (process, pid, job, input, output, channel) = match result {
            Ok(value) => value,
            Err(error) => {
                self.finish().await.map_err(cleanup_error)?;
                return Err(error);
            }
        };
        let console = super::terminal::Remote::new(self, channel);
        Ok(pty::windows::from_runner(
            process, pid, job, input, output, console,
        ))
    }

    async fn admit(
        &self,
        channel: &mut Channel,
        request: &Start,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> io::Result<(OwnedHandle, u32)> {
        // Dropping only this transport exchange is safe: the caller still owns
        // the Runner and always settles its Job, ACLs and proxy on failure.
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(channel::cancelled()),
            result = async {
                channel.send(request).await?;
                match channel.receive().await? {
                    Started::Running { process, pid } => {
                        let process = self.copy_process(process)?;
                        channel.send(&true).await?;
                        Ok((process, pid))
                    }
                    Started::Failed { message } => Err(io::Error::other(message)),
                }
            } => result,
        }
    }
    fn copy_file(&self, file: &File) -> io::Result<usize> {
        let mut target = ptr::null_mut();
        checked(unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                file.as_raw_handle(),
                self.as_handle().as_raw_handle(),
                &mut target,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        })?;
        Ok(target as usize)
    }
    fn copy_process(&self, source: usize) -> io::Result<OwnedHandle> {
        let mut target = ptr::null_mut();
        checked(unsafe {
            DuplicateHandle(
                self.as_handle().as_raw_handle(),
                source as _,
                GetCurrentProcess(),
                &mut target,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        })?;
        owned(target)
    }
}

/// The Host creates the endpoint before account launch. No command is accepted
/// from a different server process, even if it can reuse the local pipe name.
pub async fn serve(endpoint: uuid::Uuid, expected_host: u32) -> io::Result<()> {
    let mut connection = ClientOptions::new().open(channel::name(endpoint))?;
    let mut server = 0;
    checked(unsafe { GetNamedPipeServerProcessId(connection.as_raw_handle(), &mut server) })?;
    if server != expected_host {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unexpected sandbox host peer",
        ));
    }
    let start: Start =
        tokio::time::timeout(Duration::from_secs(15), channel::receive(&mut connection))
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "sandbox command was not admitted")
            })??;
    let Running {
        process,
        pid,
        job,
        console,
    } = match launch(start).await {
        Ok(result) => result,
        Err(error) => {
            channel::send(
                &mut connection,
                &Started::Failed {
                    message: error.to_string(),
                },
            )
            .await?;
            return Err(error);
        }
    };
    channel::send(
        &mut connection,
        &Started::Running {
            process: process.as_raw_handle() as usize,
            pid,
        },
    )
    .await?;
    let acknowledged: bool =
        tokio::time::timeout(Duration::from_secs(15), channel::receive(&mut connection))
            .await
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "sandbox command ownership was not acknowledged",
                )
            })??;
    if !acknowledged {
        return Err(io::Error::other("sandbox command ownership rejected"));
    }
    if let Some(console) = console {
        loop {
            match channel::receive(&mut connection).await? {
                Control::Resize { size } => {
                    let result = match console.resize(size) {
                        Ok(()) => Controlled::Done,
                        Err(error) => Controlled::Failed {
                            message: error.to_string(),
                        },
                    };
                    channel::send(&mut connection, &result).await?;
                }
                Control::Close => {
                    tokio::task::spawn_blocking(move || drop(console))
                        .await
                        .map_err(io::Error::other)?;
                    // Root exit does not detach descendants from their sandbox
                    // authority. Drain the console first, then settle any child
                    // that disconnected from it without independent admission.
                    job.terminate(130)?;
                    tokio::time::timeout(Duration::from_secs(2), async {
                        while !job.is_empty()? {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                        Ok::<_, io::Error>(())
                    })
                    .await
                    .map_err(|_| io::Error::other("sandbox descendants did not exit"))??;
                    channel::send(&mut connection, &Controlled::Done).await?;
                    break;
                }
            }
        }
    } else {
        // Pipes transfer settlement to the Host; dropping this inner Job must
        // not terminate the command just after its startup acknowledgment.
        job.preserve_descendants()?;
    }
    Ok(())
}

struct Running {
    process: OwnedHandle,
    pid: u32,
    job: Job,
    console: Option<pty::windows::console::Console>,
}
async fn launch(start: Start) -> io::Result<Running> {
    if start.capabilities.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid sandbox capabilities",
        ));
    }
    let caps: Vec<_> = start
        .capabilities
        .into_iter()
        .map(WriteCapability::new)
        .collect();
    let token = Arc::new(WriteToken::current(&caps)?);
    let plan = start
        .plan
        .command()
        .with_write_token(token)
        .prepare()
        .await
        .map_err(io::Error::other)?;
    let job = Job::new()?;
    let (process, pid, console) = match start.io {
        Transport::Pipe { stdio } => {
            // The one-command runner owns a private desktop and console. Set
            // its encoding before PowerShell initializes Console.OutputEncoding;
            // a read-only TEMP can prohibit changing it later from script.
            // Never attach to or change the user's interactive console.
            use windows_sys::Win32::System::Console::{
                AllocConsole, GetConsoleCP, SetConsoleCP, SetConsoleOutputCP,
            };
            if unsafe { GetConsoleCP() } == 0 {
                checked(unsafe { AllocConsole() }).map_err(|error| {
                    io::Error::other(format!("allocate runner console: {error}"))
                })?;
            }
            checked(unsafe { SetConsoleCP(65001) })
                .map_err(|error| io::Error::other(format!("set runner input encoding: {error}")))?;
            checked(unsafe { SetConsoleOutputCP(65001) }).map_err(|error| {
                io::Error::other(format!("set runner output encoding: {error}"))
            })?;
            let files = files(stdio)?;
            let (process, pid) = crate::windows::spawn::launch(
                &plan,
                &job,
                [&files[0], &files[1], &files[2]],
                crate::windows::spawn::Console::Inherited,
            )?;
            (process, pid, None)
        }
        Transport::Terminal {
            input,
            output,
            size,
        } => {
            let [input, output] = files([input, output])?;
            let console = pty::windows::console::Console::new(size, &input, &output)?;
            let (process, pid) = pty::windows::spawn::launch(&plan, &console, &job)?;
            (process, pid, Some(console))
        }
    };
    Ok(Running {
        process,
        pid,
        job,
        console,
    })
}
fn files<const N: usize>(handles: [usize; N]) -> io::Result<[File; N]> {
    if handles
        .iter()
        .enumerate()
        .any(|(i, h)| *h == 0 || *h == usize::MAX || handles[..i].contains(h))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid sandbox I/O handles",
        ));
    }
    // The authenticated Host duplicates these handles into this exact process.
    // The initial request transfers each handle's ownership exactly once.
    Ok(handles.map(|handle| unsafe { File::from_raw_handle(handle as _) }))
}

fn cleanup_error(error: io::Error) -> io::Error {
    io::Error::other(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(
        error.to_string(),
    ))
}
