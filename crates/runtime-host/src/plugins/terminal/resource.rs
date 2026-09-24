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

use super::{Spawn, message};
use crate::{execution::Executions, shell::ShellHandle};
use maka_plugins::call::{Scope as Authority, Ticket};
use maka_plugins::process::Lifetime;
use maka_plugins::terminal::Error;
use maka_runtime::{
    shell_run::{ShellOutput, ShellRun, ShellState, ShellVisibility},
    terminal::TerminalScreen,
};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub(super) struct Worker {
    pub host: Arc<Executions>,
    pub authority: Authority,
    pub input: Spawn,
    pub private_data: std::path::PathBuf,
    pub id: String,
    pub ticket: Option<Ticket>,
    pub stop: CancellationToken,
    pub retiring: CancellationToken,
    pub send: oneshot::Sender<Result<ShellHandle, Error>>,
}
impl Worker {
    pub async fn run(mut self) -> Result<(), String> {
        let start = self.start().await;
        let mut shell = match start {
            Ok(shell) => shell,
            Err(error) => {
                let _ = self.send.send(Err(error));
                return Ok(());
            }
        };
        if let Some(ticket) = &mut self.ticket {
            ticket.start();
        }
        if self.send.send(Ok(shell.clone())).is_err() {
            self.stop.cancel();
        }
        let invocation = match self.input.command.lifetime {
            Lifetime::Invocation => self.authority.cancellation.clone(),
            Lifetime::Instance => CancellationToken::new(),
        };
        let result = tokio::select! {
            biased;
            _ = self.stop.cancelled() => None,
            _ = self.retiring.cancelled() => None,
            _ = invocation.cancelled() => None,
            result = shell.drained() => Some(result.map_err(message)),
        };
        let result = match result {
            Some(result) => result.map(|_| ()),
            None => {
                shell.stop();
                tokio::time::timeout(Duration::from_secs(4), shell.drained())
                    .await
                    .map_err(|_| "terminal cleanup unconfirmed".to_owned())
                    .and_then(|result| result.map(|_| ()).map_err(message))
            }
        };
        if result.is_err() {
            self.host.begin_drain();
        }
        if let Some(ticket) = self.ticket {
            ticket.complete(result.clone());
        }
        result
    }
    async fn start(&self) -> Result<ShellHandle, Error> {
        if self.stop.is_cancelled()
            || self.retiring.is_cancelled()
            || self.authority.cancellation.is_cancelled()
        {
            return Err(Error::Denied);
        }
        let target = self
            .host
            .plugin_resource_target(&self.authority)
            .map_err(Error::from)?;
        let session = target
            .session()
            .ok_or_else(|| Error::Invalid("a terminal requires a Session".into()))?;
        let invocation = self.authority.identity.agent();
        let prepared = self
            .host
            .admit_plugin_process(&self.authority, &self.input.command, &self.private_data)
            .await
            .map_err(Error::from)?;
        if self.stop.is_cancelled()
            || self.retiring.is_cancelled()
            || self.authority.cancellation.is_cancelled()
        {
            return Err(Error::Denied);
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(super::failed)?
            .as_millis() as u64;
        let record = ShellRun {
            id: self.id.clone(),
            session_id: session.to_owned(),
            source_run_id: invocation.map(|invocation| invocation.run_id.clone()),
            source_turn_id: invocation
                .map(|invocation| invocation.turn_id.clone())
                .unwrap_or_else(|| self.id.clone()),
            source_tool_call_id: self
                .authority
                .identity
                .operation_id()
                .zip(invocation)
                .map(|(id, invocation)| {
                    maka_runtime::tool_call::tool_use_id(&invocation.invocation_id, id)
                })
                .unwrap_or_else(|| format!("plugin:{}", self.id)),
            visibility: ShellVisibility::Model,
            permissions: maka_runtime::shell_run::ShellPermissions {
                boundary_revision: match &prepared.boundary {
                    maka_plugins::authorization::Boundary::Session { boundary, .. } => {
                        boundary.boundary_revision
                    }
                    _ => return Err(Error::Denied),
                },
                sandbox: prepared.sandbox,
            },
            cwd: prepared.cwd,
            command: serde_json::to_string(&(
                &self.input.command.executable,
                &self.input.command.args,
            ))
            .map_err(super::failed)?,
            started_at: now,
            updated_at: now,
            timeout_ms: None,
            revision: 1,
            state: ShellState::Starting,
            output: ShellOutput::Pty {
                screen: TerminalScreen::new(self.input.size),
            },
        };
        let handle = self
            .host
            .shells
            .start_pty(record, prepared.command, self.input.size)
            .map_err(super::failed)?;
        let ready = handle.clone().ready().await;
        self.host.publish_session_change(session).await;
        ready.map_err(super::failed)?;
        drop(prepared.gate);
        Ok(handle)
    }
}
