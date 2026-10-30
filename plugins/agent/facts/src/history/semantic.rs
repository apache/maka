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
pub mod directory;

use super::RowPosition;
use crate::{
    event::{Fact, Invocation, StoredEvent, ToolOutcome},
    input::{InvocationInput, MessageInput},
    model::{
        ModelPart,
        recorded::{CompletionPart, ModelObservation},
    },
    tool_call::ToolOrigin,
    tool_output::DurableToolProjection,
};
use serde::{Deserialize, Serialize};
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Fragment {
    pub key: PayloadKey,
    pub source: FragmentSource,
}

/// The semantic writer either stores an owned payload or locates this event's projection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum FragmentSource {
    Payload(Box<Payload>),
    CanonicalToolProjection,
    CanonicalModelPart { ordinal: u64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Payload {
    User(MessageInput),
    Text(String),
    Part(ModelPart),
    Tool(DurableToolProjection),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Transition {
    pub rows: Vec<SemanticRow>,
    pub fragments: Vec<Fragment>,
    /// Indexed by invocation; used by continuation selection, before rendering.
    pub stable_cut: Option<RowPosition>,
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
    pub recorded: BTreeMap<u64, RecordedFrontier>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordedFrontier {
    pub event_id: String,
    pub key: PayloadKey,
    pub kind: RecordedKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum RecordedKind {
    Source,
    Text,
    Call(Option<CallFrontier>),
    Result,
}
impl RecordedKind {
    fn from_part(part: &ModelPart) -> Self {
        match part {
            ModelPart::Source { .. } => Self::Source,
            ModelPart::Text { .. } => Self::Text,
            ModelPart::ToolResult { .. } => Self::Result,
            ModelPart::ToolCall { call } => Self::Call((!call.provider_executed).then(|| {
                CallFrontier {
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    custom: call
                        .provider_options
                        .as_ref()
                        .is_some_and(|value| value["openai"]["toolKind"] == "custom"),
                    dispatched_at: None,
                }
            })),
        }
    }
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

        source: FragmentSource::Payload(Box::new(payload)),
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
                    recorded: BTreeMap::new(),
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
            let request = frontier
                .requests
                .get_mut(step_id)
                .ok_or("model observation lacks request")?;
            if let ModelObservation::Part(record) = event {
                let part_key = position(stored.sequence, record.ordinal);
                let kind = RecordedKind::from_part(&record.part);
                out.fragments.push(Fragment {
                    key: part_key,

                    source: FragmentSource::CanonicalModelPart {
                        ordinal: record.ordinal,
                    },
                });
                if request.item_acceptance && request.main {
                    accept_part(
                        &mut out,
                        &mut frontier.calls,
                        stored,
                        step_id,
                        request,
                        AcceptedPart {
                            ordinal: record.ordinal,
                            key: part_key,
                            kind: &kind,
                        },
                        false,
                    )?;
                }
                if request
                    .recorded
                    .insert(
                        record.ordinal,
                        RecordedFrontier {
                            event_id: stored.event.id.clone(),
                            key: part_key,
                            kind,
                        },
                    )
                    .is_some()
                {
                    return Err("duplicate recorded model ordinal");
                }
            }
        }
        Fact::ModelCompleted { step_id, output } => {
            let request = frontier
                .requests
                .get(step_id)
                .ok_or("model completion lacks request")?;
            for part in &output.parts {
                let (ordinal, part_key, kind) = match part {
                    CompletionPart::Own(record) => {
                        let part_key = position(stored.sequence, record.ordinal);
                        out.fragments.push(Fragment {
                            key: part_key,

                            source: FragmentSource::CanonicalModelPart {
                                ordinal: record.ordinal,
                            },
                        });
                        (
                            record.ordinal,
                            part_key,
                            RecordedKind::from_part(&record.part),
                        )
                    }
                    CompletionPart::Ref(reference) => {
                        let recorded = request
                            .recorded
                            .get(&reference.ordinal)
                            .ok_or("completion reference lacks recorded part")?;
                        if recorded.event_id != reference.event_id {
                            return Err("completion reference event differs");
                        }
                        (reference.ordinal, recorded.key, recorded.kind.clone())
                    }
                };
                if !request.item_acceptance && request.main {
                    accept_part(
                        &mut out,
                        &mut frontier.calls,
                        stored,
                        step_id,
                        request,
                        AcceptedPart {
                            ordinal,
                            key: part_key,
                            kind: &kind,
                        },
                        true,
                    )?;
                }
            }
            frontier.close_request(step_id);
        }
        Fact::ModelInterrupted {
            step_id, partial, ..
        } => {
            if let Some(partial) = partial {
                for part in &partial.parts {
                    if let CompletionPart::Own(record) = part {
                        let part_key = position(stored.sequence, record.ordinal);
                        out.fragments.push(Fragment {
                            key: part_key,

                            source: FragmentSource::CanonicalModelPart {
                                ordinal: record.ordinal,
                            },
                        });
                    }
                }
            }
            frontier.close_request(step_id);
        }
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
                let (source, is_error) = match outcome {
                    ToolOutcome::Succeeded { .. } => {
                        (FragmentSource::CanonicalToolProjection, false)
                    }
                    ToolOutcome::Failed { message } | ToolOutcome::Unknown { message, .. } => (
                        FragmentSource::Payload(Box::new(Payload::Text(message.clone()))),
                        true,
                    ),
                };
                out.fragments.push(Fragment { key, source });
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
    if let Some(cut) = out.stable_cut {
        frontier.stable(&mut out, cut);
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

struct AcceptedPart<'part> {
    ordinal: u64,
    key: PayloadKey,
    kind: &'part RecordedKind,
}

fn accept_part(
    out: &mut Transition,
    calls: &mut BTreeMap<String, CallFrontier>,
    stored: &StoredEvent,
    step: &str,
    request: &RequestFrontier,
    part: AcceptedPart<'_>,
    at_completion: bool,
) -> Result<(), &'static str> {
    let AcceptedPart { ordinal, key, kind } = part;
    if matches!(kind, RecordedKind::Source) {
        return Ok(());
    }
    let mut item = assistant_row(stored, step, request, ordinal, PartPayload::Complete(key));
    if at_completion {
        item.order.source_sequence = stored.sequence;
    }
    out.rows.push(item);
    if let RecordedKind::Call(Some(call)) = kind
        && calls
            .insert(format!("{step}:{}", call.call_id), call.clone())
            .is_some()
    {
        return Err("duplicate accepted tool call");
    }
    if matches!(kind, RecordedKind::Result) {
        let cut = if at_completion {
            position(stored.sequence, ordinal + 1)
        } else {
            position(stored.sequence, END_INDEX)
        };
        out.stable_cut = Some(out.stable_cut.map_or(cut, |old| old.max(cut)));
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
                    recorded: BTreeMap::new(),
                },
            )]),
            ..Frontier::default()
        }
    }

    #[test]
    fn complete_parts_keep_original_ordinal_order_and_no_frontier_body() {
        use crate::model::{TextKind, recorded::ModelPartRecord};
        let mut frontier = frontier();
        let body = "visible text".repeat(20_000);
        for (sequence, ordinal) in [(3, 1), (4, 0)] {
            let observed = event(
                sequence,
                Fact::ModelObserved {
                    step_id: "step".into(),
                    event: ModelObservation::Part(ModelPartRecord {
                        ordinal,
                        message_id: format!("message-{ordinal}"),
                        started_at: std::time::SystemTime::UNIX_EPOCH,
                        provider_part_id: None,
                        part: std::sync::Arc::new(ModelPart::Text {
                            text_kind: TextKind::Text,
                            text: body.clone().into(),
                            provider_options: None,
                        }),
                    }),
                },
            );
            let out = reduce(&mut frontier, &observed).unwrap();
            assert_eq!(out.rows[0].order, position(2, ordinal));
            assert!(
                matches!(out.rows[0].kind, SemanticKind::AssistantPart { accepted_at, payload: PartPayload::Complete(key), .. } if accepted_at == sequence && key == position(sequence, ordinal))
            );
            assert!(
                matches!(out.fragments[0].source, FragmentSource::CanonicalModelPart { ordinal: actual } if actual == ordinal)
            );
        }
        assert!(
            !serde_json::to_string(&frontier)
                .unwrap()
                .contains("visible text")
        );
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
                    partial: None,
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
