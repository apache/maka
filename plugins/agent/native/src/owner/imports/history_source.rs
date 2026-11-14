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
use super::super::*;
use maka_agent_facts::{durable::*, input::RunInput};
use maka_agent_state::{ContentBlob, session_history::snapshot::Snapshot};
use maka_capabilities::call::Scope;
use maka_plugin_core::operation::RecoveryRef;
pub(super) fn turn(operation: &RecoveryRef) -> String {
    format!("history:{}", operation.operation)
}

impl Owner {
    pub(in crate::owner) async fn history_source_spec(
        &self,
        target: &str,
        configuration: &ResolvedConfiguration,
        source: &Snapshot,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<(RunSpec, Vec<ContentBlob>), String> {
        let settings = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|error| error.to_string())?;
        let sandbox = self
            .capture_sandbox(configuration, scope.sandbox_floor())
            .await?;
        // This marker installs inert history. It has no active system prompt,
        // backend/tool binding, graph execution or budget issuer to restore.
        let system = ContentBlob::json(&Option::<maka_agent_facts::execution::SystemPrompt>::None)
            .map_err(|error| error.to_string())?;
        let selection = crate::tools::SelectionSnapshot {
            definitions: vec![],
            direct_only: Default::default(),
            services: Default::default(),
            internal_bindings: Default::default(),
        };
        let tools = ContentBlob::json(&selection).map_err(|error| error.to_string())?;
        let input = ContentBlob::json(&RunInput::HistorySource {
            source: source.reference().clone(),
        })
        .map_err(|error| error.to_string())?;
        let spec = RunSpec {
            schema_version: SCHEMA_VERSION,
            session_id: target.to_owned(),
            owner: self.run_owner(),
            turn_id: turn(operation),
            origin: RunOrigin::Imported {
                source: source.reference().clone(),
            },
            trigger: Trigger::HistorySource,
            workspace: configuration.workspace.path.clone(),
            permission_basis: configuration.permission_basis(),
            permission_ceiling: maka_sandbox::Permissions {
                sandbox,
                approval: if configuration.permissions.request_permissions {
                    maka_sandbox::Approval::OnRequest
                } else {
                    maka_sandbox::Approval::Never
                },
            },
            network_approval_ceiling: None,
            backend: BackendSpec::Historical {},
            collaboration: configuration.collaboration_mode,
            language: self.resolve_language(&settings),
            tool_discovery: false,
            allowed_tools: configuration.tools.clone(),
            mcp_revision: None,
            compaction_prompt: None,
            system_prompt: system.reference().clone(),
            tool_selection: tools.reference().clone(),
            input: input.reference().clone(),
            budget: Budget {
                tokens: None,
                retries: 0,
                deadline: None,
            },
            budget_basis: None,
        };
        Ok((spec, vec![system, tools, input]))
    }
}
