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

//! Freeze domain prerequisites, not live handles or grants, for canonical admission.
use super::*;
use maka_agent_facts::{durable::*, input::RunInput};
use maka_agent_state::{
    ContentBlob,
    queue::{PreparedRequest, RequestId},
};
use maka_capabilities::call::Scope;
use maka_plugin_core::operation::RecoveryRef;

impl Owner {
    pub(super) async fn capture_sandbox(
        &self,
        configuration: &ResolvedConfiguration,
        floor: &maka_sandbox::Sandbox,
    ) -> Result<maka_sandbox::Sandbox, String> {
        let root = self
            .store
            .owned_root()
            .map_err(|error| error.to_string())?
            .canonical_path()
            .to_path_buf();
        let workspace = configuration.workspace.clone();
        let access = configuration.permissions.access;
        let (sandbox, _) =
            tokio::task::spawn_blocking(move || workspace::sandbox(&workspace, access, &root))
                .await
                .map_err(|error| error.to_string())??;
        sandbox.intersect(floor).map_err(|error| error.to_string())
    }
    pub(super) async fn freeze_request(
        &self,
        session_id: &str,
        source: RootSourceMessage,
        basis: &CapturedRun,
        required_tools: BTreeSet<String>,
        operation: &RecoveryRef,
        parent: &Scope,
    ) -> Result<(PreparedRequest, Vec<ContentBlob>), String> {
        self.freeze_captured_request(
            session_id,
            source,
            basis,
            required_tools,
            &self.operation_id(operation),
            Some(operation.fingerprint.clone()),
            parent,
        )
        .await
    }

    pub(super) async fn freeze_background_request(
        &self,
        session_id: &str,
        source: RootSourceMessage,
        basis: &CapturedRun,
        required_tools: BTreeSet<String>,
        key: &str,
        parent: &Scope,
    ) -> Result<(PreparedRequest, Vec<ContentBlob>), String> {
        self.validate_background(basis).await?;
        self.freeze_captured_request(session_id, source, basis, required_tools, key, None, parent)
            .await
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Capture binds immutable source bytes to the original session, operation identity and parent scope"
    )]
    async fn freeze_captured_request(
        &self,
        session_id: &str,
        source: RootSourceMessage,
        basis: &CapturedRun,
        required_tools: BTreeSet<String>,
        key: &str,
        fingerprint: Option<String>,
        parent: &Scope,
    ) -> Result<(PreparedRequest, Vec<ContentBlob>), String> {
        let trigger = match &basis.background_kind {
            BackgroundKind::Goal(goal_id) => Trigger::Goal { goal_id: *goal_id },
            BackgroundKind::Schedule { task_id } => Trigger::Schedule {
                schedule_id: task_id.clone(),
            },
            BackgroundKind::Interactive => Trigger::Message {
                message_id: source.message.message_id.clone(),
            },
        };
        let budget = self
            .capture_budget(session_id, basis, &trigger, &source.message.message_id)
            .await?;
        let input = RunInput::Message {
            content: source.message.content.clone(),
            request_fingerprint: fingerprint,
            source_messages: vec![source.clone()],
        };
        let (spec, mut contents) = self
            .freeze_run_values(
                session_id,
                format!("t_{key}"),
                basis,
                trigger,
                input,
                budget,
                parent,
            )
            .await?;
        let source_blob = ContentBlob::json(&source).map_err(|error| error.to_string())?;
        let resources = ContentBlob::json(&serde_json::json!({
            "kind": "message_resources",
            "attachments": source.message.content.attachments,
            "reacquisition": {"kind": "immutable_user_uploads", "requiresAuthorization": true},
        }))
        .map_err(|error| error.to_string())?;
        let request = PreparedRequest {
            id: RequestId(key.into()),
            message_id: source.message.message_id,
            spec,
            source: source_blob.reference().clone(),
            resources: resources.reference().clone(),
            required_tools,
        };
        contents.extend([source_blob, resources]);
        Ok((request, contents))
    }

    pub(super) async fn freeze_operation_spec(
        &self,
        execution: &ExecutionIdentity,
        basis: &CapturedRun,
        input: RunInput,
        parent: &Scope,
    ) -> Result<(RunSpec, Vec<ContentBlob>), String> {
        let trigger = match &input {
            RunInput::Continuation { claim, .. } => Trigger::Continuation {
                source: claim.source.execution.run_id,
            },
            RunInput::ContextCompact { .. } => Trigger::ContextCompact,
            _ => return Err("agent_operation_input_required".into()),
        };
        let budget = self
            .capture_budget(&execution.session_id, basis, &trigger, "")
            .await?;
        self.freeze_run_values(
            &execution.session_id,
            execution.turn_id.clone(),
            basis,
            trigger,
            input,
            budget,
            parent,
        )
        .await
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Run freezing binds the source trigger, input, budget and original parent scope"
    )]
    async fn freeze_run_values(
        &self,
        session_id: &str,
        turn_id: String,
        basis: &CapturedRun,
        trigger: Trigger,
        input: RunInput,
        budget: capture_budget::CaptureBudget,
        parent: &Scope,
    ) -> Result<(RunSpec, Vec<ContentBlob>), String> {
        let session = self.mutable_session(session_id).await?;
        let configuration = session.configuration;
        if parent.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("agent_request_cancelled".into());
        }
        if configuration.workspace != basis.workspace || configuration.binding != basis.binding {
            return Err("agent_workspace_binding_changed".into());
        }
        workspace::validate(
            &self.workspace_roots,
            &configuration.workspace,
            &self.managed_worktrees,
        )
        .await?;
        let permission_ceiling = maka_sandbox::Permissions {
            sandbox: self
                .capture_sandbox(&configuration, parent.sandbox_floor())
                .await?,
            approval: if configuration.permissions.request_permissions {
                maka_sandbox::Approval::OnRequest
            } else {
                maka_sandbox::Approval::Never
            },
        };
        let system_prompt = basis.behavior.clone();
        if let Some(prompt) = &system_prompt {
            prompt.validate().map_err(|e| e.to_string())?;
        }
        let catalog = self.selected_tools(
            session_id,
            basis,
            basis.model.as_ref().and_then(|model| model.editing_tools),
        )?;
        let selection = crate::tools::SelectionSnapshot {
            definitions: catalog.definitions().cloned().collect(),
            direct_only: catalog.direct_only_names().into_iter().collect(),
            services: if basis
                .executor
                .as_ref()
                .is_some_and(|executor| executor.selection.executor != "external")
            {
                Vec::new()
            } else {
                self.tool_basis
                    .iter()
                    .map(crate::tools::SelectedTool::declaration)
                    .collect()
            },
            internal_bindings: basis.internal_bindings.as_ref().clone(),
        };
        let mut contents = Vec::new();
        let system = ContentBlob::json(&system_prompt).map_err(|e| e.to_string())?;
        let tools = ContentBlob::json(&selection).map_err(|e| e.to_string())?;
        let input = ContentBlob::json(&input).map_err(|error| error.to_string())?;
        let backend = match (&basis.model, &basis.executor) {
            (Some(model), None) => {
                let descriptor = ContentBlob::json(model).map_err(|e| e.to_string())?;
                let backend = BackendSpec::Model {
                    binding: model.binding.clone(),
                    descriptor: descriptor.reference().clone(),
                };
                contents.push(descriptor);
                backend
            }
            (None, Some(executor)) => {
                let descriptor = ContentBlob::json(executor).map_err(|e| e.to_string())?;
                let backend = BackendSpec::Executor {
                    selection: executor.selection.clone(),
                    descriptor: descriptor.reference().clone(),
                };
                contents.push(descriptor);
                backend
            }
            _ => return Err("agent_backend_not_selected".into()),
        };
        let compaction_prompt = basis
            .compaction_prompt
            .as_ref()
            .map(ContentBlob::json)
            .transpose()
            .map_err(|e| e.to_string())?;
        let spec = RunSpec {
            schema_version: SCHEMA_VERSION,
            owner: self.run_owner(),
            session_id: session_id.into(),
            turn_id,
            origin: RunOrigin::Local,
            trigger,
            workspace: configuration.workspace.path.clone(),
            permission_basis: configuration.permission_basis(),
            permission_ceiling,
            backend,
            collaboration: basis.collaboration_mode,
            language: basis.language,
            tool_discovery: basis.tool_discovery,
            allowed_tools: basis.allowed_tools.clone(),
            mcp_revision: basis.mcp_revision.clone(),
            compaction_prompt: compaction_prompt
                .as_ref()
                .map(|blob| blob.reference().clone()),
            system_prompt: system.reference().clone(),
            tool_selection: tools.reference().clone(),
            input: input.reference().clone(),
            budget: budget.budget,
            budget_basis: budget.basis.as_ref().map(|basis| basis.reference().clone()),
        };
        contents.extend([system, tools, input]);
        contents.extend(compaction_prompt);
        contents.extend(budget.basis);
        Ok((spec, contents))
    }

    pub(crate) fn run_owner(&self) -> RunOwner {
        RunOwner {
            deployment: self.data_source.deployment,
            namespace: self.data_source.namespace.clone(),
        }
    }
}
