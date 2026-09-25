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

use crate::{Inner, RunError, RunInput, RunWork, compact, prune, steps};
use maka_event_log::StoreError;
use maka_runtime::event::{
    CommitError, EventSink, EventWrite, Fact, Invocation, InvocationOutcome, RuntimeEvent,
};
use maka_runtime::input::InvocationInput;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub async fn run(
    inner: Arc<Inner>,
    mut input: RunInput,
    cancellation_owner: tokio_util::sync::CancellationToken,
    admitted: tokio::sync::oneshot::Sender<()>,
    handoff: Option<crate::HandoffGate>,
    prepared_claim: Option<maka_runtime::continuation::ContinuationClaim>,
) -> Result<Invocation, RunError> {
    let cancellation = cancellation_owner.clone();
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    let manual_message = matches!(
        &input.work,
        RunWork::Message {
            allow_prior_unknown: true,
            ..
        }
    );
    let prior_unknown = if manual_message {
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
    };
    let prior_unknown = match prior_unknown {
        Ok(value) => value,
        Err(StoreError::InvalidTransition(reason)) => {
            return Err(RunError::ReconciliationRequired(reason));
        }
        Err(error) => return Err(error.into()),
    };
    let claim = match (prepared_claim, &input.work) {
        (Some(claim), _) => Some(claim),
        (
            None,
            RunWork::Continuation { source, tools, .. } | RunWork::Handoff { source, tools, .. },
        ) => {
            Some(crate::continuation::prepare(&inner, &input, source, tools, &cancellation).await?)
        }
        _ => None,
    };
    let continuation_base = match &input.work {
        RunWork::Handoff { pause, .. } => pause.execution.replay_base,
        _ => claim.as_ref().map(|claim| claim.base.high_water),
    };
    let opening = match &input.work {
        RunWork::Handoff { pause, .. } => InvocationInput::Handoff {
            claim: Box::new(claim.expect("prepared handoff")),
            pause: pause.clone(),
        },
        RunWork::Continuation { .. } => InvocationInput::Continuation {
            claim: Box::new(claim.expect("prepared continuation")),
            request_fingerprint: input
                .request_fingerprint
                .clone()
                .expect("validated continuation fingerprint"),
        },
        RunWork::Message {
            message,
            source_messages,
            ..
        } => InvocationInput::Message {
            content: message.clone(),
            request_fingerprint: input.request_fingerprint.clone(),
            source_messages: source_messages.clone(),
        },
        RunWork::ContextCompact => InvocationInput::ContextCompact {
            request_fingerprint: input
                .request_fingerprint
                .clone()
                .expect("validated compact fingerprint"),
        },
    };
    append(
        &inner,
        &input.invocation,
        Fact::InvocationOpened {
            configuration: Some(Box::new(input.configuration.clone())),
            input: opening,
        },
    )
    .await?;
    let _ = admitted.send(());
    let result = async {
        if !prior_unknown {
            prune::run(&inner, &input, &cancellation).await?;
        }
        let model_work = match &input.work {
            RunWork::Message {
                tools, max_steps, ..
            }
            | RunWork::Continuation {
                tools, max_steps, ..
            } => Some((tools.clone(), *max_steps)),
            RunWork::Handoff { tools, pause, .. } => {
                Some((tools.clone(), usize::from(pause.remaining_steps.get())))
            }
            RunWork::ContextCompact => None,
        };
        if let Some((tools, max_steps)) = model_work {
            steps::run(
                &inner,
                &mut input,
                &tools,
                max_steps,
                &cancellation,
                continuation_base,
                handoff.as_ref().expect("model Runs own a handoff gate"),
                prior_unknown,
            )
            .await
            .map(|outcome| (outcome, None))
        } else {
            compact::run(
                &inner,
                &mut input,
                &maka_runtime::context::CheckpointMode::Standalone,
                &cancellation,
                None,
            )
            .await
            .map(|(outcome, checkpoint)| {
                (
                    InvocationOutcome::ContextCompactFinished { outcome },
                    checkpoint,
                )
            })
        }
    }
    .await;
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
                message: Some(error.to_string().chars().take(2048).collect()),
            },
            None,
        ),
    };
    if let Some(checkpoint) = checkpoint {
        // A checkpoint is adopted only with its successful terminal in this transaction.
        let terminal =
            RuntimeEvent::new(input.invocation.clone(), Fact::InvocationEnded { outcome });
        let committed = inner
            .log
            .append_batch(&[EventWrite::plain(checkpoint)?, EventWrite::plain(terminal)?])
            .await;
        if let Err(error) = committed {
            if matches!(error, CommitError::Rejected(_)) {
                append(
                    &inner,
                    &input.invocation,
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Failed {
                            class: "event_commit".into(),
                            message: Some(error.to_string().chars().take(2048).collect()),
                        },
                    },
                )
                .await?;
            }
            return Err(error.into());
        }
    } else {
        let pause = match &outcome {
            InvocationOutcome::HandoffPaused { pause } => Some(pause.clone()),
            _ => None,
        };
        append(&inner, &input.invocation, Fact::InvocationEnded { outcome }).await?;
        if let Some(pause) = pause {
            handoff.as_ref().expect("model Run handoff").sealed(&pause);
        }
    }
    result?;
    Ok(input.invocation)
}

fn failure_class(error: &RunError) -> &'static str {
    match error {
        RunError::Busy => "session_busy",
        RunError::ReconciliationRequired(_) => "reconciliation_required",
        RunError::InvalidInput(_) => "invalid_input",
        RunError::Cancelled | RunError::Model(maka_model::ModelError::Cancelled) => "cancelled",
        RunError::StepLimit => "step_limit",
        RunError::ModelIncomplete => "model_incomplete",
        RunError::Commit(_) => "event_commit",
        RunError::Store(_) => "event_store",
        RunError::Model(maka_model::ModelError::TimedOut) => "model_timeout",
        RunError::Model(maka_model::ModelError::Adapter(_)) => "model_adapter",
        RunError::Model(maka_model::ModelError::Provider(_)) => "model_provider",
        RunError::Model(maka_model::ModelError::ContextOverflow { .. }) => "context_overflow",
        RunError::Tool(_) => "tool_execution",
        RunError::Internal(_) => "runtime_internal",
    }
}

pub(super) async fn append(
    inner: &Inner,
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
            maka_runtime::interaction::ClosureReason::TurnTerminal,
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
    log.commit(maka_runtime::event::EventWrite::plain(event)?)
        .await?;
    Ok(())
}

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
