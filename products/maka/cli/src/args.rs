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
use std::{net::SocketAddr, path::PathBuf};

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

    async fn execute(self) -> Result<std::process::ExitCode, HostError> {
        let Some(command) = self.command else {
            self.terminal.unwrap_or_default().run().await?;
            return Ok(std::process::ExitCode::SUCCESS);
        };
        let result = match command {
            Command::Desktop(args) => return args.run().await,
            Command::TerminalShell(args) => args.run().await.map_err(Into::into),
            Command::Application(args) => args.run().await,
            Command::Sandbox(args) => return args.run(self.timeout_ms).await,
            Command::Host(HostCommand::Fetch(args)) => args.run().await,
            Command::Host(HostCommand::Access(args)) => args.run().await,
            Command::Host(HostCommand::Candidate(args)) => args.run().await,
            Command::Host(HostCommand::Ensure(args)) => args.run().await,
            Command::Host(HostCommand::Install(args)) => args.run().await,
            Command::Host(HostCommand::Setup(args)) => args.run().await,
            Command::Host(HostCommand::Activate(args)) => args.run().await,
            Command::Host(HostCommand::Connect(args)) => args.run().await,
            Command::Host(HostCommand::Update(args)) => args.run().await,
            Command::Host(HostCommand::Upgrade(args)) => args.run().await,
            Command::Host(HostCommand::UpdatePolicy(args)) => args.run().await,
            Command::Host(HostCommand::AutoUpdate(args)) => args.run().await,
            Command::Host(HostCommand::Reconcile(args)) => args.reconcile().await,
            Command::Host(HostCommand::Stop(args)) => {
                args.run(crate::deployment::ControlAction::Stop).await
            }
            Command::Host(HostCommand::Restart(args)) => {
                args.run(crate::deployment::ControlAction::Restart).await
            }
            Command::Host(HostCommand::Uninstall(args)) => {
                args.run(crate::deployment::ControlAction::Uninstall).await
            }
            Command::Host(HostCommand::Init(args)) => args.run().await,
            Command::Host(HostCommand::Serve { root, websocket }) => {
                #[cfg(windows)]
                crate::windows::own_process_tree()?;
                serve::run(&root.root, websocket, None).await
            }
            Command::Host(HostCommand::ServiceRun(args)) => args.run().await,
            Command::Host(HostCommand::Status(args)) => args.run().await,
            Command::Host(HostCommand::Logs(args)) => args.run().await,
            Command::Host(HostCommand::Retire {
                root,
                expected_host_epoch,
                allow_interrupt_active_tasks,
            }) => {
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
            }
            Command::Code(args) => code::run(args).await,
            Command::Acp(args) => crate::acp::run(args).await,
            Command::Inspect(args) => {
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
            }
        };
        result?;
        Ok(std::process::ExitCode::SUCCESS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn only_headless_roles_log_to_stderr() {
        for arguments in [
            vec!["maka", "host", "serve", "--root", "/tmp/logging-host"],
            vec!["maka", "host", "init", "--root", "/tmp/logging-host"],
            vec![
                "maka",
                "application",
                "serve",
                "--root",
                "/tmp/logging-host",
                "--deployment",
                "00000000-0000-0000-0000-000000000001",
                "--endpoints",
                "/tmp/endpoints",
            ],
            vec!["maka", "code", "--root", "/tmp/code-root"],
            vec!["maka", "acp"],
        ] {
            assert!(
                Cli::try_parse_from(&arguments).unwrap().logs_to_stderr(),
                "{arguments:?}"
            );
        }
        for arguments in [
            vec!["maka"],
            vec!["maka", "desktop", "--root", "/tmp/desktop-host"],
            vec!["maka", "terminal-shell"],
        ] {
            assert!(
                !Cli::try_parse_from(&arguments).unwrap().logs_to_stderr(),
                "{arguments:?}"
            );
        }
    }

    #[tokio::test]
    async fn entry_launches_the_terminal_shell_and_preserves_operator_parsing() {
        Cli::command().debug_assert();
        assert!(Cli::try_parse_from(["maka"]).unwrap().command.is_none());
        assert!(
            Cli::try_parse_from(["maka", "--root", "/tmp/host", "--session", "session-id"])
                .unwrap()
                .command
                .is_none()
        );
        assert!(
            Cli::try_parse_from([
                "maka",
                "--root",
                "/tmp/product",
                "host",
                "status",
                "--root",
                "/tmp/host"
            ])
            .unwrap()
            .run()
            .await
            .is_err()
        );
        let worker = Cli::try_parse_from([
            "maka",
            "--operation-worker",
            "--timeout-ms",
            "1000",
            "host",
            "init",
            "--root",
            "/tmp/test-root",
        ])
        .unwrap();
        assert!(worker.terminal.is_none());
        assert!(worker.operation_worker);
        assert_eq!(worker.timeout_ms, Some(1000));
        assert!(matches!(
            worker.command,
            Some(Command::Host(HostCommand::Init(_)))
        ));
        assert!(matches!(
            Cli::try_parse_from(["maka", "host", "init", "--root", "/tmp/test-root"])
                .unwrap()
                .command,
            Some(Command::Host(HostCommand::Init(_)))
        ));
        for arguments in [
            vec!["maka"],
            vec!["maka", "--root", "/tmp/host"],
            vec!["maka", "terminal-shell", "--session", "session-id"],
        ] {
            assert!(Cli::try_parse_from(arguments).unwrap().is_terminal_shell());
        }
        for arguments in [
            vec!["maka", "tui"],
            vec!["maka", "application", "run"],
            vec!["maka", "application", "launch"],
        ] {
            assert!(Cli::try_parse_from(arguments).is_err());
        }
        assert!(Cli::try_parse_from(["maka", "unknown-command"]).is_err());
    }
}
