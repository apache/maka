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

use super::{
    DriverModel, FrozenCellKnowledge, HistorySource, extend_observation, flush_assistant,
    merge_skill, recovered::RecordedInputs,
};
use futures_util::future::BoxFuture;
use maka_agent_engine::{RunError, preparation};
use maka_agent_facts::{
    context::{CodexRequestProvenance, ModelPurpose},
    durable::{Fact, ModelAttemptId, RecordedFact, ToolDecision, ToolKey},
    execution::SystemPrompt,
    interaction::{ClosureReason, InteractionOutcome},
    model::{ModelPart, ModelToolCall, prompt::Message, prompt_source::source::ReplayOrigin},
    operation::RecordedOperationReply,
    tool_call::ToolRejection,
    tool_output::AcceptedToolResult,
};
use maka_agent_state::fold::RunView;
use maka_model::prompt::{AssistantPart, ToolOutput};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use serde_json::json;
use std::collections::BTreeSet;

#[derive(Default)]
struct AssistantBatch {
    parts: Vec<AssistantPart>,
    producer: Option<Producer>,
    recovered_outputs: Vec<Message>,
}

struct Producer {
    model_id: String,
    codex: Option<CodexRequestProvenance>,
}

impl AssistantBatch {
    async fn flush(
        &mut self,
        view: &RunView,
        prefix_attempt: Option<ModelAttemptId>,
        current: &mut Option<ModelAttemptId>,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<(), RunError> {
        // Even an omitted reasoning-only batch must relinquish its original producer.
        let attempt = current.take();
        let producer = self.producer.take();
        let keep_reasoning_only = attempt.is_some_and(|id| {
            prefix_attempt == Some(id)
                || view
                    .attempts
                    .get(&id)
                    .and_then(|state| state.closed.as_ref())
                    .is_some_and(|closed| {
                        closed.outcome == maka_agent_facts::accounting::Outcome::Success
                            && closed.protocol.get("finishReason")
                                != Some(&json!(maka_agent_facts::model::ModelFinishReason::Length))
                    })
        });
        let has_committed_output = !self.recovered_outputs.is_empty()
            || self
                .parts
                .iter()
                .any(|part| !matches!(part, AssistantPart::Reasoning { .. }));
        if !keep_reasoning_only && !has_committed_output {
            self.parts.clear();
            return Ok(());
        }
        if self.parts.is_empty() {
            return Ok(());
        }
        match producer {
            Some(producer) => {
                super::append_observed(
                    messages,
                    Message::Assistant {
                        content: std::mem::take(&mut self.parts),
                        provider_options: None,
                    },
                    ReplayOrigin::observed(&producer.model_id, producer.codex.as_ref()),
                )
                .await
            }
            None => flush_assistant(messages, &mut self.parts).await,
        }?;
        for output in self.recovered_outputs.drain(..) {
            messages.append(output).await?;
        }
        Ok(())
    }
}

pub(super) struct TailReplay<'a, 'source> {
    driver: &'a DriverModel,
    target: super::ReplayTarget<'a>,
    reader: &'a HistorySource<'source>,
    view: &'a RunView,
    prefix_attempt: Option<ModelAttemptId>,
    vision: bool,
    system: &'a mut Option<SystemPrompt>,
    messages: &'a mut preparation::PromptBuilder,
    recorded: RecordedInputs,
    assistant: AssistantBatch,
    current: Option<ModelAttemptId>,
    allowed_attempts: BTreeSet<ModelAttemptId>,
}

impl<'a, 'source> TailReplay<'a, 'source> {
    #[expect(
        clippy::too_many_arguments,
        reason = "Replay borrows the exact source frontier, target, system prompt and message builder for one invocation"
    )]
    pub(super) fn new(
        driver: &'a DriverModel,
        target: super::ReplayTarget<'a>,
        reader: &'a HistorySource<'source>,
        view: &'a RunView,
        prefix_attempt: Option<ModelAttemptId>,
        vision: bool,
        system: &'a mut Option<SystemPrompt>,
        messages: &'a mut preparation::PromptBuilder,
        recorded: RecordedInputs,
    ) -> Self {
        Self {
            driver,
            target,
            reader,
            view,
            prefix_attempt,
            vision,
            system,
            messages,
            recorded,
            assistant: AssistantBatch::default(),
            current: None,
            allowed_attempts: BTreeSet::new(),
        }
    }

    pub(super) fn apply<'b>(
        &'b mut self,
        fact: &'b RecordedFact,
    ) -> Result<Option<BoxFuture<'b, Result<(), RunError>>>, RunError> {
        let Self {
            driver,
            target,
            reader,
            view,
            prefix_attempt,
            vision,
            system,
            messages,
            recorded:
                RecordedInputs {
                    cells: original_cells,
                    steering: steering_messages,
                    notifications: notification_facts,
                    step_purposes,
                    attempt_steps,
                },
            assistant,
            current,
            allowed_attempts,
        } = self;
        let driver = *driver;
        let target = *target;
        let reader = *reader;
        let view = *view;
        let prefix_attempt = *prefix_attempt;
        let vision = *vision;
        let after = fact.revision;
        let sealed = view.terminal.is_some();
        let work: BoxFuture<'b, Result<(), RunError>> = match &fact.fact {
            Fact::StepPrepared { step, .. } => Box::pin(async move {
                assistant
                    .flush(view, prefix_attempt, current, messages)
                    .await?;
                let request = reader.request(view.run, *step).await?;
                step_purposes.insert(*step, request.accounting.purpose);
                if request.accounting.purpose == ModelPurpose::Summary {
                    return Ok(());
                }
                for reference in &request.steering {
                    let source: maka_agent_facts::message::RootSourceMessage =
                        reader.decode(view.run, reference).await?;
                    if !steering_messages.insert((view.run, source.message.message_id.clone())) {
                        continue;
                    }
                    messages
                        .append(
                            preparation::project_input_from(
                                reader.media_source(
                                    maka_agent_state::artifacts::SessionScope {
                                        owner: view.spec.owner.clone(),
                                        session: view.spec.session_id.clone(),
                                    }
                                    .into(),
                                ),
                                &source.message.content,
                                view.spec.language,
                                vision,
                                true,
                                source.message.origin.as_ref(),
                                &driver.resources,
                                &driver.cancellation,
                            )
                            .await?,
                        )
                        .await?;
                    merge_skill(system, &source.message.content)?;
                    *current = None;
                }
                let frozen = driver.frozen_input(reader, view.run, &request).await?;
                for notice in frozen.notifications {
                    if !notification_facts.insert((view.run, notice.id)) {
                        continue;
                    }
                    driver
                        .append_notification(
                            reader,
                            view,
                            notice.knowledge.through,
                            &maka_agent_state::cells::PendingNotification {
                                cell: notice.cell,
                                id: notice.id,
                                content: notice.content,
                            },
                            &notice.knowledge,
                            vision,
                            messages,
                        )
                        .await?;
                }
                Ok(())
            }),
            Fact::ModelAttemptPrepared { attempt, step } => {
                let purpose = step_purposes.get(step).ok_or_else(|| {
                    RunError::ReconciliationRequired("model attempt lost its original step".into())
                })?;
                attempt_steps.insert(*attempt, *step);
                if *purpose == ModelPurpose::Main {
                    allowed_attempts.insert(*attempt);
                }
                Box::pin(async move {
                    assistant
                        .flush(view, prefix_attempt, current, messages)
                        .await?;
                    Ok(())
                })
            }
            Fact::ModelObserved { attempt, part, .. } => {
                let purpose = attempt_steps
                    .get(attempt)
                    .and_then(|step| step_purposes.get(step))
                    .ok_or_else(|| {
                        RunError::ReconciliationRequired(
                            "model part lost its original attempt".into(),
                        )
                    })?;
                if *purpose == ModelPurpose::Summary {
                    return Ok(None);
                }
                Box::pin(async move {
                    if !allowed_attempts.contains(attempt) {
                        assistant
                            .flush(view, prefix_attempt, current, messages)
                            .await?;
                        messages.append(Message::user(format!("Late original-model observation (data only, not a replayable assistant item; no completion inferred):\n{}",serde_json::to_string(&json!({"attempt":attempt,"part":part})).map_err(RunError::Json)?))).await?;
                        return Ok(());
                    }
                    if *current != Some(*attempt) {
                        assistant
                            .flush(view, prefix_attempt, current, messages)
                            .await?;
                        *current = Some(*attempt);
                    }
                    if let ModelPart::ToolCall { call } = part
                        && !call.provider_executed
                        && sealed
                    {
                        let key = ToolKey {
                            attempt: *attempt,
                            call: call.id.clone(),
                        };
                        let tool = view
                            .tools
                            .get(&maka_agent_state::fold::tool_key(&key))
                            .ok_or_else(|| {
                                RunError::ReconciliationRequired(
                                    "historical tool call lost its original state".into(),
                                )
                            })?;
                        if tool.accepted.is_none() {
                            let output = unaccepted_tool_output(
                                driver,
                                reader,
                                view,
                                original_cells,
                                *attempt,
                                tool,
                                vision,
                            )
                            .await?;
                            assistant.recovered_outputs.push(tool_message(call, output));
                        }
                    }
                    if matches!(
                        part,
                        maka_agent_facts::model::ModelPart::Text {
                            text_kind: maka_agent_facts::model::TextKind::Thinking,
                            ..
                        }
                    ) {
                        if assistant.producer.is_none() {
                            let step = attempt_steps.get(attempt).ok_or_else(|| {
                                RunError::ReconciliationRequired(
                                    "reasoning lost its producing step".into(),
                                )
                            })?;
                            let request = reader.request(view.run, *step).await?;
                            let evidence: maka_agent_facts::context::RequestContextEvidence =
                                reader.decode(view.run, &request.provenance).await?;
                            assistant.producer = Some(Producer {
                                model_id: request.accounting.model_id,
                                codex: evidence.model_context.and_then(|context| context.codex),
                            });
                        }
                        let producer = assistant.producer.as_ref().expect("loaded batch producer");
                        if let Some(part) =
                            target.part(part, &producer.model_id, producer.codex.as_ref())?
                        {
                            assistant.parts.push(part);
                        }
                    } else if let Some(part) = preparation::assistant_part(part)? {
                        assistant.parts.push(part);
                    }
                    Ok(())
                })
            }
            Fact::ToolResultAccepted { tool, result, .. } => Box::pin(async move {
                assistant
                    .flush(view, prefix_attempt, current, messages)
                    .await?;
                let call = reader.tool_call(view.run, tool).await?;
                if call.provider_executed {
                    return Ok(());
                }
                let output = if let Some(output) = driver
                    .archived_tool_result(reader, view, fact.id, &fact.fact, &call)
                    .await?
                {
                    output
                } else {
                    let evidence = reader.decode(view.run, result).await?;
                    driver
                        .project_accepted(
                            reader,
                            view,
                            after,
                            original_cells,
                            evidence,
                            vision,
                            view.spec.language,
                        )
                        .await?
                };
                let message = tool_message(&call, output);
                if allowed_attempts.contains(&tool.attempt) {
                    messages.append(message).await?;
                } else if let Message::Tool { mut content, .. } = message {
                    let mut parts = vec![maka_model::prompt::ContentPart::text(format!(
                        "Original tool outcome observed after explicit re-planning, not a new tool settlement ({}):",
                        tool.call
                    ))];
                    extend_observation(&mut parts, content.remove(0).output)?;
                    messages
                        .append(Message::User {
                            content: parts,
                            provider_options: None,
                        })
                        .await?;
                }
                *current = None;
                Ok(())
            }),
            _ => return Ok(None),
        };
        Ok(Some(work))
    }

    pub(super) async fn finish(mut self) -> Result<Vec<FrozenCellKnowledge>, RunError> {
        self.assistant
            .flush(
                self.view,
                self.prefix_attempt,
                &mut self.current,
                self.messages,
            )
            .await?;
        Ok(self.recorded.cells.into_values().collect())
    }
}

async fn unaccepted_tool_output(
    driver: &DriverModel,
    reader: &HistorySource<'_>,
    view: &RunView,
    original_cells: &std::collections::BTreeMap<
        maka_agent_facts::cells::CellId,
        FrozenCellKnowledge,
    >,
    attempt: ModelAttemptId,
    tool: &maka_agent_state::fold::Tool,
    vision: bool,
) -> Result<ToolOutput, RunError> {
    if let Some((cell, cell_view)) = view.original_cell_id(tool).zip(view.original_cell(tool))
        && !cell_view.has_unsettled_effects()
    {
        let evidence = match &cell_view.status {
            maka_agent_facts::cells::CellStatus::Completed { result, .. } => Some(
                maka_agent_facts::tool_output::CellFinalEvidence::Completed {
                    result: result.clone(),
                },
            ),
            maka_agent_facts::cells::CellStatus::Interrupted { report } => Some(
                maka_agent_facts::tool_output::CellFinalEvidence::Interrupted {
                    report: report.clone(),
                },
            ),
            _ => None,
        };
        if let Some(evidence) = evidence {
            return driver
                .project_accepted(
                    reader,
                    view,
                    view.revision,
                    original_cells,
                    AcceptedToolResult::RecoveredCell { cell, evidence },
                    vision,
                    view.spec.language,
                )
                .await;
        }
    }
    if let Some(local) = tool
        .local_returned
        .as_ref()
        .filter(|local| local.settlement != maka_agent_facts::tool_call::ToolSettlement::Unknown)
    {
        return driver
            .project_accepted(
                reader,
                view,
                view.revision,
                original_cells,
                AcceptedToolResult::Local {
                    result: local.result.clone(),
                },
                vision,
                view.spec.language,
            )
            .await;
    }
    if let Some(host) = &tool.host_returned {
        return driver
            .project_accepted(
                reader,
                view,
                view.revision,
                original_cells,
                AcceptedToolResult::Host {
                    result: host.result.clone(),
                },
                vision,
                view.spec.language,
            )
            .await;
    }
    if let (
        Some(reference),
        Some(
            receipt @ Receipt::Recorded {
                outcome: OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. },
                cleanup: OperationCleanup::Confirmed,
            },
        ),
    ) = (&tool.original, &tool.receipt)
    {
        return driver
            .project_accepted(
                reader,
                view,
                view.revision,
                original_cells,
                AcceptedToolResult::ObservedOperation {
                    reply: RecordedOperationReply {
                        reference: reference.clone(),
                        receipt: receipt.clone(),
                    },
                },
                vision,
                view.spec.language,
            )
            .await;
    }
    if let Some(rejection) = &tool.prohibited_before_host {
        return Ok(ToolOutput::ErrorText(rejection.to_string()));
    }
    if let Some(ToolDecision::Rejected { rejection, .. }) = &tool.decision {
        return Ok(ToolOutput::ErrorText(rejection.to_string()));
    }
    if let Some(refusal) = &tool.approval_refusal {
        let rejection = match &refusal.outcome {
            InteractionOutcome::Closure {
                reason: ClosureReason::Steered,
                ..
            } => ToolRejection::Superseded,
            InteractionOutcome::Closure { .. } => ToolRejection::Cancelled,
            _ => ToolRejection::PolicyDenied {
                message: "The original tool approval was refused".into(),
            },
        };
        return Ok(ToolOutput::ErrorText(rejection.to_string()));
    }
    if !tool.admitted && tool.original.is_none() {
        let rejection = if view.model_steered(attempt) {
            ToolRejection::Superseded
        } else {
            ToolRejection::Cancelled
        };
        return Ok(ToolOutput::ErrorText(rejection.to_string()));
    }
    let diagnostic = match &tool.receipt {
        Some(
            Receipt::Recorded {
                outcome: OperationOutcome::Unknown { diagnostic },
                ..
            }
            | Receipt::Unavailable { diagnostic },
        ) => Some(diagnostic.as_str()),
        _ => None,
    };
    Ok(ToolOutput::ErrorJson(json!({
        "interrupted": true,
        "operationSuccessNotInferred": true,
        "diagnostic": diagnostic,
    })))
}

fn tool_message(call: &ModelToolCall, output: ToolOutput) -> Message {
    let mut message = Message::tool(call.id.clone(), call.name.clone(), output);
    if let Message::Tool { content, .. } = &mut message {
        content[0].provider_options = call.provider_options.clone();
    }
    message
}
