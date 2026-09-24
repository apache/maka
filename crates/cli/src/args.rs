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
use maka_event_log::{EventLog, root::RootNamespaces};
use maka_runtime_host::server::HostError;
use std::{net::SocketAddr, path::PathBuf};

use crate::{candidate, code, serve};

#[derive(Parser)]
#[command(name = "maka", version, about = "Maka")]
pub(super) struct Cli {
    /// Native State Root for the default interactive TUI.
    #[arg(long = "root", value_name = "DIRECTORY")]
    tui_root: Option<PathBuf>,
    /// TUI language: auto, zh-CN, zh-TW, en. Overrides MAKA_LOCALE.
    #[arg(long = "locale", value_name = "LANGUAGE")]
    tui_locale: Option<maka_tui::LocalePreference>,
    /// Local TUI profile; use different profiles for concurrent terminals.
    #[arg(long = "profile", value_name = "NAME")]
    tui_profile: Option<String>,
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
    /// Open the interactive terminal application (also the default without a command).
    Tui(Tui),
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

#[derive(Args, Default)]
struct Tui {
    /// Native State Root, initialized automatically when empty. Defaults to the account root.
    #[arg(long, value_name = "DIRECTORY")]
    root: Option<PathBuf>,
    /// UI language: auto, zh-CN, zh-TW, en. Overrides MAKA_LOCALE.
    #[arg(long, value_name = "LANGUAGE")]
    locale: Option<maka_tui::LocalePreference>,
    /// Local TUI profile; use different profiles for concurrent terminals.
    #[arg(long, value_name = "NAME")]
    profile: Option<String>,
}

impl Tui {
    async fn run(self) -> Result<(), HostError> {
        let root = match self.root {
            Some(root) => root,
            None => RootNamespaces::for_current_account()?
                .ownership
                .parent()
                .ok_or("missing account data directory")?
                .join("runtime-host-rust"),
        };
        maka_tui::run(
            maka_tui::Options {
                root,
                locale: self.locale,
                profile: self.profile.unwrap_or_else(|| "default".into()),
            },
            crate::deployment::connect_local,
            crate::deployment::shutdown_local,
        )
        .await
    }
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
    /// Read a bounded tail of supervised Host diagnostics without starting it.
    Logs(crate::deployment::Logs),
    /// Retire the exact current Host, preserving work at safe step boundaries.
    Retire {
        #[command(flatten)]
        root: Root,
        #[arg(long)]
        expected_host_epoch: Option<String>,
        /// Coordinate with this exact connected client without interrupting other clients.
        #[arg(long, requires = "expected_host_epoch")]
        handoff_connection_id: Option<uuid::Uuid>,
        /// Permit interrupting other clients and non-cooperative resources.
        #[arg(long)]
        allow_interrupt_active_tasks: bool,
    },
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
    #[arg(long, value_name = "FILE")]
    log: PathBuf,
}

impl Cli {
    pub(super) fn error_exit_code(&self) -> u8 {
        if matches!(self.command, Some(Command::Host(HostCommand::Candidate(_)))) {
            70
        } else {
            1
        }
    }

    pub(super) async fn run(self) -> Result<std::process::ExitCode, HostError> {
        if self.tui_root.is_some() && self.command.is_some() {
            return Err(
                "Use --root after the subcommand, or use maka --root DIRECTORY for the default TUI"
                    .into(),
            );
        }
        if self.tui_locale.is_some() && self.command.is_some() {
            return Err(
                "Use --locale after tui, or use maka --locale LANGUAGE for the default TUI".into(),
            );
        }
        if self.tui_profile.is_some() && self.command.is_some() {
            return Err(
                "Use --profile after tui, or use maka --profile NAME for the default TUI".into(),
            );
        }
        let finite = matches!(&self.command, Some(Command::Host(command)) if !matches!(command,
            HostCommand::Candidate(_) | HostCommand::Serve { .. } | HostCommand::ServiceRun(_)
            | HostCommand::Connect(_)));
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
                return crate::operation::observe(timeout)
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
        let result = match self.command.unwrap_or(Command::Tui(Tui {
            root: self.tui_root,
            locale: self.tui_locale,
            profile: self.tui_profile,
        })) {
            Command::Tui(args) => args.run().await,
            Command::Sandbox(args) => return args.run(self.timeout_ms).await,
            Command::Host(HostCommand::Fetch(args)) => args.run().await,
            Command::Host(HostCommand::Access(args)) => args.run().await,
            Command::Host(HostCommand::Candidate(args)) => args.run().await,
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
                handoff_connection_id,
                allow_interrupt_active_tasks,
            }) => {
                let mut client = crate::host_client::HostClient::connect(&root.root, None).await?;
                let result = client
                    .retire(
                        expected_host_epoch.as_deref(),
                        allow_interrupt_active_tasks,
                        handoff_connection_id,
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
                let log = EventLog::open(&args.log).await?;
                let prefix = log.prefix(10_000, 8 * 1024 * 1024).await?;
                println!("{}", serde_json::to_string(&prefix)?);
                log.shutdown().await?;
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
    fn default_tui_and_explicit_tui_preserve_operator_parsing() {
        Cli::command().debug_assert();
        assert!(Cli::try_parse_from(["maka"]).unwrap().command.is_none());
        assert!(matches!(
            Cli::try_parse_from(["maka", "tui"]).unwrap().command,
            Some(Command::Tui(_))
        ));
        assert!(matches!(
            Cli::try_parse_from(["maka", "host", "init", "--root", "/tmp/test-root"])
                .unwrap()
                .command,
            Some(Command::Host(HostCommand::Init(_)))
        ));
        assert_eq!(
            Cli::try_parse_from(["maka", "--root", "/tmp/test-root"])
                .unwrap()
                .tui_root,
            Some(PathBuf::from("/tmp/test-root"))
        );
        assert!(matches!(
            Cli::try_parse_from(["maka", "tui", "--root", "/tmp/test-root"])
                .unwrap()
                .command,
            Some(Command::Tui(Tui { root: Some(_), .. }))
        ));
        assert!(Cli::try_parse_from(["maka", "unknown-command"]).is_err());
        assert_eq!(
            Cli::try_parse_from(["maka", "--locale", "zh-CN"])
                .unwrap()
                .tui_locale,
            Some(maka_tui::LocalePreference::Explicit(maka_tui::Locale::ZhCn)),
        );
        assert!(matches!(
            Cli::try_parse_from(["maka", "tui", "--locale", "zh-TW"])
                .unwrap()
                .command,
            Some(Command::Tui(Tui {
                locale: Some(maka_tui::LocalePreference::Explicit(maka_tui::Locale::ZhTw)),
                ..
            }))
        ));
        assert!(Cli::try_parse_from(["maka", "--locale", "not-a-language"]).is_err());
        assert_eq!(
            Cli::try_parse_from(["maka", "--profile", "second"])
                .unwrap()
                .tui_profile
                .as_deref(),
            Some("second")
        );
        assert!(
            matches!(Cli::try_parse_from(["maka", "tui", "--profile", "second"]).unwrap().command,
            Some(Command::Tui(Tui {profile: Some(profile), ..})) if profile == "second")
        );
    }

    #[test]
    fn help_keeps_tui_and_existing_commands_discoverable() {
        let help = Cli::command().render_long_help().to_string();
        for command in ["tui", "host", "code", "inspect", "sandbox"] {
            assert!(help.contains(command));
        }
    }
}
