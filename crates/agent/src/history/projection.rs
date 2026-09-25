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

use super::{EventRef, images, operation_id, user};
use crate::RunError;
use maka_model::prompt::{AssistantPart, Message, ToolOutput};
use maka_runtime::context::{ModelPurpose, resolve_model_purpose};
use maka_runtime::event::{Fact, ToolOutcome};
use maka_runtime::input::InvocationInput;
use maka_runtime::model::{ModelPart, TextKind};
use maka_runtime::tool_call::ToolOrigin;
use std::collections::{HashMap, HashSet};

pub(super) fn build<'a>(
    events: impl Iterator<Item = EventRef<'a>> + Clone,
    resources: &super::resources::Resources<'_>,
    images: &mut Vec<images::Target<'a>>,
    vision: bool,
    replay: Option<super::Replay<'a>>,
    prior_unknown: bool,
) -> Result<Vec<Message>, RunError> {
    let cuts = replay.map(|policy| super::replay::Cuts::new(events.clone(), policy));
    let mut messages = Vec::new();
    // Leading foreign assistant history is retained for display, but cannot
    // become an assistant-prefill request. Only a real user opens model input.
    let mut has_user = false;
    let mut calls = HashMap::new();
    let mut custom_operations = HashSet::new();
    let mut dispatched = HashSet::new();
    let mut cells = HashMap::new();
    let mut notifications = Vec::new();
    let pending: HashSet<_> = if prior_unknown {
        let settled: HashSet<_> = events
            .clone()
            .filter_map(EventRef::canonical)
            .filter_map(|stored| {
                if let Fact::ToolSettled { operation_id, .. } = &stored.event.fact {
                    Some(operation_id.as_str())
                } else {
                    None
                }
            })
            .collect();
        events
            .clone()
            .filter_map(EventRef::canonical)
            .filter_map(|stored| {
                if let Fact::ToolDispatched { operation_id, .. } = &stored.event.fact {
                    (!settled.contains(operation_id.as_str())).then_some(operation_id.as_str())
                } else {
                    None
                }
            })
            .collect()
    } else {
        HashSet::new()
    };
    let openings: HashMap<_, _> = events
        .clone()
        .filter_map(EventRef::canonical)
        .filter_map(|stored| match &stored.event.fact {
            Fact::InvocationOpened { input, .. } => {
                Some((&stored.event.invocation.invocation_id, input))
            }
            _ => None,
        })
        .collect();
    let mut requests = HashMap::new();
    for stored in events.clone().filter_map(EventRef::canonical) {
        if let Fact::ModelRequested {
            step_id,
            purpose,
            source_high_water,
            ..
        } = &stored.event.fact
        {
            let opening = openings
                .get(&stored.event.invocation.invocation_id)
                .ok_or_else(|| {
                    RunError::ReconciliationRequired("model request lacks canonical opening".into())
                })?;
            let resolved = resolve_model_purpose(opening, *purpose)
                .map_err(|reason| RunError::ReconciliationRequired(reason.into()))?;
            requests.insert(
                (&stored.event.invocation.invocation_id, step_id),
                RequestSpan {
                    purpose: resolved,
                    source: *source_high_water,
                    end: u64::MAX,
                },
            );
        }
        match &stored.event.fact {
            Fact::ModelCompleted { step_id, .. } | Fact::ModelInterrupted { step_id, .. } => {
                if let Some(request) =
                    requests.get_mut(&(&stored.event.invocation.invocation_id, step_id))
                {
                    request.end = stored.sequence;
                }
            }
            Fact::InvocationEnded { .. } => {
                for ((invocation, _), request) in &mut requests {
                    if *invocation == &stored.event.invocation.invocation_id
                        && request.end == u64::MAX
                    {
                        request.end = stored.sequence;
                    }
                }
            }
            _ => {}
        }
    }
    let compact_invocations: HashSet<_> = events
        .clone()
        .filter_map(EventRef::canonical)
        .filter_map(|stored| {
            matches!(
                &stored.event.fact,
                Fact::InvocationOpened {
                    input: InvocationInput::ContextCompact { .. },
                    ..
                }
            )
            .then_some(&stored.event.invocation.invocation_id)
        })
        .collect();
    for event in events {
        let stored = match event {
            EventRef::Canonical(stored) => stored,
            EventRef::Archived(archived) => {
                let (id, name) = calls.remove(&archived.operation_id).ok_or_else(|| {
                    RunError::ReconciliationRequired("archived result lacks provider call".into())
                })?;
                if !dispatched.remove(&archived.operation_id) {
                    return Err(RunError::ReconciliationRequired(
                        "archived result lacks dispatch".into(),
                    ));
                }
                let maka_runtime::tool_output::DurableToolProjection::Json { value } =
                    &archived.replacement
                else {
                    return Err(RunError::ReconciliationRequired(
                        "archive replacement is not a JSON page".into(),
                    ));
                };
                let output = if archived.is_error {
                    ToolOutput::ErrorJson(value.clone())
                } else {
                    ToolOutput::Json(value.clone())
                };
                messages.push(tool_message(
                    id,
                    name,
                    output,
                    custom_operations.contains(&archived.operation_id),
                ));
                if calls.is_empty() {
                    flush_notifications(&mut notifications, archived.sequence, &mut messages);
                }
                continue;
            }
        };
        if compact_invocations.contains(&stored.event.invocation.invocation_id) {
            continue;
        }
        match &stored.event.fact {
            Fact::ToolNotified {
                operation_id,
                model_text,
                ..
            } => {
                let (parent, id) = cells.get(operation_id.as_str()).ok_or_else(|| {
                    RunError::ReconciliationRequired("notification lacks its Code Mode cell".into())
                })?;
                let mut message = Message::notification(*id, model_text.clone());
                if custom_operations.contains(*parent) {
                    mark_custom(&mut message);
                }
                let release = requests
                    .iter()
                    .filter_map(|((invocation, _), request)| {
                        (*invocation == &stored.event.invocation.invocation_id
                            && request.purpose == ModelPurpose::Main
                            && request.source < stored.sequence
                            && stored.sequence <= request.end)
                            .then_some(request.end)
                    })
                    .max()
                    .unwrap_or(stored.sequence);
                notifications.push((release, message));
            }
            Fact::MessageImported { record, .. } => {
                use maka_runtime::import::Content;
                match &record.content {
                    Content::User { text } if record.is_conversation() => {
                        has_user = true;
                        messages.push(Message::user(text.clone()));
                    }
                    Content::Assistant { text, .. } if has_user && record.is_conversation() => {
                        messages.push(Message::Assistant {
                            content: vec![AssistantPart::Text {
                                text: text.clone(),
                                provider_options: None,
                            }],
                            provider_options: None,
                        });
                    }
                    // Foreign tool observations are not executable provider
                    // call/result pairs. Thinking and notes stay in the ledger/UI.
                    _ => {}
                }
            }
            Fact::InvocationOpened { input, .. } => {
                if input.inherited_claim().is_some() {
                    continue;
                }
                let InvocationInput::Message { content, .. } = input else {
                    return Err(RunError::ReconciliationRequired(
                        "invocation has no model-history input".into(),
                    ));
                };
                has_user = true;
                messages.push(user::project(
                    content,
                    resources,
                    false,
                    messages.len(),
                    images,
                    vision,
                )?);
            }
            Fact::MessageSteered { message, .. } => {
                has_user = true;
                message
                    .validate()
                    .map_err(|reason| RunError::ReconciliationRequired(reason.into()))?;
                messages.push(user::project(
                    &message.content,
                    resources,
                    true,
                    messages.len(),
                    images,
                    vision,
                )?);
            }
            Fact::ExecutorCompleted { text } => {
                messages.push(Message::Assistant {
                    content: vec![AssistantPart::Text {
                        text: text.clone(),
                        provider_options: None,
                    }],
                    provider_options: None,
                });
            }
            Fact::ModelCompleted { step_id, output } => {
                match requests
                    .get(&(&stored.event.invocation.invocation_id, step_id))
                    .map(|request| request.purpose)
                {
                    Some(ModelPurpose::Summary) => continue,
                    Some(ModelPurpose::Main) => {}
                    None => {
                        return Err(RunError::ReconciliationRequired(
                            "model completion lacks request purpose".into(),
                        ));
                    }
                }
                let mut content = Vec::new();
                for (index, part) in output.parts.iter().enumerate() {
                    let value =
                        match part {
                            // Citations are preserved in the canonical result/UI, not
                            // fabricated as additional model-authored prompt text.
                            ModelPart::Source { .. } => continue,
                            ModelPart::Text {
                                text_kind,
                                text,
                                provider_options,
                            } => match text_kind {
                                TextKind::Thinking => AssistantPart::Reasoning {
                                    text: text.clone(),
                                    provider_options: provider_options.clone(),
                                },
                                TextKind::Text => AssistantPart::Text {
                                    text: text.clone(),
                                    provider_options: provider_options.clone(),
                                },
                            },
                            ModelPart::ToolCall { call } => {
                                if !call.provider_executed {
                                    if call.provider_options.as_ref().is_some_and(|value| {
                                        value["openai"]["toolKind"] == "custom"
                                    }) {
                                        custom_operations.insert(operation_id(step_id, &call.id));
                                    }
                                    calls.insert(
                                        operation_id(step_id, &call.id),
                                        (&call.id, &call.name),
                                    );
                                }
                                AssistantPart::ToolCall {
                                    tool_call_id: call.id.clone(),
                                    tool_name: call.name.clone(),
                                    input: call.input.clone(),
                                    provider_executed: Some(call.provider_executed),
                                    provider_options: call.provider_options.clone(),
                                }
                            }
                            ModelPart::ToolResult {
                                id,
                                name,
                                output,
                                is_error,
                                provider_options,
                            } => AssistantPart::ToolResult {
                                tool_call_id: id.clone(),
                                tool_name: name.clone(),
                                output: if *is_error {
                                    ToolOutput::ErrorJson(output.clone())
                                } else {
                                    ToolOutput::Json(output.clone())
                                },
                                provider_options: provider_options.clone(),
                            },
                        };
                    if cuts
                        .as_ref()
                        .map(|cuts| cuts.allows(stored, step_id, index, part))
                        .transpose()?
                        .unwrap_or(true)
                    {
                        content.push(value);
                    }
                }
                if !content.is_empty() {
                    messages.push(Message::Assistant {
                        content,
                        provider_options: None,
                    });
                }
            }
            Fact::ToolDispatched {
                operation_id: operation,
                call,
                name,
                ..
            } => match &call.origin {
                ToolOrigin::Provider { step_id } => {
                    if operation_id(step_id, &call.tool_call_id) != *operation
                        || calls.get(operation) != Some(&(&call.tool_call_id, name))
                        || !dispatched.insert(operation)
                    {
                        return Err(RunError::ReconciliationRequired(
                            "provider tool dispatch identity mismatch".into(),
                        ));
                    }
                    if pending.contains(operation.as_str()) {
                        let (id, name) = calls.remove(operation).ok_or_else(|| {
                            RunError::ReconciliationRequired(
                                "unknown tool call lacks accepted model output".into(),
                            )
                        })?;
                        dispatched.remove(operation);
                        messages.push(tool_message(id, name, ToolOutput::ErrorText(
                            "outcome_unknown: The tool was dispatched, but no durable result was recorded. Its effect may have happened. Inspect current state before repeating it.".into(),
                        ), custom_operations.contains(operation)));
                    }
                }
                ToolOrigin::CodeCell {
                    parent_operation_id,
                    parent_tool_call_id,
                    ..
                } => {
                    if calls.contains_key(operation) {
                        return Err(RunError::ReconciliationRequired(
                            "hidden cell aliases provider call".into(),
                        ));
                    }
                    cells.insert(
                        operation.as_str(),
                        (parent_operation_id.as_str(), parent_tool_call_id.as_str()),
                    );
                }
                ToolOrigin::CodeMode { .. }
                | ToolOrigin::HostSdk { .. }
                | ToolOrigin::Standalone => {
                    if calls.contains_key(operation) {
                        return Err(RunError::ReconciliationRequired(
                            "hidden tool operation aliases provider call".into(),
                        ));
                    }
                }
            },
            Fact::ToolRejected {
                operation_id: operation,
                call,
                name,
                reason,
                ..
            } => match &call.origin {
                ToolOrigin::Provider { step_id } => {
                    if operation_id(step_id, &call.tool_call_id) != *operation
                        || calls.get(operation) != Some(&(&call.tool_call_id, name))
                        || dispatched.contains(operation)
                    {
                        return Err(RunError::ReconciliationRequired(
                            "provider tool rejection identity mismatch".into(),
                        ));
                    }
                    let (id, name) = calls.remove(operation).expect("validated accepted call");
                    messages.push(tool_message(
                        id,
                        name,
                        ToolOutput::ErrorText(reason.to_string()),
                        custom_operations.contains(operation),
                    ));
                }
                ToolOrigin::CodeMode { .. }
                | ToolOrigin::CodeCell { .. }
                | ToolOrigin::HostSdk { .. }
                | ToolOrigin::Standalone => {
                    if calls.contains_key(operation) {
                        return Err(RunError::ReconciliationRequired(
                            "hidden tool rejection aliases provider call".into(),
                        ));
                    }
                }
            },
            Fact::ToolSettled {
                operation_id,
                outcome,
            } => {
                if let Some((id, name)) = calls.remove(operation_id) {
                    if !dispatched.remove(operation_id) {
                        return Err(RunError::ReconciliationRequired(
                            "provider tool result lacks matching dispatch".into(),
                        ));
                    }
                    let output = match outcome {
                        ToolOutcome::Succeeded {
                            model_projection, ..
                        } => {
                            super::output::project(model_projection, messages.len(), images, vision)
                        }
                        ToolOutcome::Failed { message } | ToolOutcome::Unknown { message } => {
                            ToolOutput::ErrorText(message.clone())
                        }
                    };
                    messages.push(tool_message(
                        id,
                        name,
                        output,
                        custom_operations.contains(operation_id),
                    ));
                }
            }
            _ => {}
        }
        // The request's source cut, not its commit timestamp, proves whether
        // it saw a notification. This also preserves frozen physical retries.
        if calls.is_empty() {
            flush_notifications(&mut notifications, stored.sequence, &mut messages);
        }
    }
    if !calls.is_empty() {
        return Err(RunError::ReconciliationRequired(
            "model tool calls have no committed outcome".into(),
        ));
    }
    Ok(messages)
}

fn tool_message(id: &str, name: &str, output: ToolOutput, custom: bool) -> Message {
    let mut message = Message::tool(id, name, output);
    if custom {
        mark_custom(&mut message);
    }
    message
}

fn mark_custom(message: &mut Message) {
    if let Message::Tool { content, .. } = message {
        for part in content {
            let options = part
                .provider_options
                .get_or_insert_with(|| serde_json::json!({}));
            options["openai"] = serde_json::json!({"toolKind":"custom"});
        }
    }
}

struct RequestSpan {
    purpose: ModelPurpose,
    source: u64,
    end: u64,
}

fn flush_notifications(
    pending: &mut Vec<(u64, Message)>,
    through: u64,
    messages: &mut Vec<Message>,
) {
    messages.extend(
        pending
            .extract_if(.., |(release, _)| *release <= through)
            .map(|(_, message)| message),
    );
}
