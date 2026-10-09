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

//! The transcript flattened into list rows: one per turn item plus one
//! footer per turn, after a row about older history when there is any, each
//! a presentation snapshot the row renderer reads without touching an
//! entity.
//!
//! Rows are rebuilt from the [`Transcript`] on every commit (at most about
//! 8 Hz while a turn streams) and diffed against the previous rows by
//! identity, so the virtual list only splices where rows came or went and
//! remeasures the rows whose content changed.

use std::collections::{HashMap, HashSet};
use std::ops::Range;

use gpui_kit::{ElementId, SharedString};
use host_protocol::{
    AttachmentKind, AttachmentRef, InteractionClosureReason, InteractionRequest,
    PermissionDecision, PermissionPrompt, PermissionReview, SandboxBoundaryRequest,
    SandboxBoundaryScope, SandboxBoundaryStatus, StorageRef, TurnProviderRetry,
};
use serde_json::Value;
use shared::diff::DiffRows;
use shared::domain_element_id;
use transcript_model::{
    InteractionItem, InteractionState, ItemKey, Resolution, ThinkingItem, ToolItem, ToolStatus,
    Transcript, TurnItem, TurnView, TurnViewStatus,
};

use crate::quiet_json::quiet_text;
use crate::state::{AnswerState, OlderHistory};
use shared::copy::conversation as copy;
use shared::copy::{self as shell_copy, Locale};

/// The most characters of Tool input or output a card shows.
const DETAIL_MAX_CHARS: usize = 16 * 1024;
/// The most characters of a Tool card's one-line summary.
const SUMMARY_MAX_CHARS: usize = 120;
/// The most lines of a `file_diff` a card shows (Desktop's
/// `TOOL_LINE_CAP`).
const TOOL_DIFF_MAX_LINES: usize = 500;

/// The `ElementId` of the row that shows item `key` of turn `turn_id`.
///
/// Item keys are unique within their turn only (a provider may reuse a
/// Tool call id in a later turn), so the turn id is part of the identity.
pub fn item_element_id(turn_id: &str, key: &ItemKey) -> ElementId {
    domain_element_id("transcript-item", &format!("{turn_id}/{key}"))
}

/// The `ElementId` of the footer row of turn `turn_id`.
pub fn footer_element_id(turn_id: &str) -> ElementId {
    domain_element_id("turn-footer", turn_id)
}

/// The `ElementId` of the row above the first message that loads, or
/// marks the end of, older history.
pub fn history_element_id() -> ElementId {
    domain_element_id("transcript-history", "top")
}

/// The identity of a row.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum RowKey {
    /// The first row while the transcript has, or had, older history.
    History,
    Item {
        turn_id: String,
        key: ItemKey,
    },
    Footer {
        turn_id: String,
    },
}

impl RowKey {
    pub(crate) fn element_id(&self) -> ElementId {
        match self {
            Self::History => history_element_id(),
            Self::Item { turn_id, key } => item_element_id(turn_id, key),
            Self::Footer { turn_id } => footer_element_id(turn_id),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Row {
    pub(crate) key: RowKey,
    pub(crate) body: RowBody,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RowBody {
    History(HistoryRow),
    User { text: SharedString, attachments: Vec<SentAttachment> },
    Thinking(ThinkingRow),
    Text { text: SharedString, streaming: bool, interrupted: bool },
    Tool(ToolRow),
    Prompt(PromptRow),
    Footer(FooterRow),
}

/// A file a sent message carries, as its chip above the bubble shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SentAttachment {
    /// What names it within its message: where its bytes are stored.
    pub(crate) key: SharedString,
    pub(crate) name: SharedString,
    pub(crate) bytes: u64,
    /// The Host took it as an image.
    pub(crate) image: bool,
    /// The kind the Host gave it, which its chip's glyph shows.
    pub(crate) kind: AttachmentKind,
}

impl SentAttachment {
    fn of(attachment: AttachmentRef) -> Self {
        let key = match &attachment.storage {
            StorageRef::SessionFile { relative_path, .. }
            | StorageRef::WorkspaceFile { relative_path } => relative_path.clone(),
            StorageRef::ExternalFile { absolute_path } => absolute_path.clone(),
            StorageRef::SessionContext { ref_id, .. } => ref_id.clone(),
            _ => attachment.name.clone(),
        };
        Self {
            key: key.into(),
            image: attachment.kind == AttachmentKind::Image,
            kind: attachment.kind.clone(),
            name: attachment.name.into(),
            bytes: attachment.bytes,
        }
    }

    /// The chip's `ElementId`, unique within its message's row.
    pub(crate) fn element_id(&self) -> ElementId {
        domain_element_id("sent-attachment", &self.key)
    }
}

/// What the row above the first message says about older history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HistoryRow {
    /// Older messages exist; reaching this row loads them. Blank, the height
    /// of the loading line, so loading changes nothing around it.
    More,
    Loading,
    Failed(SharedString),
    /// Loading reached the Session's first message.
    Beginning,
}

impl HistoryRow {
    /// The row for `older`, or none when there is nothing to say.
    pub(crate) fn of(older: &OlderHistory) -> Option<Self> {
        Some(match older {
            OlderHistory::Available => Self::More,
            OlderHistory::Loading => Self::Loading,
            OlderHistory::Failed(message) => Self::Failed(message.clone()),
            OlderHistory::Reached => Self::Beginning,
            _ => return None,
        })
    }
}

/// An assistant step's reasoning: a collapsed line that expands to the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ThinkingRow {
    /// Identifies the row for expansion: `turn_id/thinking:stepId`.
    pub(crate) expansion_key: String,
    pub(crate) streaming: bool,
    /// The earliest reasoning was cut to keep the most recent.
    pub(crate) truncated: bool,
    pub(crate) expanded: bool,
    /// The first line, shown after the label once the reasoning is complete
    /// and collapsed.
    pub(crate) preview: Option<SharedString>,
    /// The whole reasoning, filled only while expanded.
    pub(crate) text: Option<SharedString>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ToolRow {
    /// Identifies the card for expansion: `turn_id/toolUseId`.
    pub(crate) expansion_key: String,
    pub(crate) name: SharedString,
    /// What the Tool does, for its icon.
    pub(crate) kind: ToolKind,
    pub(crate) summary: Option<SharedString>,
    /// Lines the call added and removed, from a `file_diff` result; 0 when
    /// the result carries no diff.
    pub(crate) added: u32,
    pub(crate) removed: u32,
    pub(crate) status: ToolStatus,
    /// The call is unfinished while its Turn waits on the user (a permission
    /// or boundary prompt), so it shows as waiting rather than stopped.
    pub(crate) waiting: bool,
    /// Where the row sits in its run of consecutive Tool calls, which share
    /// one container.
    pub(crate) group: GroupPlace,
    pub(crate) expanded: bool,
    /// Filled only while expanded; the input only before a result.
    pub(crate) input: Option<SharedString>,
    pub(crate) output: Option<SharedString>,
    /// The `file_diff` the call returned, filled only while expanded; the
    /// card shows it with the kit's Diff component, or `output` as text
    /// when the component's parser rejects it.
    pub(crate) diff: Option<ToolDiff>,
    /// What the open card says when it has neither output nor input.
    pub(crate) note: ToolNote,
}

/// An open card's `file_diff`, cut to [`TOOL_DIFF_MAX_LINES`] as Maka
/// Desktop cuts it for its diff preview (`capLines` in
/// packages/ui/src/tool-activity/preview-utils.ts).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ToolDiff {
    pub(crate) text: SharedString,
    /// Lines past the cut.
    pub(crate) hidden_lines: usize,
    /// Its hunks and their lines, which set the Diff's height.
    pub(crate) rows: DiffRows,
}

impl ToolDiff {
    fn new(diff: &str) -> Self {
        let bounded = shared::diff::bounded(diff, TOOL_DIFF_MAX_LINES);
        Self {
            rows: shared::diff::display_rows(&bounded.text),
            text: bounded.text.into(),
            hidden_lines: bounded.hidden_lines,
        }
    }
}

/// What an open Tool card says when it has neither output nor input to
/// show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolNote {
    /// The call runs, or waits on the user, and has produced nothing yet
    /// (Maka Desktop's `noOutputYet`).
    NoOutputYet,
    /// The call finished, and what it returned has not arrived: a live
    /// `tool_result` carries no content, and the Host announces the Turn's
    /// durable rows, which carry it, only when the Turn ends.
    OutputAtTurnEnd,
    /// The call finished without output (Maka Desktop's `noOutput`).
    NoOutput,
}

/// What a Tool does, as its row's icon says (spec §7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolKind {
    Terminal,
    Read,
    Edit,
    Search,
    Web,
    /// MCP Tools and anything else.
    Plug,
}

impl ToolKind {
    /// The kind of Tool `name`, by the names the spec maps; a name it does
    /// not list falls back to the Host's `activityKind`
    /// (`ToolActivityKind` in packages/core), then to [`Self::Plug`].
    pub(crate) fn of(name: &str, activity_kind: Option<&str>) -> Self {
        match name {
            "Bash" => Self::Terminal,
            "Read" => Self::Read,
            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => Self::Edit,
            "Glob" | "Grep" | "LS" => Self::Search,
            "WebFetch" | "WebSearch" => Self::Web,
            _ => match activity_kind {
                Some("command") => Self::Terminal,
                Some("read") => Self::Read,
                Some("edit") => Self::Edit,
                Some("search") => Self::Search,
                Some("web") => Self::Web,
                _ => Self::Plug,
            },
        }
    }
}

/// A Tool row's place in its run of consecutive Tool calls: the first row
/// draws the container's top edge, the last its bottom edge, the rest a
/// divider above them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct GroupPlace {
    pub(crate) first: bool,
    pub(crate) last: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PromptRow {
    pub(crate) interaction_id: String,
    pub(crate) body: PromptBody,
    pub(crate) answer: Option<AnswerState>,
}

impl PromptRow {
    /// Whether the prompt still waits for an answer.
    pub(crate) fn is_pending(&self) -> bool {
        match &self.body {
            PromptBody::Permission { outcome, .. }
            | PromptBody::SandboxBoundary { outcome, .. }
            | PromptBody::Question { outcome, .. }
            | PromptBody::Unsupported { outcome } => outcome.is_none(),
        }
    }

    pub(crate) fn is_sending(&self) -> bool {
        matches!(self.answer, Some(AnswerState::Sending(_)))
    }

    pub(crate) fn failure(&self) -> Option<&SharedString> {
        match &self.answer {
            Some(AnswerState::Failed(message)) => Some(message),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PromptBody {
    Permission {
        tool_name: SharedString,
        /// What the call does: a command line, a path, or arguments.
        detail: Option<SharedString>,
        /// `None` while pending; otherwise how it ended.
        outcome: Option<SharedString>,
    },
    /// The turn wants the sandbox widened (`InteractionSandboxBoundaryRequest`
    /// in `packages/core/src/interaction.ts`): paths outside the workspace or
    /// the network.
    SandboxBoundary {
        /// The model's reason, as the Host passed it on.
        justification: Option<SharedString>,
        /// One line per access asked for.
        grants: Vec<SandboxGrant>,
        outcome: Option<SharedString>,
    },
    Question {
        questions: Vec<QuestionRow>,
        /// The option picked per question, before the answer is sent.
        selected: Vec<Option<usize>>,
        outcome: Option<SharedString>,
    },
    Unsupported {
        outcome: Option<SharedString>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct QuestionRow {
    pub(crate) text: SharedString,
    pub(crate) options: Vec<SharedString>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FooterRow {
    pub(crate) status: TurnViewStatus,
    pub(crate) failure: Option<SharedString>,
    /// Host wall-clock milliseconds of the turn's earliest row; 0 when
    /// unknown.
    pub(crate) started_at: u64,
    /// The turn is the session's live root Turn, so a running line can
    /// claim progress: a durable `running` turn without one is a leftover
    /// of a Host that stopped mid-turn.
    pub(crate) live: bool,
    /// The provider request the live turn's Runtime retries.
    pub(crate) retry: Option<TurnProviderRetry>,
    /// The model of the turn's latest assistant step.
    pub(crate) model: Option<SharedString>,
    /// The turn has reply text to copy.
    pub(crate) has_reply: bool,
}

/// View-local choices the rows reflect.
#[derive(Debug, Default)]
pub(crate) struct RowOptions {
    /// Expanded Tool cards and reasoning rows by their expansion key
    /// ([`ToolRow::expansion_key`], [`ThinkingRow::expansion_key`]).
    pub(crate) expanded: HashSet<String>,
    /// Picked options per question prompt, by interaction id.
    pub(crate) choices: HashMap<String, Vec<Option<usize>>>,
    /// The language the rows' words are in.
    pub(crate) locale: Locale,
}

/// An answer in flight or failed, by interaction id: what the conversation
/// state knows about a prompt beyond the transcript.
pub(crate) type PromptAnswers<'a> = &'a dyn Fn(&str) -> Option<AnswerState>;

/// Flattens `transcript` into rows, after the older-history row when
/// `older` has one. Text already shown by `previous` keeps its
/// `SharedString`, so a text view that receives the same allocation again
/// skips comparing it.
pub(crate) fn build_rows(
    transcript: &Transcript,
    older: &OlderHistory,
    answers: PromptAnswers<'_>,
    options: &RowOptions,
    previous: &[Row],
) -> Vec<Row> {
    let previous: HashMap<&RowKey, &RowBody> =
        previous.iter().map(|row| (&row.key, &row.body)).collect();
    let mut rows = Vec::new();
    if let Some(history) = HistoryRow::of(older) {
        rows.push(Row { key: RowKey::History, body: RowBody::History(history) });
    }
    let live_turn = transcript
        .root_turn()
        .filter(|root| !root.status.is_terminal())
        .map(|root| root.turn_id.as_str());
    for turn in transcript.turns() {
        for item in &turn.items {
            let key = RowKey::Item { turn_id: turn.turn_id.clone(), key: item.key() };
            let before = previous.get(&key).copied();
            let body = match item {
                TurnItem::User(user) => {
                    let before = match before {
                        Some(RowBody::User { text, .. }) => Some(text),
                        _ => None,
                    };
                    let attachments = user
                        .content
                        .attachment_refs()
                        .into_iter()
                        .map(SentAttachment::of)
                        .collect();
                    RowBody::User { text: reuse(before, user.text()), attachments }
                }
                TurnItem::Text(text) => {
                    let before = match before {
                        Some(RowBody::Text { text, .. }) => Some(text),
                        _ => None,
                    };
                    RowBody::Text {
                        text: reuse(before, &text.text),
                        streaming: text.streaming,
                        interrupted: text.interrupted,
                    }
                }
                TurnItem::Thinking(thinking) => {
                    RowBody::Thinking(thinking_row(&turn.turn_id, thinking, options))
                }
                TurnItem::Tool(tool) if hidden_tool(tool, turn.status) => continue,
                TurnItem::Tool(tool) => {
                    RowBody::Tool(tool_row(&turn.turn_id, turn.status, tool, options))
                }
                TurnItem::Interaction(prompt) => {
                    RowBody::Prompt(prompt_row(turn, prompt, answers, options))
                }
                _ => continue,
            };
            rows.push(Row { key, body });
        }
        rows.push(Row {
            key: RowKey::Footer { turn_id: turn.turn_id.clone() },
            body: RowBody::Footer(FooterRow {
                status: turn.status,
                failure: turn.failure.as_ref().map(|failure| {
                    SharedString::from(failure.message.clone().unwrap_or(failure.class.clone()))
                }),
                started_at: turn.started_at,
                live: live_turn == Some(turn.turn_id.as_str()),
                retry: turn.provider_retry.clone(),
                model: turn.model_id.clone().map(SharedString::from),
                has_reply: turn.items.iter().any(
                    |item| matches!(item, TurnItem::Text(text) if !text.text.trim().is_empty()),
                ),
            }),
        });
    }
    place_tool_groups(&mut rows);
    rows
}

/// Marks each Tool row's place in its run of consecutive Tool rows. Runs
/// never cross a turn: every turn ends with its footer row.
fn place_tool_groups(rows: &mut [Row]) {
    let is_tool = |row: Option<&Row>| matches!(row.map(|row| &row.body), Some(RowBody::Tool(_)));
    for ix in 0..rows.len() {
        let first = !is_tool(ix.checked_sub(1).and_then(|before| rows.get(before)));
        let last = !is_tool(rows.get(ix + 1));
        if let RowBody::Tool(tool) = &mut rows[ix].body {
            tool.group = GroupPlace { first, last };
        }
    }
}

/// The reply of a turn as one text: its assistant text items in order,
/// separated by a blank line. Built when the reply is copied, not per row.
pub(crate) fn reply_text(turn: &TurnView) -> String {
    let parts: Vec<&str> = turn
        .items
        .iter()
        .filter_map(|item| match item {
            TurnItem::Text(text) if !text.text.trim().is_empty() => Some(text.text.trim()),
            _ => None,
        })
        .collect();
    parts.join("\n\n")
}

fn reuse(before: Option<&SharedString>, text: &str) -> SharedString {
    match before {
        Some(before) if before.as_ref() == text => before.clone(),
        _ => SharedString::from(text.to_owned()),
    }
}

fn thinking_row(turn_id: &str, thinking: &ThinkingItem, options: &RowOptions) -> ThinkingRow {
    let expansion_key = format!("{turn_id}/thinking:{}", thinking.message_id);
    let expanded = options.expanded.contains(&expansion_key);
    let collapsed_done = !expanded && !thinking.streaming;
    ThinkingRow {
        streaming: thinking.streaming,
        truncated: thinking.truncated,
        expanded,
        preview: collapsed_done
            .then(|| one_line(&thinking.text, SUMMARY_MAX_CHARS))
            .filter(|line| !line.is_empty())
            .map(SharedString::from),
        text: expanded.then(|| SharedString::from(cap(&thinking.text))),
        expansion_key,
    }
}

fn tool_row(
    turn_id: &str,
    turn_status: TurnViewStatus,
    tool: &ToolItem,
    options: &RowOptions,
) -> ToolRow {
    let expansion_key = format!("{turn_id}/{}", tool.tool_use_id);
    let expanded = options.expanded.contains(&expansion_key);
    let name = tool.display_name.clone().unwrap_or_else(|| tool_label(&tool.tool_name));
    let (added, removed) = file_diff(tool).map(shared::diff::line_counts).unwrap_or_default();
    // Unfinished, or refused by the sandbox, while the turn waits on the
    // user: the call is waiting for permission, not failed (DESIGN.md §9
    // keeps `attention` apart from `error` and `active`).
    let waiting = turn_status == TurnViewStatus::WaitingForUser
        && (tool.status == ToolStatus::Interrupted
            || (tool.status == ToolStatus::Errored && sandbox_denied(tool)));
    ToolRow {
        expansion_key,
        kind: ToolKind::of(&tool.tool_name, tool.activity_kind.as_deref()),
        name: name.into(),
        summary: tool_summary(tool).map(SharedString::from),
        added,
        removed,
        status: tool.status,
        waiting,
        group: GroupPlace::default(),
        expanded,
        // Only until a result arrives: a result with nothing to show says
        // so, as Maka Desktop's does, rather than repeat the call.
        input: (expanded && tool.result.is_none())
            .then(|| tool.display_args().map(pretty))
            .flatten()
            .map(SharedString::from),
        output: expanded
            .then(|| tool_output(tool, options.locale))
            .flatten()
            .map(SharedString::from),
        diff: expanded.then(|| file_diff(tool).map(ToolDiff::new)).flatten(),
        note: tool_note(tool, waiting),
    }
}

/// What an open card says when the call has neither output nor input: a
/// call that finished without a result finished live, since a durable
/// `tool_result` row always carries one.
fn tool_note(tool: &ToolItem, waiting: bool) -> ToolNote {
    match tool.status {
        _ if waiting => ToolNote::NoOutputYet,
        ToolStatus::Running => ToolNote::NoOutputYet,
        ToolStatus::Completed | ToolStatus::Errored if tool.result.is_none() => {
            ToolNote::OutputAtTurnEnd
        }
        _ => ToolNote::NoOutput,
    }
}

/// Whether the Host refused the call at the sandbox (`sandboxDenial` on a
/// terminal result, packages/core/src/events.ts `ToolResultContent`).
fn sandbox_denied(tool: &ToolItem) -> bool {
    tool.result.as_ref().is_some_and(|result| result.get("sandboxDenial").is_some())
}

/// Tool calls a person has nothing to do with: `tool_search` only loads
/// another tool's definition, and a boundary request that still waits is
/// already shown in full by its prompt card right below (review round 2).
fn hidden_tool(tool: &ToolItem, turn_status: TurnViewStatus) -> bool {
    tool.tool_name == "tool_search"
        || (tool.tool_name == "request_sandbox_boundary"
            && tool.status == ToolStatus::Interrupted
            && turn_status == TurnViewStatus::WaitingForUser)
}

/// The name a person reads for a Tool the Host names in snake_case: the
/// two runtime tools a user meets get words, the rest become sentence case
/// (`agent_spawn` reads "Agent spawn"). Named tools (`Bash`, `Read`) keep
/// their names, as in Maka Desktop.
fn tool_label(tool_name: &str) -> String {
    match tool_name {
        "tool_search" => "Load tool".to_owned(),
        "request_sandbox_boundary" => "Permission".to_owned(),
        name if name.contains('_') => {
            let words = name.replace('_', " ");
            let mut chars = words.chars();
            chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or(words)
        }
        name => name.to_owned(),
    }
}

/// What a boundary request asks for, in words: `Write ~/folder`, one entry
/// per path, then network access (`SandboxBoundaryExpansion` in
/// packages/core/src/sandbox-boundary.ts).
fn boundary_summary(args: &Value) -> Option<String> {
    let expansion = args.get("expansion")?;
    let home = std::env::var("HOME").ok();
    let mut parts: Vec<String> = expansion
        .pointer("/filesystem/entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let path = display_path(entry.get("path")?.as_str()?, home.as_deref());
            let verb = if entry.get("access")?.as_str()? == "write" { "Write" } else { "Read" };
            Some(format!("{verb} {path}"))
        })
        .collect();
    if expansion.pointer("/network/enabled").and_then(Value::as_bool) == Some(true) {
        parts.push("Network access".to_owned());
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// One access a sandbox boundary request asks for: the sentence that says
/// it, and the path inside that sentence, which the prompt sets as machine
/// text.
#[derive(Debug, Clone, PartialEq)]
pub struct SandboxGrant {
    pub text: SharedString,
    pub path: Option<SharedString>,
}

/// A path as a permission names it: under the home folder it starts with
/// `~`, and it never ends with a slash, since the wording around it says
/// whether it covers what is inside.
fn display_path(path: &str, home: Option<&str>) -> String {
    let trimmed = path.trim_end_matches('/');
    let path = if trimmed.is_empty() { path } else { trimmed };
    let home = home.map(|home| home.trim_end_matches('/')).filter(|home| !home.is_empty());
    match home.and_then(|home| path.strip_prefix(home)) {
        Some("") => "~".to_owned(),
        Some(rest) if rest.starts_with('/') => format!("~{rest}"),
        _ => path.to_owned(),
    }
}

/// One line that says what the call does: the command, the path, the
/// pattern, or the model's stated intent; for a code cell (`exec`), whose
/// only argument is its `code`, the intent before the script's first line,
/// as Maka Desktop puts a call's intent before its arguments.
fn tool_summary(tool: &ToolItem) -> Option<String> {
    if tool.tool_name == "request_sandbox_boundary"
        && let Some(summary) = tool.display_args().and_then(boundary_summary)
    {
        return Some(one_line(&summary, SUMMARY_MAX_CHARS));
    }
    const KEYS: [&str; 10] = [
        "command",
        "cmd",
        "script",
        "file_path",
        "filePath",
        "path",
        "pattern",
        "url",
        "query",
        "prompt",
    ];
    let args = tool.display_args();
    let field = |key: &str| args.and_then(|args| args.get(key)?.as_str().map(str::to_owned));
    let summary = KEYS
        .iter()
        .find_map(|key| field(key))
        .or_else(|| tool.intent.clone())
        .or_else(|| field("code").filter(|code| !code.trim().is_empty()))
        .or_else(|| args.filter(|args| !is_empty_json(args)).map(Value::to_string))?;
    Some(one_line(&summary, SUMMARY_MAX_CHARS))
}

fn is_empty_json(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Object(map) => map.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// The unified diff of a `file_diff` result (`ToolResultContent` in
/// packages/core/src/events.ts), which Write and Edit return when the Host
/// computed one.
fn file_diff(tool: &ToolItem) -> Option<&str> {
    let result = tool.result.as_ref()?;
    (result.get("kind")?.as_str()? == "file_diff").then(|| result.get("diff")?.as_str())?
}

/// What a shell run printed, from a `terminal` result (`ShellOutput` in
/// packages/core/src/shell-run.ts): stdout then stderr for pipes, the
/// scrollback then the screen for a pty; the failure message when it
/// printed nothing.
fn terminal_output(result: &Value) -> Option<String> {
    let output = result.get("output")?;
    let field = |key: &str| output.get(key).and_then(Value::as_str).unwrap_or("");
    let streams = match output.get("mode")?.as_str()? {
        "pipes" => [field("stdout"), field("stderr")],
        "pty" => [field("scrollback"), field("screen")],
        _ => return None,
    };
    let printed: Vec<&str> = streams
        .iter()
        .map(|stream| stream.trim_end_matches('\n'))
        .filter(|stream| !stream.is_empty())
        .collect();
    if printed.is_empty() {
        return result.get("failureMessage").and_then(Value::as_str).map(str::to_owned);
    }
    Some(printed.join("\n"))
}

/// What an open card shows as the call's output: what its result holds,
/// else what it printed live; `None` when there is nothing to show, and the
/// card says why instead ([`ToolNote`]).
fn tool_output(tool: &ToolItem, locale: Locale) -> Option<String> {
    let settled = tool.result.as_ref().and_then(|result| result_output(result, locale));
    let live = || {
        (!tool.output.is_empty())
            .then(|| tool.output.iter().map(|chunk| chunk.text.as_str()).collect::<String>())
    };
    settled.or_else(live).map(|text| cap(&text))
}

/// The output a durable result holds (`ToolResultContent` in
/// packages/core/src/events.ts), as Maka Desktop's result preview shows it;
/// `None` when the call returned nothing to show: empty text, or a command
/// that printed nothing and did not fail (Desktop's `noOutput`).
fn result_output(result: &Value, locale: Locale) -> Option<String> {
    let field = |key: &str| result.get(key).and_then(Value::as_str);
    match field("kind") {
        Some("text") => field("text").filter(|text| !text.is_empty()).map(str::to_owned),
        Some("file_diff") if field("diff").is_some() => field("diff").map(str::to_owned),
        Some("json") => Some(quiet_text(
            result.get("value").unwrap_or(&Value::Null),
            copy::TOOL_OUTPUT_EMPTY.in_locale(locale),
        )),
        Some("terminal") => terminal_output(result),
        _ => Some(terminal_output(result).unwrap_or_else(|| json_text(result))),
    }
}

fn json_text(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn pretty(value: &Value) -> String {
    cap(&json_text(value))
}

/// At most [`DETAIL_MAX_CHARS`] characters, marked when cut.
fn cap(text: &str) -> String {
    match text.char_indices().nth(DETAIL_MAX_CHARS) {
        Some((end, _)) => format!("{}\n…", &text[..end]),
        None => text.to_owned(),
    }
}

/// The first line of `text`, at most `max` characters, marked when cut.
fn one_line(text: &str, max: usize) -> String {
    let first = text.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
    let more_lines = text.trim().lines().count() > 1;
    match first.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", &first[..end]),
        None if more_lines => format!("{first} …"),
        None => first.to_owned(),
    }
}

fn prompt_row(
    turn: &TurnView,
    item: &InteractionItem,
    answers: PromptAnswers<'_>,
    options: &RowOptions,
) -> PromptRow {
    let locale = options.locale;
    let outcome = match &item.state {
        InteractionState::Pending => None,
        InteractionState::Resolved(resolution) => {
            Some(SharedString::from(outcome(resolution, locale)))
        }
        _ => Some(SharedString::from(copy::NO_LONGER_WAITING.in_locale(locale))),
    };
    let body = match &item.request {
        Some(InteractionRequest::Question(request)) => {
            let questions: Vec<QuestionRow> = request
                .questions
                .iter()
                .map(|question| QuestionRow {
                    text: question.question.clone().into(),
                    options: question
                        .options
                        .iter()
                        .map(|option| SharedString::from(option.label.clone()))
                        .collect(),
                })
                .collect();
            let mut selected =
                options.choices.get(&item.interaction_id).cloned().unwrap_or_default();
            selected.resize(questions.len(), None);
            PromptBody::Question { questions, selected, outcome }
        }
        Some(InteractionRequest::Permission(request)) => PromptBody::Permission {
            tool_name: tool_name(item, Some(&request.prompt), locale),
            detail: permission_detail(&request.prompt, locale).or_else(|| tool_args(turn, item)),
            outcome,
        },
        // A history row carries only the decision.
        None => PromptBody::Permission {
            tool_name: tool_name(item, None, locale),
            detail: tool_args(turn, item),
            outcome,
        },
        Some(InteractionRequest::SandboxBoundary(request)) => {
            let (justification, grants) = sandbox_request(request, locale);
            PromptBody::SandboxBoundary { justification, grants, outcome }
        }
        Some(_) => PromptBody::Unsupported { outcome },
    };
    PromptRow {
        interaction_id: item.interaction_id.clone(),
        body,
        answer: answers(&item.interaction_id),
    }
}

/// The model's reason and one line per access a sandbox boundary request
/// asks for (`InteractionSandboxBoundaryRequest` in
/// `packages/core/src/interaction.ts`).
fn sandbox_request(
    request: &SandboxBoundaryRequest,
    locale: Locale,
) -> (Option<SharedString>, Vec<SandboxGrant>) {
    let justification = Some(request.justification.trim())
        .filter(|text| !text.is_empty())
        .map(|text| SharedString::from(text.to_owned()));
    let expansion = &request.expansion;
    let home = std::env::var("HOME").ok();
    let mut grants: Vec<SandboxGrant> = expansion
        .filesystem
        .iter()
        .flat_map(|filesystem| &filesystem.entries)
        .map(|entry| {
            // An unknown scope reads as the wider one, so the prompt never
            // understates what it grants.
            let subtree = entry.scope != SandboxBoundaryScope::Exact;
            let path = display_path(&entry.path, home.as_deref());
            let text = copy::sandbox_grant(locale, entry.access.as_str(), &path, subtree);
            SandboxGrant { text: text.into(), path: Some(path.into()) }
        })
        .collect();
    if expansion.network.as_ref().is_some_and(|network| network.enabled) {
        grants.push(SandboxGrant {
            text: copy::SANDBOX_NETWORK.in_locale(locale).into(),
            path: None,
        });
    }
    (justification, grants)
}

fn tool_name(
    item: &InteractionItem,
    prompt: Option<&PermissionPrompt>,
    locale: Locale,
) -> SharedString {
    item.tool_name
        .as_deref()
        .or_else(|| prompt.and_then(PermissionPrompt::tool_name))
        .unwrap_or(copy::TOOL_UNNAMED.in_locale(locale))
        .to_owned()
        .into()
}

/// What the Host's review says the call does. Texts are already sanitized
/// for display by the Host.
fn permission_detail(prompt: &PermissionPrompt, locale: Locale) -> Option<SharedString> {
    let review = match prompt {
        PermissionPrompt::ToolPermission(prompt) => &prompt.review,
        PermissionPrompt::SandboxEscalation(prompt) => &prompt.review,
        _ => return None,
    };
    let text = match review {
        PermissionReview::Command(review) => match &review.cwd {
            Some(cwd) => copy::PERMISSION_COMMAND_IN
                .fill(locale, &[("command", &review.command), ("cwd", cwd)]),
            None => review.command.clone(),
        },
        PermissionReview::Path(review) => format!("{} {}", review.operation, review.path),
        PermissionReview::Search(review) => copy::PERMISSION_SEARCH.fill(
            locale,
            &[
                ("operation", &review.operation),
                ("pattern", &review.pattern),
                ("root", &review.root),
            ],
        ),
        PermissionReview::Web(review) => review.target.clone(),
        PermissionReview::Tool(review) => {
            let arguments = serde_json::from_str::<Value>(&review.arguments.text)
                .map(|value| pretty(&value))
                .unwrap_or_else(|_| review.arguments.text.clone());
            if review.arguments.truncated { format!("{arguments}\n…") } else { arguments }
        }
        _ => return None,
    };
    Some(cap(&text).into())
}

/// The arguments of the Tool a prompt is about, from its Tool item.
fn tool_args(turn: &TurnView, item: &InteractionItem) -> Option<SharedString> {
    let tool_use_id = item.tool_use_id.as_ref()?;
    match turn.item(&ItemKey::Tool(tool_use_id.clone()))? {
        TurnItem::Tool(tool) => tool.display_args().map(|args| pretty(args).into()),
        _ => None,
    }
}

fn outcome(resolution: &Resolution, locale: Locale) -> String {
    match resolution {
        Resolution::Permission { decision: PermissionDecision::Allow, remember_for_turn: true } => {
            copy::ALLOWED_FOR_TURN.in_locale(locale).to_owned()
        }
        Resolution::Permission { decision: PermissionDecision::Allow, .. } => {
            copy::ALLOWED.in_locale(locale).to_owned()
        }
        Resolution::Permission { decision: PermissionDecision::Deny, .. } => {
            copy::DENIED.in_locale(locale).to_owned()
        }
        Resolution::Question { answers } => {
            let answers: Vec<&str> =
                answers.iter().map(|answer| answer.as_deref().unwrap_or("—")).collect();
            let answers = shell_copy::list(locale, &answers);
            shell_copy::labeled(locale, copy::ANSWERED.in_locale(locale), &answers)
        }
        Resolution::SandboxBoundary { status, decision } => match status {
            SandboxBoundaryStatus::Approved => copy::ALLOWED.in_locale(locale).to_owned(),
            SandboxBoundaryStatus::Denied => copy::DENIED.in_locale(locale).to_owned(),
            SandboxBoundaryStatus::Conflict => copy::SANDBOX_CONFLICT.in_locale(locale).to_owned(),
            // A status this client does not know: the decision still holds.
            _ if *decision == PermissionDecision::Deny => copy::DENIED.in_locale(locale).to_owned(),
            _ => copy::ANSWERED.in_locale(locale).to_owned(),
        },
        Resolution::Closed(reason) => closure(reason).in_locale(locale).to_owned(),
        Resolution::Unknown => copy::NO_LONGER_WAITING.in_locale(locale).to_owned(),
        _ => copy::ANSWERED.in_locale(locale).to_owned(),
    }
}

/// Why an interaction closed without an answer.
fn closure(reason: &InteractionClosureReason) -> shell_copy::Text {
    match reason {
        InteractionClosureReason::TurnStopped => copy::CLOSED_TURN_STOPPED,
        InteractionClosureReason::TurnTerminal => copy::CLOSED_TURN_ENDED,
        InteractionClosureReason::ProducerCancelled => copy::CLOSED_WITHDRAWN,
        InteractionClosureReason::TimedOut => copy::CLOSED_TIMED_OUT,
        InteractionClosureReason::HostRestarted => copy::CLOSED_HOST_RESTARTED,
        InteractionClosureReason::ProviderDisconnected => copy::CLOSED_MODEL_DISCONNECTED,
        _ => copy::CLOSED,
    }
}

/// One change to the virtual list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ListEdit {
    /// Replace `range` of the old rows with `count` new ones.
    Splice { range: Range<usize>, count: usize },
    /// The row at this index (after any splice) changed content.
    Remeasure(usize),
}

/// The edits that turn `old` into `new`: rows keep their place when their
/// key is unchanged, so only the region between the common prefix and the
/// common suffix is spliced.
pub(crate) fn diff(old: &[Row], new: &[Row]) -> Vec<ListEdit> {
    let prefix = old.iter().zip(new).take_while(|(old, new)| old.key == new.key).count();
    let limit = old.len().min(new.len()) - prefix;
    let suffix = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(limit)
        .take_while(|(old, new)| old.key == new.key)
        .count();
    let mut edits = Vec::new();
    if old.len() != prefix + suffix || new.len() != prefix + suffix {
        edits.push(ListEdit::Splice {
            range: prefix..old.len() - suffix,
            count: new.len() - prefix - suffix,
        });
    }
    for ix in 0..prefix {
        if old[ix].body != new[ix].body {
            edits.push(ListEdit::Remeasure(ix));
        }
    }
    for offset in 0..suffix {
        let (old_ix, new_ix) = (old.len() - suffix + offset, new.len() - suffix + offset);
        if old[old_ix].body != new[new_ix].body {
            edits.push(ListEdit::Remeasure(new_ix));
        }
    }
    edits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(turn: &str, id: &str, text: &str) -> Row {
        Row {
            key: RowKey::Item { turn_id: turn.into(), key: ItemKey::Text(id.into()) },
            body: RowBody::Text {
                text: text.to_owned().into(),
                streaming: false,
                interrupted: false,
            },
        }
    }

    fn footer(turn: &str) -> Row {
        Row {
            key: RowKey::Footer { turn_id: turn.into() },
            body: RowBody::Footer(FooterRow {
                status: TurnViewStatus::Running,
                failure: None,
                started_at: 0,
                live: true,
                retry: None,
                model: None,
                has_reply: false,
            }),
        }
    }

    #[test]
    fn appending_splices_before_the_footer_and_remeasures_changed_text() {
        let old = [row("t", "a", "Hel"), footer("t")];
        let new = [row("t", "a", "Hello"), row("t", "b", "x"), footer("t")];
        assert_eq!(
            diff(&old, &new),
            [ListEdit::Splice { range: 1..1, count: 1 }, ListEdit::Remeasure(0)]
        );
    }

    #[test]
    fn unchanged_rows_need_nothing_and_content_changes_only_remeasure() {
        let old = [row("t", "a", "one"), footer("t")];
        assert_eq!(diff(&old, &old), []);
        let new = [row("t", "a", "two"), footer("t")];
        assert_eq!(diff(&old, &new), [ListEdit::Remeasure(0)]);
    }

    #[test]
    fn a_new_turn_and_a_removed_row_splice_only_their_region() {
        let old = [row("t1", "a", "x"), footer("t1")];
        let new = [row("t1", "a", "x"), footer("t1"), row("t2", "u", "y"), footer("t2")];
        assert_eq!(diff(&old, &new), [ListEdit::Splice { range: 2..2, count: 2 }]);
        assert_eq!(diff(&new, &old), [ListEdit::Splice { range: 2..4, count: 0 }]);
        assert_eq!(diff(&[], &old), [ListEdit::Splice { range: 0..0, count: 2 }]);
    }

    #[test]
    fn summaries_take_one_bounded_line() {
        assert_eq!(one_line("ls -la\n", 120), "ls -la");
        assert_eq!(one_line("echo a\necho b", 120), "echo a …");
        assert_eq!(one_line("abcdef", 3), "abc…");
    }

    #[test]
    fn permission_paths_shorten_home_and_drop_the_trailing_slash() {
        let home = Some("/Users/me");
        assert_eq!(display_path("/Users/me/export/", home), "~/export");
        assert_eq!(display_path("/Users/me", home), "~");
        assert_eq!(display_path("/Users/me/", Some("/Users/me/")), "~");
        assert_eq!(display_path("/Users/meg/notes", home), "/Users/meg/notes", "not a prefix");
        assert_eq!(display_path("/", home), "/");
        assert_eq!(display_path("/tmp/out", None), "/tmp/out");
    }

    #[test]
    fn sandbox_requests_list_each_access() {
        let request = |value: serde_json::Value| -> SandboxBoundaryRequest {
            serde_json::from_value(value).expect("request")
        };
        let (justification, grants) = sandbox_request(
            &request(serde_json::json!({
                "expansion": {
                    "filesystem": {"entries": [
                        {"path": "/etc/hosts", "access": "read", "scope": "exact"},
                        {"path": "/tmp/out", "access": "write", "scope": "subtree"},
                        {"path": "/dev/x", "access": "execute", "scope": "glob"}
                    ]},
                    "network": {"enabled": true}
                },
                "justification": "List files outside the workspace"
            })),
            Locale::English,
        );
        assert_eq!(justification.as_deref(), Some("List files outside the workspace"));
        assert_eq!(
            grants.iter().map(|grant| grant.text.as_ref()).collect::<Vec<_>>(),
            [
                "Read /etc/hosts",
                "Write /tmp/out and everything in it",
                "execute access to /dev/x and everything in it",
                copy::SANDBOX_NETWORK.en()
            ]
        );
        let (justification, grants) = sandbox_request(
            &request(serde_json::json!({
                "expansion": {"network": {"enabled": true}}, "justification": "  "
            })),
            Locale::English,
        );
        assert_eq!(justification, None);
        assert_eq!(grants, [SandboxGrant { text: copy::SANDBOX_NETWORK.en().into(), path: None }]);
    }

    #[test]
    fn a_sandbox_decision_names_the_result() {
        let resolution = |decision: PermissionDecision, status: SandboxBoundaryStatus| {
            outcome(&Resolution::SandboxBoundary { decision, status }, Locale::English)
        };
        assert_eq!(
            resolution(PermissionDecision::Allow, SandboxBoundaryStatus::Approved),
            copy::ALLOWED.en()
        );
        assert_eq!(
            resolution(PermissionDecision::Allow, SandboxBoundaryStatus::Conflict),
            copy::SANDBOX_CONFLICT.en()
        );
        assert_eq!(
            resolution(PermissionDecision::Deny, SandboxBoundaryStatus::Other("later".into())),
            copy::DENIED.en()
        );
        assert_eq!(
            resolution(PermissionDecision::Allow, SandboxBoundaryStatus::Other("later".into())),
            copy::ANSWERED.en()
        );
    }

    #[test]
    fn a_shell_run_shows_what_it_printed() {
        let result = serde_json::json!({
            "kind": "terminal", "cmd": "cargo test", "cwd": "/w", "status": "failed",
            "exitCode": 101, "failureMessage": "Command failed",
            "output": {"mode": "pipes", "stdout": "running 3 tests\n", "stderr": "error: boom\n",
                       "stdoutTruncated": false, "stderrTruncated": false, "redacted": false}
        });
        assert_eq!(terminal_output(&result).as_deref(), Some("running 3 tests\nerror: boom"));
        let silent = serde_json::json!({
            "kind": "terminal", "failureMessage": "Command failed",
            "output": {"mode": "pipes", "stdout": "", "stderr": ""}
        });
        assert_eq!(terminal_output(&silent).as_deref(), Some("Command failed"));
        assert_eq!(terminal_output(&serde_json::json!({"kind": "text", "text": "x"})), None);
    }

    #[test]
    fn a_result_shows_its_output_or_nothing_when_it_has_none() {
        let output = |result: Value| result_output(&result, Locale::English);
        assert_eq!(
            output(serde_json::json!({"kind": "text", "text": "a\nb"})).as_deref(),
            Some("a\nb")
        );
        assert_eq!(output(serde_json::json!({"kind": "text", "text": ""})), None);
        assert_eq!(
            output(serde_json::json!({"kind": "terminal", "status": "succeeded",
                                      "output": {"mode": "pipes", "stdout": "", "stderr": ""}})),
            None,
            "a command that printed nothing"
        );
        assert_eq!(
            output(serde_json::json!({"kind": "json", "value": {"content": "x\n", "offset": 0}}))
                .as_deref(),
            Some("x\n\noffset: 0")
        );
        assert_eq!(
            output(serde_json::json!({"kind": "json", "value": null})).as_deref(),
            Some(copy::TOOL_OUTPUT_EMPTY.en())
        );
        assert_eq!(
            output(serde_json::json!({"kind": "file_diff", "paths": ["a"], "diff": "+x"}))
                .as_deref(),
            Some("+x")
        );
        let other = serde_json::json!({"kind": "image", "mimeType": "image/png"});
        assert_eq!(output(other.clone()), Some(json_text(&other)), "an unknown kind stays JSON");
    }

    #[test]
    fn tool_kinds_follow_the_name_then_the_activity() {
        assert_eq!(ToolKind::of("Bash", None), ToolKind::Terminal);
        assert_eq!(ToolKind::of("MultiEdit", None), ToolKind::Edit);
        assert_eq!(ToolKind::of("LS", Some("read")), ToolKind::Search);
        assert_eq!(ToolKind::of("ApplyPatch", Some("edit")), ToolKind::Edit);
        assert_eq!(ToolKind::of("mcp__github__search", None), ToolKind::Plug);
    }

    #[test]
    fn consecutive_tools_share_a_group_within_a_turn() {
        let tool = |turn: &str, id: &str| Row {
            key: RowKey::Item { turn_id: turn.into(), key: ItemKey::Tool(id.into()) },
            body: RowBody::Tool(ToolRow {
                expansion_key: format!("{turn}/{id}"),
                name: "Read".into(),
                kind: ToolKind::Read,
                summary: None,
                added: 0,
                removed: 0,
                status: ToolStatus::Completed,
                waiting: false,
                group: GroupPlace::default(),
                expanded: false,
                input: None,
                output: None,
                diff: None,
                note: ToolNote::NoOutput,
            }),
        };
        let mut rows = vec![
            tool("t", "a"),
            tool("t", "b"),
            tool("t", "c"),
            row("t", "x", "text"),
            tool("t", "d"),
            footer("t"),
        ];
        place_tool_groups(&mut rows);
        let places: Vec<(bool, bool)> = rows
            .iter()
            .filter_map(|row| match &row.body {
                RowBody::Tool(tool) => Some((tool.group.first, tool.group.last)),
                _ => None,
            })
            .collect();
        assert_eq!(places, [(true, false), (false, false), (false, true), (true, true)]);
    }

    #[test]
    fn long_details_are_capped_and_marked() {
        let long = "x".repeat(DETAIL_MAX_CHARS + 5);
        let capped = cap(&long);
        assert!(capped.ends_with("\n…"));
        assert_eq!(capped.chars().count(), DETAIL_MAX_CHARS + 2);
        assert_eq!(cap("short"), "short");
    }
}
