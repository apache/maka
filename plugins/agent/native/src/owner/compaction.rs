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
use maka_agent_engine::{RunError, RunInput, RunWork};
use maka_agent_facts::input::InvocationInput;

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
        &self,
        input: SetCompactionPrompt,
    ) -> Result<MetadataResult, String> {
        let runs = self.runs.lock().await;
        if runs.closing {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::Closed,
            });
        }
        if !self.owns(&input.session_id) {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        let session = self.session(&input.session_id).await?;
        if session.archived {
            return Ok(MetadataResult::Rejected {
                reason: Rejection::SessionUnavailable,
            });
        }
        use maka_event_log::sessions::SessionMutation;
        match self
            .store
            .update_session_metadata(
                &input.session_id,
                input.expected_revision,
                move |configuration: &mut StoredSessionConfiguration| {
                    configuration.compaction_prompt = input.prompt;
                    Ok(())
                },
            )
            .await
            .map_err(|error| format!("agent_compaction_prompt_commit_unknown: {error}"))?
        {
            SessionMutation::Committed(session) => Ok(MetadataResult::Committed {
                session: Box::new(crate::service::summary(self, resolve_session(*session)?)),
            }),
            SessionMutation::RevisionConflict { expected, actual } => {
                Ok(MetadataResult::RevisionConflict { expected, actual })
            }
        }
    }

    pub async fn compact(
        self: &Arc<Self>,
        input: Compact,
        operation: &maka_plugin_core::operation::RecoveryRef,
    ) -> Result<CompactResult, String> {
        let mut runs = self.runs.lock().await;
        let session = self.session(&input.session_id).await?;
        let identity = self.operation_id(operation);
        let invocation = Invocation {
            session_id: input.session_id.clone(),
            turn_id: format!("t_{identity}"),
            run_id: format!("r_{identity}"),
            invocation_id: format!("i_{identity}"),
        };
        // The canonical opening is the receipt, including after restart.
        if let Some(boundary) = self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .invocation_boundary(&input.session_id, &invocation.invocation_id)
            .await
            .map_err(|_| "agent_execution_unavailable")?
        {
            if boundary.0.invocation != invocation
                || !matches!(&boundary.0.input,
                InvocationInput::ContextCompact { request_fingerprint } if request_fingerprint == &operation.fingerprint)
            {
                return Err("agent_compact_conflict".into());
            }
            return Ok(CompactResult::Started {
                execution: execution::project(boundary),
            });
        }
        let rejected = |reason| Ok(CompactResult::Rejected { reason });
        if runs.closing || self.stop.is_cancelled() || runs.quarantined.contains(&input.session_id)
        {
            return rejected(CompactRejection::Closed);
        }
        if session.archived {
            return rejected(CompactRejection::Archived);
        }
        if runs.busy(&input.session_id)
            || self.has_parked_invocation(&input.session_id).await?
            || !self
                .store
                .session(&input.session_id)
                .await
                .map_err(|error| error.to_string())?
                .message_queue(&input.session_id)
                .await
                .map_err(|_| "agent_queue_unavailable")?
                .entries
                .is_empty()
        {
            return rejected(CompactRejection::Busy);
        }
        if matches!(
            session.configuration.backend,
            Some(BackendPreference::Executor { .. })
        ) {
            return rejected(CompactRejection::BackendUnavailable);
        }
        let workspace = &session.configuration.workspace;
        if workspace::validate(&self.workspace_roots, workspace, &self.managed_worktrees)
            .await
            .is_err()
        {
            return rejected(CompactRejection::WorkspaceChanged);
        }
        let (source, prepared) = crate::model::Source::select(
            self.configuration.clone(),
            self.catalog.clone(),
            self.credentials.clone(),
            input.model,
            input.thinking_level,
            input.session_id.clone(),
            self.revision.clone(),
        )
        .await
        .map_err(public_error)?;
        let snapshot = self
            .configuration
            .runtime_policy()
            .await
            .map_err(|_| "agent_configuration_unavailable")?;
        let language = self.resolve_language(&snapshot);
        let prompt = match input.prompt {
            Some(prompt) => prompt,
            None => self.effective_compaction_prompt(
                session.configuration.compaction_prompt.as_deref(),
                &snapshot,
                language,
            ),
        };
        let permissions = &session.configuration.permissions;
        let configuration = InvocationConfiguration {
            language,
            compaction_prompt: Some(prompt.clone()),
            editing_tools: source.accepted.editing_tools,
            tool_discovery: false,
            cwd: workspace.path.clone(),
            workspace_identity: Some(workspace.identity.clone()),
            workspace_origin: WorkspaceOrigin::Selected,
            sandbox_mode: match permissions.access {
                WorkspaceAccess::ReadOnly => SandboxMode::ReadOnly,
                WorkspaceAccess::WorkspaceWrite => SandboxMode::WorkspaceWrite,
                WorkspaceAccess::DangerFullAccess => SandboxMode::DangerFullAccess,
            },
            approval_policy: if permissions.request_permissions {
                ApprovalPolicy::OnRequest
            } else {
                ApprovalPolicy::Never
            },
            boundary_revision: session.configuration.boundary_revision,
            workspace_binding: Some(session.configuration.binding),
            collaboration_mode: session.configuration.collaboration_mode,
            orchestration_mode: BehaviorId::default(),
            tool_mode: source.accepted.tool_mode,
            code_language: source.accepted.code_language,
            model: Some(source.accepted.binding.clone()),
            thinking_level: source.accepted.thinking_level,
            system_prompt: None,
            tool_composition: None,
        };
        let basis = MessageBasis {
            mcp_revision: None,
            mcp_catalog: None,
            language,
            compaction_prompt: Some(prompt),
            graph: None,
            collaboration_mode: session.configuration.collaboration_mode,
            background_kind: BackgroundKind::Schedule,
            tool_discovery: false,
            allowed_tools: session.configuration.tools.clone(),
            background: None,
            internal_tools: Arc::default(),
            internal_bindings: Arc::default(),
            behavior: None,
            model: Some(source.accepted.clone()),
            executor: None,
            workspace: workspace.clone(),
            binding: session.configuration.binding,
            fingerprint: operation.fingerprint.clone(),
            tools: Arc::default(),
        };
        let run = RunInput {
            native_activation_basis: None,
            invocation: invocation.clone(),
            model_source: Some(Arc::new(source)),
            model_revision: Some(prepared.revision),
            provider_id: prepared.provider_id,
            context: prepared.context,
            provider: prepared.provider,
            provider_options: prepared.options,
            main_output_limit: prepared.main_output_limit,
            supports_vision: prepared.supports_vision,
            request_fingerprint: Some(operation.fingerprint.clone()),
            configuration,
            work: RunWork::ContextCompact,
        };
        let running = match self
            .engine
            .start(
                self.store
                    .session(&run.invocation.session_id)
                    .await
                    .map_err(|error| error.to_string())?,
                run,
                self.stop.child_token(),
            )
            .await
        {
            Ok(running) => running,
            Err(RunError::Busy) => return rejected(CompactRejection::Busy),
            Err(error) => {
                if error.is_cleanup_unconfirmed() {
                    runs.quarantined.insert(input.session_id.clone());
                    runs.closing = true;
                    self.stop.cancel();
                }
                return Err(public_error(error));
            }
        };
        runs.controls.insert(
            input.session_id.clone(),
            Control {
                preview: running.preview(),
                compacting: true,
                invocation: invocation.clone(),
                basis,
                cancellation: running.cancellation(),
                failure: None,
            },
        );
        self.workers.spawn(self.clone().drive(running));
        let boundary = self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .invocation_boundary(&input.session_id, &invocation.invocation_id)
            .await
            .map_err(|_| "agent_execution_unavailable")?
            .ok_or("agent_execution_unavailable")?;
        Ok(CompactResult::Started {
            execution: execution::project(boundary),
        })
    }
}
