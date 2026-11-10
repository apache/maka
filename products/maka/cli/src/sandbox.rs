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

use maka_host_runtime::HostError;
use maka_plugin_core::shell_run::PipeStream;
use maka_process::{PipeEvent, ProcessOutcome, ShellExecutor, Termination};
use maka_sandbox::Sandbox;
use std::{path::PathBuf, process::ExitCode, time::Duration};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

#[derive(clap::Subcommand)]
pub(super) enum Command {
    /// Diagnose a command using the production shell and sandbox.
    Run(Args),
    /// Inspect Windows isolation; MXC needs no account setup or elevation.
    #[cfg(windows)]
    Status(crate::args::Root),
    /// Configure Windows account isolation for systems or policies without MXC.
    #[cfg(windows)]
    Setup(crate::args::Root),
    /// Remove Windows isolation after accepted work drains; requests consent.
    #[cfg(windows)]
    Remove(crate::args::Root),
}

impl Command {
    pub(super) async fn run(self, timeout_ms: Option<u64>) -> Result<ExitCode, HostError> {
        match self {
            Self::Run(args) => args.run(timeout_ms).await,
            #[cfg(windows)]
            Self::Status(args) => {
                let status = tokio::task::spawn_blocking(move || {
                    maka_host_runtime::sandbox::windows::status(&args.root)
                })
                .await??;
                println!("{}", serde_json::to_string(&status)?);
                Ok(ExitCode::SUCCESS)
            }
            #[cfg(windows)]
            Self::Setup(args) => {
                provision(
                    args,
                    maka_host_runtime::sandbox::windows::Operation::Setup,
                    timeout_ms,
                )
                .await?;
                println!(
                    "Windows account sandbox configured; used when MXC cannot enforce the requested policy"
                );
                Ok(ExitCode::SUCCESS)
            }
            #[cfg(windows)]
            Self::Remove(args) => {
                provision(
                    args,
                    maka_host_runtime::sandbox::windows::Operation::Remove,
                    timeout_ms,
                )
                .await?;
                println!("Windows sandbox accounts removed");
                Ok(ExitCode::SUCCESS)
            }
        }
    }
}

#[cfg(windows)]
async fn provision(
    args: crate::args::Root,
    operation: maka_host_runtime::sandbox::windows::Operation,
    timeout_ms: Option<u64>,
) -> std::io::Result<()> {
    let request = maka_host_runtime::sandbox::windows::Provision {
        root: std::path::absolute(args.root)?,
        operation,
    };
    let executable = std::env::current_exe()?;
    // Dropping the observer closes admission to a late consent helper. A helper
    // that already received its request keeps ownership through durable commit.
    tokio::select! {
        result = request.request(&executable) => result,
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms.unwrap_or(180_000))) => {
            Err(std::io::Error::new(std::io::ErrorKind::TimedOut,
                "sandbox setup observation timed out; query `maka sandbox status --root ...` before retrying"))
        }
        result = tokio::signal::ctrl_c() => {
            result?;
            Err(std::io::Error::new(std::io::ErrorKind::Interrupted,
                "sandbox setup observation cancelled; accepted setup may still complete"))
        }
    }
}

#[derive(clap::Args)]
pub(super) struct Args {
    /// Explicit Windows installation owner; never inferred from environment.
    #[cfg(windows)]
    #[command(flatten)]
    installation: crate::args::Root,
    /// JSON Sandbox policy. Paths are absolute paths on this machine.
    #[arg(long, value_name = "FILE")]
    policy: PathBuf,
    /// Working directory; defaults to the current directory.
    #[arg(long, value_name = "DIRECTORY")]
    cwd: Option<PathBuf>,
    /// Literal source for the same shell used by Host tools; stdin is closed.
    #[arg(long, allow_hyphen_values = true)]
    command: String,
}

impl Args {
    pub(super) async fn run(self, timeout_ms: Option<u64>) -> Result<ExitCode, HostError> {
        let plan = tokio::task::spawn_blocking(move || -> Result<_, HostError> {
            let bytes = std::fs::read(self.policy)?;
            let policy: Sandbox = serde_json::from_slice(&bytes)?;
            if matches!(policy, Sandbox::External { .. }) {
                return Err("external isolation must be established by an executor".into());
            }
            let cwd = match self.cwd {
                Some(path) => path,
                None => std::env::current_dir()?,
            };
            let executor = ShellExecutor::new(&cwd, policy)?;
            #[cfg(target_os = "linux")]
            let executor = executor.with_network_helper(std::env::current_exe()?);
            #[cfg(windows)]
            let executor = executor.with_backend(std::sync::Arc::new(
                maka_host_runtime::sandbox::windows::Backend::new(
                    &self.installation.root,
                    &std::env::current_exe()?,
                ),
            ));
            Ok(executor.command_pipes(&self.command)?)
        })
        .await??;
        let cancel = CancellationToken::new();
        let timeout_ms = timeout_ms.unwrap_or(120_000);
        let maka_process::ObservedProcess {
            mut events,
            mut completion,
        } = plan.observe(Some(timeout_ms), cancel.clone())?;
        let mut stdout = maka_transport::stdio::Output::open("sandbox-stdout", std::io::stdout())?;
        let mut stderr = maka_transport::stdio::Output::open("sandbox-stderr", std::io::stderr())?;
        let output = async move {
            while let Some(event) = events.recv().await {
                if let PipeEvent::Output { stream, bytes } = event {
                    match stream {
                        PipeStream::Stdout => stdout.writer.write_all(&bytes).await?,
                        PipeStream::Stderr => stderr.writer.write_all(&bytes).await?,
                    }
                }
            }
            stdout.writer.shutdown().await?;
            stderr.writer.shutdown().await?;
            let (out, err) =
                tokio::try_join!(stdout.done, stderr.done).map_err(std::io::Error::other)?;
            out?;
            err
        };
        let deadline = tokio::time::sleep(Duration::from_millis(timeout_ms));
        tokio::pin!(output, deadline);
        let mut interruption = None;
        let mut output_error = None;
        let mut delivered = false;
        let mut result = None;
        while result.is_none() || (!delivered && interruption.is_none()) {
            tokio::select! {
                completed = &mut completion, if result.is_none() => result = Some(completed),
                _ = &mut deadline, if interruption.is_none() => {
                    interruption = Some(124);
                    cancel.cancel();
                }
                signal = tokio::signal::ctrl_c(), if interruption.is_none() => {
                    interruption = Some(130);
                    if let Err(error) = signal {
                        output_error = Some(error);
                    }
                    cancel.cancel();
                }
                written = &mut output, if !delivered && interruption.is_none() => {
                    delivered = true;
                    if let Err(error) = written {
                        output_error = Some(error);
                        cancel.cancel();
                    }
                }
            }
        }
        // Await native cleanup even when delivery is abandoned. Only the stdio
        // workers can outlive this call; they own no execution or Host resources.
        let result = result.expect("process completion was observed")?;
        if let Some(error) = output_error {
            return Err(error.into());
        }
        if let Some(code) = interruption {
            return Ok(ExitCode::from(code));
        }
        let code = match result.outcome {
            ProcessOutcome::Exited(exit) => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    exit.code()
                        .unwrap_or_else(|| 128 + exit.signal().unwrap_or(1))
                }
                #[cfg(windows)]
                {
                    exit.code().unwrap_or(1)
                }
            }
            ProcessOutcome::Interrupted {
                reason: Termination::Timeout,
                ..
            } => 124,
            ProcessOutcome::Interrupted {
                reason: Termination::Cancelled,
                ..
            } => 130,
        };
        Ok(ExitCode::from(u8::try_from(code).unwrap_or(1)))
    }
}
