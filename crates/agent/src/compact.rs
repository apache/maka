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

use crate::{Inner, RunError, RunInput, model_attempt};
use maka_event_log::StoreError;
use maka_runtime::{
    context::{
        CheckpointMode, CompactOutcome, ContextCheckpoint, ModelPurpose, SUMMARY_FORMAT_TEMPLATE,
        SummaryDefect, TextSummary,
    },
    event::{Fact, RuntimeEvent},
    model::ModelFinishReason,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) type Candidate = (CompactOutcome, Option<RuntimeEvent>);

pub(super) struct Job {
    input: RunInput,
    source: maka_event_log::context::ModelContextSource,
    mode: CheckpointMode,
    prompt: Vec<maka_model::prompt::Message>,
    adapter: maka_plugins::model::Binding,
}

pub(super) async fn run(
    inner: &Arc<Inner>,
    input: &mut RunInput,
    mode: &CheckpointMode,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
) -> Result<Candidate, RunError> {
    match capture(inner, input, mode, cancellation, continuation_base).await {
        Ok(Some(job)) => job.execute(inner, cancellation, None).await,
        Ok(None) => Ok((
            CompactOutcome::Unchanged {
                reason: "no_new_history".into(),
            },
            None,
        )),
        Err(RunError::Store(StoreError::PrefixTooLarge)) => Ok(failed("input_too_large")),
        Err(error) => Err(error),
    }
}

pub(super) async fn capture(
    inner: &Arc<Inner>,
    input: &mut RunInput,
    mode: &CheckpointMode,
    cancellation: &CancellationToken,
    continuation_base: Option<u64>,
) -> Result<Option<Job>, RunError> {
    input.refresh_model(cancellation).await?;
    let source = inner
        .log
        .prepare_context_compaction(
            &input.invocation.session_id,
            Some(&input.invocation.invocation_id),
            maka_runtime::context::MAX_HISTORY_EVENTS,
            maka_runtime::context::MAX_HISTORY_BYTES,
            mode,
        )
        .await?;
    if !source
        .tail
        .iter()
        .filter_map(|event| match event {
            maka_event_log::context::ContextEvent::Canonical(stored) => Some(stored.as_ref()),
            _ => None,
        })
        .any(|stored| {
            matches!(
                &stored.event.fact,
                Fact::InvocationOpened {
                    input: maka_runtime::input::InvocationInput::Message { .. },
                    ..
                } | Fact::MessageSteered { .. }
                    | Fact::ModelCompleted { .. }
            ) || matches!(&stored.event.fact, Fact::MessageImported { record, .. } if record.is_conversation())
        })
    {
        return Ok(None);
    }
    let prompt = model_attempt::prompt(
        inner,
        input,
        &source,
        ModelPurpose::Summary,
        cancellation,
        continuation_base,
        &input.invocation.invocation_id,
        false,
    )
    .await?;
    let adapter = inner.model.binding_in_scope(
        &input.provider,
        &maka_plugins::composition::Scope::Session(input.invocation.session_id.clone()),
    )?;
    Ok(Some(Job {
        input: input.clone(),
        source,
        mode: mode.clone(),
        prompt,
        adapter,
    }))
}

impl Job {
    pub async fn execute(
        self,
        inner: &Arc<Inner>,
        cancellation: &CancellationToken,
        mut reservation: Option<maka_model::ModelReservation>,
    ) -> Result<Candidate, RunError> {
        let Self {
            input,
            source,
            mode,
            prompt,
            adapter,
        } = self;
        let base = format!(
            "You are a context summarization assistant.\nRead the conversation between a user and an AI assistant, then produce a structured summary another LLM will use to continue the same task.\nDo NOT continue the conversation. Do NOT answer questions in it. ONLY output the structured summary.\n\nUse this exact format:\n\n{SUMMARY_FORMAT_TEMPLATE}\n\nKeep each section concise. Preserve exact file paths, function names, commands, and error messages."
        );
        let mut instruction = base.clone();
        let mut shortened = false;
        let mut repair = None;
        loop {
            let mut request = prompt.clone();
            request.push(maka_model::prompt::Message::user(format!("{instruction}\n\nNow write the structured summary of the conversation above. Output only the summary.")));
            let (step_id, output) = model_attempt::execute(
                inner,
                &input,
                &source,
                request,
                Vec::new(),
                model_attempt::Attempt::Summary {
                    adapter: adapter.clone(),
                    reservation: reservation.as_mut(),
                },
                cancellation,
            )
            .await?;
            if output.finish_reason == ModelFinishReason::Length {
                if shortened || repair.is_some() {
                    return Ok(failed("output_length"));
                }
                shortened = true;
                instruction = format!(
                    "{base}\n\nYour previous attempt was cut off at the output limit. Produce the same summary in well under half the length: keep every section, drop detail rather than sections."
                );
                continue;
            }
            let summary = match TextSummary::from_model_step(&output, source.baseline.is_none()) {
                Ok(summary) => summary,
                Err(defect) => {
                    if let Some(original) = repair {
                        return Ok(failed(&SummaryDefect::to_string(&original)));
                    }
                    if !matches!(
                        defect,
                        SummaryDefect::MissingSection
                            | SummaryDefect::Truncated
                            | SummaryDefect::TooSmallForFold
                    ) {
                        return Ok(failed(&defect.to_string()));
                    }
                    repair = Some(defect);
                    instruction = format!(
                        "{base}\n\nA prior attempt was rejected as {defect}.\nProduce one complete replacement summary from the source conversation.\nEvery required section must appear in order with substantive content. Do not discuss the repair."
                    );
                    continue;
                }
            };
            let checkpoint = RuntimeEvent::new(
                input.invocation.clone(),
                Fact::ContextCheckpointRecorded {
                    checkpoint: ContextCheckpoint {
                        mode: mode.clone(),
                        covered_through: source.source_evidence.high_water,
                        source_digest: source.source_evidence.digest,
                        previous_checkpoint_id: source.baseline.map(|baseline| baseline.event_id),
                        summary,
                        summary_step_id: step_id,
                    },
                },
            );
            return Ok((
                CompactOutcome::Compacted {
                    checkpoint_id: checkpoint.id.clone(),
                },
                Some(checkpoint),
            ));
        }
    }
}
fn failed(reason: &str) -> (CompactOutcome, Option<RuntimeEvent>) {
    (
        CompactOutcome::Failed {
            reason: reason.into(),
        },
        None,
    )
}
