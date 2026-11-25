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

use super::send::NativeMutation;
use super::*;
use maka_agent_facts::{
    durable::{RunId, UnixMillis},
    input::RunInput,
};
use maka_capabilities::call::Scope;

pub(crate) const TOOL: &str = "CompactContext";

pub(super) fn tool() -> maka_agent_facts::tools::ToolRegistration {
    use maka_agent_facts::tools::*;
    ToolRegistration {
        definition: ToolDefinition {
            name: TOOL.into(), provider: None, freeform: None, output_schema: None,
            description: "Summarize earlier work at a natural break and continue from the checkpoint after the current tool batch settles.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "What this checkpoint should prioritize retaining. Applies only to this compaction."},
                    "resumeModel": {
                        "type": "object",
                        "description": "Choose a connectionId and modelId from ModelList to take over after a successful checkpoint and handle later messages. Omit to keep the current model.",
                        "properties": {"connectionId": {"type":"string","minLength":1}, "modelId":{"type":"string","minLength":1}},
                        "required":["connectionId","modelId"], "additionalProperties":false
                    }
                },
                "additionalProperties": false
            }),
        },
        nesting: ToolNesting::DirectOnly,
        semantics: ToolSemantics::Parallel,
        handler: ToolHandler::Immediate(Arc::new(CompactContext)),
    }
}

struct CompactContext;
impl maka_agent_facts::tools::ToolExecutor for CompactContext {
    fn names(&self) -> Vec<String> {
        vec![TOOL.into()]
    }

    fn invoke(
        &self,
        _: String,
        _: serde_json::Value,
        _: CancellationToken,
    ) -> maka_agent_facts::tools::ToolFuture {
        Box::pin(async { Ok(serde_json::json!({"status":"requested"})) })
    }
}

pub(super) fn model_thinking_level(
    configuration: &ResolvedConfiguration,
) -> Option<maka_agent_facts::execution::ThinkingLevel> {
    match &configuration.backend {
        Some(BackendPreference::Model { thinking_level, .. }) => *thinking_level,
        _ => None,
    }
}

impl Owner {
    pub(super) fn effective_compaction_prompt(
        &self,
        prompt: Option<&str>,
        snapshot: &RuntimePolicySnapshot,
        language: Language,
    ) -> String {
        prompt
            .or(snapshot.policy.compaction_prompt.as_deref())
            .unwrap_or_else(|| maka_agent_facts::context::default_compaction_prompt(language))
            .into()
    }

    pub async fn compaction_prompt(&self, input: SessionRead) -> Result<CompactionPrompt, String> {
        let session = self.session(&input.session_id).await?;
        let snapshot = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|_| "agent_configuration_unavailable")?;
        let language = self.resolve_language(&snapshot);
        Ok(CompactionPrompt {
            revision: session.revision,
            prompt: session.configuration.compaction_prompt.clone(),
            compaction_prompt: self.effective_compaction_prompt(
                session.configuration.compaction_prompt.as_deref(),
                &snapshot,
                language,
            ),
            default_compaction_prompt: self.effective_compaction_prompt(None, &snapshot, language),
        })
    }

    pub async fn set_compaction_prompt(
        self: &Arc<Self>,
        input: SetCompactionPrompt,
        _operation: &maka_plugin_core::operation::RecoveryRef,
    ) -> Result<NativeMutation<MetadataResult>, String> {
        let ordered = Arc::new(self.runs.ordered(&input.session_id).await);
        let rejected = |reason| {
            Ok(NativeMutation::Returned(MetadataResult::Rejected {
                reason,
            }))
        };
        if self.compaction_busy(&input.session_id).await? {
            return rejected(Rejection::Busy);
        }
        if self.runs.state().await.closing {
            return rejected(Rejection::Closed);
        }
        if !self.owns(&input.session_id) {
            return rejected(Rejection::SessionUnavailable);
        }
        let record = self
            .canonical_catalog()?
            .record(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("agent_session_unavailable")?;
        if record.metadata.archived {
            return rejected(Rejection::SessionUnavailable);
        }
        if record.metadata.revision != input.expected_revision {
            return Ok(NativeMutation::Returned(MetadataResult::RevisionConflict {
                expected: input.expected_revision,
                actual: record.metadata.revision,
            }));
        }
        self.prepare_configuration(record, ordered, None, move |configuration| {
            configuration.compaction_prompt = input.prompt;
            Ok(())
        })
        .await
    }

    pub async fn compact(
        self: &Arc<Self>,
        input: Compact,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &Scope,
    ) -> Result<NativeMutation<CompactResult>, String> {
        let ordered = self.runs.session(&input.session_id).await;
        let rejected = |reason| Ok(NativeMutation::Returned(CompactResult::Rejected { reason }));
        if ordered.state().await.closing || self.stop.is_cancelled() {
            return rejected(CompactRejection::Closed);
        }
        let session = self.session(&input.session_id).await?;
        if session.archived {
            return rejected(CompactRejection::Archived);
        }
        if self.compaction_busy(&input.session_id).await?
            || !self
                .durable
                .queue()
                .read(input.session_id.clone())
                .await
                .map_err(|error| error.to_string())?
                .entries
                .iter()
                .all(|entry| matches!(entry.placement, maka_agent_state::queue::Placement::Held))
        {
            return rejected(CompactRejection::Busy);
        }
        if matches!(
            session.configuration.backend,
            Some(BackendPreference::Executor { .. })
        ) {
            return rejected(CompactRejection::BackendUnavailable);
        }
        if workspace::validate(
            &self.workspace_roots,
            &session.configuration.workspace,
            &self.managed_worktrees,
        )
        .await
        .is_err()
        {
            return rejected(CompactRejection::WorkspaceChanged);
        }
        let preference = BackendPreference::model(input.model, input.thinking_level);
        let mut basis = self
            .capture_current_run(
                &input.session_id,
                Some(preference),
                operation.fingerprint.clone(),
                crate::owner::send::PinCapture::Excluded,
                parent,
            )
            .await?;
        basis.tool_discovery = false;
        if let Some(prompt) = input.prompt {
            basis.compaction_prompt = Some(prompt);
        }
        let identity = ExecutionIdentity {
            session_id: input.session_id,
            turn_id: format!("t_{}", self.operation_id(operation)),
            run_id: RunId::new(),
        };
        let (spec, contents) = self
            .freeze_operation_spec(
                &identity,
                &basis,
                RunInput::ContextCompact {
                    request_fingerprint: operation.fingerprint.clone(),
                },
                parent,
            )
            .await?;
        let admission = maka_agent_state::Admission::with_identity(
            identity.run_id,
            spec,
            UnixMillis(now().try_into().map_err(|_| "invalid clock")?),
            contents,
        );
        let execution =
            super::execution::project(&admission.preview().map_err(|error| error.to_string())?);
        Ok(NativeMutation::Commit {
            value: CompactResult::Started { execution },
            change: self.durable.prepare_admission(admission),
        })
    }

    async fn compaction_busy(&self, session: &str) -> Result<bool, String> {
        let Some(run) = self
            .durable
            .latest_run(session.to_owned())
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(false);
        };
        Ok(self
            .session_run(session, run)
            .await?
            .is_some_and(|view| view.terminal.is_none()))
    }
}

impl super::driver::NativeDriver {
    async fn handoff_user_run(
        &self,
        view: &maka_agent_state::fold::RunView,
    ) -> Result<Option<bool>, maka_agent_engine::RunError> {
        use maka_agent_facts::memory::MemoryAdmission;
        match view.spec.memory_admission {
            MemoryAdmission::Disabled | MemoryAdmission::Enabled => Ok(Some(true)),
            MemoryAdmission::Excluded => Ok(Some(false)),
            MemoryAdmission::Legacy => Ok(self
                .access
                .data_writer()
                .map_err(maka_agent_engine::RunError::InvalidInput)?
                .query(maka_agent_state::memory::reads::OriginalAdmission(view.run))
                .await?),
        }
    }

    pub(super) async fn resume_after_checkpoint(
        &self,
        view: &maka_agent_state::fold::RunView,
        baseline: maka_agent_state::ContentBlob,
        target: ModelSelection,
    ) -> Result<(), maka_agent_engine::RunError> {
        use maka_agent_engine::RunError;
        use maka_agent_facts::durable::{BackendSpec, Trigger};
        use maka_agent_state::{Admission, ContentBlob};

        let session = &view.spec.session_id;
        let owner = &self.owner;
        let root = owner.store.owned_root()?;
        let metadata = owner
            .mutable_session(session)
            .await
            .map_err(RunError::InvalidInput)?;
        let thinking = model_thinking_level(&metadata.configuration);
        let source = crate::model::Source::select(
            owner.configuration.clone(),
            owner.catalog.clone(),
            owner.credentials.clone(),
            target.clone(),
            thinking,
            session.clone(),
            owner.revision.clone(),
        )
        .await?;
        let model = ContentBlob::json(&source.accepted)?;
        let input = ContentBlob::json(&RunInput::CheckpointHandoff { source: view.run })?;
        let (mcp, _) = self
            .access
            .current_model_tools(&metadata.configuration.workspace)?;
        let mut selection: crate::tools::SelectionSnapshot = owner
            .run_content(view.run, &view.spec.tool_selection)
            .await?;
        let target_tools = owner.select_catalog_tools(
            &mcp.tools,
            Some(session),
            view.spec.allowed_tools.as_deref(),
            source.accepted.editing_tools,
        );
        // Switch only the editing tools. Other bindings retain their original declarations.
        let edit = |name: &str| owner.editing_tools.iter().any(|(tool, _)| tool == name);
        selection.definitions.retain(|tool| !edit(&tool.name));
        selection.direct_only.retain(|name| !edit(name));
        selection.definitions.extend(
            target_tools
                .definitions()
                .filter(|tool| edit(&tool.name))
                .cloned(),
        );
        selection.direct_only.extend(
            target_tools
                .direct_only_names()
                .into_iter()
                .filter(|name| edit(name)),
        );
        selection.definitions.sort_by(|a, b| a.name.cmp(&b.name));
        let tools = ContentBlob::json(&selection)?;
        let policy = owner
            .configuration
            .runtime_policy()
            .await
            .map_err(|e| RunError::InvalidInput(e.to_string()))?;
        let user_run = self.handoff_user_run(view).await?;
        let (mut admission_kind, memory) = owner
            .admit_memory(
                session,
                &metadata.configuration,
                user_run.unwrap_or(true),
                &policy,
            )
            .await
            .map_err(RunError::InvalidInput)?;
        if user_run.is_none() {
            if memory.is_some() {
                return Err(RunError::InvalidInput("original memory admission unavailable; start a new user Run to load pinned memory".into()));
            }
            admission_kind = maka_agent_facts::memory::MemoryAdmission::Legacy;
        }
        if let Some(memory) = &memory {
            let system: Option<SystemPrompt> = owner
                .run_content(view.run, &view.spec.system_prompt)
                .await?;
            memory
                .check_admitted_window(
                    source.accepted.input_limit,
                    system.as_ref(),
                    owner.tool_catalog.fixed_schema_tokens(
                        &source.accepted,
                        view.spec.tool_discovery,
                        selection.definitions.iter(),
                    ),
                )
                .map_err(RunError::InvalidInput)?;
        }
        let memory = memory.as_deref().map(ContentBlob::json).transpose()?;
        let mut spec = view.spec.clone();
        spec.memory_admission = admission_kind;
        spec.memory_projection = memory.as_ref().map(|blob| blob.reference().clone());
        spec.tool_selection = tools.reference().clone();
        spec.trigger = Trigger::CheckpointHandoff { source: view.run };
        spec.input = input.reference().clone();
        spec.backend = BackendSpec::Model {
            binding: source.accepted.binding,
            descriptor: model.reference().clone(),
        };
        let mut contents = vec![input, model, tools];
        contents.extend(memory);
        let admission = Admission::new(
            spec,
            UnixMillis(
                now()
                    .try_into()
                    .map_err(|_| RunError::Internal("invalid clock".into()))?,
            ),
            contents,
        );
        let statement =
            self.state
                .checkpoint_handoff(self.access.claim(), view.into(), baseline, admission)?;
        let writer = self.access.data_writer().map_err(RunError::InvalidInput)?;
        let _ordered = owner.runs.ordered(session).await;
        if metadata.archived
            || metadata.configuration.permission_basis() != view.spec.permission_basis
        {
            return Err(RunError::InvalidInput(
                "Session workspace or availability changed before model handoff".into(),
            ));
        }
        owner
            .store
            .write_session_metadata_with(
                session,
                metadata.revision,
                move |settings: &mut StoredSessionConfiguration| {
                    settings.backend = Some(BackendPreference::model(target, thinking));
                    Ok(())
                },
                &writer,
                statement,
            )
            .await?;
        root.capability_source_changed();
        Ok(())
    }
}
