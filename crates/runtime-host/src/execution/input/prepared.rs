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

use crate::execution::{Executions, Result, failure, input::Outcome, internal};
use crate::session::SessionConfiguration;
use maka_client_capability::BindingMode;
use maka_event_log::sessions::SessionRecord;
use maka_protocol::OperationErrorCode as Code;
use maka_runtime::input::MessageInput;
use std::{collections::HashSet, sync::Arc};

/// The caller revalidates the queue/steering owner and original message identity.
pub(crate) struct PreparedMessageInput {
    digest: String,
    prepared: Option<maka_plugins::input::Prepared>,
    environment: Option<crate::execution::prepare::Environment>,
    pub content: MessageInput,
    pub selection: Outcome,
}

#[derive(Default)]
pub(crate) struct MessageAdmission {
    _input: Option<maka_plugins::input::Admission>,
    _environment: Option<crate::execution::prepare::Admission>,
}

impl Executions {
    pub(crate) async fn prepare_message_input(
        &self,
        session: SessionRecord<SessionConfiguration>,
        content: MessageInput,
        connection: Option<uuid::Uuid>,
        active_tools: Option<Arc<HashSet<String>>>,
    ) -> Result<PreparedMessageInput> {
        let Some(tools) = active_tools else {
            let digest = session.configuration_digest.clone();
            let (environment, content, selection) = self
                .prepare_environment_for(session, connection, BindingMode::Strict, None)
                .await?
                .expand(content, Default::default())
                .await?;
            return Ok(PreparedMessageInput {
                digest,
                environment: Some(environment),
                prepared: None,
                content,
                selection,
            });
        };
        let cwd = &session.configuration.workspace.host_cwd;
        let location = cwd.clone();
        let mode = session.configuration.sandbox_mode;
        let origin = session.configuration.workspace_origin;
        let state_root = self.paths.state_root.clone();
        let workspace = tokio::task::spawn_blocking(move || {
            crate::execution::permissions::read_root(
                mode,
                std::path::Path::new(&location),
                &state_root,
                origin,
            )
        })
        .await
        .map_err(internal)?
        .map_err(internal)?;
        let (prepared, selection) = super::prepare(
            &self.plugin_catalog,
            maka_plugins::input::Request {
                session_id: session.id,
                cwd: cwd.clone(),
                content,
                tools: tools.iter().cloned().collect(),
                selections: Default::default(),
                cancellation: self.shutdown.child_token(),
            },
            &workspace,
        )
        .await?;
        Ok(PreparedMessageInput {
            digest: session.configuration_digest,
            content: prepared.content.clone(),
            prepared: Some(prepared),
            environment: None,
            selection,
        })
    }
}
impl PreparedMessageInput {
    pub(in crate::execution) fn environment(
        &self,
    ) -> Option<&crate::execution::prepare::Environment> {
        self.environment.as_ref()
    }

    pub(crate) async fn commit(
        mut self,
        executions: &Executions,
        session: &str,
    ) -> Result<Option<(Self, Option<MessageAdmission>)>> {
        let record = executions
            .log
            .get_session::<SessionConfiguration>(session)
            .await
            .map_err(internal)?
            .ok_or_else(|| failure(Code::NotFound, "Session does not exist"))?;
        if record.archived {
            return Err(failure(Code::SessionArchived, "Session is archived"));
        }
        if record.configuration_digest != self.digest {
            return Ok(None);
        }
        if executions.shutdown.is_cancelled() {
            return Err(failure(Code::HostDraining, "Host is draining"));
        }
        let mut admission = MessageAdmission::default();
        if let Some(prepared) = &self.prepared {
            let Some(admitted) = prepared.admit().map_err(internal)? else {
                return Ok(None);
            };
            admission._input = Some(admitted);
        }
        if let Some(environment) = self.environment.take() {
            let Some((_, admitted)) = environment.commit(executions, session).await? else {
                return Ok(None);
            };
            admission._environment = Some(admitted);
        }
        Ok(Some((self, Some(admission))))
    }
}
