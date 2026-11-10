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
    durable::{Fact, ModelAttemptId, RecordedFact, ToolKey},
    execution::SystemPrompt,
    model::{prompt::Message, prompt_source::source::ReplayOrigin},
};
use maka_agent_state::fold::RunView;
use maka_model::prompt::AssistantPart;
use serde_json::json;
use std::collections::BTreeSet;

#[derive(Default)]
struct AssistantBatch {
    parts: Vec<AssistantPart>,
    producer: Option<Producer>,
}

struct Producer {
    model_id: String,
    codex: Option<CodexRequestProvenance>,
}

impl AssistantBatch {
    async fn flush(&mut self, messages: &mut preparation::PromptBuilder) -> Result<(), RunError> {
        // Even an omitted reasoning-only batch must relinquish its original producer.
        let producer = self.producer.take();
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
        }
    }
}

pub(super) struct TailReplay<'a, 'source> {
    driver: &'a DriverModel,
    target: super::ReplayTarget<'a>,
    reader: &'a HistorySource<'source>,
    view: &'a RunView,
    vision: bool,
    system: &'a mut Option<SystemPrompt>,
    messages: &'a mut preparation::PromptBuilder,
    recorded: RecordedInputs,
    assistant: AssistantBatch,
    current: Option<ModelAttemptId>,
    allowed_attempts: BTreeSet<ModelAttemptId>,
    accepted_tools: BTreeSet<ToolKey>,
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
            vision,
            system,
            messages,
            recorded,
            assistant: AssistantBatch::default(),
            current: None,
            allowed_attempts: BTreeSet::new(),
            accepted_tools: BTreeSet::new(),
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
            accepted_tools,
        } = self;
        let driver = *driver;
        let target = *target;
        let reader = *reader;
        let view = *view;
        let vision = *vision;
        let after = fact.revision;
        let work: BoxFuture<'b, Result<(), RunError>> = match &fact.fact {
            Fact::StepPrepared { step, .. } => Box::pin(async move {
                assistant.flush(messages).await?;
                *current = None;
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
                    assistant.flush(messages).await?;
                    *current = None;
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
                        assistant.flush(messages).await?;
                        *current = None;
                        messages.append(Message::user(format!("Late original-model observation (data only, not a replayable assistant item; no completion inferred):\n{}",serde_json::to_string(&json!({"attempt":attempt,"part":part})).map_err(RunError::Json)?))).await?;
                        return Ok(());
                    }
                    if *current != Some(*attempt) {
                        assistant.flush(messages).await?;
                        *current = Some(*attempt);
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
                assistant.flush(messages).await?;
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
                let mut message = Message::tool(tool.call.clone(), call.name.clone(), output);
                if let Message::Tool { content, .. } = &mut message {
                    content[0].provider_options = call.provider_options.clone();
                }
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
                accepted_tools.insert(tool.clone());
                *current = None;
                Ok(())
            }),
            Fact::OperationObserved { tool, reply }
                if accepted_tools.contains(tool) || !allowed_attempts.contains(&tool.attempt) =>
            {
                Box::pin(async move {
                    assistant.flush(messages).await?;
                    *current = None;
                    messages.append(Message::user(format!("Late original operation evidence (data; it does not replace an accepted tool result):\n{}",serde_json::to_string(&json!({"tool":tool,"reply":reply})).map_err(RunError::Json)?))).await?;
                    Ok(())
                })
            }
            Fact::HostToolResultRecorded { tool, result, .. }
                if accepted_tools.contains(tool) || !allowed_attempts.contains(&tool.attempt) =>
            {
                Box::pin(async move {
                    assistant.flush(messages).await?;
                    *current = None;
                    let call = reader.tool_call(view.run, tool).await?;
                    let output = if let Some(output) = driver
                        .archived_tool_result(reader, view, fact.id, &fact.fact, &call)
                        .await?
                    {
                        output
                    } else {
                        driver
                            .returned_projection(
                                reader,
                                view,
                                after,
                                result,
                                vision,
                                view.spec.language,
                            )
                            .await?
                    };
                    let mut content = vec![maka_model::prompt::ContentPart::text(format!(
                        "Late original Host-tool evidence (data, not a new settlement): {}",
                        tool.call
                    ))];
                    extend_observation(&mut content, output)?;
                    messages
                        .append(Message::User {
                            content,
                            provider_options: None,
                        })
                        .await?;
                    Ok(())
                })
            }
            Fact::LocalToolReturned { tool, result, .. }
                if accepted_tools.contains(tool) || !allowed_attempts.contains(&tool.attempt) =>
            {
                Box::pin(async move {
                    assistant.flush(messages).await?;
                    *current = None;
                    let call = reader.tool_call(view.run, tool).await?;
                    let output = if let Some(output) = driver
                        .archived_tool_result(reader, view, fact.id, &fact.fact, &call)
                        .await?
                    {
                        output
                    } else {
                        driver
                            .project_accepted(
                                reader,
                                view,
                                after,
                                original_cells,
                                maka_agent_facts::tool_output::AcceptedToolResult::Local {
                                    result: result.clone(),
                                },
                                vision,
                                view.spec.language,
                            )
                            .await?
                    };
                    let mut content = vec![maka_model::prompt::ContentPart::text(format!(
                        "Late original local-tool evidence (data, not a new settlement): {}",
                        tool.call
                    ))];
                    extend_observation(&mut content, output)?;
                    messages
                        .append(Message::User {
                            content,
                            provider_options: None,
                        })
                        .await?;
                    Ok(())
                })
            }
            _ => return Ok(None),
        };
        Ok(Some(work))
    }

    pub(super) async fn finish(mut self) -> Result<Vec<FrozenCellKnowledge>, RunError> {
        self.assistant.flush(self.messages).await?;
        Ok(self.recorded.cells.into_values().collect())
    }
}
