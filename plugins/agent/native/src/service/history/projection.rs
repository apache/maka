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
use maka_agent_facts::{input::MessageInput, message::MessageOrigin, model::ToolInput};
use wire::{Chunk, HistoryField, Role, SourceField};

mod cells;

pub(super) enum Field {
    Text(TextBody),
    Json(Value),
    Content(ContentRef),
    Receipt(Box<maka_agent_facts::operation::RecordedOperationReply>),
    CellChildReceipt {
        cell: maka_agent_facts::cells::CellId,
        operation: uuid::Uuid,
        reply: Box<maka_agent_facts::operation::RecordedOperationReply>,
    },
    Imported {
        reference: ContentRef,
        selectors: Vec<String>,
        returned: bool,
    },
}
pub(super) enum Body {
    Text(TextBody),
    Field(SourceField),
    Empty,
}
pub(super) struct Row {
    pub chunk: Chunk,
    pub visible: bool,
    pub body: Body,
    pub fields: Vec<(SourceField, Field)>,
}
pub(super) fn visible(fact: &Fact) -> bool {
    use maka_agent_facts::cells::CellEvent;
    match fact {
        Fact::Cell {
            event:
                CellEvent::ChildPrepared { .. }
                | CellEvent::ChildRejected { .. }
                | CellEvent::ChildResultRecorded { .. }
                | CellEvent::LocalChildReturned { .. },
        } => true,
        Fact::Cell {
            event: CellEvent::ChildObserved { reply, .. },
        } => super::super::delivery::recorded_settlement(reply).is_some(),
        Fact::OperationObserved { reply, .. } => {
            super::super::delivery::recorded_settlement(reply).is_some()
        }
        Fact::Cell { .. } => false,
        Fact::ExternalEffect { event } => matches!(
            event,
            maka_agent_facts::external_effects::ExternalEffectEvent::Prepared { .. }
                | maka_agent_facts::external_effects::ExternalEffectEvent::Returned { .. }
        ),
        _ => true,
    }
}
fn base(
    item: &HistoryItem,
    turn: &str,
    index: u64,
    role: Role,
    address: &wire::HistoryRowAddress,
) -> Result<Row, String> {
    let position = address.with_item_index(index);
    Ok(Row {
        visible: visible(&item.recorded.fact),
        chunk: Chunk {
            order: wire::HistoryOrder {
                path: vec![item.sequence],
                item_index: index,
            },
            position,
            model_part: None,
            has_references: false,
            final_output: false,
            model: None,
            origin: None,
            compaction: None,
            timing: None,
            field: HistoryField::Body,
            imported_turn: None,
            message_id: Some(item.recorded.id.to_string()),
            run_id: Some(item.recorded.run),
            turn_id: Some(turn.into()),
            timestamp: Some(
                item.recorded
                    .at
                    .0
                    .try_into()
                    .map_err(|_| "agent_history_timestamp_invalid")?,
            ),
            role,
            offset: 0,
            total_bytes: 0,
            text: String::new(),
            tool: None,
            attachments: Vec::new(),
        },
        body: Body::Empty,
        fields: Vec::new(),
    })
}
fn text(row: &mut Row, field: SourceField, body: TextBody) {
    row.body = Body::Text(body.clone());
    row.fields.push((field, Field::Text(body)));
}
fn user(
    item: &HistoryItem,
    turn: &str,
    index: u64,
    content: &MessageInput,
    message_id: Option<String>,
    origin: Option<MessageOrigin>,
    address: &wire::HistoryRowAddress,
) -> Result<Row, String> {
    let mut row = base(item, turn, index, Role::User, address)?;
    row.chunk.message_id = message_id;
    row.chunk.origin = origin;
    let has_references = content
        .quotes
        .as_ref()
        .is_some_and(|value| !value.is_empty())
        || content
            .directory_references
            .as_ref()
            .is_some_and(|value| !value.is_empty())
        || content
            .inline_references
            .as_ref()
            .is_some_and(|value| !value.is_empty());
    input(
        &mut row,
        Field::Text(
            content
                .display_text
                .as_ref()
                .unwrap_or(&content.text)
                .clone()
                .into(),
        ),
        content.attachments.clone().unwrap_or_default(),
        has_references,
    );
    Ok(row)
}
pub(super) fn input(
    row: &mut Row,
    body: Field,
    attachments: Vec<maka_agent_facts::attachment::AttachmentRef>,
    has_references: bool,
) {
    row.chunk.attachments = attachments;
    row.chunk.has_references = has_references;
    row.body = match &body {
        Field::Text(text) => Body::Text(text.clone()),
        _ => Body::Field(SourceField::Body),
    };
    row.fields.push((SourceField::Body, body));
}
fn apply_display(call: &mut wire::ToolCall, display: &ToolDisplay) {
    call.title = display
        .title
        .as_ref()
        .map(|title| Box::new(maka_agent_facts::display::Text::plain(title.clone())));
    call.presentation = display.presentation.as_deref().map(Into::into);
}
fn tool(row: &mut Row, id: String, name: Option<String>, is_error: Option<bool>) {
    row.chunk.tool = Some(wire::Tool {
        tool_use_id: id,
        call: name.map(|name| wire::ToolCall {
            ancestor_tool_use_ids: Vec::new(),
            origin: wire::ToolCallOrigin::Provider,
            presentation: None,
            position: row.chunk.position.clone(),
            name,
            title: None,
            pending: false,
            dispatched: false,
        }),
        result: is_error.map(|is_error| wire::ToolResult {
            settlement: None,
            position: row.chunk.position.clone(),
            is_error,
            image: false,
            images: 0,
        }),
    });
}

pub(super) async fn project(
    reader: &data::DataSource,
    item: &HistoryItem,
    source: &maka_agent_state::session_history::RunSource,
    address: &wire::HistoryRowAddress,
    views: &mut std::collections::BTreeMap<RunId, maka_agent_state::fold::RunView>,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<Vec<Row>, String> {
    let turn = source.spec.turn_id.as_str();
    let ordinal = match address {
        wire::HistoryRowAddress::Live { item_index, .. }
        | wire::HistoryRowAddress::Snapshot { item_index, .. } => *item_index,
        wire::HistoryRowAddress::Imported { .. } => {
            return Err("agent_history_canonical_address_invalid".into());
        }
    };
    let mut result = Vec::new();
    if matches!(
        item.recorded.fact,
        Fact::RunAdmitted { .. } | Fact::StepPrepared { .. } | Fact::ExternalTaskPrepared { .. }
    ) {
        if let Some(message) = data::input(reader, item.sequence, ordinal).await? {
            result.push(user(
                item,
                turn,
                ordinal,
                &message.message.content,
                Some(message.message.message_id),
                message.message.origin,
                address,
            )?);
        }
        if !result.is_empty() {
            return Ok(result);
        }
    }
    match &item.recorded.fact {
        Fact::RunAdmitted { .. } => {
            let input: RunInput =
                data::content(reader, item.recorded.run, &source.spec.input).await?;
            match input {
                RunInput::Message {
                    content,
                    source_messages,
                    ..
                } => {
                    if source_messages.is_empty() {
                        let id = match &source.spec.trigger {
                            Trigger::Message { message_id } => Some(message_id.clone()),
                            _ => None,
                        };
                        result.push(user(item, turn, 0, &content, id, None, address)?);
                    } else {
                        if let Some(source) = source_messages.into_iter().nth(
                            usize::try_from(ordinal)
                                .map_err(|_| "agent_history_ordinal_invalid")?,
                        ) {
                            result.push(user(
                                item,
                                turn,
                                ordinal,
                                &source.message.content,
                                Some(source.message.message_id),
                                source.message.origin,
                                address,
                            )?);
                        }
                    }
                }
                RunInput::Code { source } => {
                    let mut row = base(item, turn, 0, Role::User, address)?;
                    text(&mut row, SourceField::Body, source.into());
                    result.push(row);
                }
                RunInput::Continuation { .. }
                | RunInput::ContextCompact { .. }
                | RunInput::HistorySource { .. } => {}
            }
        }
        Fact::StepPrepared { step, .. } => {
            let request = reader
                .request(item.recorded.run, *step)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(reference) = request
                .steering
                .get(usize::try_from(ordinal).map_err(|_| "agent_history_ordinal_invalid")?)
            {
                let source: maka_agent_facts::message::RootSourceMessage =
                    data::content(reader, item.recorded.run, reference).await?;
                result.push(user(
                    item,
                    turn,
                    ordinal,
                    &source.message.content,
                    Some(source.message.message_id),
                    source.message.origin,
                    address,
                )?);
            }
        }
        Fact::ModelObserved {
            attempt,
            index,
            part,
            ..
        } => {
            let mut row = base(item, turn, 0, Role::Assistant, address)?;
            row.chunk.model_part = Some(wire::ModelPartIdentity {
                step_id: item.scope.step.ok_or("agent_history_step_missing")?,
                attempt_id: *attempt,
                ordinal: *index,
            });
            row.chunk.message_id = Some(item.recorded.id.to_string());
            if let BackendSpec::Model { binding, .. } = &source.spec.backend {
                if let std::collections::btree_map::Entry::Vacant(e) =
                    views.entry(item.recorded.run)
                {
                    e.insert(
                        reader
                            .view_at(item.recorded.run)
                            .await
                            .map_err(|error| error.to_string())?,
                    );
                }
                let original = views[&item.recorded.run]
                    .attempts
                    .get(attempt)
                    .ok_or("agent_history_original_attempt_missing")?;
                let reported_model_id = match original.closed.as_ref() {
                    Some(closed)
                        if closed.outcome == maka_agent_facts::accounting::Outcome::Success =>
                    {
                        let protocol: maka_agent_facts::context::ModelClosureProtocol =
                            serde::Deserialize::deserialize(&closed.protocol).map_err(|error| {
                                format!("agent_history_model_closure_invalid: {error}")
                            })?;
                        protocol.model
                    }
                    _ => None,
                };
                row.chunk.model = Some(wire::HistoryModel::Native {
                    requested_model_id: binding.model.clone(),
                    reported_model_id,
                });
            }
            match part {
                ModelPart::Text {
                    text_kind,
                    text: body,
                    provider_options,
                } => {
                    row.chunk.field = if *text_kind == TextKind::Thinking {
                        HistoryField::Thinking
                    } else {
                        HistoryField::Body
                    };
                    let body = if *text_kind == TextKind::Thinking {
                        maka_presentation::reasoning_text(body, provider_options.as_deref())
                    } else {
                        body.clone()
                    };
                    let field = if *text_kind == TextKind::Thinking {
                        SourceField::Thinking
                    } else {
                        SourceField::Body
                    };
                    text(&mut row, field, body);
                    if let ModelPart::Text { text: original, .. } = part {
                        row.fields[0].1 = Field::Text(original.clone());
                    }
                }
                ModelPart::Source { source } => {
                    let body = match source {
                        maka_agent_facts::model::ModelSource::Url { url, title, .. } => match title
                        {
                            Some(title) => format!("[{title}]({url})"),
                            None => url.clone(),
                        },
                        maka_agent_facts::model::ModelSource::Document {
                            title, filename, ..
                        } => filename
                            .as_ref()
                            .map_or_else(|| title.clone(), |file| format!("{title} ({file})")),
                    };
                    text(&mut row, SourceField::Body, body.into());
                }
                ModelPart::ToolCall { call } => {
                    row.chunk.role = Role::ToolCall;
                    tool(
                        &mut row,
                        super::super::delivery::tool_id(
                            item.recorded.run,
                            &ToolKey {
                                attempt: *attempt,
                                call: call.id.clone(),
                            },
                        ),
                        Some(call.name.clone()),
                        None,
                    );
                    row.fields
                        .push((SourceField::ToolName, Field::Text(call.name.clone().into())));
                    row.fields.push((
                        SourceField::Arguments,
                        match &call.input {
                            ToolInput::Json(value) => Field::Json(value.clone()),
                            ToolInput::InvalidJson { raw } => Field::Text(raw.clone().into()),
                        },
                    ));
                }
                ModelPart::ToolResult {
                    id,
                    output,
                    is_error,
                    ..
                } => {
                    row.chunk.role = Role::ToolResult;
                    tool(
                        &mut row,
                        super::super::delivery::tool_id(
                            item.recorded.run,
                            &ToolKey {
                                attempt: *attempt,
                                call: id.clone(),
                            },
                        ),
                        None,
                        Some(*is_error),
                    );
                    row.fields
                        .push((SourceField::Result, Field::Json(output.clone())));
                }
            }
            if let std::collections::btree_map::Entry::Vacant(e) = views.entry(item.recorded.run) {
                let view = reader
                    .view_at(item.recorded.run)
                    .await
                    .map_err(|e| e.to_string())?;
                e.insert(view);
            }
            let view = &views[&item.recorded.run];
            row.chunk.final_output = view.terminal == Some(Terminal::Completed)
                && view.current_attempt == Some(*attempt)
                && matches!(
                    part,
                    ModelPart::Source { .. }
                        | ModelPart::Text {
                            text_kind: TextKind::Text,
                            ..
                        }
                );
            if let ModelPart::ToolCall { call } = part {
                let key = ToolKey {
                    attempt: *attempt,
                    call: call.id.clone(),
                };
                if let Some(state) = view.tools.values().find(|tool| tool.key == key)
                    && let Some(call) = row.chunk.tool.as_mut().and_then(|tool| tool.call.as_mut())
                {
                    call.pending = view.terminal.is_none() && state.accepted.is_none();
                    call.dispatched = state.admitted;
                    if let Some(display) = state.decision.as_ref().map(ToolDecision::display) {
                        apply_display(call, display);
                    }
                }
            }
            result.push(row);
        }
        Fact::LocalToolReturned {
            tool: key,
            result: returned,
            is_error,
            ..
        }
        | Fact::HostToolResultRecorded {
            tool: key,
            result: returned,
            is_error,
            ..
        } => {
            let mut row = base(item, turn, 0, Role::ToolResult, address)?;
            tool(
                &mut row,
                super::super::delivery::tool_id(item.recorded.run, key),
                None,
                Some(*is_error),
            );
            if let Fact::LocalToolReturned { settlement, .. } = &item.recorded.fact {
                row.chunk
                    .tool
                    .as_mut()
                    .expect("tool result row")
                    .result
                    .as_mut()
                    .expect("tool result metadata")
                    .settlement = Some(*settlement);
            }
            if let Fact::HostToolResultRecorded { reference, .. } = &item.recorded.fact {
                row.fields.push((
                    SourceField::Receipt,
                    Field::Json(serde_json::to_value(reference).map_err(|e| e.to_string())?),
                ));
            }
            row.fields
                .push((SourceField::Result, Field::Content(returned.clone())));
            result.push(row);
        }
        Fact::ToolResultAccepted {
            tool: key,
            result: reference,
            outcome,
        } => {
            use maka_agent_facts::{cells::CellStatus, tool_call::ToolSettlement};
            let settlement = match outcome {
                AcceptedResult::Succeeded => ToolSettlement::Returned,
                AcceptedResult::Failed => ToolSettlement::Failed,
                AcceptedResult::Rejected => ToolSettlement::Rejected,
                AcceptedResult::RiskAdjudicated { .. } => ToolSettlement::Unknown,
                AcceptedResult::CellRecovered { cell } => {
                    if let std::collections::btree_map::Entry::Vacant(e) =
                        views.entry(item.recorded.run)
                    {
                        e.insert(
                            reader
                                .view_at(item.recorded.run)
                                .await
                                .map_err(|error| error.to_string())?,
                        );
                    }
                    match views[&item.recorded.run]
                        .cells
                        .get(cell)
                        .ok_or("agent_history_cell_missing")?
                        .status
                    {
                        CellStatus::Completed { .. } => ToolSettlement::Returned,
                        CellStatus::Interrupted { .. } => ToolSettlement::Failed,
                        CellStatus::Running => {
                            return Err("agent_history_cell_result_not_final".into());
                        }
                    }
                }
            };
            let mut row = base(item, turn, 0, Role::ToolResult, address)?;
            tool(
                &mut row,
                super::super::delivery::tool_id(item.recorded.run, key),
                None,
                Some(settlement != ToolSettlement::Returned),
            );
            row.chunk
                .tool
                .as_mut()
                .and_then(|tool| tool.result.as_mut())
                .expect("accepted tool result")
                .settlement = Some(settlement);
            row.fields
                .push((SourceField::Result, Field::Content(reference.clone())));
            result.push(row);
        }
        Fact::OperationObserved { tool: key, reply } => {
            let mut row = base(item, turn, 0, Role::ToolResult, address)?;
            let settlement = super::super::delivery::recorded_settlement(reply);
            tool(
                &mut row,
                super::super::delivery::tool_id(item.recorded.run, key),
                None,
                settlement
                    .map(|value| value != maka_agent_facts::tool_call::ToolSettlement::Returned),
            );
            if let Some(result) = row
                .chunk
                .tool
                .as_mut()
                .and_then(|tool| tool.result.as_mut())
            {
                result.settlement = settlement;
            }
            row.fields.push((
                SourceField::Receipt,
                Field::Receipt(Box::new(reply.clone())),
            ));
            result.push(row);
        }
        Fact::ExternalEffect { event } => {
            use maka_agent_facts::external_effects::{
                ExternalEffectDescriptor, ExternalEffectEvent,
            };
            let key = event.key();
            if !matches!(
                event,
                ExternalEffectEvent::Prepared { .. } | ExternalEffectEvent::Returned { .. }
            ) {
                return Ok(result);
            }
            if let std::collections::btree_map::Entry::Vacant(e) = views.entry(item.recorded.run) {
                e.insert(
                    reader
                        .view_at(item.recorded.run)
                        .await
                        .map_err(|error| error.to_string())?,
                );
            }
            let view = &views[&item.recorded.run];
            let state = view
                .external
                .as_ref()
                .filter(|external| external.task == key.task)
                .and_then(|external| external.effects.get(&key.operation))
                .ok_or("agent_history_external_effect_missing")?;
            let descriptor: ExternalEffectDescriptor =
                data::content(reader, item.recorded.run, &state.descriptor).await?;
            let id = maka_agent_facts::tool_call::tool_use_id(
                item.recorded.run,
                &descriptor.operation_id,
            );
            let mut row = match event {
                ExternalEffectEvent::Prepared { .. } => {
                    let mut row = base(item, turn, 0, Role::ToolCall, address)?;
                    tool(&mut row, id, Some(descriptor.name.clone()), None);
                    let call = row
                        .chunk
                        .tool
                        .as_mut()
                        .and_then(|tool| tool.call.as_mut())
                        .expect("external Host call");
                    call.origin = wire::ToolCallOrigin::HostSdk;
                    if let Some(display) = &state.display {
                        apply_display(call, display);
                    }
                    call.dispatched = state.admitted;
                    call.pending = view.terminal.is_none()
                        && state.returned.is_none()
                        && state.rejected.is_none();
                    row.fields
                        .push((SourceField::Arguments, Field::Json(descriptor.input)));
                    row
                }
                ExternalEffectEvent::Returned { output, .. } => {
                    let (is_error, settlement) = super::stream::external_result_metadata(
                        reader,
                        item.recorded.run,
                        output,
                        stop,
                    )
                    .await?;
                    let mut row = base(item, turn, 0, Role::ToolResult, address)?;
                    tool(&mut row, id, None, Some(is_error));
                    row.chunk
                        .tool
                        .as_mut()
                        .and_then(|tool| tool.result.as_mut())
                        .expect("external Host return")
                        .settlement = Some(settlement);
                    row.fields
                        .push((SourceField::Result, Field::Content(output.clone())));
                    row
                }
                _ => unreachable!("selected external history event"),
            };
            row.fields
                .push((SourceField::ToolName, Field::Text(descriptor.name.into())));
            result.push(row);
        }
        Fact::ExternalTaskObserved { task, output, .. } => {
            use maka_agent_facts::executor::Output;
            let mut row = base(item, turn, 0, Role::Assistant, address)?;
            row.chunk.message_id = Some(item.recorded.id.to_string());
            match output {
                Output::OutputDelta {
                    message_id,
                    text: body,
                }
                | Output::ThinkingDelta {
                    message_id,
                    text: body,
                } => {
                    let thinking = matches!(output, Output::ThinkingDelta { .. });
                    if !thinking {
                        if let std::collections::btree_map::Entry::Vacant(e) =
                            views.entry(item.recorded.run)
                        {
                            e.insert(
                                reader
                                    .view_at(item.recorded.run)
                                    .await
                                    .map_err(|error| error.to_string())?,
                            );
                        }
                        row.chunk.final_output = views[&item.recorded.run]
                            .external
                            .as_ref()
                            .filter(|external| external.task == *task)
                            .and_then(|external| external.closed.as_ref())
                            .and_then(|closed| closed.final_message.as_ref())
                            .is_some_and(|final_message| final_message.message_id == *message_id);
                    }
                    row.chunk.field = if thinking {
                        HistoryField::Thinking
                    } else {
                        HistoryField::Body
                    };
                    text(
                        &mut row,
                        if thinking {
                            SourceField::Thinking
                        } else {
                            SourceField::Body
                        },
                        body.clone().into(),
                    );
                }
                Output::ToolStart {
                    tool_call_id,
                    name,
                    input,
                } => {
                    row.chunk.role = Role::ToolCall;
                    let id = maka_agent_facts::tool_call::tool_use_id(
                        item.recorded.run,
                        &format!("{task}:{tool_call_id}"),
                    );
                    tool(&mut row, id, Some(name.clone()), None);
                    row.fields
                        .push((SourceField::ToolName, Field::Text(name.clone().into())));
                    row.fields
                        .push((SourceField::Arguments, Field::Json(input.clone())));
                }
                Output::ToolProgress {
                    tool_call_id,
                    text: body,
                }
                | Output::ToolResult {
                    tool_call_id,
                    text: body,
                    ..
                } => {
                    row.chunk.role = Role::ToolResult;
                    let id = maka_agent_facts::tool_call::tool_use_id(
                        item.recorded.run,
                        &format!("{task}:{tool_call_id}"),
                    );
                    let is_error = match output {
                        Output::ToolResult { is_error, .. } => Some(*is_error),
                        _ => None,
                    };
                    tool(&mut row, id, None, is_error);
                    text(&mut row, SourceField::Result, body.clone().into());
                }
                Output::MessageStart { .. } | Output::MessageEnd { .. } => return Ok(result),
            }
            result.push(row);
        }
        Fact::Cell { event } => {
            if let std::collections::btree_map::Entry::Vacant(e) = views.entry(item.recorded.run) {
                e.insert(
                    reader
                        .view_at(item.recorded.run)
                        .await
                        .map_err(|error| error.to_string())?,
                );
            }
            result.push(cells::project(
                item,
                turn,
                address,
                event,
                &views[&item.recorded.run],
            )?);
        }
        Fact::ContextCompacted { baseline } => {
            let compact: maka_agent_facts::context::CompactedContext =
                data::content(reader, item.recorded.run, baseline).await?;
            compact.validate().map_err(str::to_owned)?;
            let mut row = base(item, turn, 0, Role::Compaction, address)?;
            let started = reader
                .compaction_started_at(
                    item.recorded.run,
                    compact.checkpoint.summary_step_id,
                    item.sequence,
                )
                .await
                .map_err(|error| error.to_string())?;
            let duration = item
                .recorded
                .at
                .0
                .checked_sub(started.0)
                .and_then(|value| u64::try_from(value).ok())
                .ok_or("agent_history_compaction_timing_invalid")?;
            row.chunk.compaction = Some(wire::Compaction {
                duration_ms: duration,
            });
            if let maka_agent_facts::context::CheckpointContent::Text(summary) =
                compact.checkpoint.summary
            {
                row.body = Body::Text(summary.into());
            }
            row.fields
                .push((SourceField::Body, Field::Content(baseline.clone())));
            result.push(row);
        }
        Fact::ModelInterrupted { diagnostic, .. } => {
            let mut row = base(item, turn, 0, Role::Failure, address)?;
            text(
                &mut row,
                SourceField::FailureMessage,
                diagnostic.clone().into(),
            );
            result.push(row);
        }
        Fact::RunTerminated {
            diagnostic: Some(diagnostic),
            ..
        } => {
            let mut row = base(item, turn, 0, Role::Failure, address)?;
            text(
                &mut row,
                SourceField::FailureMessage,
                diagnostic.clone().into(),
            );
            result.push(row);
        }
        _ => {}
    }
    for row in &mut result {
        if row.chunk.role == Role::ToolResult {
            super::media::describe_source(reader, item, row, stop).await?;
        }
    }
    Ok(result)
}
