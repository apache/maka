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

use crate::message::message;
use crate::tool_message_id;
use crate::{Content, Message, ProjectionError, ToolContent};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelPart;
use maka_agent_facts::model::ModelStep;
use maka_agent_facts::model::ToolInput;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_agent_facts::tool_output::ToolOutput;

mod state;
use state::CallState;
pub(super) use state::Tools;

fn display_input(input: &ToolInput) -> serde_json::Value {
    match input {
        ToolInput::Json(value) => value.clone(),
        ToolInput::InvalidJson { raw } => serde_json::Value::String(raw.clone()),
    }
}

impl Tools {
    pub fn accept(
        &mut self,
        event: &RuntimeEvent,
        ts: u64,
        step: &str,
        output: &ModelStep,
        text: Vec<Message>,
    ) -> Result<Vec<Message>, ProjectionError> {
        let anchor = text.last().map(|message| message.id.clone());
        let mut text = text.into_iter();
        let mut rows = Vec::new();
        for (index, part) in output.parts.iter().enumerate() {
            if matches!(part, ModelPart::Text { .. }) {
                rows.push(
                    text.next()
                        .ok_or(ProjectionError::Invalid("missing accepted text"))?,
                );
            } else {
                rows.extend(self.accept_item(
                    event,
                    ts,
                    step,
                    index,
                    part,
                    anchor.as_deref(),
                    output.model.as_deref().unwrap_or_default(),
                )?);
            }
        }
        Ok(rows)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn accept_item(
        &mut self,
        event: &RuntimeEvent,
        ts: u64,
        step: &str,
        index: usize,
        part: &ModelPart,
        anchor: Option<&str>,
        model: &str,
    ) -> Result<Vec<Message>, ProjectionError> {
        let mut rows = Vec::new();
        match part {
            ModelPart::Source { source } => {
                let text = match source {
                    maka_agent_facts::model::ModelSource::Url { url, title, .. } => {
                        format!("Source: {}\n{}", title.as_deref().unwrap_or(""), url)
                    }
                    maka_agent_facts::model::ModelSource::Document {
                        title, filename, ..
                    } => format!("Source: {}\n{}", title, filename.as_deref().unwrap_or("")),
                };
                rows.push(message(
                    event,
                    ts,
                    format!("{}:source:{index}", event.id),
                    Content::Assistant {
                        imported: false,
                        text,
                        model_id: model.to_owned(),
                        interrupted: false,
                        thinking: None,
                        provider_options: None,
                    },
                ));
            }
            ModelPart::Text { .. } => {}
            ModelPart::ToolCall { call } => {
                let operation = format!("{step}:{}", call.id);
                let identity = ToolCallIdentity::provider(step.into(), call.id.clone());
                let metadata = self.insert(
                    &operation,
                    identity,
                    &call.name,
                    call.input.clone(),
                    if call.provider_executed {
                        CallState::ProviderExecuted
                    } else {
                        CallState::AwaitingDispatch
                    },
                    event,
                )?;
                rows.push(message(
                    event,
                    ts,
                    tool_message_id(&event.invocation.invocation_id, &operation),
                    Content::ToolCall {
                        tool_name: call.name.clone(),
                        args: display_input(&call.input),
                        step_id: anchor.map(str::to_owned),
                        provider_options: call.provider_options.clone(),
                        provider_executed: Some(call.provider_executed),
                        metadata,
                    },
                ));
            }
            ModelPart::ToolResult {
                id,
                name,
                output,
                is_error,
                ..
            } => {
                let operation = format!("{step}:{id}");
                let pending = self
                    .pending
                    .get(&operation)
                    .ok_or(ProjectionError::Invalid("provider result without call"))?;
                if pending.name != *name || pending.state != CallState::ProviderExecuted {
                    return Err(ProjectionError::Invalid("provider result name mismatch"));
                }
                rows.push(self.result(
                    event,
                    ts,
                    &operation,
                    maka_agent_facts::tool_call::provider_result_id(&event.id, index),
                    *is_error,
                    ToolContent::Json {
                        value: output.clone(),
                    },
                )?);
            }
        }
        Ok(rows)
    }
    pub fn boundary(
        &mut self,
        event: &RuntimeEvent,
        ts: u64,
        resolved: Option<&ToolOutput>,
    ) -> Result<Vec<Message>, ProjectionError> {
        let metadata = match &event.fact {
            Fact::ToolDispatched {
                operation_id,
                call,
                name,
                ..
            }
            | Fact::ToolRejected {
                operation_id,
                call,
                name,
                ..
            } => {
                let rejected = matches!(event.fact, Fact::ToolRejected { .. });
                if matches!(call.origin, ToolOrigin::Provider { .. }) {
                    let pending =
                        self.pending
                            .get_mut(operation_id)
                            .ok_or(ProjectionError::Invalid(
                                "provider dispatch without accepted call",
                            ))?;
                    let same_input = match &event.fact {
                        Fact::ToolDispatched { input, .. } => {
                            pending.input.as_json() == Some(input)
                        }
                        Fact::ToolRejected { input, .. } => pending.input == *input,
                        _ => unreachable!("tool admission fact"),
                    };
                    if pending.identity != *call
                        || pending.name != *name
                        || !same_input
                        || pending.state != CallState::AwaitingDispatch
                    {
                        return Err(ProjectionError::Invalid(
                            "dispatch differs from accepted call",
                        ));
                    }
                    if !rejected {
                        pending.state = CallState::Dispatched;
                    }
                } else {
                    let input = match &event.fact {
                        Fact::ToolDispatched { input, .. } => ToolInput::Json(input.clone()),
                        Fact::ToolRejected { input, .. } => input.clone(),
                        _ => unreachable!("tool admission fact"),
                    };
                    self.insert(
                        operation_id,
                        call.clone(),
                        name,
                        input,
                        if rejected {
                            CallState::AwaitingDispatch
                        } else {
                            CallState::Dispatched
                        },
                        event,
                    )?;
                }
                if rejected {
                    self.pending
                        .remove(operation_id)
                        .expect("admitted tool is pending")
                        .metadata
                } else {
                    self.pending[operation_id].metadata.clone()
                }
            }
            Fact::ToolSettled { operation_id, .. } => {
                if !self
                    .pending
                    .get(operation_id)
                    .is_some_and(|pending| pending.state == CallState::Dispatched)
                {
                    return Err(ProjectionError::Invalid("result without dispatch"));
                }
                self.pending
                    .remove(operation_id)
                    .expect("dispatched tool is pending")
                    .metadata
            }
            _ => unreachable!("tool boundary fact"),
        };
        boundary_messages(event, ts, metadata, resolved)
    }
    fn result(
        &mut self,
        event: &RuntimeEvent,
        ts: u64,
        operation: &str,
        id: String,
        is_error: bool,
        content: ToolContent,
    ) -> Result<Message, ProjectionError> {
        let pending = self
            .pending
            .remove(operation)
            .ok_or(ProjectionError::Invalid("result without call"))?;
        Ok(result_message(
            event,
            ts,
            operation,
            id,
            is_error,
            content,
            pending.metadata,
        ))
    }
}

fn result_message(
    event: &RuntimeEvent,
    ts: u64,
    operation: &str,
    id: String,
    is_error: bool,
    content: ToolContent,
    metadata: crate::ToolMetadata,
) -> Message {
    message(
        event,
        ts,
        id,
        Content::ToolResult {
            tool_use_id: tool_message_id(&event.invocation.invocation_id, operation),
            settlement: match &event.fact {
                Fact::ToolRejected { .. } => {
                    Some(maka_agent_facts::tool_call::ToolSettlement::Rejected)
                }
                Fact::ToolSettled { outcome, .. } => Some(match outcome {
                    maka_agent_facts::event::ToolOutcome::Succeeded { .. } => {
                        maka_agent_facts::tool_call::ToolSettlement::Returned
                    }
                    maka_agent_facts::event::ToolOutcome::Failed { .. } => {
                        maka_agent_facts::tool_call::ToolSettlement::Failed
                    }
                    maka_agent_facts::event::ToolOutcome::Unknown { .. } => {
                        maka_agent_facts::tool_call::ToolSettlement::Unknown
                    }
                }),
                _ => None,
            },
            is_error,
            content,
            metadata,
        },
    )
}

fn boundary_messages(
    event: &RuntimeEvent,
    ts: u64,
    metadata: crate::ToolMetadata,
    resolved: Option<&ToolOutput>,
) -> Result<Vec<Message>, ProjectionError> {
    match &event.fact {
        Fact::ToolDispatched {
            operation_id,
            call,
            name,
            ..
        }
        | Fact::ToolRejected {
            operation_id,
            call,
            name,
            ..
        } => {
            let mut rows = Vec::new();
            if !matches!(call.origin, ToolOrigin::Provider { .. }) {
                let args = match &event.fact {
                    Fact::ToolDispatched { input, .. } => input.clone(),
                    Fact::ToolRejected { input, .. } => display_input(input),
                    _ => unreachable!("tool admission fact"),
                };
                rows.push(message(
                    event,
                    ts,
                    tool_message_id(&event.invocation.invocation_id, operation_id),
                    Content::ToolCall {
                        tool_name: name.clone(),
                        args,
                        step_id: None,
                        provider_options: None,
                        provider_executed: None,
                        metadata: metadata.clone(),
                    },
                ));
            }
            match &event.fact {
                Fact::ToolDispatched {
                    title,
                    presentation,
                    ..
                } => {
                    if let Some(title) = title {
                        title.validate().map_err(ProjectionError::Invalid)?;
                    }
                    if let Some(key) = presentation {
                        maka_agent_facts::display::validate_presentation(key)
                            .map_err(ProjectionError::Invalid)?;
                    }
                    rows.push(message(
                        event,
                        ts,
                        format!("{}:activity", event.id),
                        Content::ToolActivity {
                            tool_use_id: tool_message_id(
                                &event.invocation.invocation_id,
                                operation_id,
                            ),
                            tool_name: name.clone(),
                            title: title.clone(),
                            presentation: presentation.clone(),
                        },
                    ));
                }
                Fact::ToolRejected { reason, .. } => rows.push(result_message(
                    event,
                    ts,
                    operation_id,
                    event.id.clone(),
                    true,
                    ToolContent::Text {
                        text: reason.to_string(),
                    },
                    metadata,
                )),
                _ => unreachable!("tool admission fact"),
            }
            Ok(rows)
        }
        Fact::ToolSettled {
            operation_id,
            outcome,
        } => {
            let (is_error, content) = ToolContent::from_outcome(outcome, resolved)?;
            let mut rows = vec![result_message(
                event,
                ts,
                operation_id,
                event.id.clone(),
                is_error,
                content,
                metadata,
            )];
            if let Some(ToolOutput::Model(result)) = resolved
                && let (Some(input), Some(output)) =
                    (result.usage.input_tokens, result.usage.output_tokens)
            {
                rows.push(message(
                    event,
                    ts,
                    maka_agent_facts::tool_call::metered_usage_id(&event.id),
                    Content::TokenUsage {
                        input,
                        output,
                        cache_read: result.usage.cache_read_tokens,
                        cache_creation: result.usage.cache_write_tokens,
                        reasoning: result.usage.reasoning_tokens,
                    },
                ));
            }
            Ok(rows)
        }
        _ => unreachable!("tool boundary fact"),
    }
}

/// Project one admitted tool boundary using only its original dispatch provenance.
/// The caller supplies the original T1 for a settlement and its verified raw result.
/// Causal acceptance and ancestry admission belong to the canonical store.
///
/// # Errors
/// Returns an error for missing dispatch identity, unsupported origin, invalid
/// presentation metadata, or a result that differs from the boundary kind.
pub fn project_tool_boundary(
    stored: &maka_agent_facts::event::StoredEvent,
    dispatch: Option<&RuntimeEvent>,
    resolved: Option<&ToolOutput>,
) -> Result<Vec<crate::Row>, ProjectionError> {
    let event = &stored.event;
    let succeeds = matches!(
        event.fact,
        Fact::ToolSettled {
            outcome: maka_agent_facts::event::ToolOutcome::Succeeded { .. },
            ..
        }
    );
    if succeeds != resolved.is_some() {
        return Err(ProjectionError::Invalid(
            "tool payload does not match fact kind",
        ));
    }
    let origin = match &event.fact {
        Fact::ToolDispatched { call, .. } | Fact::ToolRejected { call, .. } => &call.origin,
        Fact::ToolSettled { operation_id, .. } => match dispatch {
            Some(RuntimeEvent {
                invocation,
                fact:
                    Fact::ToolDispatched {
                        operation_id: original,
                        call,
                        ..
                    },
                ..
            }) if invocation == &event.invocation && original == operation_id => &call.origin,
            _ => return Err(ProjectionError::Invalid("result without original dispatch")),
        },
        _ => return Err(ProjectionError::Invalid("expected tool boundary")),
    };
    let metadata = crate::ToolMetadata::from_origin(origin, &event.invocation.invocation_id)?;
    crate::rows(
        stored.sequence,
        boundary_messages(event, crate::message::timestamp(event)?, metadata, resolved)?,
    )
}
