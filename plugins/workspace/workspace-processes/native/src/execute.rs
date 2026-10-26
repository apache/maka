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

use super::*;
use maka_agent_api::contract::WorkspaceAccess;
use maka_agent_facts::interaction::PermissionCommand;
use maka_agent_facts::interaction::PermissionRequest;
use maka_agent_facts::shell_run::ShellOutput;
use maka_agent_facts::shell_run::ShellPermissions;
use maka_agent_facts::shell_run::ShellRun;
use maka_agent_facts::shell_run::ShellState;
use maka_agent_facts::shell_run::ShellVisibility;
use maka_agent_facts::terminal::TerminalSize;
use maka_agent_facts::terminal::display::Display;
use maka_sandbox::filesystem::{Access, Rule};

pub(super) struct Captured {
    pub(super) executor: maka_process::ShellExecutor,
    ceiling: Sandbox,
}
pub(super) fn capture(
    configuration: &ResolvedConfiguration,
    settings: &Configuration,
    state_root: &std::path::Path,
) -> Result<Captured, ToolError> {
    let workspace = &configuration.workspace;
    if workspace.worktree.is_some() && !settings.isolated_workspaces {
        return Err(failed("Isolated workspace execution is not installed"));
    }
    let path = PathBuf::from(&workspace.path);
    let directory =
        maka_fs_tools::directory::open(&path, &workspace.directory_identity).map_err(failed)?;
    if maka_fs_tools::workspace::read_directory_identity(
        path.clone(),
        directory.try_clone().map_err(failed)?,
    )
    .map_err(failed)?
        != workspace.identity
    {
        return Err(failed("Workspace marker identity changed"));
    }
    if configuration.permissions.access == WorkspaceAccess::DangerFullAccess {
        let executor = maka_process::ShellExecutor::from_directory(
            path,
            directory.into_std_file(),
            Sandbox::Disabled,
        )?;
        return Ok(Captured {
            executor: platform(executor, settings, state_root),
            ceiling: Sandbox::Disabled,
        });
    }
    let (base, protections) =
        maka_workspace_support::sandbox(workspace, configuration.permissions.access, state_root)
            .map_err(failed)?;
    let mut installed_filesystem = settings.filesystem.clone();
    if workspace.worktree.is_some() {
        installed_filesystem
            .rules
            .push(Rule::subtree(&path, Access::Write));
    }
    let installation = Sandbox::Managed {
        filesystem: installed_filesystem,
        network: settings.network.clone(),
    };
    let ceiling = installation.intersect(&protections).map_err(failed)?;
    let base = base.intersect(&ceiling).map_err(failed)?;
    maka_fs_tools::directory::open(&path, &workspace.directory_identity).map_err(failed)?;
    let executor =
        maka_process::ShellExecutor::from_directory(path, directory.into_std_file(), base)?;
    let executor = platform(executor, settings, state_root);
    Ok(Captured { executor, ceiling })
}
/// Platform bootstrap shared by Session and explicitly installed setup launches.
pub(super) fn platform(
    executor: maka_process::ShellExecutor,
    settings: &Configuration,
    state_root: &std::path::Path,
) -> maka_process::ShellExecutor {
    let _ = (settings, state_root);
    #[cfg(target_os = "linux")]
    let executor = match &settings.helper {
        Some(helper) => executor.with_network_helper(helper.clone()),
        None => executor,
    };
    #[cfg(windows)]
    let executor =
        executor.with_backend(Arc::new(maka_host_runtime::sandbox::windows::Backend::new(
            state_root,
            settings.helper.as_ref().expect("validated helper"),
        )));
    executor
}

impl Processes {
    pub(super) async fn execute(
        &self,
        mut input: Execute,
        tool: &ToolCallContext,
        configuration: ResolvedConfiguration,
        cancellation: &CancellationToken,
    ) -> Result<Value, ToolError> {
        let requested = input
            .additional_permissions
            .take()
            .map(|permissions| PermissionRequest {
                reason: input.justification.take().expect("validated justification"),
                command: Some(PermissionCommand {
                    command: input.command.clone(),
                    cwd: configuration.workspace.path.clone(),
                }),
                permissions,
            });
        let captured = self
            .prepare(tool, &configuration, requested, cancellation)
            .await?;
        let captured = Captured {
            executor: captured.executor.with_login_shell(input.login),
            ..captured
        };
        let compiler = captured.executor.clone();
        let source = input.command.clone();
        let terminal = input.pty;
        let command = tokio::task::spawn_blocking(move || {
            if terminal {
                compiler.command_pty(&source)
            } else {
                compiler.command_pipes(&source)
            }
        })
        .await
        .map_err(failed)??;
        // Original SQL projection orders admission against metadata CAS and Turn closure.
        let current = maka_agent_authority::permissions::live(
            &maka_agent_authority::permissions::execution(
                &self.store,
                &tool.invocation,
                tool.execution.as_deref(),
            )?,
            &tool.invocation,
        )
        .await?;
        if current.permission_basis() != configuration.permission_basis()
            || current.workspace != configuration.workspace
        {
            return Err(failed(
                "Workspace permissions changed before process admission",
            ));
        }
        cancelled(cancellation)?;
        if !input.run_in_background {
            let mut process = command.observe(
                Some(input.timeout_ms.unwrap_or(120_000)),
                cancellation.clone(),
            )?;
            let mut events_open = true;
            let output = loop {
                tokio::select! {
                    event = process.events.recv(), if events_open => { if event.is_none() { events_open = false; } },
                    output = &mut process.completion => break output?,
                }
            };
            return Ok(output.into_output(captured.executor.cwd().to_owned(), input.command));
        }
        let size = TerminalSize::new(80, 24).expect("terminal size");
        let at = maka_agent_authority::now();
        let record = ShellRun {
            id: format!("{}{}", self.prefix, uuid::Uuid::new_v4()),
            session_id: tool.invocation.session_id.clone(),
            source_run_id: Some(tool.invocation.run_id.clone()),
            source_turn_id: tool.invocation.turn_id.clone(),
            source_tool_call_id: tool.tool_use_id(),
            visibility: ShellVisibility::Model,
            permissions: ShellPermissions {
                basis: configuration.permission_basis(),
                sandbox: captured.executor.sandbox().clone(),
            },
            cwd: configuration.workspace.path,
            command: input.command,
            started_at: at,
            updated_at: at,
            timeout_ms: input.timeout_ms,
            revision: 1,
            state: ShellState::Starting,
            output: if input.pty {
                ShellOutput::Pty {
                    screen: Arc::new(Display::new(size)),
                }
            } else {
                ShellOutput::Pipes {
                    stdout: String::new(),
                    stderr: String::new(),
                    latest_stream: None,
                    stdout_truncated: false,
                    stderr_truncated: false,
                }
            },
        };
        let execution = tool
            .execution
            .as_ref()
            .map(|token| (tool.invocation.clone(), token.clone()));
        let mut handle = if input.pty {
            self.resources.start_pty(record, command, size, execution)
        } else {
            self.resources.start_pipes(record, command, execution)
        }
        .map_err(|error| match error {
            ShellError::Process(error) => error,
            error => failed(error),
        })?;
        let record = tokio::select! {
            biased;
            _ = cancellation.cancelled() => { handle.stop(); handle.drained().await.map_err(worker_error)? },
            ready = handle.ready() => ready.map_err(worker_error)?,
        };
        let record = if cancellation.is_cancelled() {
            handle.stop();
            handle.drained().await.map_err(worker_error)?
        } else {
            record
        };
        self.project(tool, (*record).clone(), record.state.active())
            .await
    }
}

impl Processes {
    pub(super) async fn prepare(
        &self,
        tool: &ToolCallContext,
        configuration: &ResolvedConfiguration,
        requested: Option<PermissionRequest>,
        cancellation: &CancellationToken,
    ) -> Result<Captured, ToolError> {
        let settings = self.settings.clone();
        let state_root = self.state_root.clone();
        let captured_configuration = configuration.clone();
        let mut captured = tokio::task::spawn_blocking(move || {
            capture(&captured_configuration, &settings, &state_root)
        })
        .await
        .map_err(failed)??;
        let store = maka_agent_authority::permissions::execution(
            &self.store,
            &tool.invocation,
            tool.execution.as_deref(),
        )?;
        let grants = store
            .permission_grants(
                &tool.invocation,
                Some(&tool.tool_use_id()),
                &configuration.permission_basis(),
            )
            .await
            .map_err(persistence)?;
        let mut sandbox = captured.executor.sandbox().clone();
        for grant in grants {
            sandbox = sandbox
                .with_grant(&grant.permissions, &captured.ceiling)
                .map_err(failed)?;
        }
        if let Some(requested) = requested {
            let permissions = requested.permissions;
            let required = tokio::task::spawn_blocking(move || {
                maka_fs_tools::workspace::permissions::materialize(permissions)
            })
            .await
            .map_err(failed)?
            .map_err(failed)?;
            if !captured.ceiling.permits(&required).map_err(failed)? {
                return Err(failed(
                    "Requested access exceeds the process installation or protected workspace boundary",
                ));
            }
            if !sandbox.permits(&required).map_err(failed)? {
                let grant = maka_agent_authority::permissions::request(
                    &store,
                    configuration,
                    PermissionRequest {
                        reason: requested.reason,
                        command: requested.command,
                        permissions: required.clone(),
                    },
                    tool,
                    cancellation,
                )
                .await?;
                sandbox = sandbox
                    .with_grant(&grant.permissions, &captured.ceiling)
                    .map_err(failed)?;
            }
            if !sandbox.permits(&required).map_err(failed)? {
                return Err(failed(
                    "Not all requested process permissions were approved; command was not started",
                ));
            }
        }
        let network = self
            .configuration
            .network_configuration()
            .await
            .map_err(|_| failed("Process network configuration unavailable"))?;
        let route =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|_| failed("Process network route unavailable"))?;
        captured.executor = captured
            .executor
            .with_sandbox(sandbox)
            .with_network_route(route);
        Ok(captured)
    }
}
