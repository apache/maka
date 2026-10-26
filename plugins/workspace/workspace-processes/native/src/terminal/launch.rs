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
use maka_agent_facts::shell_run::ShellOutput;
use maka_agent_facts::shell_run::ShellPermissions;
use maka_agent_facts::shell_run::ShellRun;
use maka_agent_facts::shell_run::ShellState;
use maka_agent_facts::shell_run::ShellVisibility;
use maka_agent_facts::terminal::TerminalSize;
use maka_agent_facts::terminal::display::Display;
impl Processes {
    pub(super) async fn terminal_start(
        &self,
        input: Start,
        context: &Context,
    ) -> Result<ResourceUpdate, ToolError> {
        if self.drain.is_cancelled() {
            return Err(failed("Process owner is draining"));
        }
        if input.command.is_some() && input.size.is_some() {
            return Err(failed("Pipe command cannot have a terminal size"));
        }
        let configuration = self
            .terminal_session(&input.session_id, true, context)
            .await?
            .configuration;
        let settings = self.settings.clone();
        let state_root = self.state_root.clone();
        let captured_configuration = configuration.clone();
        let mut captured = tokio::task::spawn_blocking(move || {
            super::super::execute::capture(&captured_configuration, &settings, &state_root)
        })
        .await
        .map_err(failed)??;
        // A direct user launch uses the configured base sandbox. Agent grants
        // require their original live Invocation and cannot authorize this work.
        let network = self
            .configuration
            .network_configuration()
            .await
            .map_err(|_| failed("Process network configuration unavailable"))?;
        let route =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|_| failed("Process network route unavailable"))?;
        captured.executor = captured.executor.with_network_route(route);
        let sandbox = captured.executor.sandbox().clone();
        let (command, source, pty) = tokio::task::spawn_blocking(move || match input.command {
            Some(source) => captured
                .executor
                .command_pipes(&source)
                .map(|command| (command, source, false)),
            None => captured
                .executor
                .interactive_pty()
                .map(|(source, command)| (command, source, true)),
        })
        .await
        .map_err(failed)??;
        let current = self
            .terminal_session(&input.session_id, true, context)
            .await?
            .configuration;
        if current.permission_basis() != configuration.permission_basis()
            || current.workspace != configuration.workspace
        {
            return Err(failed(
                "Workspace permissions changed before terminal admission",
            ));
        }
        cancelled(&context.scope().cancellation)?;
        if self.drain.is_cancelled() {
            return Err(failed("Process owner is draining"));
        }
        let origin = context
            .operation()
            .ok_or_else(|| failed("Terminal mutation required"))?
            .operation
            .to_string();
        let size = input
            .size
            .unwrap_or(TerminalSize::new(80, 24).expect("default terminal size"));
        let at = maka_agent_authority::now();
        let record = ShellRun {
            id: format!("{}{}", self.prefix, uuid::Uuid::new_v4()),
            session_id: input.session_id,
            source_run_id: None,
            source_turn_id: origin.clone(),
            source_tool_call_id: origin,
            visibility: if pty {
                ShellVisibility::Model
            } else {
                ShellVisibility::User
            },
            permissions: ShellPermissions {
                basis: configuration.permission_basis(),
                sandbox,
            },
            cwd: configuration.workspace.path,
            command: source,
            started_at: at,
            updated_at: at,
            timeout_ms: None,
            revision: 1,
            state: ShellState::Starting,
            output: if pty {
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
        // No await between the final canonical Session read and native acceptance.
        // After acceptance the original owner joins work even if the caller leaves.
        let execution = context
            .scope()
            .identity
            .agent()
            .filter(|invocation| invocation.session_id == record.session_id)
            .zip(context.scope().execution())
            .map(|(invocation, custody)| (invocation.clone(), custody.clone()));
        let mut handle = if pty {
            self.resources.start_pty(record, command, size, execution)
        } else {
            self.resources.start_pipes(record, command, execution)
        }
        .map_err(|error| match error {
            ShellError::Process(error) => error,
            error => failed(error),
        })?;
        let record = tokio::select! { biased;
            _ = context.scope().cancellation.cancelled() => {
                handle.stop(); handle.drained().await.map_err(worker_error)?
            },
            ready = handle.ready() => ready.map_err(worker_error)?,
        };
        let record = if context.scope().cancellation.is_cancelled() {
            handle.stop();
            handle.drained().await.map_err(worker_error)?
        } else {
            record
        };
        snapshot((*record).clone())
    }
}
