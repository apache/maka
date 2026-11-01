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

use crate::{RunContext, RunError, RunInput, RunWork, compact, prune, steps};
use maka_agent_facts::event::CommitError;
use maka_agent_facts::event::EventSink;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::InvocationInput;
use maka_event_log::StoreError;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(super) struct ModelWork {
    pub tools: maka_tools::ToolCatalog,
    pub restored: Option<(
        maka_agent_facts::handoff::HandoffTools,
        maka_agent_facts::handoff::CompactionBudget,
    )>,
}

pub async fn run(
    inner: Arc<RunContext>,
    input: RunInput,
    cancellation_owner: tokio_util::sync::CancellationToken,
    admitted: tokio::sync::oneshot::Sender<()>,
    handoff: Option<crate::HandoffGate>,
    prepared_claim: Option<crate::continuation::PreparedClaim>,
    effects: Arc<maka_event_log::root_store::InvocationEffects>,
) -> Result<crate::ActivationExit, RunError> {
    let cancellation = cancellation_owner.clone();
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    let message = matches!(&input.work, RunWork::Message { .. });
    let prior_unknown = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(RunError::Cancelled),
        result = async {
            if message {
                inner
                    .log
                    .check_manual_message_history(&input.invocation.session_id)
                    .await
            } else {
                inner
                    .log
                    .prepare_prune_candidates(&input.invocation.session_id, None, 0, 0, None)
                    .await
                    .map(|_| false)
            }
        } => result,
    };
    let prior_unknown = match prior_unknown {
        Ok(value) => value,
        Err(StoreError::InvalidTransition(reason)) => {
            return Err(RunError::ReconciliationRequired(reason));
        }
        Err(StoreError::HistoryUnsettled) => {
            return Err(RunError::ReconciliationRequired(
                "Session contains unsealed or unresolved prior execution".into(),
            ));
        }
        Err(StoreError::HistoryProviderEffectUnresolved) => {
            return Err(RunError::ReconciliationRequired(
                "Session contains an unresolved prior provider tool effect".into(),
            ));
        }
        Err(error) => return Err(error.into()),
    };
    let claim = match (prepared_claim, &input.work) {
        (Some(prepared), _) => {
            // The Engine owns Session admission now. Another turn may have
            // changed discovery after preflight, but no stale proof may commit.
            // Handoff restores its explicit checkpoint instead of live names.
            if matches!(input.work, RunWork::Continuation { .. })
                && prepared.loaded_basis
                    != inner.shared.loaded_snapshot(&input.invocation.session_id)?
            {
                return Err(RunError::ContinuationChanged);
            }
            Some(prepared.claim)
        }
        (
            None,
            RunWork::Continuation { source, tools, .. } | RunWork::Handoff { source, tools, .. },
        ) => Some(
            Box::pin(crate::continuation::prepare(
                &inner,
                &input,
                source,
                tools,
                &cancellation,
            ))
            .await?
            .claim,
        ),
        _ => None,
    };
    let continuation_base = match &input.work {
        RunWork::Handoff { pause, .. } => pause.execution.replay_base,
        _ => claim.as_ref().map(|claim| claim.base.high_water),
    };
    let (mut input, work) = input.into_context();
    let (opening, model_work) = match work {
        RunWork::Handoff { pause, tools, .. } => {
            let work = ModelWork {
                tools,
                restored: Some((pause.execution.tools.clone(), pause.execution.compaction)),
            };
            (
                InvocationInput::Handoff {
                    claim: Box::new(claim.expect("prepared handoff")),
                    pause,
                },
                Some(work),
            )
        }
        RunWork::Continuation { tools, .. } => (
            InvocationInput::Continuation {
                claim: Box::new(claim.expect("prepared continuation")),
                request_fingerprint: input
                    .request_fingerprint
                    .clone()
                    .expect("validated continuation fingerprint"),
            },
            Some(ModelWork {
                tools,
                restored: None,
            }),
        ),
        RunWork::Message {
            message,
            source_messages,
            tools,
            ..
        } => (
            InvocationInput::Message {
                content: message,
                request_fingerprint: input.request_fingerprint.clone(),
                source_messages,
            },
            Some(ModelWork {
                tools,
                restored: None,
            }),
        ),
        RunWork::ContextCompact => (
            InvocationInput::ContextCompact {
                request_fingerprint: input
                    .request_fingerprint
                    .clone()
                    .expect("validated compact fingerprint"),
            },
            None,
        ),
    };
    let opening = RuntimeEvent::new(
        input.invocation.clone(),
        Fact::InvocationOpened {
            configuration: Some(Box::new(input.configuration.clone())),
            input: opening,
        },
    );
    let opening_id = opening.id.clone();
    inner
        .log
        .clone()
        .commit(EventWrite::plain(opening)?)
        .await?;
    let _ = admitted.send(());
    let result = async {
        let mut inspected_through = 0;
        if !prior_unknown {
            prune::run(&inner, &input, &cancellation, &mut inspected_through).await?;
        }
        if let Some(work) = model_work {
            // Model steps include frozen retry preparation; keep that frame out of the runner.
            Box::pin(steps::run(
                &inner,
                &mut input,
                work,
                &opening_id,
                &cancellation,
                continuation_base,
                handoff.as_ref().expect("model Runs own a handoff gate"),
                prior_unknown,
                inspected_through,
                &effects,
            ))
            .await
            .map(|exit| (exit, None))
        } else {
            // Compaction owns a larger preparation frame than normal steps.
            // Allocate it only for this branch, not for every live invocation.
            Box::pin(compact::run(
                &inner,
                &mut input,
                &maka_agent_facts::context::CheckpointMode::Standalone,
                &cancellation,
                None,
            ))
            .await
            .map(|(outcome, checkpoint)| {
                (
                    steps::StepExit::Terminal(InvocationOutcome::ContextCompactFinished {
                        outcome,
                    }),
                    checkpoint,
                )
            })
        }
    }
    .await;
    finish(
        &inner,
        input.invocation,
        result,
        &cancellation,
        handoff.as_ref(),
        &effects,
    )
    .await
}

pub(super) async fn finish(
    inner: &Arc<RunContext>,
    invocation: Invocation,
    result: Result<(steps::StepExit, Option<RuntimeEvent>), RunError>,
    cancellation: &tokio_util::sync::CancellationToken,
    handoff: Option<&crate::HandoffGate>,
    effects: &maka_event_log::root_store::InvocationEffects,
) -> Result<crate::ActivationExit, RunError> {
    let result = match effects.settle().await {
        Ok(()) => result,
        Err(error) => crate::model_attempt::additional_failure(result, error.into()),
    };
    let result = crate::model_attempt::seal_unfinished_attempts(inner, result).await;
    if let Ok((steps::StepExit::Parked(receipt), _)) = &result {
        return Ok(crate::ActivationExit::Parked(receipt.clone()));
    }
    let result = result.map(|(exit, checkpoint)| match exit {
        steps::StepExit::Terminal(outcome) => (outcome, checkpoint),
        steps::StepExit::Parked(_) => unreachable!("parked exits returned above"),
    });
    let result = if matches!(&result, Err(RunError::Commit(CommitError::Retired)))
        || (matches!(&result, Ok((outcome, _)) if !matches!(outcome, InvocationOutcome::HandoffPaused { .. }))
            && cancellation.is_cancelled())
    {
        Err(RunError::Cancelled)
    } else {
        result
    };
    let (outcome, checkpoint) = match &result {
        Ok((outcome, checkpoint)) => (outcome.clone(), checkpoint.clone()),
        Err(RunError::Cancelled | RunError::Model(maka_model::ModelError::Cancelled)) => (
            InvocationOutcome::Cancelled {
                source: "runtime_cancellation".into(),
            },
            None,
        ),
        Err(error) => (
            InvocationOutcome::Failed {
                class: failure_class(error).into(),
                model_failure: match error {
                    RunError::Model(error) => error.failure_cause(),
                    _ => None,
                },
                message: Some(error.to_string().chars().take(2048).collect()),
            },
            None,
        ),
    };
    if let Some(checkpoint) = checkpoint {
        // A checkpoint is adopted only with its successful terminal in this transaction.
        let terminal = RuntimeEvent::new(invocation.clone(), Fact::InvocationEnded { outcome });
        let committed = inner
            .log
            .append_batch(&[EventWrite::plain(checkpoint)?, EventWrite::plain(terminal)?])
            .await;
        if let Err(error) = committed {
            if matches!(error, CommitError::Rejected(_)) {
                append(
                    inner,
                    &invocation,
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Failed {
                            class: "event_commit".into(),
                            model_failure: None,
                            message: Some(error.to_string().chars().take(2048).collect()),
                        },
                    },
                )
                .await?;
            }
            return Err(error.into());
        }
        inner.shared.clear_loaded(&invocation.session_id)?;
    } else {
        let pause = match &outcome {
            InvocationOutcome::HandoffPaused { pause } => Some(pause.clone()),
            _ => None,
        };
        append(inner, &invocation, Fact::InvocationEnded { outcome }).await?;
        if let Some(pause) = pause {
            handoff.expect("model Run handoff").sealed(&pause);
        }
    }
    result?;
    Ok(crate::ActivationExit::Terminal(invocation))
}

fn failure_class(error: &RunError) -> &'static str {
    match error {
        RunError::SessionState(_) => "session_state_error",
        RunError::Busy => "session_busy",
        RunError::ContinuationChanged => "continuation_changed",
        RunError::ReconciliationRequired(_) => "reconciliation_required",
        RunError::InvalidInput(_) => "invalid_input",
        RunError::Cancelled | RunError::Model(maka_model::ModelError::Cancelled) => "cancelled",
        RunError::ModelIncomplete => "model_incomplete",
        RunError::Commit(_) => "event_commit",
        RunError::Store(_) => "event_store",
        RunError::Model(maka_model::ModelError::Http { .. }) => "model_http",
        RunError::Model(maka_model::ModelError::TimedOut) => "model_timeout",
        RunError::Model(maka_model::ModelError::Adapter(_)) => "model_adapter",
        RunError::Model(maka_model::ModelError::ImageInputRejected { .. }) => {
            "image_input_rejected"
        }
        RunError::Model(maka_model::ModelError::ImageInputPayloadTooLarge { .. }) => {
            "image_input_payload_too_large"
        }
        RunError::Model(maka_model::ModelError::Provider(failure))
            if failure.reason()
                == maka_agent_facts::model::error::ProviderFailureReason::TimedOut =>
        {
            "model_timeout"
        }
        RunError::Model(maka_model::ModelError::Provider(_)) => "model_provider",
        RunError::Model(maka_model::ModelError::ContextOverflow { .. }) => "context_overflow",
        RunError::Tool(_) => "tool_execution",
        RunError::Internal(_) => "runtime_internal",
        RunError::Checkpoint(_) => "activation_checkpoint",
        RunError::Preparation(_) => "model_preparation",
        RunError::CleanupUnconfirmed
        | RunError::PreparationCleanup(_)
        | RunError::Model(maka_model::ModelError::CleanupUnconfirmed) => "cleanup_unconfirmed",
    }
}

pub(super) async fn append(
    inner: &RunContext,
    invocation: &Invocation,
    fact: Fact,
) -> Result<(), RunError> {
    let log = inner.log.clone();
    let event = RuntimeEvent::new(invocation.clone(), fact);
    if matches!(event.fact, Fact::InvocationEnded { .. }) {
        let now = event
            .recorded_at
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| CommitError::Rejected(error.to_string()))?
            .as_millis();
        log.close_run_interactions(
            invocation,
            maka_agent_facts::interaction::ClosureReason::TurnTerminal,
            u64::try_from(now).map_err(|error| CommitError::Rejected(error.to_string()))?,
        )
        .await
        .map_err(|error| match error {
            maka_event_log::StoreError::CommitUnknown(error) => {
                CommitError::OutcomeUnknown(error.to_string())
            }
            maka_event_log::StoreError::OperationUnknown => {
                CommitError::OutcomeUnknown(error.to_string())
            }
            other => CommitError::Rejected(other.to_string()),
        })?;
    }
    log.commit(maka_agent_facts::event::EventWrite::plain(event)?)
        .await?;
    Ok(())
}

pub(super) fn digest(value: &impl serde::Serialize) -> Result<String, RunError> {
    struct Writer(Sha256);
    impl std::io::Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Writer(Sha256::new());
    serde_json::to_writer(&mut writer, value)
        .map_err(|error| RunError::Internal(error.to_string()))?;
    Ok(format!("sha256:{}", hex::encode(writer.0.finalize())))
}
