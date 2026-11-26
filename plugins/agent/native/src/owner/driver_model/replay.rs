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
    DriverModel, FrozenCellKnowledge, HistorySource, ReplayedTail, extend_observation,
    flush_assistant, merge_skill, recovered::RecordedInputs,
};
use crate::tools::HistoryReader;
use futures_util::future::BoxFuture;
use maka_agent_engine::{RunError, preparation};
use maka_agent_facts::{
    context::{CodexRequestProvenance, ModelPurpose},
    durable::{AcceptedResult, Fact, ModelAttemptId, RecordedFact, ToolDecision, ToolKey},
    execution::SystemPrompt,
    model::{ModelPart, ModelToolCall, prompt::Message, prompt_source::source::ReplayOrigin},
    operation::RecordedOperationReply,
    tool_call::ToolRejection,
    tool_output::AcceptedToolResult,
};
use maka_agent_state::{fold::RunView, memory::recall::ArchiveRestriction};
use maka_model::prompt::{AssistantPart, ToolOutput};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
struct AssistantBatch {
    attempt: Option<ModelAttemptId>,
    parts: Vec<AssistantPart>,
    producer: Option<Producer>,
    tool_outputs: Vec<Message>,
    last_emitted_attempt: Option<ModelAttemptId>,
}

struct Producer {
    model_id: String,
    codex: Option<CodexRequestProvenance>,
}

impl AssistantBatch {
    fn is_attempt(&self, attempt: ModelAttemptId) -> bool {
        self.attempt == Some(attempt)
    }

    async fn ensure_attempt(
        &mut self,
        attempt: ModelAttemptId,
        view: &RunView,
        prefix_attempt: Option<ModelAttemptId>,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<(), RunError> {
        if !self.is_attempt(attempt) {
            self.flush(view, prefix_attempt, messages).await?;
            self.attempt = Some(attempt);
        }
        Ok(())
    }

    async fn flush(
        &mut self,
        view: &RunView,
        prefix_attempt: Option<ModelAttemptId>,
        messages: &mut preparation::PromptBuilder,
    ) -> Result<(), RunError> {
        // Always drain the whole batch so early returns can never leak stale state into the next attempt.
        let attempt = self.attempt.take();
        let producer = self.producer.take();
        let mut parts = std::mem::take(&mut self.parts);
        let tool_outputs = std::mem::take(&mut self.tool_outputs);
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
        let has_committed_output = !tool_outputs.is_empty()
            || parts
                .iter()
                .any(|part| !matches!(part, AssistantPart::Reasoning { .. }));
        if !keep_reasoning_only && !has_committed_output {
            return Ok(());
        }
        if !parts.is_empty() {
            self.last_emitted_attempt = attempt;
            match producer {
                Some(producer) => {
                    super::append_observed(
                        messages,
                        Message::Assistant {
                            content: parts,
                            provider_options: None,
                        },
                        ReplayOrigin::observed(&producer.model_id, producer.codex.as_ref()),
                    )
                    .await
                }
                None => flush_assistant(messages, &mut parts).await,
            }?;
        }
        for output in tool_outputs {
            messages.append(output).await?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FailureNote {
    Include,
    Omit,
}

pub(super) struct TailReplay<'a, 'source> {
    aliases: BTreeMap<String, HistoryReader>,
    driver: &'a DriverModel,
    target: super::ReplayTarget<'a>,
    failure_note: FailureNote,
    reader: &'a HistorySource<'source>,
    view: &'a RunView,
    prefix_attempt: Option<ModelAttemptId>,
    vision: bool,
    system: &'a mut Option<SystemPrompt>,
    messages: &'a mut preparation::PromptBuilder,
    recorded: RecordedInputs,
    assistant: AssistantBatch,
    allowed_attempts: BTreeSet<ModelAttemptId>,
    compaction_request: Option<ToolKey>,
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
        failure_note: FailureNote,
        aliases: BTreeMap<String, HistoryReader>,
    ) -> Self {
        Self {
            aliases,
            driver,
            target,
            failure_note,
            reader,
            view,
            prefix_attempt,
            vision,
            system,
            messages,
            recorded,
            assistant: AssistantBatch::default(),
            allowed_attempts: BTreeSet::new(),
            compaction_request: None,
        }
    }

    pub(super) fn apply<'b>(
        &'b mut self,
        fact: &'b RecordedFact,
        restriction: Option<ArchiveRestriction>,
    ) -> Result<Option<BoxFuture<'b, Result<(), RunError>>>, RunError> {
        let Self {
            aliases,
            driver,
            target,
            failure_note,
            reader,
            view,
            prefix_attempt,
            vision,
            system,
            messages,
            recorded:
                RecordedInputs {
                    unfinished_provider_calls,
                    cells: original_cells,
                    restricted_cells,
                    steering: steering_messages,
                    notifications: notification_facts,
                    step_purposes,
                    attempt_steps,
                },
            assistant,
            allowed_attempts,
            compaction_request,
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
                assistant.flush(view, prefix_attempt, messages).await?;
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
                }
                let frozen = driver.frozen_input(reader, view.run, &request).await?;
                for notice in frozen.notifications {
                    if !notification_facts.insert((view.run, notice.id)) {
                        continue;
                    }
                    if view.run != driver.execution.run_id
                        && (restricted_cells.notifications.contains(&notice.id)
                            || restricted_cells.includes(
                                notice.cell,
                                notice
                                    .knowledge
                                    .as_ref()
                                    .map_or(notice.through, |knowledge| knowledge.through),
                            ))
                    {
                        messages
                            .append(Message::User {
                                content: vec![maka_model::prompt::ContentPart::text(
                                    FRESH_READ.to_owned(),
                                )],
                                provider_options: None,
                            })
                            .await?;
                        continue;
                    }
                    driver
                        .append_notification(
                            reader,
                            view,
                            notice.through,
                            &maka_agent_state::cells::PendingNotification {
                                cell: notice.cell,
                                id: notice.id,
                                content: notice.content,
                            },
                            notice.knowledge.as_ref(),
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
                    assistant.flush(view, prefix_attempt, messages).await?;
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
                    let redacted;
                    let part = match (restriction, part) {
                        (Some(ArchiveRestriction::Source), ModelPart::ToolCall { call }) => {
                            redacted = ModelPart::ToolCall {
                                call: ModelToolCall {
                                    id: call.id.clone(),
                                    name: call.name.clone(),
                                    input: maka_agent_facts::model::ToolInput::Json(
                                        json!({"gap": "Historical tool arguments are restricted"}),
                                    ),
                                    provider_options: None,
                                    provider_executed: call.provider_executed,
                                },
                            };
                            &redacted
                        }
                        (Some(_), ModelPart::ToolResult { id, name, .. }) => {
                            redacted = ModelPart::ToolResult {
                                id: id.clone(),
                                name: name.clone(),
                                output: json!({"gap": FRESH_READ}),
                                is_error: true,
                                provider_options: None,
                            };
                            &redacted
                        }
                        _ => part,
                    };
                    if !allowed_attempts.contains(attempt) {
                        assistant.flush(view, prefix_attempt, messages).await?;
                        messages.append(Message::user(format!("Late original-model observation (data only, not a replayable assistant item; no completion inferred):\n{}",serde_json::to_string(&json!({"attempt":attempt,"part":part})).map_err(RunError::Json)?))).await?;
                        return Ok(());
                    }
                    assistant
                        .ensure_attempt(*attempt, view, prefix_attempt, messages)
                        .await?;
                    if let ModelPart::ToolCall { call } = part
                        && call.provider_executed
                        && unfinished_provider_calls.contains(&ToolKey {
                            attempt: *attempt,
                            call: call.id.clone(),
                        })
                    {
                        assistant.parts.push(AssistantPart::Text {
                            text: format!("The provider started tool {} (call ID {}). Its outcome is unknown. Continue without repeating this call.", json!(call.name), json!(call.id)),
                            provider_options: None,
                        });
                        return Ok(());
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
                            let output = if restriction.is_some()
                                || (view.run != driver.execution.run_id
                                    && sensitive_tool(
                                        view,
                                        tool,
                                        aliases,
                                        restricted_cells,
                                        view.revision,
                                    )) {
                                ToolOutput::Json(json!({"gap": FRESH_READ}))
                            } else {
                                unaccepted_tool_output(
                                    driver,
                                    reader,
                                    view,
                                    original_cells,
                                    *attempt,
                                    tool,
                                    vision,
                                )
                                .await?
                            };
                            assistant.tool_outputs.push(tool_message(call, output));
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
            Fact::ToolResultAccepted {
                tool,
                result,
                outcome,
            } => Box::pin(async move {
                let call = reader.tool_call(view.run, tool).await?;
                if call.provider_executed {
                    return Ok(());
                }
                if !assistant.is_attempt(tool.attempt) {
                    assistant.flush(view, prefix_attempt, messages).await?;
                }
                if call.name == crate::owner::compaction::TOOL
                    && *outcome == AcceptedResult::Succeeded
                {
                    *compaction_request = Some(tool.clone());
                }
                let output = if restriction.is_some()
                    || (view.run != driver.execution.run_id
                        && sensitive_tool(
                            view,
                            view.tools
                                .get(&maka_agent_state::fold::tool_key(tool))
                                .ok_or_else(|| {
                                    RunError::ReconciliationRequired(
                                        "historical result lost its tool call".into(),
                                    )
                                })?,
                            aliases,
                            restricted_cells,
                            after,
                        )) {
                    ToolOutput::Json(json!({"gap": FRESH_READ}))
                } else if let Some(output) = driver
                    .archived_tool_result(reader, view, after, fact.id, &fact.fact, &call, vision)
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
                if assistant.is_attempt(tool.attempt) {
                    // More calls may still arrive from this attempt.
                    assistant.tool_outputs.push(message);
                } else if allowed_attempts.contains(&tool.attempt) {
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
                Ok(())
            }),
            // Later turns otherwise replay the failed turn as if it had simply stopped.
            Fact::RunTerminated {
                terminal: maka_agent_facts::durable::Terminal::Failed,
                diagnostic,
            } => Box::pin(async move {
                assistant.flush(view, prefix_attempt, messages).await?;
                if *failure_note == FailureNote::Include {
                    messages
                        .append(Message::user(failed_turn_note(
                            view.spec.language,
                            diagnostic.as_deref().filter(|_| restriction.is_none()),
                        )))
                        .await?;
                }
                Ok(())
            }),
            _ => return Ok(None),
        };
        Ok(Some(work))
    }

    pub(super) async fn finish(mut self) -> Result<ReplayedTail, RunError> {
        self.assistant
            .flush(self.view, self.prefix_attempt, self.messages)
            .await?;
        Ok(ReplayedTail {
            cells: self.recorded.cells.into_values().collect(),
            compaction_request: self.compaction_request,
            last_emitted_attempt: self.assistant.last_emitted_attempt,
        })
    }
}

const FRESH_READ: &str = "Archived output requires a fresh authorized read";

fn reader_kind(name: &str, aliases: &BTreeMap<String, HistoryReader>) -> HistoryReader {
    aliases
        .get(name)
        .copied()
        .or_else(|| HistoryReader::builtin(name))
        .unwrap_or(HistoryReader::Other)
}

fn sensitive_call(kind: HistoryReader, input: Option<&serde_json::Value>) -> bool {
    match kind {
        HistoryReader::Session => true,
        HistoryReader::Other => false,
        HistoryReader::File => input
            .and_then(|v| v.get("path")?.as_str())
            .is_some_and(maka_agent_facts::read::reads_history_resource),
    }
}

pub(super) async fn sensitive_child(
    reader: &HistorySource<'_>,
    run: maka_agent_facts::durable::RunId,
    name: &str,
    input: &maka_agent_facts::durable::ContentRef,
    aliases: &BTreeMap<String, HistoryReader>,
) -> Result<bool, RunError> {
    let kind = reader_kind(name, aliases);
    let input = if kind == HistoryReader::File {
        Some(reader.decode(run, input).await?)
    } else {
        None
    };
    Ok(sensitive_call(kind, input.as_ref()))
}

fn sensitive_tool(
    view: &RunView,
    tool: &maka_agent_state::fold::Tool,
    aliases: &BTreeMap<String, HistoryReader>,
    restricted: &super::recovered::RestrictedCells,
    through: u64,
) -> bool {
    if sensitive_call(
        reader_kind(&tool.call.name, aliases),
        tool.call.input.as_json(),
    ) {
        return true;
    }
    if tool.local_returned.is_some() {
        return restricted
            .returns
            .contains(&maka_agent_state::fold::tool_key(&tool.key));
    }
    view.original_cell(tool)
        .is_some_and(|cell| restricted.includes(cell.id, through))
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
    if let Some(cell_view) = view.original_cell(tool)
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
                    AcceptedToolResult::RecoveredCell {
                        cell: cell_view.id,
                        evidence,
                    },
                    vision,
                    view.spec.language,
                )
                .await;
        }
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
        return Ok(ToolOutput::ErrorText(
            ToolRejection::for_refused_approval(&refusal.outcome).to_string(),
        ));
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

const MAX_FAILED_TURN_DIAGNOSTIC_CHARS: usize = 512;

fn failed_turn_note(
    language: maka_agent_facts::language::Language,
    diagnostic: Option<&str>,
) -> String {
    let normalized = diagnostic
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| {
            if text.chars().count() <= MAX_FAILED_TURN_DIAGNOSTIC_CHARS {
                text.to_owned()
            } else {
                let truncated: String = text
                    .chars()
                    .take(MAX_FAILED_TURN_DIAGNOSTIC_CHARS)
                    .collect();
                format!("{truncated}…")
            }
        });
    match normalized.as_deref() {
        Some(reason) => {
            maka_agent_facts::i18n::driver::failed_turn_note_with_reason(language, reason)
        }
        None => maka_agent_facts::i18n::driver::failed_turn_note(language).into(),
    }
}

#[cfg(test)]
mod failed_turn_note_tests {
    use super::*;
    use maka_agent_facts::language::Language;

    #[test]
    fn normalizes_blank_and_truncates_overlong_diagnostics() {
        assert_eq!(
            failed_turn_note(Language::EN, Some("   \n\t  ")),
            "[Host] This turn failed and ended here."
        );
        let huge = "错".repeat(MAX_FAILED_TURN_DIAGNOSTIC_CHARS + 50);
        let note = failed_turn_note(Language::ZH_CN, Some(&huge));
        assert!(note.starts_with("[Host] 这一轮失败，在此结束："), "{note}");
        assert!(note.ends_with('…'), "{note}");
        assert!(note.chars().count() < MAX_FAILED_TURN_DIAGNOSTIC_CHARS + 30);
    }
}

#[cfg(test)]
mod tests {
    use super::{reader_kind, sensitive_call};
    use crate::tools::ServiceSelection;
    use rusqlite::{Connection, params};
    use serde_json::{Value, json};

    #[test]
    fn replay_and_archive_use_the_captured_history_reader() {
        let db = Connection::open_in_memory().unwrap();
        let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(maka_agent_state::MIGRATIONS)
            .copied()
            .collect();
        maka_event_log::migration::run(&db, &migrations).unwrap();
        let blob = |value: &Value| {
            let bytes = serde_json::to_vec(value).unwrap();
            let digest = maka_agent_facts::artifact::content_digest(&bytes);
            let id = maka_event_log::content::put(&db, &digest, &bytes).unwrap();
            (id, digest)
        };
        let services = [
            ("SessionRead", "web", "import", "search", "web", "other"),
            ("FindMessages", "agent", "export", "search", "json", "session"),
            ("ReadNotes", "files", "import", "read", "json", "file"),
        ].map(|(name, target, kind, method, input, reader)| json!({
            "history_reader": reader,
            "selection": {"name":name,"description":name,"method":method,"target":{"kind":kind,"name":target},
                "input":input,"result":"json","confirmation":"preapproved"}
        }));
        let input = json!({"query":"notes", "path":"maka://session/test"});
        let (_, selection) = blob(&json!({"services":services}));
        let (spec, _) = blob(&json!({"toolSelection":{"digest":selection}}));
        let run = "run";
        db.execute("INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES(?,1,'owner','chat',?)", params![run,spec]).unwrap();
        for (i, service) in services.iter().enumerate() {
            let name = service["selection"]["name"].as_str().unwrap();
            let call = json!({"fact":{"part":{"call":{"name":name,"input":{"data":input}}}}});
            for (seq, kind, payload, is_call) in [
                (1 + 2 * i as i64, "model_observed", call, true),
                (
                    1 + 2 * i as i64 + 1,
                    "local_tool_returned",
                    json!({"fact":{}}),
                    false,
                ),
            ] {
                let fact = format!("fact-{seq}");
                let (id, _) = blob(&payload);
                db.execute(
                    "INSERT INTO agent_facts VALUES(?,?,?,?,1,1,?)",
                    params![seq, fact, run, seq, id],
                )
                .unwrap();
                db.execute("INSERT INTO agent_session_history(owner,session,sequence,run,admission_sequence,kind,prefix_digest,tool_start,opening_message,fact_id,result_source,tool_use_id)
                    VALUES('owner','chat',?,?,1,?,'prefix',?,0,?,?,?)",params![seq,run,kind,is_call,fact,!is_call,name]).unwrap();
            }
        }
        let restricted = db
            .prepare(
                "SELECT h.tool_use_id FROM agent_memory_recall_outputs r
                 JOIN agent_session_history h ON h.owner=r.owner AND h.fact_id=r.fact ORDER BY h.tool_use_id",
            )
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let aliases = services
            .iter()
            .cloned()
            .map(|value| serde_json::from_value::<ServiceSelection>(value).unwrap())
            .filter_map(ServiceSelection::history_alias)
            .collect();
        let mut replay: Vec<_> = services
            .iter()
            .map(|service| service["selection"]["name"].as_str().unwrap())
            .filter(|name| sensitive_call(reader_kind(name, &aliases), Some(&input)))
            .collect();
        replay.sort_unstable();
        assert_eq!(replay, ["FindMessages", "ReadNotes"]);
        assert_eq!(restricted, replay);
    }
}
