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

//! ChatGPT pre-turn compaction: the compactor and continuing model are distinct.
use super::*;
use maka_agent_facts::context::{
    CodexContinuation, CodexPreflight, CodexPreflightStage, CompactedContext,
    RequestContextEvidence,
};

pub(super) struct Plan {
    pub previous: Option<(Source, maka_agent_engine::PreparedModel)>,
    pub evidence: CodexPreflight,
}

impl DriverModel {
    pub(super) async fn switch_checkpoint_id(
        &self,
        view: &RunView,
        baseline: &ContentRef,
    ) -> Result<String, RunError> {
        let cut = self.history.capture().await?;
        let mut before = None;
        loop {
            let page = self.history.previous_page(&cut, before, 64).await?;
            if page.items.is_empty() {
                return Err(unsupported("switch-checkpoint-fact-missing"));
            }
            for item in page.items.iter().rev() {
                if item.recorded.run == view.run
                    && matches!(&item.recorded.fact, Fact::ContextCompacted { baseline: actual } if actual == baseline)
                {
                    return Ok(item.recorded.id.to_string());
                }
            }
            before = page.items.first().map(|item| item.sequence);
        }
    }

    pub(super) fn request_source(&self, frozen: &FrozenInput) -> Result<Arc<Source>, RunError> {
        if frozen.continuing.as_ref().unwrap_or(&frozen.accepted) != &self.source.accepted {
            return Err(unsupported("frozen-model-target-changed"));
        }
        if frozen.continuing.is_some() {
            if frozen.operation != ModelOperation::CodexCompaction {
                return Err(unsupported("switch-request-is-not-native-compaction"));
            }
            Ok(Arc::new(
                self.source.for_compaction(frozen.accepted.clone())?,
            ))
        } else {
            Ok(self.source.clone())
        }
    }

    pub(super) async fn switch_plan(
        &self,
        view: &RunView,
        mode: &Preparation,
        target: &maka_agent_engine::PreparedModel,
    ) -> Result<Option<Plan>, RunError> {
        match mode {
            Preparation::Initial
                if matches!(view.spec.trigger, Trigger::CheckpointHandoff { .. }) =>
            {
                // The source already produced a portable text checkpoint for this transition.
                return Ok(None);
            }
            Preparation::Initial => {
                let cut = self.history.capture_before(view.run).await?;
                return self.initial_switch_plan(&cut, target).await;
            }
            Preparation::AfterCompaction { .. } | Preparation::CodexFallback { .. } => {}
            _ => return Ok(None),
        }
        if target.provider.capabilities.native_compaction != Some(true) {
            return Ok(None);
        }
        let Some(provenance) = target.context.as_ref().and_then(|c| c.codex.clone()) else {
            return Ok(None);
        };
        let destination = CodexContinuation {
            model: target.provider.model.clone(),
            model_context_window: target.context.as_ref().and_then(|c| c.model_context_window),
            provenance,
        };
        let reader = self.history_reader(view.run).await?;
        if let Preparation::CodexFallback { attempt } = mode {
            let original = self.state.model_attempt(view.run, *attempt).await?;
            let request = reader.request(view.run, original.step).await?;
            let evidence: RequestContextEvidence =
                reader.decode(view.run, &request.provenance).await?;
            if !evidence
                .codex_preflight
                .is_some_and(|p| p.stage == CodexPreflightStage::Previous)
            {
                return Err(unsupported("switch-fallback-source"));
            }
            return Ok(Some(Plan {
                previous: None,
                evidence: CodexPreflight {
                    stage: CodexPreflightStage::Fallback,
                    target: destination,
                },
            }));
        }
        if let Preparation::AfterCompaction { .. } = mode {
            let baseline: CompactedContext = self
                .decode(
                    view.run,
                    view.baseline
                        .as_ref()
                        .ok_or_else(|| unsupported("switch-baseline"))?,
                )
                .await?;
            let request = reader
                .request(view.run, baseline.checkpoint.summary_step_id)
                .await?;
            let evidence: RequestContextEvidence =
                reader.decode(view.run, &request.provenance).await?;
            let Some(preflight) = evidence.codex_preflight else {
                return Ok(None);
            };
            if preflight.stage != CodexPreflightStage::Current
                && target.context.as_ref().and_then(|c| c.declared_window)
                    .is_some_and(|limit| matches!(baseline.checkpoint.summary, maka_agent_facts::context::CheckpointContent::CodexNative { estimated_tokens, .. } if estimated_tokens >= limit))
            {
                return Ok(Some(Plan { previous: None,
                    evidence: CodexPreflight { stage: CodexPreflightStage::Current, target: destination } }));
            }
            return Ok(None);
        }
        Ok(None)
    }

    pub(super) async fn initial_switch_plan(
        &self,
        cut: &maka_agent_facts::history_snapshot::HistoryCut,
        target: &maka_agent_engine::PreparedModel,
    ) -> Result<Option<Plan>, RunError> {
        if target.provider.capabilities.native_compaction != Some(true) {
            return Ok(None);
        }
        let Some(provenance) = target.context.as_ref().and_then(|c| c.codex.clone()) else {
            return Ok(None);
        };
        let destination = CodexContinuation {
            model: target.provider.model.clone(),
            model_context_window: target.context.as_ref().and_then(|c| c.model_context_window),
            provenance,
        };
        let Some(previous) = self.history.current_model_context(cut, None).await? else {
            return Ok(None);
        };
        let reader = match previous.source {
            maka_agent_state::session_history::source_tree::HistoryDataSource::Live {
                cut, ..
            } => HistorySource::live(&self.state, &cut),
            maka_agent_state::session_history::source_tree::HistoryDataSource::Snapshot(
                snapshot,
            ) => HistorySource::Snapshot(snapshot, previous.path),
        };
        let run = previous.run;
        let request = reader.request(run, previous.step).await?;
        let continuation = previous.continuation;
        let evidence: RequestContextEvidence = reader.decode(run, &request.provenance).await?;
        let Some(old) = continuation
            .as_ref()
            .map(|target| &target.provenance)
            .or_else(|| {
                evidence
                    .model_context
                    .as_ref()
                    .and_then(|c| c.codex.as_ref())
            })
        else {
            return Ok(None);
        };
        let previous_model = continuation
            .as_ref()
            .map_or(request.accounting.model_id.as_str(), |target| {
                target.model.as_str()
            });
        let changed = old
            .compatibility
            .as_ref()
            .zip(destination.provenance.compatibility.as_ref())
            .is_some_and(|(a, b)| a.comp_hash != b.comp_hash);
        let previous_window = match &continuation {
            Some(target) => target.model_context_window,
            None => evidence
                .model_context
                .as_ref()
                .and_then(|c| c.model_context_window),
        };
        let tokens = previous.tokens.unwrap_or(evidence.estimated_input_tokens);
        let limit_reached = target
            .context
            .as_ref()
            .and_then(|c| c.declared_window)
            .is_some_and(|limit| tokens >= limit);
        let downshift = previous_model != destination.model
            && previous_window
                .zip(target.context.as_ref().and_then(|c| c.model_context_window))
                .is_some_and(|(a, b)| a > b)
            && limit_reached;
        if !changed && !downshift {
            if limit_reached {
                return Ok(Some(Plan {
                    previous: None,
                    evidence: CodexPreflight {
                        stage: CodexPreflightStage::Current,
                        target: destination,
                    },
                }));
            }
            return Ok(None);
        }
        let frozen = self.frozen_input(&reader, run, &request).await?;
        let accepted = if continuation.is_some() {
            frozen.continuing.unwrap_or(frozen.accepted)
        } else {
            frozen.accepted
        };
        let source = self.source.for_compaction(accepted)?;
        let model = match source.capture().await {
            Ok(model) => model,
            Err(RunError::ModelUnavailable)
                if source.accepted.binding.model != destination.model =>
            {
                tracing::warn!(model = %source.accepted.binding.model, "previous ChatGPT model unavailable; compacting with target");
                return Ok(Some(Plan {
                    previous: None,
                    evidence: CodexPreflight {
                        stage: CodexPreflightStage::Fallback,
                        target: destination,
                    },
                }));
            }
            Err(error) => return Err(error),
        };
        Ok(Some(Plan {
            previous: Some((source, model)),
            evidence: CodexPreflight {
                stage: CodexPreflightStage::Previous,
                target: destination,
            },
        }))
    }
}

pub(super) fn fallback_recovery(
    evidence: &RequestContextEvidence,
    request: &RequestSpec,
    failure: &maka_model::ModelError,
    attempt: &maka_agent_state::fold::Attempt,
) -> Option<RecoveryEvidence> {
    (!attempt.semantic
        && !attempt.has_tools
        && attempt
            .closed
            .as_ref()
            .is_some_and(|closed| closed.outcome == maka_agent_facts::accounting::Outcome::Error)
        && request.accounting.purpose == ModelPurpose::Summary
        && evidence.model_context.as_ref().is_some_and(|context| {
            context.operation == ModelOperation::CodexCompaction && context.codex.is_some()
        })
        && evidence
            .codex_preflight
            .as_ref()
            .is_some_and(|plan| plan.retry_with_target(&request.accounting.model_id, failure)))
    .then(|| RecoveryEvidence {
        recovery: AttemptRecovery::CodexCompactionFallback,
        contents: vec![],
    })
}
