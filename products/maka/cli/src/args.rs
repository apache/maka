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

use clap::{Args, Parser, Subcommand};
use maka_host_runtime::HostError;
use std::{future::Future, net::SocketAddr, path::PathBuf, pin::Pin, process::ExitCode};

use crate::{candidate, code, serve};

#[derive(Parser)]
#[command(name = "maka", version, about = "Maka")]
pub(super) struct Cli {
    #[command(flatten)]
    terminal: Option<maka_terminal_shell::entry::Args>,
    /// Total observation budget for a finite Host operation, including cleanup.
    #[arg(long, global = true, value_parser = clap::value_parser!(u64).range(1..=600_000))]
    timeout_ms: Option<u64>,
    #[arg(long, hide = true)]
    operation_worker: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Open the desktop shell connected to a business Host Root.
    Desktop(crate::desktop::Args),
    /// Open the NSH terminal shell (connects to or starts the selected Host).
    TerminalShell(maka_terminal_shell::entry::Args),
    /// Author, inspect and serve plugin applications.
    #[command(subcommand)]
    Application(crate::application::Command),
    /// Manage the native runtime host.
    #[command(subcommand)]
    Host(HostCommand),
    /// Execute a journaled Code Mode cell read from stdin.
    Code(code::Args),
    /// Serve Agent Client Protocol v2 over stdin/stdout.
    Acp(crate::acp::Args),
    /// Inspect the committed execution log.
    Inspect(Log),
    /// Diagnose commands and manage native sandbox setup.
    #[command(subcommand)]
    Sandbox(crate::sandbox::Command),
}

#[derive(Subcommand)]
enum HostCommand {
    /// Download and verify an exact native CLI package without installing or starting it.
    Fetch(crate::distribution::Fetch),
    /// Prepare one-time remote Desktop pairing or revoke a credential.
    #[command(subcommand)]
    Access(crate::access::Access),
    /// Initialize an empty native State Root, or verify its existing identity.
    Init(crate::initialize::Init),
    /// Install this native executable as the root's managed Host.
    Install(crate::deployment::Install),
    /// Install or reuse native code, activate it, and optionally prepare Desktop pairing.
    Setup(crate::deployment::Setup),
    /// Activate an installed Host and report its verified loopback endpoint.
    Activate(crate::deployment::Activate),
    /// Connect an installed Host to stdin/stdout using the client wire protocol.
    Connect(crate::deployment::Connect),
    /// Update code and optional deployment configuration at a safe boundary.
    Update(crate::deployment::Update),
    /// Download a verified native release and update at a safe boundary.
    Upgrade(crate::deployment::Upgrade),
    /// Observe or configure unattended native preview updates.
    UpdatePolicy(crate::deployment::UpdatePolicy),
    #[command(hide = true)]
    AutoUpdate(crate::deployment::AutoUpdate),
    /// Finish an interrupted deployment update without choosing another target.
    Reconcile(crate::deployment::Expected),
    /// Stop a deployment without changing its configuration or pending update.
    Stop(crate::deployment::Control),
    /// Restart the current deployment without applying a pending update.
    Restart(crate::deployment::Control),
    /// Revoke startup and unregister its service, retaining State Root data.
    Uninstall(crate::deployment::Control),
    /// Observe a Host or managed deployment without starting or changing it.
    Status(crate::deployment::Status),
    /// Read or follow captured Host diagnostics without starting it.
    Logs(crate::deployment::Logs),
    /// Retire the exact current Host when idle, or explicitly interrupt its work.
    Retire {
        #[command(flatten)]
        root: Root,
        #[arg(long)]
        expected_host_epoch: Option<String>,
        /// Permit interrupting other clients and non-cooperative resources.
        #[arg(long)]
        allow_interrupt_active_tasks: bool,
    },
    /// Coordinate automatic local startup for a trusted UI launcher.
    #[command(hide = true)]
    Ensure(crate::startup::Ensure),
    /// Run a discoverable ephemeral Host under its launcher.
    Candidate(candidate::Candidate),
    /// Run only the currently admitted supervised deployment.
    #[command(hide = true)]
    ServiceRun(crate::deployment::ServiceRun),
    /// Serve a native State Root over a private local endpoint.
    Serve {
        #[command(flatten)]
        root: Root,
        #[arg(long)]
        websocket: Option<SocketAddr>,
    },
}

#[derive(Args)]
pub(super) struct Root {
    #[arg(long, value_name = "DIRECTORY")]
    pub(super) root: PathBuf,
}

#[derive(Args)]
struct Log {
    #[arg(long, value_name = "DIRECTORY")]
    root: PathBuf,
    #[arg(long)]
    session: String,
}

impl Cli {
    pub(super) fn is_terminal_shell(&self) -> bool {
        self.command.is_none() || matches!(self.command, Some(Command::TerminalShell(_)))
    }

    pub(super) fn logs_to_stderr(&self) -> bool {
        // Interactive products own the terminal; only headless roles write logs
        // to stderr. Libraries never install a process-global subscriber.
        matches!(
            self.command,
            Some(
                Command::Host(_)
                    | Command::Application(crate::application::Command::Serve(_))
                    | Command::Code(_)
                    | Command::Acp(_)
            )
        )
    }

    pub(super) fn error_exit_code(&self) -> u8 {
        if matches!(self.command, Some(Command::Host(HostCommand::Candidate(_)))) {
            70
        } else {
            1
        }
    }

    pub(super) async fn run(self) -> Result<std::process::ExitCode, HostError> {
        if self.command.is_some() && self.terminal.is_some() {
            return Err("terminal options cannot be combined with a CLI command".into());
        }
        let finite = matches!(&self.command, Some(Command::Host(command)) if !matches!(command,
            HostCommand::Candidate(_) | HostCommand::Serve { .. } | HostCommand::ServiceRun(_)
            | HostCommand::Connect(_) | HostCommand::Ensure(_))
            && !matches!(command, HostCommand::Logs(logs) if logs.follow));
        if finite {
            let default = if matches!(
                &self.command,
                Some(Command::Host(HostCommand::Status(_) | HostCommand::Logs(_)))
            ) {
                15_000
            } else {
                180_000
            };
            let timeout = std::time::Duration::from_millis(self.timeout_ms.unwrap_or(default));
            if !self.operation_worker {
                let settings_stdin = matches!(&self.command, Some(Command::Host(HostCommand::Init(args))) if args.settings_stdin);
                return crate::operation::observe(timeout, settings_stdin)
                    .await
                    .map(|()| std::process::ExitCode::SUCCESS);
            }
            let result = crate::operation::scope(timeout, self.execute()).await;
            if let Err(error) = &result
                && error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
            {
                // The executor did not admit this operation. Retrying must
                // still re-read deployment authority, never remove its lock.
                eprintln!("MAKA_HOST_ERROR {{\"kind\":\"busy\"}}");
            }
            return result;
        }
        self.execute().await
    }

    // Keep dispatch out of the poll stack shared with the selected command.
    fn execute(self) -> CommandFuture {
        let Some(command) = self.command else {
            return command_exit(async move {
                self.terminal
                    .unwrap_or_default()
                    .run()
                    .await
                    .map_err(Into::into)
            });
        };
        match command {
            Command::Desktop(args) => Box::pin(args.run()),
            Command::TerminalShell(args) => {
                command_exit(async move { args.run().await.map_err(Into::into) })
            }
            Command::Application(args) => command_exit(args.run()),
            Command::Sandbox(args) => Box::pin(args.run(self.timeout_ms)),
            Command::Host(HostCommand::Fetch(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Access(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Candidate(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Ensure(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Install(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Setup(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Activate(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Connect(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Update(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Upgrade(args)) => command_exit(args.run()),
            Command::Host(HostCommand::UpdatePolicy(args)) => command_exit(args.run()),
            Command::Host(HostCommand::AutoUpdate(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Reconcile(args)) => command_exit(args.reconcile()),
            Command::Host(HostCommand::Stop(args)) => {
                command_exit(args.run(crate::deployment::ControlAction::Stop))
            }
            Command::Host(HostCommand::Restart(args)) => {
                command_exit(args.run(crate::deployment::ControlAction::Restart))
            }
            Command::Host(HostCommand::Uninstall(args)) => {
                command_exit(args.run(crate::deployment::ControlAction::Uninstall))
            }
            Command::Host(HostCommand::Init(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Serve { root, websocket }) => command_exit(async move {
                #[cfg(windows)]
                crate::windows::own_process_tree()?;
                serve::run(&root.root, websocket, None).await
            }),
            Command::Host(HostCommand::ServiceRun(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Status(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Logs(args)) => command_exit(args.run()),
            Command::Host(HostCommand::Retire {
                root,
                expected_host_epoch,
                allow_interrupt_active_tasks,
            }) => command_exit(async move {
                let mut client = crate::host_client::HostClient::connect(&root.root, None).await?;
                let result = client
                    .retire(
                        expected_host_epoch.as_deref(),
                        allow_interrupt_active_tasks,
                        false,
                    )
                    .await?;
                drop(client);
                println!("{}", serde_json::to_string(&result)?);
                Ok(())
            }),
            Command::Code(args) => command_exit(code::run(args)),
            Command::Acp(args) => command_exit(crate::acp::run(args)),
            Command::Inspect(args) => command_exit(async move {
                let store = crate::application::open_store(args.root).await?;
                let session = store.session(&args.session).await?;
                let prefix = session
                    .scoped_prefix(
                        maka_agent_facts::event::LogScope::Session {
                            id: session.id().into(),
                        },
                        10_000,
                        8 * 1024 * 1024,
                    )
                    .await;
                let closed = store.shutdown().await;
                let prefix = prefix?;
                closed?;
                println!("{}", serde_json::to_string(&prefix)?);
                Ok(())
            }),
        }
    }
}

type CommandFuture = Pin<Box<dyn Future<Output = Result<ExitCode, HostError>>>>;

fn command_exit(work: impl Future<Output = Result<(), HostError>> + 'static) -> CommandFuture {
    Box::pin(async move {
        work.await?;
        Ok(ExitCode::SUCCESS)
    })
}
