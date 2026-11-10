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
        let preference = BackendPreference::Model {
            connection_id: input.model.connection_id,
            model_id: input.model.model_id,
            thinking_level: input.thinking_level,
        };
        let mut basis = self
            .capture_current_run(
                &input.session_id,
                Some(preference),
                operation.fingerprint.clone(),
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
