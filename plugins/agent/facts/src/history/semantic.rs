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

//! Pure write-time history reduction. Payload fragments are persisted separately
//! from the small relationship frontier; no completed transcript is retained.
use super::RowPosition;
use crate::{
    event::{Fact, Invocation, StoredEvent, ToolOutcome},
    input::{InvocationInput, MessageInput},
    model::{ModelEvent, ModelPart, TextKind},
    tool_call::ToolOrigin,
    tool_output::DurableToolProjection,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type PayloadKey = RowPosition;
/// Exclusive end of a canonical event's semantic items, within SQLite/JSON's
/// supported positive sequence domain.
pub const END_INDEX: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SemanticRow {
    pub id: RowPosition,
    /// Canonical sequence that published this row version.
    pub revision: u64,
    pub invocation: Invocation,
    /// Assistant items share their request position; item_index orders them.
    pub order: RowPosition,
    pub kind: SemanticKind,
}

/// Storage resolves extracted fragments, never full canonical event envelopes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResolvedRow {
    pub row: SemanticRow,
    pub payload: Option<Payload>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum SemanticKind {
    User {
        payload: PayloadKey,
        steering: bool,
    },
    ImportedUser {
        payload: PayloadKey,
    },
    /// The selected view must already contain a real user.
    ImportedAssistant {
        payload: PayloadKey,
    },
    ExecutorText {
        payload: PayloadKey,
    },
    AssistantPart {
        step_id: String,
        model_id: String,
        route_identity: String,
        accepted_at: u64,
        index: u64,
        payload: PartPayload,
    },
    ToolResult {
        operation_id: String,
        call_id: String,
        name: String,
        custom: bool,
        payload: PayloadKey,
        is_error: bool,
        archived: bool,
    },
    Notification {
        call_id: String,
        custom: bool,
        payload: PayloadKey,
    },
    UnknownTool {
        operation_id: String,
        call_id: String,
        name: String,
        custom: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum PartPayload {
    Complete(PayloadKey),
    /// Read the ordered fragments with this part key through `end`. Text and
    /// provider metadata are accumulated only when the consumer renders it.
    Text {
        part: PayloadKey,
        end: u64,
        text_kind: TextKind,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Fragment {
    pub key: PayloadKey,
    /// For streamed text, all deltas use the start's key as their part identity.
    pub part: PayloadKey,
    pub payload: Payload,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Payload {
    User(MessageInput),
    Text(String),
    Part(ModelPart),
    Tool(DurableToolProjection),
    TextDelta {
        text: String,
        provider_options: Option<Value>,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Transition {
    pub rows: Vec<SemanticRow>,
    pub fragments: Vec<Fragment>,
    /// Indexed by invocation; used by continuation selection, before rendering.
    pub stable_cut: Option<RowPosition>,
    pub checkpoint: Option<crate::context::ContextCheckpoint>,
    /// Storage versions the existing result row at its original order position.
    pub archive: Option<crate::archive::ArchivedPlaceholder>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Frontier {
    pub opening: Option<OpeningKind>,
    pub requests: BTreeMap<String, RequestFrontier>,
    pub calls: BTreeMap<String, CallFrontier>,
    pub cells: BTreeMap<String, CellFrontier>,
    pub notifications: Vec<PendingNotification>,
    pub stable_cut: Option<RowPosition>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum OpeningKind {
    Conversation,
    Compact,
    Code,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RequestFrontier {
    pub sequence: u64,
    pub source: u64,
    pub model_id: String,
    pub route_identity: String,
    pub main: bool,
    pub item_acceptance: bool,
    pub next_index: u64,
    pub open_text: BTreeMap<String, OpenText>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OpenText {
    pub part: PayloadKey,
    pub index: u64,
    pub text_kind: TextKind,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CallFrontier {
    pub call_id: String,
    pub name: String,
    pub custom: bool,
    pub dispatched_at: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CellFrontier {
    pub call_id: String,
    pub custom: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingNotification {
    pub row: SemanticRow,
    pub blocked_by: Vec<String>,
}

fn position(sequence: u64, item_index: u64) -> RowPosition {
    RowPosition {
        source_sequence: sequence,
        item_index,
    }
}

fn fragment(transition: &mut Transition, key: PayloadKey, payload: Payload) {
    transition.fragments.push(Fragment {
        key,
        part: key,
        payload,
    });
}

fn row(stored: &StoredEvent, index: u64, order: RowPosition, kind: SemanticKind) -> SemanticRow {
    SemanticRow {
        id: position(stored.sequence, index),
        revision: stored.sequence,
        invocation: stored.event.invocation.clone(),
        order,
        kind,
    }
}

impl Frontier {
    /// View-only recovery output. This does not settle a canonical operation.
    /// The view owner includes these rows only for the prior-unknown policy.
    pub fn unknown_rows(&self, invocation: &Invocation) -> Vec<SemanticRow> {
        self.calls
            .iter()
            .filter_map(|(operation_id, call)| {
                let sequence = call.dispatched_at?;
                Some(SemanticRow {
                    id: position(sequence, 0),
                    revision: sequence,
                    invocation: invocation.clone(),
                    order: position(sequence, 0),
                    kind: SemanticKind::UnknownTool {
                        operation_id: operation_id.clone(),
                        call_id: call.call_id.clone(),
                        name: call.name.clone(),
                        custom: call.custom,
                    },
                })
            })
            .collect()
    }

    fn stable(&mut self, transition: &mut Transition, cut: RowPosition) {
        self.stable_cut = Some(self.stable_cut.map_or(cut, |old| old.max(cut)));
        transition.stable_cut = self.stable_cut;
    }

    fn flush(&mut self, through: u64, transition: &mut Transition) {
        if !self.calls.is_empty() {
            return;
        }
        let first_ordinal = transition
            .rows
            .iter()
            .filter(|row| row.order.source_sequence == through)
            .map(|row| row.order.item_index + 1)
            .max()
            .unwrap_or(0);
        for (ordinal, pending) in (first_ordinal..).zip(
            self.notifications
                .extract_if(.., |pending| pending.blocked_by.is_empty()),
        ) {
            let mut row = pending.row;
            // Notifications follow the event that finally closes the boundary.
            row.order = position(through, ordinal);
            row.revision = through;
            transition.rows.push(row);
        }
    }

    fn close_request(&mut self, step: &str) {
        self.requests.remove(step);
        for notification in &mut self.notifications {
            notification.blocked_by.retain(|blocked| blocked != step);
        }
    }
}

/// Interpret one already-admitted canonical fact. The owner persists fragments,
/// rows and the changed invocation frontier in the same transaction. Admission
/// remains responsible for stream validity and execution authority.
pub fn reduce(frontier: &mut Frontier, stored: &StoredEvent) -> Result<Transition, &'static str> {
    let mut out = Transition::default();
    let key = position(stored.sequence, 0);
    match &stored.event.fact {
        Fact::InvocationOpened { input, .. } => {
            frontier.opening = Some(match input {
                InvocationInput::ContextCompact { .. } => OpeningKind::Compact,
                InvocationInput::Code { .. } => OpeningKind::Code,
                _ => OpeningKind::Conversation,
            });
            if let InvocationInput::Message { content, .. } = input {
                fragment(&mut out, key, Payload::User(content.clone()));
                out.rows.push(row(
                    stored,
                    0,
                    key,
                    SemanticKind::User {
                        payload: key,
                        steering: false,
                    },
                ));
                frontier.stable(&mut out, position(stored.sequence, END_INDEX));
            }
        }
        Fact::ContextCheckpointRecorded { checkpoint } => out.checkpoint = Some(checkpoint.clone()),
        Fact::ToolResultArchived { placeholder } => out.archive = Some(placeholder.clone()),
        _ if matches!(frontier.opening, Some(OpeningKind::Compact)) => {}
        Fact::MessageImported { record, .. } if record.is_conversation() => {
            let kind = match &record.content {
                crate::import::Content::User { text } => {
                    fragment(&mut out, key, Payload::Text(text.clone()));
                    Some(SemanticKind::ImportedUser { payload: key })
                }
                crate::import::Content::Assistant { text, .. } => {
                    fragment(&mut out, key, Payload::Text(text.clone()));
                    Some(SemanticKind::ImportedAssistant { payload: key })
                }
                _ => None,
            };
            if let Some(kind) = kind {
                out.rows.push(row(stored, 0, key, kind));
            }
        }
        Fact::MessageSteered { message, .. } => {
            fragment(&mut out, key, Payload::User(message.content.clone()));
            out.rows.push(row(
                stored,
                0,
                key,
                SemanticKind::User {
                    payload: key,
                    steering: true,
                },
            ));
            frontier.stable(&mut out, position(stored.sequence, END_INDEX));
        }
        Fact::ExecutorCompleted { text } => {
            fragment(&mut out, key, Payload::Text(text.clone()));
            out.rows.push(row(
                stored,
                0,
                key,
                SemanticKind::ExecutorText { payload: key },
            ));
        }
        Fact::ModelRequested {
            step_id,
            model_id,
            route_identity,
            source_high_water,
            purpose,
            item_acceptance,
            ..
        } => {
            if !matches!(frontier.opening, Some(OpeningKind::Conversation)) {
                return Err("model request lacks a conversation opening");
            }
            if frontier.requests.contains_key(step_id) {
                return Err("duplicate model request");
            }
            frontier.requests.insert(
                step_id.clone(),
                RequestFrontier {
                    sequence: stored.sequence,
                    source: *source_high_water,
                    model_id: model_id.clone(),
                    route_identity: route_identity.clone(),
                    main: *purpose == crate::context::ModelPurpose::Main,
                    item_acceptance: *item_acceptance,
                    next_index: 0,
                    open_text: BTreeMap::new(),
                },
            );
            if *purpose == crate::context::ModelPurpose::Main {
                for pending in &mut frontier.notifications {
                    if pending.row.id.source_sequence > *source_high_water {
                        pending.blocked_by.push(step_id.clone());
                    }
                }
            }
        }
        Fact::ModelObserved { step_id, event } => {
            let Some(request) = frontier.requests.get_mut(step_id) else {
                return Err("model observation lacks request");
            };
            if request.item_acceptance && request.main {
                match event {
                    ModelEvent::PartStarted {
                        id,
                        text_kind,
                        provider_options,
                    } => {
                        let index = request.next_index;
                        request.next_index += 1;
                        request.open_text.insert(
                            id.clone(),
                            OpenText {
                                part: key,
                                index,
                                text_kind: *text_kind,
                            },
                        );
                        fragment(
                            &mut out,
                            key,
                            Payload::TextDelta {
                                text: String::new(),
                                provider_options: provider_options.clone(),
                            },
                        );
                    }
                    ModelEvent::PartDelta {
                        id,
                        text,
                        provider_options,
                    } => {
                        let open = request
                            .open_text
                            .get(id)
                            .ok_or("model delta lacks open text")?;
                        out.fragments.push(Fragment {
                            key,
                            part: open.part,
                            payload: Payload::TextDelta {
                                text: text.clone(),
                                provider_options: provider_options.clone(),
                            },
                        });
                    }
                    ModelEvent::PartFinished {
                        id,
                        provider_options,
                    } => {
                        let open = request
                            .open_text
                            .remove(id)
                            .ok_or("model finish lacks open text")?;
                        out.fragments.push(Fragment {
                            key,
                            part: open.part,
                            payload: Payload::TextDelta {
                                text: String::new(),
                                provider_options: provider_options.clone(),
                            },
                        });
                        out.rows.push(assistant_row(
                            stored,
                            step_id,
                            request,
                            open.index,
                            PartPayload::Text {
                                part: open.part,
                                end: stored.sequence,
                                text_kind: open.text_kind,
                            },
                        ));
                    }
                    ModelEvent::Source(_) => {
                        request.next_index += 1;
                    }
                    ModelEvent::ToolCall(call) => {
                        let part = ModelPart::ToolCall { call: call.clone() };
                        let index = request.next_index;
                        request.next_index += 1;
                        fragment(&mut out, key, Payload::Part(part.clone()));
                        out.rows.push(assistant_row(
                            stored,
                            step_id,
                            request,
                            index,
                            PartPayload::Complete(key),
                        ));
                        register_call(&mut frontier.calls, step_id, &part)?;
                    }
                    ModelEvent::ProviderToolResult {
                        id,
                        name,
                        output,
                        is_error,
                        provider_options,
                    } => {
                        let part = ModelPart::ToolResult {
                            id: id.clone(),
                            name: name.clone(),
                            output: output.clone(),
                            is_error: *is_error,
                            provider_options: provider_options.clone(),
                        };
                        let index = request.next_index;
                        request.next_index += 1;
                        fragment(&mut out, key, Payload::Part(part));
                        out.rows.push(assistant_row(
                            stored,
                            step_id,
                            request,
                            index,
                            PartPayload::Complete(key),
                        ));
                        frontier.stable(&mut out, position(stored.sequence, END_INDEX));
                    }
                    _ => {}
                }
            }
        }
        Fact::ModelCompleted { step_id, output } => {
            let request = frontier
                .requests
                .get(step_id)
                .ok_or("model completion lacks request")?;
            if !request.item_acceptance && request.main {
                for (index, part) in output.parts.iter().enumerate() {
                    let index = index as u64;
                    if matches!(part, ModelPart::Source { .. }) {
                        continue;
                    }
                    let part_key = position(stored.sequence, index);
                    fragment(&mut out, part_key, Payload::Part(part.clone()));
                    let mut item = assistant_row(
                        stored,
                        step_id,
                        request,
                        index,
                        PartPayload::Complete(part_key),
                    );
                    // Non-streaming output historically belongs at completion.
                    item.order.source_sequence = stored.sequence;
                    out.rows.push(item);
                    register_call(&mut frontier.calls, step_id, part)?;
                    if matches!(part, ModelPart::ToolResult { .. }) {
                        let cut = position(stored.sequence, index + 1);
                        frontier.stable_cut =
                            Some(frontier.stable_cut.map_or(cut, |old| old.max(cut)));
                        out.stable_cut = frontier.stable_cut;
                    }
                }
            }
            frontier.close_request(step_id);
        }
        Fact::ModelInterrupted { step_id, .. } => frontier.close_request(step_id),
        Fact::ToolDispatched {
            operation_id,
            call,
            name,
            ..
        } => match &call.origin {
            ToolOrigin::Provider { step_id } => {
                let pending = frontier
                    .calls
                    .get_mut(operation_id)
                    .ok_or("provider dispatch lacks accepted call")?;
                if *operation_id != format!("{step_id}:{}", call.tool_call_id)
                    || pending.call_id != call.tool_call_id
                    || pending.name != *name
                    || pending.dispatched_at.is_some()
                {
                    return Err("provider dispatch identity mismatch");
                }
                pending.dispatched_at = Some(stored.sequence);
            }
            ToolOrigin::CodeCell {
                parent_operation_id,
                parent_tool_call_id,
                ..
            } => {
                if frontier.calls.contains_key(operation_id) {
                    return Err("hidden cell aliases provider call");
                }
                frontier.cells.insert(
                    operation_id.clone(),
                    CellFrontier {
                        call_id: parent_tool_call_id.clone(),
                        custom: frontier
                            .calls
                            .get(parent_operation_id)
                            .is_some_and(|call| call.custom),
                    },
                );
            }
            _ if frontier.calls.contains_key(operation_id) => {
                return Err("hidden operation aliases provider call");
            }
            _ => {}
        },
        Fact::ToolRejected {
            operation_id,
            call,
            name,
            input,
            reason,
        } => {
            if let ToolOrigin::Provider { step_id } = &call.origin {
                let pending = frontier
                    .calls
                    .remove(operation_id)
                    .ok_or("provider rejection lacks accepted call")?;
                if *operation_id != format!("{step_id}:{}", call.tool_call_id)
                    || pending.call_id != call.tool_call_id
                    || pending.name != *name
                    || pending.dispatched_at.is_some()
                {
                    return Err("provider rejection identity mismatch");
                }
                let text = match input.invalid_json_diagnostic() {
                    Some(diagnostic) => format!("{reason}\n{diagnostic}"),
                    None => reason.to_string(),
                };
                fragment(&mut out, key, Payload::Text(text));
                out.rows
                    .push(tool_row(stored, operation_id, pending, key, true));
                frontier.stable(&mut out, position(stored.sequence, END_INDEX));
            } else if frontier.calls.contains_key(operation_id) {
                return Err("hidden rejection aliases provider call");
            }
        }
        Fact::ToolSettled {
            operation_id,
            outcome,
        } => {
            frontier.cells.remove(operation_id);
            if let Some(pending) = frontier.calls.remove(operation_id) {
                if pending.dispatched_at.is_none() {
                    return Err("provider result lacks dispatch");
                }
                let (payload, is_error) = match outcome {
                    ToolOutcome::Succeeded {
                        model_projection, ..
                    } => (Payload::Tool(model_projection.clone()), false),
                    ToolOutcome::Failed { message } | ToolOutcome::Unknown { message, .. } => {
                        (Payload::Text(message.clone()), true)
                    }
                };
                fragment(&mut out, key, payload);
                out.rows
                    .push(tool_row(stored, operation_id, pending, key, is_error));
                frontier.stable(&mut out, position(stored.sequence, END_INDEX));
            }
        }
        Fact::ToolNotified {
            operation_id,
            model_text,
            ..
        } => {
            let cell = frontier
                .cells
                .get(operation_id)
                .ok_or("notification lacks Code Mode cell")?;
            fragment(&mut out, key, Payload::Text(model_text.clone()));
            let notification = row(
                stored,
                0,
                key,
                SemanticKind::Notification {
                    call_id: cell.call_id.clone(),
                    custom: cell.custom,
                    payload: key,
                },
            );
            let blocked_by = frontier
                .requests
                .iter()
                .filter(|(_, request)| request.main && request.source < stored.sequence)
                .map(|(id, _)| id.clone())
                .collect();
            frontier.notifications.push(PendingNotification {
                row: notification,
                blocked_by,
            });
            frontier.stable(&mut out, position(stored.sequence, END_INDEX));
        }
        Fact::InvocationEnded { .. } => {
            frontier.requests.clear();
            for pending in &mut frontier.notifications {
                pending.blocked_by.clear();
            }
            // Keep physically pending cells/calls: recovery may still record a
            // settlement or notification after the invocation terminal marker.
        }
        _ => {}
    }
    frontier.flush(stored.sequence, &mut out);
    Ok(out)
}

fn assistant_row(
    stored: &StoredEvent,
    step: &str,
    request: &RequestFrontier,
    index: u64,
    payload: PartPayload,
) -> SemanticRow {
    row(
        stored,
        index,
        position(request.sequence, index),
        SemanticKind::AssistantPart {
            step_id: step.into(),
            model_id: request.model_id.clone(),
            route_identity: request.route_identity.clone(),
            accepted_at: stored.sequence,
            index,
            payload,
        },
    )
}

fn register_call(
    calls: &mut BTreeMap<String, CallFrontier>,
    step: &str,
    part: &ModelPart,
) -> Result<(), &'static str> {
    if let ModelPart::ToolCall { call } = part
        && !call.provider_executed
    {
        let custom = call
            .provider_options
            .as_ref()
            .is_some_and(|value| value["openai"]["toolKind"] == "custom");
        if calls
            .insert(
                format!("{step}:{}", call.id),
                CallFrontier {
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    custom,
                    dispatched_at: None,
                },
            )
            .is_some()
        {
            return Err("duplicate accepted tool call");
        }
    }
    Ok(())
}

fn tool_row(
    stored: &StoredEvent,
    operation: &str,
    call: CallFrontier,
    payload: PayloadKey,
    is_error: bool,
) -> SemanticRow {
    row(
        stored,
        0,
        position(stored.sequence, 0),
        SemanticKind::ToolResult {
            operation_id: operation.into(),
            call_id: call.call_id,
            name: call.name,
            custom: call.custom,
            payload,
            is_error,
            archived: false,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::RuntimeEvent;

    fn event(sequence: u64, fact: Fact) -> StoredEvent {
        StoredEvent {
            sequence,
            event: RuntimeEvent::new(
                Invocation {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                fact,
            ),
        }
    }

    fn frontier() -> Frontier {
        Frontier {
            opening: Some(OpeningKind::Conversation),
            requests: BTreeMap::from([(
                "step".into(),
                RequestFrontier {
                    sequence: 2,
                    source: 1,
                    model_id: "model".into(),
                    route_identity: "route".into(),
                    main: true,
                    item_acceptance: true,
                    next_index: 0,
                    open_text: BTreeMap::new(),
                },
            )]),
            ..Frontier::default()
        }
    }

    fn observed(sequence: u64, event: ModelEvent) -> StoredEvent {
        self::event(
            sequence,
            Fact::ModelObserved {
                step_id: "step".into(),
                event,
            },
        )
    }

    #[test]
    fn text_payload_never_accumulates_in_frontier_and_acceptance_retains_start_order() {
        let mut frontier = frontier();
        for (sequence, id) in [(3, "first"), (4, "second")] {
            reduce(
                &mut frontier,
                &observed(
                    sequence,
                    ModelEvent::PartStarted {
                        id: id.into(),
                        text_kind: TextKind::Text,
                        provider_options: None,
                    },
                ),
            )
            .unwrap();
        }
        let frontier_bytes = serde_json::to_vec(&frontier).unwrap();
        for sequence in 5..105 {
            let out = reduce(
                &mut frontier,
                &observed(
                    sequence,
                    ModelEvent::PartDelta {
                        id: "first".into(),
                        text: "large incoming text".repeat(1000),
                        provider_options: None,
                    },
                ),
            )
            .unwrap();
            assert_eq!(out.fragments.len(), 1);
            assert!(out.rows.is_empty());
            assert_eq!(out.fragments[0].part, position(3, 0));
        }
        assert_eq!(serde_json::to_vec(&frontier).unwrap(), frontier_bytes);
        let second = reduce(
            &mut frontier,
            &observed(
                105,
                ModelEvent::PartFinished {
                    id: "second".into(),
                    provider_options: None,
                },
            ),
        )
        .unwrap();
        let first = reduce(
            &mut frontier,
            &observed(
                106,
                ModelEvent::PartFinished {
                    id: "first".into(),
                    provider_options: None,
                },
            ),
        )
        .unwrap();
        assert_eq!(first.rows[0].order, position(2, 0));
        assert_eq!(second.rows[0].order, position(2, 1));
        assert!(frontier.requests["step"].open_text.is_empty());
    }

    #[test]
    fn notifications_wait_for_request_and_call_then_release_after_result() {
        let mut frontier = frontier();
        frontier.cells.insert(
            "cell".into(),
            CellFrontier {
                call_id: "call".into(),
                custom: true,
            },
        );
        frontier.calls.insert(
            "step:call".into(),
            CallFrontier {
                call_id: "call".into(),
                name: "exec".into(),
                custom: true,
                dispatched_at: Some(3),
            },
        );
        let pending = reduce(
            &mut frontier,
            &event(
                4,
                Fact::ToolNotified {
                    operation_id: "cell".into(),
                    text: "notice".into(),
                    model_text: "notice".into(),
                },
            ),
        )
        .unwrap();
        assert!(pending.rows.is_empty());
        let ended = reduce(
            &mut frontier,
            &event(
                5,
                Fact::ModelInterrupted {
                    step_id: "step".into(),
                    status: crate::event::ModelInterruption::Cancelled,
                    diagnostic: None,
                    model_failure: None,
                },
            ),
        )
        .unwrap();
        assert!(ended.rows.is_empty());
        let settled = reduce(
            &mut frontier,
            &event(
                6,
                Fact::ToolSettled {
                    operation_id: "step:call".into(),
                    outcome: ToolOutcome::Failed {
                        message: "failed".into(),
                    },
                },
            ),
        )
        .unwrap();
        assert_eq!(settled.rows.len(), 2);
        assert!(matches!(
            settled.rows[0].kind,
            SemanticKind::ToolResult { .. }
        ));
        assert!(matches!(
            settled.rows[1].kind,
            SemanticKind::Notification { custom: true, .. }
        ));
        assert!(settled.rows[0].order < settled.rows[1].order);
        assert_eq!(settled.rows[1].id, position(4, 0));
        assert_eq!(settled.rows[1].revision, 6);
    }
}
