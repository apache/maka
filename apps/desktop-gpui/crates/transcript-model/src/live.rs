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

//! The live projection of Turns that are still streaming.
//!
//! Ported from three TypeScript layers, fused where the intermediate
//! `SessionEvent` added nothing:
//!
//! - [`Projector`] is `RuntimeHostSessionProjector` in
//!   `packages/runtime-host/src/adapter/session-projector.ts`: it folds
//!   assistant deltas per message (`accept`, `foldRuntimeHostAssistantDelta`),
//!   turns Tool frames into events (`projectSessionEvent`), and emits the
//!   completions and terminal event when a root Turn settles
//!   (`#terminalEvents`).
//! - [`LiveTurn::apply`] is `projectLiveTurnEvent` in
//!   `packages/ui/src/live-turn-projection.ts`: it places text and Tools into
//!   steps keyed by step id, in first-observed order, with steering messages
//!   as boundaries.
//! - [`reconcile`] is `reconcileLiveTurnBuffer` in
//!   `packages/ui/src/live-turn-buffer.ts` with `reconcileTerminalLiveTurn`
//!   and `settleLiveTurnStep`: once durable rows cover live content, the live
//!   copy is dropped.
//!
//! Text and reasoning (`thinking`) stream per message side by side, keyed
//! by kind and message as `accumulatorKey` does; reasoning never enters the
//! text.

use std::collections::{HashMap, HashSet};

use host_protocol::{
    AssistantStreamKind, MessageContent, SessionAssistantDelta, SessionFrameEvent,
    SessionSteeringEvent, SessionToolResultStatus, SessionToolStart, StoredMessage,
};

use crate::stream::{FoldError, StreamCaps, StreamText, apply_stream_complete, apply_stream_delta};
use crate::view::{ToolItem, ToolOutputChunk, ToolStatus};

/// A live Turn (`LiveTurnProjection`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LiveTurn {
    pub turn_id: String,
    /// The Turn ended; its steps are frozen until durable rows replace them.
    pub terminal: bool,
    /// Host time of the first Tool or steering event, when one was seen.
    pub started_at: Option<u64>,
    pub steps: Vec<LiveStep>,
}

/// One step or steering slice (`LiveTurnStepProjection`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LiveStep {
    pub step_id: String,
    /// First-observed order of this step's text and Tools.
    pub content_order: Vec<ContentKind>,
    pub steering: Option<LiveSteering>,
    pub thinking: Option<LiveText>,
    pub text: Option<LiveText>,
    pub tools: Vec<ToolItem>,
}

impl LiveStep {
    fn part_mut(&mut self, part: Part) -> &mut Option<LiveText> {
        match part {
            Part::Text => &mut self.text,
            Part::Thinking => &mut self.thinking,
        }
    }

    fn part(&self, part: Part) -> Option<&LiveText> {
        match part {
            Part::Text => self.text.as_ref(),
            Part::Thinking => self.thinking.as_ref(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContentKind {
    Thinking,
    Text,
    Tools,
}

/// Which stream of an assistant message (`SessionAssistantDelta.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum Part {
    Text,
    Thinking,
}

impl Part {
    /// The part a wire kind names; `None` for a kind this client does not
    /// know, whose deltas are skipped.
    pub fn of(kind: &AssistantStreamKind) -> Option<Self> {
        match kind {
            AssistantStreamKind::Text => Some(Self::Text),
            AssistantStreamKind::Thinking => Some(Self::Thinking),
            _ => None,
        }
    }

    fn caps(self) -> StreamCaps {
        match self {
            Self::Text => StreamCaps::ASSISTANT,
            Self::Thinking => StreamCaps::THINKING,
        }
    }

    fn content_kind(self) -> ContentKind {
        match self {
            Self::Text => ContentKind::Text,
            Self::Thinking => ContentKind::Thinking,
        }
    }
}

/// `LiveTextProjection`, and `LiveThinkingProjection` (never interrupted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiveText {
    pub text: String,
    pub complete: bool,
    pub interrupted: bool,
    pub truncated: bool,
}

/// `LiveSteeringProjection`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LiveSteering {
    pub message_id: String,
    pub content: MessageContent,
    pub ts: u64,
}

/// The events [`LiveTurn::apply`] understands: the subset of `SessionEvent`
/// the Runtime Host adapter produces and the MVP renders.
#[derive(Debug)]
pub(crate) enum LiveEvent<'a> {
    /// `text_delta` or `thinking_delta`.
    Delta {
        part: Part,
        turn_id: &'a str,
        message_id: &'a str,
        text: String,
    },
    /// `text_complete` or `thinking_complete`.
    Complete {
        part: Part,
        turn_id: &'a str,
        message_id: &'a str,
        text: String,
        interrupted: bool,
    },
    Frame(&'a SessionFrameEvent),
    /// `complete`, `error`, or `abort`: all three freeze the Turn the same way.
    Terminal {
        turn_id: &'a str,
    },
}

impl LiveEvent<'_> {
    fn turn_id(&self) -> Option<&str> {
        match self {
            Self::Delta { turn_id, .. }
            | Self::Complete { turn_id, .. }
            | Self::Terminal { turn_id } => Some(turn_id),
            Self::Frame(event) => event.turn_id(),
        }
    }
}

/// Per-message delta accumulators (`AssistantAccumulator`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Projector {
    /// By part and message id (`accumulatorKey`).
    accumulators: HashMap<(Part, String), Accumulator>,
    /// Steering messages already rendered live for the current root run.
    rendered_steering: HashSet<String>,
}

#[derive(Debug, Clone)]
struct Accumulator {
    turn_id: String,
    stream: StreamText,
    complete: bool,
    /// After a `reset`, deltas replace the text; the display keeps the old
    /// text until the completion lands.
    replacing: bool,
    interrupted: bool,
}

/// What folding one delta produced.
pub(crate) enum DeltaOutcome {
    None,
    Delta(String),
    Complete { text: String, interrupted: bool },
}

impl Projector {
    /// Seeds accumulators for the live root Turn, as the projector's
    /// constructor does: durable assistant rows (text and reasoning) are
    /// complete, active streams start empty (the Host resends their text
    /// from offset 0 after `subscription.ready`).
    pub fn seed(
        &mut self,
        root_turn_id: &str,
        durable: &[&StoredMessage],
        active: &[(Part, String)],
    ) {
        for message in durable {
            let StoredMessage::Assistant(assistant) = message else { continue };
            if assistant.turn_id != root_turn_id {
                continue;
            }
            if let Some(thinking) = assistant.thinking_text() {
                self.accumulators.insert(
                    (Part::Thinking, assistant.id.clone()),
                    Accumulator {
                        turn_id: root_turn_id.to_owned(),
                        stream: StreamText::from_text(thinking),
                        complete: true,
                        replacing: false,
                        interrupted: false,
                    },
                );
            }
            if !assistant.text.is_empty() || assistant.interrupted {
                self.accumulators.insert(
                    (Part::Text, assistant.id.clone()),
                    Accumulator {
                        turn_id: root_turn_id.to_owned(),
                        stream: StreamText::from_text(&assistant.text),
                        complete: true,
                        replacing: false,
                        interrupted: assistant.interrupted,
                    },
                );
            }
        }
        for key in active {
            let stream = self
                .accumulators
                .get(key)
                .map(|accumulator| accumulator.stream.clone())
                .unwrap_or_default();
            self.accumulators.insert(
                key.clone(),
                Accumulator {
                    turn_id: root_turn_id.to_owned(),
                    stream,
                    complete: false,
                    replacing: false,
                    interrupted: false,
                },
            );
        }
    }

    /// A new root run started (`startedTurn`): forget the previous run.
    pub fn start_run(&mut self) {
        self.accumulators.clear();
        self.rendered_steering.clear();
    }

    /// Folds one assistant delta (`accept`, `subscription.session_delta`),
    /// text or reasoning.
    pub fn fold(&mut self, delta: &SessionAssistantDelta) -> Result<DeltaOutcome, FoldError> {
        let Some(part) = Part::of(&delta.kind) else {
            return Ok(DeltaOutcome::None);
        };
        let key = (part, delta.message_id.clone());
        let current = self.accumulators.get(&key);
        let mut stream = match (delta.reset, current) {
            (false, Some(accumulator)) => accumulator.stream.clone(),
            _ => StreamText::default(),
        };
        let replacing = delta.reset || current.is_some_and(|accumulator| accumulator.replacing);
        let tail = stream.fold(delta.start_offset, &delta.text)?;
        let text = stream.as_str().to_owned();
        self.accumulators.insert(
            key,
            Accumulator {
                turn_id: delta.turn_id.clone(),
                stream,
                complete: delta.complete,
                replacing: !delta.complete && replacing,
                interrupted: delta.interrupted,
            },
        );
        Ok(if delta.complete {
            DeltaOutcome::Complete { text, interrupted: delta.interrupted }
        } else if !tail.is_empty() && !replacing {
            DeltaOutcome::Delta(tail)
        } else {
            DeltaOutcome::None
        })
    }

    /// Whether a steering event should be rendered live (not yet durable,
    /// not yet rendered). Marks it rendered.
    pub fn admit_steering(
        &mut self,
        event: &SessionSteeringEvent,
        durable_users: &HashSet<String>,
    ) -> bool {
        !durable_users.contains(&event.message_id)
            && self.rendered_steering.insert(event.message_id.clone())
    }

    /// The completions a settling root Turn owes its open streams
    /// (`#terminalEvents`, without the settled ones), as `(part, message id,
    /// text, interrupted)`.
    pub fn open_streams(&self, turn_id: &str) -> Vec<(Part, String, String, bool)> {
        let mut open: Vec<_> = self
            .accumulators
            .iter()
            .filter(|(_, accumulator)| accumulator.turn_id == turn_id && !accumulator.complete)
            .map(|((part, message_id), accumulator)| {
                (
                    *part,
                    message_id.clone(),
                    accumulator.stream.as_str().to_owned(),
                    accumulator.interrupted,
                )
            })
            .collect();
        open.sort();
        open
    }
}

/// Applies `event` to the live Turn buffer (`applyLiveTurnBufferEvent`).
pub(crate) fn apply(turns: &mut Vec<LiveTurn>, event: LiveEvent<'_>) {
    let Some(turn_id) = event.turn_id().map(str::to_owned) else {
        return;
    };
    let index = turns.iter().position(|turn| turn.turn_id == turn_id);
    if let LiveEvent::Terminal { .. } = event {
        if let Some(index) = index {
            let turn = &mut turns[index];
            turn.terminalize();
            if turn.steps.is_empty() {
                turns.remove(index);
            }
        }
        return;
    }
    let index = index.unwrap_or_else(|| {
        turns.push(LiveTurn {
            turn_id: turn_id.clone(),
            terminal: false,
            started_at: None,
            steps: Vec::new(),
        });
        turns.len() - 1
    });
    turns[index].apply(event);
}

impl LiveTurn {
    /// `terminalizeLiveSteps` plus the `terminal` flag.
    fn terminalize(&mut self) {
        self.terminal = true;
        for step in &mut self.steps {
            for text in [&mut step.thinking, &mut step.text].into_iter().flatten() {
                text.complete = true;
            }
            for tool in &mut step.tools {
                if tool.status.is_in_flight() {
                    tool.status = ToolStatus::Interrupted;
                }
            }
        }
    }

    fn has_steering(&self) -> bool {
        self.steps.iter().any(|step| step.steering.is_some())
    }

    /// `projectLiveTurnEvent` for one content or steering event.
    fn apply(&mut self, event: LiveEvent<'_>) {
        if let LiveEvent::Frame(SessionFrameEvent::SteeringMessage(steering)) = &event {
            let exists = self.steps.iter().any(|step| {
                step.steering.as_ref().is_some_and(|s| s.message_id == steering.message_id)
            });
            if !exists {
                self.started_at.get_or_insert(steering.ts);
                self.steps.push(LiveStep {
                    step_id: format!("steering:{}", steering.message_id),
                    content_order: Vec::new(),
                    steering: Some(LiveSteering {
                        message_id: steering.message_id.clone(),
                        content: steering.content.clone(),
                        ts: steering.ts,
                    }),
                    thinking: None,
                    text: None,
                    tools: Vec::new(),
                });
            }
            return;
        }
        let (message_part, is_complete) = match &event {
            LiveEvent::Delta { part, .. } => (Some(*part), false),
            LiveEvent::Complete { part, .. } => (Some(*part), true),
            LiveEvent::Frame(_) => (None, false),
            LiveEvent::Terminal { .. } => return,
        };
        let message_event = message_part.is_some();
        let frame_event = match &event {
            LiveEvent::Frame(frame_event) => Some(*frame_event),
            _ => None,
        };
        if let Some(SessionFrameEvent::Unknown(_)) = frame_event {
            return;
        }
        if let Some(frame_event) = frame_event
            && let Some(ts) = frame_event_ts(frame_event)
        {
            self.started_at.get_or_insert(ts);
        }
        let tool_use_id = frame_event.and_then(SessionFrameEvent::tool_use_id);
        let existing_tool_step = tool_use_id.and_then(|id| {
            self.steps.iter().position(|step| step.tools.iter().any(|tool| tool.tool_use_id == id))
        });
        let start_step_id = match frame_event {
            Some(SessionFrameEvent::ToolStart(start)) => start.step_id.as_deref(),
            _ => None,
        };
        let step_id = match &event {
            LiveEvent::Delta { message_id, .. } | LiveEvent::Complete { message_id, .. } => {
                (*message_id).to_owned()
            }
            _ => start_step_id
                .map(str::to_owned)
                .or_else(|| existing_tool_step.map(|index| self.steps[index].step_id.clone()))
                .unwrap_or_else(|| format!("tool:{}", tool_use_id.unwrap_or_default())),
        };
        // A steering boundary freezes positions before it; completions and
        // updates to an existing Tool resolve to the row wherever it sits.
        let boundary = self.steps.iter().rposition(|step| step.steering.is_some());
        let same = self.steps.iter().rposition(|step| step.step_id == step_id);
        let after_boundary = |index: Option<usize>| match (index, boundary) {
            (Some(index), Some(boundary)) => (index > boundary).then_some(index),
            (index, None) => index,
            (None, _) => None,
        };
        let step_index = match existing_tool_step {
            None if is_complete => same,
            None => after_boundary(same),
            Some(existing) => {
                let keeps_step = start_step_id.is_none_or(|id| id == self.steps[existing].step_id);
                if keeps_step { Some(existing) } else { same }
            }
        };
        let mut step = match step_index {
            Some(index) => self.steps[index].clone(),
            None => LiveStep {
                step_id: step_id.clone(),
                content_order: Vec::new(),
                steering: None,
                thinking: None,
                text: None,
                tools: Vec::new(),
            },
        };
        match &event {
            LiveEvent::Delta { part, text, .. } => {
                let slot = step.part_mut(*part);
                let previous = slot.take();
                let mut display = previous.as_ref().map(|t| t.text.clone()).unwrap_or_default();
                let truncated = apply_stream_delta(&mut display, text, part.caps());
                *slot = Some(LiveText {
                    text: display,
                    complete: false,
                    interrupted: false,
                    truncated: previous.is_some_and(|t| t.truncated) || truncated,
                });
            }
            LiveEvent::Complete { part, text, interrupted, .. } => {
                let remainder = self.completion_remainder(step_index, &step.step_id, *part, text);
                let (display, truncated) = apply_stream_complete(remainder, part.caps());
                *step.part_mut(*part) = Some(LiveText {
                    text: display,
                    complete: true,
                    interrupted: *interrupted && *part == Part::Text,
                    truncated,
                });
            }
            LiveEvent::Frame(frame_event) => {
                let existing = existing_tool_step.and_then(|index| {
                    self.steps[index]
                        .tools
                        .iter()
                        .find(|tool| Some(tool.tool_use_id.as_str()) == tool_use_id)
                        .cloned()
                });
                let position = step
                    .tools
                    .iter()
                    .position(|tool| Some(tool.tool_use_id.as_str()) == tool_use_id);
                let base = position
                    .map(|index| step.tools[index].clone())
                    .or(existing)
                    .unwrap_or_else(|| placeholder_tool(tool_use_id.unwrap_or_default()));
                let tool = apply_tool_event(base, frame_event);
                match position {
                    Some(index) => step.tools[index] = tool,
                    None => step.tools.push(tool),
                }
            }
            LiveEvent::Terminal { .. } => {}
        }
        let kind = message_part.map_or(ContentKind::Tools, Part::content_kind);
        if !step.content_order.contains(&kind) {
            step.content_order.push(kind);
        }
        self.place_step(step, step_index, existing_tool_step, message_event, tool_use_id);
        if let (Some(part), true) = (message_part, is_complete) {
            // A completion finalizes the message across every slice.
            for (index, candidate) in self.steps.iter_mut().enumerate() {
                if Some(index) != step_index
                    && candidate.step_id == step_id
                    && let Some(text) = candidate.part_mut(part)
                {
                    text.complete = true;
                }
            }
        }
    }

    /// Writes `step` back, moving a Tool out of the step it was first seen
    /// in when a `tool_start` names a different step.
    fn place_step(
        &mut self,
        step: LiveStep,
        step_index: Option<usize>,
        existing_tool_step: Option<usize>,
        message_event: bool,
        tool_use_id: Option<&str>,
    ) {
        let relocate = existing_tool_step
            .filter(|&source| !message_event && self.steps[source].step_id != step.step_id);
        let Some(source) = relocate else {
            match step_index {
                Some(index) => self.steps[index] = step,
                None => self.steps.push(step),
            }
            return;
        };
        let mut source_step = self.steps[source].clone();
        source_step.tools.retain(|tool| Some(tool.tool_use_id.as_str()) != tool_use_id);
        if source_step.tools.is_empty() {
            source_step.content_order.retain(|kind| *kind != ContentKind::Tools);
        }
        let source_empty = source_step.text.is_none()
            && source_step.thinking.is_none()
            && source_step.tools.is_empty()
            && source_step.steering.is_none();
        let mut steps = Vec::with_capacity(self.steps.len() + 1);
        let mut pending = Some(step);
        for (index, candidate) in self.steps.drain(..).enumerate() {
            if index == source {
                if !source_empty {
                    steps.push(source_step.clone());
                } else if step_index.is_none()
                    && let Some(step) = pending.take()
                {
                    steps.push(step);
                }
            } else if Some(index) == step_index {
                if let Some(step) = pending.take() {
                    steps.push(step);
                }
            } else {
                steps.push(candidate);
            }
        }
        if let Some(step) = pending {
            steps.push(step);
        }
        self.steps = steps;
    }

    /// `completionRemainder`: when a steering boundary split the step, the
    /// earlier slices keep what they rendered and this slice takes the rest,
    /// but only on a verified prefix.
    fn completion_remainder<'t>(
        &self,
        step_index: Option<usize>,
        step_id: &str,
        part: Part,
        full: &'t str,
    ) -> &'t str {
        let rendered: String = self
            .steps
            .iter()
            .enumerate()
            .filter(|(index, candidate)| Some(*index) != step_index && candidate.step_id == step_id)
            .filter_map(|(_, candidate)| candidate.part(part).map(|text| text.text.as_str()))
            .collect();
        full.strip_prefix(rendered.as_str()).unwrap_or(full)
    }
}

fn frame_event_ts(event: &SessionFrameEvent) -> Option<u64> {
    Some(match event {
        SessionFrameEvent::ToolStart(event) => event.ts,
        SessionFrameEvent::ToolOutputDelta(event) => event.ts,
        SessionFrameEvent::ToolProgress(event) => event.ts,
        SessionFrameEvent::ToolResult(event) => event.ts,
        SessionFrameEvent::ToolResultPreview(event) => event.ts,
        SessionFrameEvent::SteeringMessage(event) => event.ts,
        _ => return None,
    })
}

/// The row a Tool event creates when its `tool_start` has not been seen.
fn placeholder_tool(tool_use_id: &str) -> ToolItem {
    ToolItem {
        tool_use_id: tool_use_id.to_owned(),
        tool_name: "Tool".to_owned(),
        display_name: None,
        activity_kind: None,
        intent: None,
        args: None,
        args_preview: None,
        step_id: None,
        status: ToolStatus::Running,
        result: None,
        duration_ms: None,
        output: Vec::new(),
    }
}

/// The argument a `tool_start` names in `shellRunRef` in place of an
/// `argsPreview`, as the arguments it came from: `Read`'s `path` and
/// `StopBackgroundTask`'s `ref` (`toolStartShellRunRef` in
/// packages/runtime-host/src/server/session-continuity-coordinator.ts). The
/// Host sends it for every `Read` whose path is a string, not only for a
/// poll of a background shell, so without it a live `Read` row could not
/// say which file it reads until the Turn's durable rows arrive, when the
/// Turn ends.
fn shell_run_ref_args(start: &SessionToolStart) -> Option<serde_json::Value> {
    let key = match start.tool_name.as_str() {
        "Read" => "path",
        "StopBackgroundTask" => "ref",
        _ => return None,
    };
    let reference = start.shell_run_ref.as_ref()?;
    Some(serde_json::json!({ key: reference }))
}

/// The Tool branches of `projectLiveTurnEvent`.
fn apply_tool_event(mut tool: ToolItem, event: &SessionFrameEvent) -> ToolItem {
    match event {
        SessionFrameEvent::ToolStart(start) => {
            // An existing row keeps the status it reached; a new row is the
            // running placeholder.
            tool.tool_name = start.tool_name.clone();
            tool.activity_kind = start.activity_kind.clone().or(tool.activity_kind);
            tool.display_name = start.display_name.clone().or(tool.display_name);
            tool.intent = start.intent.clone().or(tool.intent);
            tool.args_preview = start
                .args_preview
                .clone()
                .or_else(|| shell_run_ref_args(start))
                .or(tool.args_preview);
            tool.step_id = start.step_id.clone().or(tool.step_id);
        }
        SessionFrameEvent::ToolOutputDelta(delta) => {
            // `applyToolOutputChunk`: dedupe by seq, keep seq order. The
            // renderer's secondary redaction and caps are Phase 2.
            if let Err(position) = tool.output.binary_search_by_key(&delta.seq, |chunk| chunk.seq) {
                tool.output.insert(
                    position,
                    ToolOutputChunk {
                        seq: delta.seq,
                        stream: delta.stream.as_str().to_owned(),
                        text: delta.chunk.clone(),
                        redacted: delta.redacted,
                    },
                );
            }
        }
        // Progress and subagent previews only refresh an in-flight status here.
        SessionFrameEvent::ToolProgress(_) | SessionFrameEvent::ToolResultPreview(_) => {}
        SessionFrameEvent::ToolResult(result) => {
            // Live results omit content, so a failed cancel cannot be told
            // apart from an error until the durable row lands.
            tool.status = match result.status {
                SessionToolResultStatus::Completed => ToolStatus::Completed,
                _ => ToolStatus::Errored,
            };
            tool.duration_ms = result.duration_ms.or(tool.duration_ms);
        }
        _ => {}
    }
    tool
}

/// Drops live content that durable rows now cover (`reconcileLiveTurnBuffer`).
///
/// Returns whether anything changed. TS settles a non-terminal Turn's text
/// step only when the renderer finishes revealing it; this client has no
/// reveal animation, so a complete text step is settled as soon as its
/// durable assistant row exists.
pub(crate) fn reconcile(
    turns: &mut Vec<LiveTurn>,
    durable: &HashMap<String, Vec<&StoredMessage>>,
) -> bool {
    let before = turns.clone();
    turns.retain_mut(|turn| {
        let empty = Vec::new();
        let messages = durable.get(&turn.turn_id).unwrap_or(&empty);
        if !reconcile_terminal(turn, messages) {
            return false;
        }
        for message in messages {
            if let StoredMessage::Assistant(assistant) = message {
                let streams_complete =
                    turn.steps.iter().filter(|step| step.step_id == assistant.id).all(|step| {
                        [&step.thinking, &step.text]
                            .into_iter()
                            .all(|text| text.as_ref().is_none_or(|text| text.complete))
                    });
                if (turn.terminal || streams_complete) && !settle_step(turn, &assistant.id) {
                    return false;
                }
            }
        }
        true
    });
    *turns != before
}

/// `reconcileTerminalLiveTurn`. Returns `false` when the live Turn should be
/// dropped.
fn reconcile_terminal(turn: &mut LiveTurn, messages: &[&StoredMessage]) -> bool {
    let reached_terminal = messages.iter().any(|message| {
        matches!(message, StoredMessage::TurnState(state) if state.status != host_protocol::TurnStatus::Running)
    });
    if reached_terminal && !turn.terminal {
        turn.terminalize();
    }
    if turn.terminal && turn.has_steering() && !reached_terminal {
        return true;
    }
    let call_ids: HashSet<&str> = messages
        .iter()
        .filter_map(|message| match message {
            StoredMessage::ToolCall(call) => Some(call.id.as_str()),
            _ => None,
        })
        .collect();
    let result_ids: HashSet<&str> = messages
        .iter()
        .filter_map(|message| match message {
            StoredMessage::ToolResult(result) => Some(result.tool_use_id.as_str()),
            _ => None,
        })
        .collect();
    let assistant_ids: HashSet<&str> = messages
        .iter()
        .filter_map(|message| match message {
            StoredMessage::Assistant(assistant) => Some(assistant.id.as_str()),
            _ => None,
        })
        .collect();
    let before = turn.steps.len();
    turn.steps.retain(|step| {
        if step.steering.is_some() {
            return true;
        }
        if step.text.as_ref().is_some_and(|text| !text.text.is_empty()) {
            return true;
        }
        if step.thinking.is_some() && !assistant_ids.contains(step.step_id.as_str()) {
            return true;
        }
        let covered = step.tools.iter().all(|tool| {
            if !call_ids.contains(tool.tool_use_id.as_str()) {
                return false;
            }
            let has_result = result_ids.contains(tool.tool_use_id.as_str());
            if !tool.output.is_empty()
                && (!has_result || !durable_stream_evidence(messages, &tool.tool_use_id))
            {
                return false;
            }
            tool.status == ToolStatus::Interrupted || has_result
        });
        !covered
    });
    let steering_settled = turn.terminal && reached_terminal && turn.has_steering();
    if steering_settled {
        turn.steps.retain(|step| step.steering.is_none());
    }
    let dropped_some = turn.steps.len() != before;
    !(turn.steps.is_empty() && turn.terminal && (reached_terminal || dropped_some))
}

/// `durableStreamEvidence`: whether a durable result can replace live output.
fn durable_stream_evidence(messages: &[&StoredMessage], tool_use_id: &str) -> bool {
    for message in messages {
        let StoredMessage::ToolResult(result) = message else { continue };
        if result.tool_use_id != tool_use_id {
            continue;
        }
        let content = &result.content;
        let kind = content.get("kind").and_then(serde_json::Value::as_str);
        if matches!(kind, Some("terminal" | "shell_run")) {
            let Some(output) = content.get("output").filter(|output| !output.is_null()) else {
                return false;
            };
            if output.get("mode").and_then(serde_json::Value::as_str) == Some("pty") {
                return true;
            }
            let non_empty = |field: &str| {
                output
                    .get(field)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|text| !text.is_empty())
            };
            let flag =
                |field: &str| output.get(field).and_then(serde_json::Value::as_bool) == Some(true);
            return non_empty("stdout")
                || non_empty("stderr")
                || flag("stdoutTruncated")
                || flag("stderrTruncated")
                || flag("redacted");
        }
        return true;
    }
    false
}

/// `settleLiveTurnStep`: drop the text and reasoning of `step_id`, keeping
/// Tools that hold live output. Returns `false` when the live Turn should be
/// dropped.
fn settle_step(turn: &mut LiveTurn, step_id: &str) -> bool {
    let mut found = false;
    turn.steps.retain_mut(|step| {
        if step.step_id != step_id {
            return true;
        }
        found = true;
        step.tools.retain(|tool| !tool.output.is_empty());
        step.text = None;
        step.thinking = None;
        step.content_order =
            if step.tools.is_empty() { Vec::new() } else { vec![ContentKind::Tools] };
        !step.tools.is_empty()
    });
    !(found && turn.steps.is_empty() && turn.terminal)
}
