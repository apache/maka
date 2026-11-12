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

use crate::{
    Engine, RunError,
    reconcile::{CompactionLevel, ModelLevel},
};
use maka_agent_facts::{
    accounting::Outcome,
    context::{
        CheckpointContent, CheckpointMode, CompactedContext, ContextCheckpoint,
        ModelClosureProtocol, ModelOperation, ModelPurpose, NativeCheckpoint,
        RequestContextEvidence, SummaryOrigin, SummaryResult,
    },
    durable::*,
    history_snapshot::RequestSource,
    input::RunInput,
    model::ModelFinishReason,
};
use maka_agent_state::{ContentBlob, fold::RunView};
use serde::{Deserialize, de::DeserializeOwned};

#[derive(Deserialize)]
struct FrozenRouteEvidence {
    #[serde(rename = "routeIdentity")]
    route_identity: String,
}

fn compaction_timing(evidence: &RequestContextEvidence) -> (bool, bool) {
    let threshold = evidence
        .model_context
        .as_ref()
        .filter(|context| context.operation == ModelOperation::Inference)
        .and_then(|context| context.declared_window);
    match threshold {
        Some(threshold) => (
            u128::from(evidence.estimated_input_tokens) * 100 >= u128::from(threshold) * 85,
            evidence.estimated_input_tokens >= threshold,
        ),
        None => (false, false),
    }
}

impl Engine {
    pub(super) async fn model_level(
        &self,
        view: &RunView,
        rejected: &[SummaryOrigin],
        overflow: bool,
    ) -> Result<ModelLevel, RunError> {
        let input = decode(self, view.run, &view.spec.input, "run-input-schema").await?;
        let baseline: Option<CompactedContext> = match &view.baseline {
            Some(reference) => {
                Some(decode(self, view.run, reference, "compacted-context-schema").await?)
            }
            None => None,
        };
        let request = match view.current_step {
            Some(step) => Some(self.store.request(view.run, step).await?),
            None => None,
        };
        let mut compaction = CompactionLevel::None;
        if let Some(request) = &request {
            if request.accounting.purpose == ModelPurpose::Summary {
                let main = if baseline
                    .as_ref()
                    .is_some_and(|baseline| baseline.checkpoint.summary_step_id == request.step)
                {
                    None
                } else {
                    self.store
                        .compaction_fallback(view.run, request.step)
                        .await?
                };
                let evidence: RequestContextEvidence = decode(
                    self,
                    view.run,
                    &request.provenance,
                    "request-provenance-schema",
                )
                .await?;
                let native = evidence
                    .model_context
                    .as_ref()
                    .is_some_and(|context| context.operation == ModelOperation::CodexCompaction);
                let adopt = match main {
                    Some(step) => {
                        let original = self.store.request(view.run, step).await?;
                        let evidence: RequestContextEvidence = decode(
                            self,
                            view.run,
                            &original.provenance,
                            "request-provenance-schema",
                        )
                        .await?;
                        compaction_timing(&evidence).1
                    }
                    None => true,
                };
                compaction = CompactionLevel::Summary {
                    main,
                    adopt,
                    native,
                };
            } else {
                let provenance: RequestContextEvidence = decode(
                    self,
                    view.run,
                    &request.provenance,
                    "request-provenance-schema",
                )
                .await?;
                let (prepare, adopt) = compaction_timing(&provenance);
                let mut has_proactive_summary = false;
                let mut can_prepare = true;
                let mut proactive_baseline = baseline
                    .as_ref()
                    .is_some_and(|baseline| baseline.summary_origin.is_some());
                if let Some((summary, original)) = view.proactive_summary_attempt() {
                    let origin = SummaryOrigin {
                        run: view.run,
                        attempt: summary,
                    };
                    let summary_request = self.store.request(view.run, original.step).await?;
                    let summary_provenance: RequestContextEvidence = decode(
                        self,
                        view.run,
                        &summary_request.provenance,
                        "request-provenance-schema",
                    )
                    .await?;
                    has_proactive_summary = provenance.previous_checkpoint_id
                        == summary_provenance.previous_checkpoint_id;
                    can_prepare = (original.closed.is_some() || original.interrupted.is_some())
                        && (original.admission.is_none()
                            || original.cleanup
                                == maka_plugin_core::operation::OperationCleanup::Confirmed);
                    let already_adopted = baseline.as_ref().is_some_and(|baseline| {
                        baseline.checkpoint.summary_step_id == original.step
                    });
                    proactive_baseline |= already_adopted;
                    if has_proactive_summary {
                        if original.closed.is_none() && original.interrupted.is_none() {
                            compaction = CompactionLevel::Pending {
                                attempt: summary,
                                adopt,
                            };
                        } else if !rejected.contains(&origin)
                            && usable_summary(original, &summary_provenance)?
                        {
                            compaction = if already_adopted {
                                CompactionLevel::Adopted { summary }
                            } else if original.cleanup
                                != maka_plugin_core::operation::OperationCleanup::Confirmed
                            {
                                CompactionLevel::Pending {
                                    attempt: summary,
                                    adopt,
                                }
                            } else {
                                CompactionLevel::Candidate { origin, adopt }
                            };
                        }
                    }
                }
                if compaction == CompactionLevel::None && !has_proactive_summary {
                    let adopted_origin = baseline
                        .as_ref()
                        .and_then(|baseline| baseline.summary_origin);
                    let candidate = match adopted_origin {
                        Some(origin) => Some(origin),
                        None if prepare || overflow => {
                            self.store.previous_proactive_summary(view).await?
                        }
                        None => None,
                    };
                    if let Some(origin) = candidate.filter(|origin| !rejected.contains(origin)) {
                        let original = self.store.model_attempt(origin.run, origin.attempt).await?;
                        let summary_request = self.store.request(origin.run, original.step).await?;
                        let previous: RequestContextEvidence = decode(
                            self,
                            origin.run,
                            &summary_request.provenance,
                            "request-provenance-schema",
                        )
                        .await?;
                        if previous.previous_checkpoint_id == provenance.previous_checkpoint_id
                            && usable_summary(&original, &previous)?
                        {
                            compaction = if adopted_origin.is_some() {
                                CompactionLevel::Adopted {
                                    summary: origin.attempt,
                                }
                            } else {
                                CompactionLevel::Candidate { origin, adopt }
                            };
                        }
                    }
                }
                if compaction == CompactionLevel::None
                    && let Some(summary) = request.compaction_recovery
                    && !rejected.contains(&SummaryOrigin {
                        run: view.run,
                        attempt: summary,
                    })
                {
                    let original = self.store.model_attempt(view.run, summary).await?;
                    let summary_request = self.store.request(view.run, original.step).await?;
                    if summary_request.accounting.purpose == ModelPurpose::Summary {
                        let summary_provenance: RequestContextEvidence = decode(
                            self,
                            view.run,
                            &summary_request.provenance,
                            "request-provenance-schema",
                        )
                        .await?;
                        if usable_summary(&original, &summary_provenance)? {
                            if baseline.as_ref().is_some_and(|baseline| {
                                baseline.checkpoint.summary_step_id == original.step
                            }) {
                                if provenance.previous_checkpoint_id
                                    == summary_provenance.previous_checkpoint_id
                                {
                                    compaction = CompactionLevel::Adopted { summary };
                                }
                            } else {
                                compaction = CompactionLevel::Candidate {
                                    origin: SummaryOrigin {
                                        run: view.run,
                                        attempt: summary,
                                    },
                                    adopt,
                                };
                            }
                        }
                    }
                }
                if compaction == CompactionLevel::None
                    && (!proactive_baseline
                        || (!prepare && !overflow)
                        || self.progress_since_checkpoint(view, &provenance).await?)
                    && (request.compaction_recovery.is_none()
                        || self
                            .store
                            .compaction_progress(view.run, request.step)
                            .await?
                            .is_some())
                {
                    compaction = CompactionLevel::Fresh {
                        prepare: prepare && can_prepare && !has_proactive_summary,
                        adopt,
                    };
                }
            }
        }
        Ok(ModelLevel {
            input,
            request,
            baseline,
            compaction,
            failure: None,
            fallback_available: false,
        })
    }

    async fn progress_since_checkpoint(
        &self,
        view: &RunView,
        provenance: &RequestContextEvidence,
    ) -> Result<bool, RunError> {
        let Some(attempt) = view
            .current_attempt
            .and_then(|id| view.attempts.get(&id))
            .filter(|attempt| {
                attempt.closed.as_ref().is_some_and(|closed| {
                    closed.outcome == Outcome::Success && closed.diagnostic.is_none()
                })
            })
        else {
            return Ok(false);
        };
        let request = self.store.request(view.run, attempt.step).await?;
        let previous: RequestContextEvidence = decode(
            self,
            view.run,
            &request.provenance,
            "request-provenance-schema",
        )
        .await?;
        Ok(request.accounting.purpose == ModelPurpose::Main
            && previous.previous_checkpoint_id == provenance.previous_checkpoint_id)
    }

    pub(super) async fn refresh_model_failure(
        &self,
        view: &RunView,
        level: &mut ModelLevel,
    ) -> Result<(), RunError> {
        let failure = if let Some(attempt) = view
            .current_attempt
            .and_then(|id| view.attempts.get(&id))
            .filter(|attempt| {
                level
                    .request
                    .as_ref()
                    .is_some_and(|request| request.step == attempt.step)
            }) {
            if let Some(reference) = &attempt.source_failure {
                Some(
                    decode::<maka_agent_facts::context::ModelFailureProtocol>(
                        self,
                        view.run,
                        reference,
                        "model-source-failure-schema",
                    )
                    .await?,
                )
            } else if let Some(closed) = attempt
                .closed
                .as_ref()
                .filter(|closed| closed.outcome == Outcome::Error)
            {
                if closed
                    .protocol
                    .get("failure")
                    .is_some_and(|failure| !failure.is_null())
                {
                    Some(
                        serde_json::from_value::<maka_agent_facts::context::ModelFailureProtocol>(
                            closed.protocol.clone(),
                        )
                        .map_err(|error| unsupported(format!("model-failure-schema: {error}")))?,
                    )
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        level.fallback_available = false;
        if let (Some(transport), Some(request)) = (
            failure
                .as_ref()
                .and_then(|failure| failure.transport.as_ref()),
            level.request.as_ref(),
        ) && transport.fallback
            == maka_agent_facts::model::retry_transport::FallbackAvailability::WarmIdlePrimary
            && transport.adapter.kind == maka_agent_facts::composition::SourceKind::ModelAdapter
            && request
                .composition
                .sources
                .iter()
                .any(|source| source == &transport.adapter)
        {
            let provenance: FrozenRouteEvidence = decode(
                self,
                view.run,
                &request.provenance,
                "model-route-evidence-schema",
            )
            .await?;
            level.fallback_available = provenance.route_identity == transport.route_identity;
        }
        level.failure = failure;
        Ok(())
    }

    pub(super) async fn checkpoint_for_next_run(
        &self,
        view: &RunView,
    ) -> Result<Option<ContentBlob>, RunError> {
        if view.cancelled_by_risk
            || !view.compaction_frontier_is_closed()
            || !matches!(view.spec.backend, BackendSpec::Model { .. })
        {
            return Ok(None);
        }
        let Some(step) = view.current_step else {
            return Ok(None);
        };
        let Some(attempt) = self
            .store
            .ready_summary(view.run, step, view.current_attempt)
            .await?
        else {
            return Ok(None);
        };
        self.compaction_checkpoint(
            view,
            SummaryOrigin {
                run: view.run,
                attempt,
            },
        )
        .await?
        .as_ref()
        .map(ContentBlob::json)
        .transpose()
        .map_err(Into::into)
    }

    pub(super) async fn compaction_checkpoint(
        &self,
        view: &RunView,
        origin: SummaryOrigin,
    ) -> Result<Option<CompactedContext>, RunError> {
        let original = self.store.model_attempt(origin.run, origin.attempt).await?;
        if let Some(reference) = &view.baseline {
            let baseline: CompactedContext =
                decode(self, view.run, reference, "compacted-context-schema").await?;
            if baseline.checkpoint.summary_step_id == original.step {
                return Ok(None);
            }
        }
        let request = self.store.request(origin.run, original.step).await?;
        if request.accounting.purpose != ModelPurpose::Summary {
            return Err(unsupported("compaction-requires-summary-purpose"));
        }
        let closed = original
            .closed
            .as_ref()
            .ok_or_else(|| unsupported("summary-upstream-terminal-missing"))?;
        if closed.outcome != Outcome::Success {
            return Err(unsupported(format!(
                "summary-upstream-outcome-{:?}",
                closed.outcome
            )));
        }
        if closed.diagnostic.is_some() {
            return Err(unsupported("summary-upstream-diagnostic-present"));
        }
        let provenance: RequestContextEvidence = decode(
            self,
            origin.run,
            &request.provenance,
            "request-provenance-schema",
        )
        .await?;
        let protocol = ModelClosureProtocol::deserialize(&closed.protocol)
            .map_err(|error| unsupported(format!("summary-terminal-protocol: {error}")))?;
        match &protocol.summary {
            Some(SummaryResult::RejectedToolContent) => {
                return Err(RunError::CompactionFailed(
                    "summary_contains_tool_content".into(),
                ));
            }
            Some(SummaryResult::Incomplete) => {
                return Err(RunError::CompactionFailed(
                    "summary_has_invalid_finish_reason".into(),
                ));
            }
            Some(SummaryResult::ProviderEffectsUnknown { .. }) => {
                return Err(unsupported("summary-provider-effects-unknown"));
            }
            _ => {}
        }
        let native_operation = provenance
            .model_context
            .as_ref()
            .is_some_and(|context| context.operation == ModelOperation::CodexCompaction);
        let (summary, native) = if native_operation {
            if protocol.finish_reason != ModelFinishReason::Stop {
                return Err(RunError::CompactionFailed(
                    "summary_has_invalid_finish_reason".into(),
                ));
            }
            let item = protocol.compaction.ok_or_else(|| {
                RunError::CompactionFailed("native-compaction-material-missing".into())
            })?;
            let producer = provenance
                .model_context
                .as_ref()
                .and_then(|context| context.codex.as_ref())
                .ok_or_else(|| unsupported("native-compaction-producer-provenance-missing"))?
                .clone();
            let estimated_tokens = closed
                .usage
                .output_tokens
                .ok_or_else(|| unsupported("native-compaction-output-usage-missing"))?;
            (
                CheckpointContent::native(&item, estimated_tokens),
                Some(NativeCheckpoint { item, producer }),
            )
        } else {
            if protocol.compaction.is_some() {
                return Err(unsupported(
                    "native-compaction-operation-provenance-missing",
                ));
            }
            if protocol.finish_reason != ModelFinishReason::Stop {
                return Err(RunError::CompactionFailed(
                    "summary_has_invalid_finish_reason".into(),
                ));
            }
            let Some(SummaryResult::Text { summary: text }) = protocol.summary else {
                return Err(unsupported("summary-terminal-material-missing"));
            };
            if text.text.trim().is_empty() {
                return Err(RunError::CompactionFailed("summary_text_empty".into()));
            }
            (CheckpointContent::text(text), None)
        };
        let source: RequestSource = decode(
            self,
            origin.run,
            &request.source_capture,
            "request-source-schema",
        )
        .await?;
        let input: RunInput = decode(self, view.run, &view.spec.input, "run-input-schema").await?;
        let mode = if matches!(input, RunInput::ContextCompact { .. }) {
            CheckpointMode::Standalone
        } else if source.current_revision == 0 {
            CheckpointMode::PreTurn
        } else {
            let history = self
                .store
                .session_history(view.spec.owner.clone(), view.spec.session_id.clone());
            match history
                .previous_page(&source.current, None, 1)
                .await?
                .items
                .last()
            {
                Some(anchor) => CheckpointMode::MidTurn {
                    anchor_event_id: anchor.recorded.id.to_string(),
                },
                None => CheckpointMode::PreTurn,
            }
        };
        let compacted = CompactedContext {
            summary_origin: (origin.run != view.run).then_some(origin),
            source_capture: request.source_capture,
            checkpoint: ContextCheckpoint {
                mode,
                covered_through: source.current.through_sequence,
                source_digest: request.source_digest,
                previous_checkpoint_id: provenance.previous_checkpoint_id,
                summary,
                summary_step_id: original.step,
            },
            native,
        };
        compacted.validate().map_err(unsupported)?;
        Ok(Some(compacted))
    }
}

fn usable_summary(
    attempt: &maka_agent_state::fold::Attempt,
    provenance: &RequestContextEvidence,
) -> Result<bool, RunError> {
    let Some(closed) = attempt
        .closed
        .as_ref()
        .filter(|closed| closed.outcome == Outcome::Success && closed.diagnostic.is_none())
    else {
        return Ok(false);
    };
    let protocol = ModelClosureProtocol::deserialize(&closed.protocol)
        .map_err(|error| unsupported(format!("summary-terminal-protocol: {error}")))?;
    let native = provenance
        .model_context
        .as_ref()
        .is_some_and(|context| context.operation == ModelOperation::CodexCompaction);
    Ok(protocol.finish_reason == ModelFinishReason::Stop
        && if native {
            protocol.compaction.is_some()
        } else {
            matches!(protocol.summary, Some(SummaryResult::Text { summary }) if !summary.text.trim().is_empty())
        })
}

async fn decode<T: DeserializeOwned>(
    engine: &Engine,
    run: RunId,
    reference: &ContentRef,
    protocol: &str,
) -> Result<T, RunError> {
    let bytes = engine.store.content(run, reference.clone()).await?;
    serde_json::from_slice(&bytes).map_err(|error| unsupported(format!("{protocol}: {error}")))
}

fn unsupported(reason: impl Into<String>) -> RunError {
    RunError::from(BlockerKind::UnsupportedProtocol {
        protocol: reason.into(),
        version: 1,
    })
}
