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

//! The helper owns MXC's SDK process until the execution owner settles its tree.
//! It inherits the Host-created stdio or ConPTY; user requests cross only the
//! authenticated local channel, never helper argv or process-global state.
mod lease;
pub use lease::Lease;

use super::{
    Channel, Endpoint, channel,
    protocol::{Control, Controlled, Plan, Started},
};
use crate::{
    Command, pipe, pty,
    windows::{checked, job::Job, owned, wait_process},
};
use maka_plugin_core::terminal::TerminalSize;
use maka_sandbox::{Network, filesystem::Policy, windows::mxc::PreparedPolicy};
use serde::{Deserialize, Serialize};
use std::{
    io,
    os::windows::io::{AsHandle, AsRawHandle, OwnedHandle},
    path::PathBuf,
    ptr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{net::windows::named_pipe::ClientOptions, task::JoinHandle};
use windows_sys::Win32::{
    Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle},
    System::{Pipes::GetNamedPipeServerProcessId, Threading::GetCurrentProcess},
};

pub const HELPER: &str = "__maka-mxc-sandbox";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    plan: Plan,
    filesystem: Policy,
    network: Network,
}

pub(crate) struct Owner {
    state: State,
    terminated: Arc<AtomicBool>,
}
enum State {
    Pending(Resources),
    Running(JoinHandle<io::Result<()>>),
    Complete,
    Failed(String),
}
struct Resources {
    helper: OwnedHandle,
    job: Job,
    channel: Channel,
    proxy: Option<Arc<maka_network::proxy::Proxy>>,
    lease: Lease,
    terminated: Arc<AtomicBool>,
}
impl Owner {
    pub fn terminate(&mut self) {
        self.terminated.store(true, Ordering::Release);
    }

    pub async fn finish(&mut self) -> io::Result<()> {
        if matches!(self.state, State::Pending(_)) {
            let State::Pending(resources) = std::mem::replace(&mut self.state, State::Complete)
            else {
                unreachable!()
            };
            self.state = State::Running(tokio::spawn(resources.finish()));
        }
        if let State::Running(task) = &mut self.state {
            self.state = match task.await {
                Ok(Ok(())) => State::Complete,
                Ok(Err(error)) => State::Failed(error.to_string()),
                Err(error) => State::Failed(error.to_string()),
            };
        }
        match &self.state {
            State::Complete => Ok(()),
            State::Failed(message) => Err(io::Error::other(message.clone())),
            _ => unreachable!("settlement task was awaited"),
        }
    }
}
impl Resources {
    async fn finish(mut self) -> io::Result<()> {
        let outcome = async {
            if !self.terminated.load(Ordering::Acquire) {
                self.channel.send(&Control::Close).await?;
                match self.channel.receive().await? {
                    Controlled::Done => {}
                    Controlled::Failed { message } => return Err(io::Error::other(message)),
                }
            }
            let status = wait_process(&self.helper).await?;
            if !self.terminated.load(Ordering::Acquire) && !status.success() {
                return Err(io::Error::other("MXC helper failed during settlement"));
            }
            Ok(())
        }
        .await;
        // Even a lost control channel must confirm tree exit before releasing
        // the execution's proxy. Never report successful cleanup after an error.
        self.job.terminate(130)?;
        // Job accounting reaching zero is not a signalled process-object fence.
        // Retain and observe the exact helper even after a broken control reply.
        wait_process(&self.helper).await?;
        while !self.job.is_empty()? {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if let Some(mut proxy) = self.proxy.take().and_then(Arc::into_inner) {
            proxy.close().await?;
        }
        self.lease.finish().await?;
        if self.terminated.load(Ordering::Acquire) {
            Ok(())
        } else {
            outcome
        }
    }
}

pub(crate) async fn pipes(
    executable: PathBuf,
    filesystem: Policy,
    network: Network,
    mut proxy: Option<Arc<maka_network::proxy::Proxy>>,
    lease: Lease,
    plan: crate::command::Prepared,
) -> io::Result<pipe::Spawned> {
    let _directory = plan.directory();
    let cancellation = plan.startup_cancellation();
    let mut lease = Some(lease);
    let result = async {
        let endpoint = Endpoint::current_user()?;
        let helper = helper(executable, endpoint.id()).await?;
        let (stdin, input_peer) = crate::windows::pipe::input().await?;
        let (stdout, output_peer) = crate::windows::pipe::output().await?;
        let (stderr, error_peer) = crate::windows::pipe::output().await?;
        let job = lease.as_ref().expect("preparation owns lease").job()?;
        let (helper_process, _) = crate::windows::spawn::launch(
            &helper,
            &job,
            [&input_peer, &output_peer, &error_peer],
            crate::windows::spawn::Console::None,
        )?;
        let (process, pid, owner) = admit(
            endpoint,
            helper_process,
            &job,
            proxy.take(),
            lease.take().expect("admission takes lease"),
            Start {
                plan: plan.runner_plan(),
                filesystem,
                network,
            },
            &cancellation,
        )
        .await?;
        Ok(pipe::Spawned {
            child: pipe::Child::from_mxc(process, pid, job, owner),
            stdin,
            stdout,
            stderr,
        })
    }
    .await;
    if let Some(mut lease) = lease {
        close_proxy(proxy).await.map_err(cleanup_error)?;
        lease.finish().await.map_err(cleanup_error)?;
    }
    result
}

pub(crate) async fn terminal(
    executable: PathBuf,
    filesystem: Policy,
    network: Network,
    mut proxy: Option<Arc<maka_network::proxy::Proxy>>,
    lease: Lease,
    plan: crate::command::Prepared,
    size: TerminalSize,
) -> io::Result<(pty::PtyChild, pty::PtyIo)> {
    let _directory = plan.directory();
    let cancellation = plan.startup_cancellation();
    let mut lease = Some(lease);
    let result = async {
        let endpoint = Endpoint::current_user()?;
        let helper = helper(executable, endpoint.id()).await?;
        let (output, output_peer) = crate::windows::pipe::pty_output().await?;
        let (input, input_peer) = crate::windows::pipe::pty_input().await?;
        let job = lease.as_ref().expect("preparation owns lease").job()?;
        let console = pty::windows::console::Console::new(size, &input_peer, &output_peer)?;
        let launch = async {
            let (helper_process, _) = pty::windows::spawn::launch(&helper, &console, &job)?;
            admit(
                endpoint,
                helper_process,
                &job,
                proxy.take(),
                lease.take().expect("admission takes lease"),
                Start {
                    plan: plan.runner_plan(),
                    filesystem,
                    network,
                },
                &cancellation,
            )
            .await
        }
        .await;
        match launch {
            Ok((process, pid, owner)) => Ok(pty::windows::from_mxc(
                process, pid, job, input, output, console, owner,
            )),
            Err(error) => {
                let _ = output.disconnect();
                tokio::task::spawn_blocking(move || drop(console))
                    .await
                    .map_err(io::Error::other)?;
                Err(error)
            }
        }
    }
    .await;
    if let Some(mut lease) = lease {
        close_proxy(proxy).await.map_err(cleanup_error)?;
        lease.finish().await.map_err(cleanup_error)?;
    }
    result
}

async fn close_proxy(proxy: Option<Arc<maka_network::proxy::Proxy>>) -> io::Result<()> {
    if let Some(mut proxy) = proxy.and_then(Arc::into_inner) {
        proxy.close().await?;
    }
    Ok(())
}

async fn helper(executable: PathBuf, endpoint: uuid::Uuid) -> io::Result<crate::command::Prepared> {
    let system =
        std::env::var_os("SystemRoot").ok_or_else(|| io::Error::other("SystemRoot is missing"))?;
    let mut command = Command::new(executable, PathBuf::from(&system));
    command.env_clear().env("SystemRoot", system);
    for name in ["SystemDrive", "LOCALAPPDATA"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .arg(HELPER)
        .arg(endpoint.to_string())
        .arg(std::process::id().to_string());
    command.prepare().await.map_err(io::Error::other)
}

async fn admit(
    endpoint: Endpoint,
    helper: OwnedHandle,
    job: &Job,
    proxy: Option<Arc<maka_network::proxy::Proxy>>,
    mut lease: Lease,
    request: Start,
    cancellation: &tokio_util::sync::CancellationToken,
) -> io::Result<(OwnedHandle, u32, Owner)> {
    let mut proxy = proxy;
    // The Job and proxy remain outside the cancellable transport future. Every
    // error, including cancellation during SDK startup, settles them below.
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(channel::cancelled()),
        result = async {
            let mut channel = endpoint.accept(helper.as_handle(), cancellation).await?;
            channel.send(&request).await?;
            let (process, pid) = match channel.receive().await? {
                Started::Running { process, pid } => {
                    let mut handle = ptr::null_mut();
                    checked(unsafe {
                        DuplicateHandle(
                            helper.as_raw_handle(),
                            process as _,
                            GetCurrentProcess(),
                            &mut handle,
                            0,
                            0,
                            DUPLICATE_SAME_ACCESS,
                        )
                    })?;
                    (owned(handle)?, pid)
                }
                Started::Failed { message } => return Err(io::Error::other(message)),
            };
            let execution_job = Job(job.0.try_clone()?);
            Ok((process, pid, channel, execution_job))
        } => result,
    };
    match result {
        Ok((process, pid, channel, execution_job)) => {
            // The SDK and inherited stdio remain owned by the helper until finish.
            let terminated = Arc::new(AtomicBool::new(false));
            let owner = Owner {
                state: State::Pending(Resources {
                    helper,
                    job: execution_job,
                    channel,
                    proxy,
                    lease,
                    terminated: terminated.clone(),
                }),
                terminated,
            };
            Ok((process, pid, owner))
        }
        Err(error) => {
            let cleanup = async {
                job.terminate(130)?;
                // Termination is asynchronous; ActiveProcesses == 0 alone must
                // not publish admission cancellation while this helper is alive.
                wait_process(&helper).await?;
                while !job.is_empty()? {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                close_proxy(proxy.take()).await?;
                lease.finish().await?;
                Ok::<_, io::Error>(())
            }
            .await;
            cleanup.map_err(cleanup_error)?;
            Err(error)
        }
    }
}

pub async fn serve(endpoint: uuid::Uuid, expected_host: u32) -> io::Result<()> {
    let mut channel = ClientOptions::new().open(channel::name(endpoint))?;
    let mut server = 0;
    checked(unsafe { GetNamedPipeServerProcessId(channel.as_raw_handle(), &mut server) })?;
    if server != expected_host {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unexpected MXC host peer",
        ));
    }
    let request: Start = channel::receive(&mut channel).await?;
    let _console_stdio = console_stdio()?;
    let result = async {
        let policy = PreparedPolicy::new(&request.filesystem, &request.network, &request.plan.cwd)
            .map_err(io::Error::other)?;
        let cwd = request.plan.cwd.clone();
        let environment = request.plan.environment.clone();
        let plan = request
            .plan
            .command()
            .prepare()
            .await
            .map_err(io::Error::other)?;
        let command_line = plan.windows_command_line()?;
        tokio::task::spawn_blocking(move || {
            policy.spawn_inherited(&command_line, &cwd, &environment)
        })
        .await
        .map_err(io::Error::other)?
        .map_err(io::Error::other)
    }
    .await;
    let mut execution = match result {
        Ok(execution) => execution,
        Err(error) => {
            channel::send(
                &mut channel,
                &Started::Failed {
                    message: error.to_string(),
                },
            )
            .await?;
            return Err(error);
        }
    };
    channel::send(
        &mut channel,
        &Started::Running {
            process: execution.as_handle().as_raw_handle() as usize,
            pid: execution.id(),
        },
    )
    .await?;
    let close: Control = channel::receive(&mut channel).await?;
    if !matches!(close, Control::Close) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid MXC settlement request",
        ));
    }
    let result = tokio::task::spawn_blocking(move || execution.finish_tree())
        .await
        .map_err(io::Error::other)?;
    let response = match &result {
        Ok(_) => Controlled::Done,
        Err(error) => Controlled::Failed {
            message: error.to_string(),
        },
    };
    channel::send(&mut channel, &response).await?;
    result.map(|_| ())
}

/// A process attached through a ConPTY attribute starts with explicit null stdio
/// to prevent redirected Host streams leaking into it. Open its own console so
/// the SDK detects console-sharing mode rather than trying to inherit nulls.
fn console_stdio() -> io::Result<Vec<std::fs::File>> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{
        GetConsoleCP, GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        SetStdHandle,
    };
    if unsafe { GetConsoleCP() } == 0 {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for (kind, path) in [
        (STD_INPUT_HANDLE, "CONIN$"),
        (STD_OUTPUT_HANDLE, "CONOUT$"),
        (STD_ERROR_HANDLE, "CONOUT$"),
    ] {
        let current = unsafe { GetStdHandle(kind) };
        if current.is_null() || current == INVALID_HANDLE_VALUE {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)?;
            checked(unsafe { SetStdHandle(kind, file.as_raw_handle()) })?;
            files.push(file);
        }
    }
    Ok(files)
}

fn cleanup_error(error: io::Error) -> io::Error {
    io::Error::other(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(
        error.to_string(),
    ))
}
