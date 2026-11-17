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

use super::send::NativeMutation;
use super::*;
use crate::service;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use maka_agent_facts::{
    durable::Terminal, history::HistoryRowAddress, message::MessageOrigin, read::ResourceAddress,
    room::RoomAuthor, session::ForkPosition,
};
use maka_agent_ports::session::history as wire;
use maka_capabilities::call::Scope;
use maka_plugin_core::operation::RecoveryRef;

#[derive(Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "snake_case")]
enum OpaqueSessionCursor {
    AgentBefore {
        through: Option<u64>,
        cursor: wire::Cursor,
        #[serde(default)]
        raw: bool,
        #[serde(default)]
        include_thinking: bool,
    },
    AgentAfter {
        through: Option<u64>,
        cursor: wire::Cursor,
        #[serde(default)]
        raw: bool,
        #[serde(default)]
        include_thinking: bool,
    },
    RoomBefore {
        through: u64,
        message_id: String,
    },
    RoomAfter {
        through: u64,
        message_id: String,
    },
}

fn encode_cursor(token: &OpaqueSessionCursor) -> Option<String> {
    let bytes = serde_json::to_vec(token).ok()?;
    Some(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_cursor(encoded: &str) -> Result<OpaqueSessionCursor, String> {
    let bytes = URL_SAFE_NO_PAD.decode(encoded.trim()).map_err(|_| {
        "Invalid SessionRead cursor; pass beforeCursor or afterCursor unchanged from a previous SessionRead response".to_owned()
    })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        "Invalid SessionRead cursor; pass beforeCursor or afterCursor unchanged from a previous SessionRead response".to_owned()
    })
}

fn enum_snake<T: serde::Serialize>(val: &T) -> String {
    serde_json::to_value(val)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".into())
}

pub(crate) fn humanize_agent_error(err: String) -> String {
    match err.as_str() {
        "agent_session_unavailable" => {
            "Session or Room was not found or is archived; check the ID with SessionList".into()
        }
        "agent_room_message_required" => {
            "mentions and replyTo are only valid when sessionId is a Room; omit them when sending to an Agent conversation".into()
        }
        "agent_room_has_no_backend" => {
            "Target sessionId is a Room; Rooms hold shared messages and do not execute a model backend directly".into()
        }
        "agent_room_reply_unavailable" => {
            "replyTo messageId was not found in the target Room; read recent Room messages first".into()
        }
        "agent_message_invalid" => {
            "Message must include non-empty text or at least one valid attachment".into()
        }
        "agent_cursor_invalid" | "invalid history read" => {
            "Invalid history cursor or position; omit cursor to read from tail/start, or pass beforeCursor/afterCursor unchanged".into()
        }
        "agent_not_your_worker" => {
            "Permission denied: an Agent session can only control worker sessions it created".into()
        }
        _ => err,
    }
}

fn tool_result_path(session_id: &str, position: &HistoryRowAddress) -> Option<String> {
    match position {
        HistoryRowAddress::Live { fact, .. } => ResourceAddress::SessionToolResult {
            session_id: session_id.to_owned(),
            event_id: fact.to_string(),
        }
        .canonical_path()
        .ok(),
        HistoryRowAddress::Imported { .. } => ResourceAddress::SessionImportedToolResult {
            session_id: session_id.to_owned(),
            address: position.clone(),
        }
        .canonical_path()
        .ok(),
        HistoryRowAddress::Snapshot { .. } => None,
    }
}

fn chunk_to_entry(
    session_id: &str,
    chunk: HistoryChunk,
    include_byte_bounds: bool,
    include_thinking: bool,
) -> Option<AgentTranscriptEntry> {
    let sliced =
        include_byte_bounds || chunk.offset > 0 || chunk.total_bytes > chunk.text.len() as u64;
    let offset = sliced.then_some(chunk.offset);
    let total_bytes = sliced.then_some(chunk.total_bytes);
    match chunk.role {
        wire::Role::User => Some(AgentTranscriptEntry {
            role: "user".into(),
            turn_id: chunk.turn_id,
            message_id: chunk.message_id,
            tool_name: None,
            status: None,
            result_path: None,
            offset,
            total_bytes,
            text: chunk.text,
        }),
        wire::Role::Assistant => {
            let role = if chunk.field == wire::HistoryField::Thinking {
                if !include_thinking || chunk.text.is_empty() {
                    return None;
                }
                "thinking"
            } else {
                "assistant"
            };
            Some(AgentTranscriptEntry {
                role: role.into(),
                turn_id: chunk.turn_id,
                message_id: chunk.message_id,
                tool_name: None,
                status: None,
                result_path: None,
                offset,
                total_bytes,
                text: chunk.text,
            })
        }
        wire::Role::Failure => {
            if chunk.text.is_empty() {
                None
            } else {
                Some(AgentTranscriptEntry {
                    role: "failure".into(),
                    turn_id: chunk.turn_id,
                    message_id: chunk.message_id,
                    tool_name: None,
                    status: None,
                    result_path: None,
                    offset,
                    total_bytes,
                    text: chunk.text,
                })
            }
        }
        wire::Role::Compaction => {
            if chunk.text.is_empty() {
                None
            } else {
                Some(AgentTranscriptEntry {
                    role: "compaction".into(),
                    turn_id: chunk.turn_id,
                    message_id: chunk.message_id,
                    tool_name: None,
                    status: None,
                    result_path: None,
                    offset,
                    total_bytes,
                    text: chunk.text,
                })
            }
        }
        wire::Role::ToolCall => {
            let tool = chunk.tool?;
            let call = tool.call.as_ref();
            if call.is_some_and(|c| !c.ancestor_tool_use_ids.is_empty()) && chunk.text.is_empty() {
                return None;
            }
            let (status, result_path) = match tool.result.as_ref() {
                Some(res) => {
                    let st = if res.is_error {
                        "error".to_owned()
                    } else {
                        enum_snake(&res.settlement)
                    };
                    (Some(st), tool_result_path(session_id, &res.position))
                }
                None => (
                    Some(
                        if call.is_some_and(|c| c.pending) {
                            "running"
                        } else {
                            "pending"
                        }
                        .into(),
                    ),
                    None,
                ),
            };
            let name = call
                .map(|c| c.name.clone())
                .unwrap_or_else(|| "tool".into());
            let title = call
                .and_then(|c| c.title.as_ref())
                .map(|t| t.fallback.as_str())
                .unwrap_or("");
            let summary_text = if !chunk.text.is_empty() {
                chunk.text
            } else if !title.is_empty() {
                title.to_owned()
            } else {
                name.clone()
            };
            Some(AgentTranscriptEntry {
                role: "tool".into(),
                turn_id: chunk.turn_id,
                message_id: chunk.message_id,
                tool_name: Some(name),
                status,
                result_path,
                offset,
                total_bytes,
                text: summary_text,
            })
        }
        wire::Role::ToolResult => {
            if chunk.text.is_empty() {
                None
            } else {
                let tool_name = chunk
                    .tool
                    .as_ref()
                    .and_then(|t| t.call.as_ref())
                    .map(|c| c.name.clone());
                let result_path = tool_result_path(session_id, &chunk.position);
                Some(AgentTranscriptEntry {
                    role: "tool_result".into(),
                    turn_id: chunk.turn_id,
                    message_id: chunk.message_id,
                    tool_name,
                    status: None,
                    result_path,
                    offset,
                    total_bytes,
                    text: chunk.text,
                })
            }
        }
        _ => None,
    }
}

impl Owner {
    fn resolve_caller_or_target(
        &self,
        explicit: Option<String>,
        scope: &Scope,
    ) -> Result<String, String> {
        match explicit.filter(|id| !id.trim().is_empty()) {
            Some(id) => Ok(id),
            None => scope
                .identity
                .agent()
                .map(|exec| exec.session_id.clone())
                .ok_or_else(|| {
                    "sessionId is required when calling outside an Agent session".into()
                }),
        }
    }

    pub async fn session_list_tool(
        self: &Arc<Self>,
        input: SessionListInput,
        scope: &Scope,
    ) -> Result<SessionListOutput, String> {
        let limit = input.limit.unwrap_or(25).clamp(1, 100);
        let (list_scope, only_archived, include_archived) = match input.scope {
            SessionToolScope::All => (SessionListScope::All, false, false),
            SessionToolScope::Archived => (SessionListScope::All, true, true),
            SessionToolScope::Children => {
                let parent = self.resolve_caller_or_target(input.parent_session_id, scope)?;
                (
                    SessionListScope::Children { session_id: parent },
                    false,
                    false,
                )
            }
        };
        let mut exclusive_after = input
            .cursor
            .map(|c| c.trim().to_owned())
            .filter(|c| !c.is_empty());
        let query_lower = input
            .query
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(str::to_lowercase);
        let ws_filter = input
            .workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty());

        let mut matched = Vec::with_capacity(limit);
        let mut next_cursor = None;
        let mut pages_scanned = 0usize;

        while matched.len() < limit && pages_scanned < 16 {
            pages_scanned += 1;
            let position = match &exclusive_after {
                Some(cursor) => SessionPosition::At {
                    cursor: cursor.clone(),
                },
                None => SessionPosition::Start,
            };
            let page = service::catalog_page_for_tool(
                self,
                &List {
                    kind: input.kind.clone(),
                    filter: if only_archived {
                        SessionFilter::Archived
                    } else {
                        SessionFilter::All
                    },
                    include_archived,
                    roots_only: false,
                    position,
                    scope: list_scope.clone(),
                    title_query: String::new(),
                },
            )
            .await
            .map_err(humanize_agent_error)?;

            let page_after = page.after;
            let items = page.sessions;
            let mut progressed = false;
            for (idx, session) in items.iter().enumerate() {
                if exclusive_after.as_deref() == Some(session.id.as_str()) {
                    exclusive_after = None;
                    continue;
                }
                progressed = true;
                if let Some(expected_activity) = &input.activity
                    && !matches!(
                        (&session.activity, expected_activity),
                        (SessionActivity::Idle, SessionActivity::Idle)
                            | (SessionActivity::Working, SessionActivity::Working)
                            | (SessionActivity::Waiting, SessionActivity::Waiting)
                    )
                {
                    continue;
                }
                if let Some(ws) = ws_filter
                    && session.workspace.path != ws
                    && session
                        .workspace
                        .worktree
                        .as_ref()
                        .is_none_or(|wt| wt.directory() != std::path::Path::new(ws))
                {
                    continue;
                }
                if let Some(q) = &query_lower {
                    let in_title = session.title.to_lowercase().contains(q);
                    let in_ws = session.workspace.path.to_lowercase().contains(q);
                    if !in_title && !in_ws {
                        continue;
                    }
                }
                matched.push(SessionSummary::from(session.clone()));
                if matched.len() == limit {
                    let has_more = idx + 1 < items.len() || page_after.is_some();
                    next_cursor = has_more.then(|| session.id.clone());
                    break;
                }
            }
            if matched.len() == limit {
                break;
            }
            if !progressed {
                next_cursor = None;
                break;
            }
            match page_after {
                Some(after_id) => {
                    exclusive_after = Some(after_id.clone());
                    next_cursor = Some(after_id);
                }
                None => {
                    next_cursor = None;
                    break;
                }
            }
        }

        Ok(SessionListOutput {
            sessions: matched,
            next_cursor,
        })
    }

    pub async fn session_read_tool(
        self: &Arc<Self>,
        input: SessionReadInput,
        scope: &Scope,
    ) -> Result<SessionReadOutput, String> {
        let cursor = input.cursor.filter(|c| !c.trim().is_empty());
        let message_id = input.message_id.filter(|m| !m.trim().is_empty());
        let locator_count = u8::from(input.position.is_some())
            + u8::from(cursor.is_some())
            + u8::from(message_id.is_some())
            + u8::from(input.row.is_some());
        if locator_count > 1 {
            return Err(
                "Specify at most one of position, cursor, messageId, or row in SessionRead".into(),
            );
        }
        if input.anchor.is_some() && message_id.is_none() {
            return Err("anchor requires messageId in SessionRead".into());
        }

        let session_id = self.resolve_caller_or_target(input.session_id, scope)?;
        let observed = service::history_observation_for_tool(
            self,
            scope,
            SessionRead {
                session_id: session_id.clone(),
            },
        )
        .await
        .map_err(humanize_agent_error)?;

        let is_room = matches!(observed.session.kind, SessionKind::Room);
        if is_room && input.row.is_some() {
            return Err(
                "row is only valid for Agent conversations, not Rooms; use messageId or cursor for Rooms".into(),
            );
        }
        if !is_room && (message_id.is_some() || input.anchor.is_some()) {
            return Err(
                "messageId and anchor are only valid for Rooms; use position, cursor, or row for Agent conversations".into(),
            );
        }

        let summary = SessionSummary::from(observed.session);

        let mut run_overview = None;
        let mut live_output_preview = None;
        if !is_room {
            if let Some(active_run) = &observed.run {
                if let Ok(Some(work)) = self.durable.work(active_run.run_id, 0, 2048).await
                    && !work.answer.text.is_empty()
                {
                    let mut preview: String = work.answer.text.chars().take(800).collect();
                    if work.answer.next.is_some() || work.answer.text.chars().count() > 800 {
                        preview.push('…');
                    }
                    live_output_preview = Some(preview);
                }
                let mut blockers = Vec::new();
                let mut stopped = false;
                if let Ok(Some(view)) = self.session_run(&session_id, active_run.run_id).await {
                    stopped = view.stopped;
                    for b in view.blockers.values() {
                        if b.decision.is_none() && b.resolved_by.is_none() {
                            blockers.push(format!("{:?}", b.reason));
                        }
                    }
                }
                run_overview = Some(SessionRunOverview {
                    run_id: active_run.run_id,
                    state: enum_snake(&active_run.state),
                    stopped,
                    error: None,
                    blockers,
                });
            } else if let Ok(Some(latest_id)) = self.durable.latest_run(session_id.clone()).await
                && let Ok(Some(view)) = self.session_run(&session_id, latest_id).await
            {
                let state = match &view.terminal {
                    Some(term) => enum_snake(term),
                    None if view.stopped => "stopped".into(),
                    None => "running".into(),
                };
                let mut error = view.recovery_failure().and_then(|f| {
                    serde_json::to_value(f)
                        .ok()
                        .and_then(|v| {
                            v.get("diagnostic")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                        .or_else(|| serde_json::to_string(f).ok())
                });
                if error.is_none() && matches!(view.terminal, Some(Terminal::Failed)) {
                    error = self
                        .history_run_snippet(&session_id, latest_id, &Terminal::Failed)
                        .await;
                }
                run_overview = Some(SessionRunOverview {
                    run_id: latest_id,
                    state,
                    stopped: view.stopped,
                    error,
                    blockers: Vec::new(),
                });
            }
        }

        let mut pending_interactions = Vec::new();
        if !is_room
            && self
                .require_interaction_access(scope, &session_id)
                .await
                .is_ok()
            && let Ok(pending) = self.pending_interactions(&session_id).await
        {
            for item in pending.entries {
                if let Ok(record) = self.interaction(&session_id, &item.request_id).await {
                    pending_interactions.push(record);
                }
            }
        }

        let mut queued_messages = Vec::new();
        let mut queue_revision = None;
        if !is_room && let Ok(q) = self.queue(&session_id).await {
            let caller_id = scope.identity.agent().map(|e| e.session_id.as_str());
            queue_revision = Some(q.revision);
            for entry in q.entries {
                let editable = match caller_id {
                    None => true,
                    Some(cid) => matches!(
                        &entry.origin,
                        Some(MessageOrigin::Session { execution }) if execution.session_id == cid
                    ),
                };
                queued_messages.push(QueuedMessageOverview {
                    message_id: entry.message_id,
                    text: entry.preview,
                    editable_by_caller: editable,
                });
            }
        }

        let transcript = if matches!(input.view, SessionTranscriptView::StatusOnly) {
            None
        } else if is_room {
            let (through, pos) = if let Some(cur) = cursor.as_deref() {
                match decode_cursor(cur)? {
                    OpaqueSessionCursor::RoomBefore {
                        through,
                        message_id,
                    } => (Some(through), wire::Position::BeforeMessage { message_id }),
                    OpaqueSessionCursor::RoomAfter {
                        through,
                        message_id,
                    } => (Some(through), wire::Position::AfterMessage { message_id }),
                    _ => return Err("Cursor belongs to an Agent session, not a Room".into()),
                }
            } else if let Some(mid) = message_id {
                let pos = match input.anchor.unwrap_or(RoomAnchorMode::At) {
                    RoomAnchorMode::At => wire::Position::Message { message_id: mid },
                    RoomAnchorMode::Before => wire::Position::BeforeMessage { message_id: mid },
                    RoomAnchorMode::After => wire::Position::AfterMessage { message_id: mid },
                };
                (None, pos)
            } else {
                let p = match input.position.unwrap_or(SessionWindowPosition::Tail) {
                    SessionWindowPosition::Tail => wire::Position::Tail,
                    SessionWindowPosition::Start => wire::Position::Start,
                };
                (None, p)
            };

            let page = service::history_read_for_tool(
                self,
                scope,
                History {
                    session_id: session_id.clone(),
                    through,
                    position: pos,
                    include_thinking: false,
                    view: wire::HistoryView::Conversation,
                },
            )
            .await
            .map_err(humanize_agent_error)?;

            match page {
                HistoryPage::Room { page } => {
                    let before_cursor = page.before.as_ref().and_then(|mid| {
                        encode_cursor(&OpaqueSessionCursor::RoomBefore {
                            through: page.through,
                            message_id: mid.clone(),
                        })
                    });
                    let after_cursor = page.after.as_ref().and_then(|mid| {
                        encode_cursor(&OpaqueSessionCursor::RoomAfter {
                            through: page.through,
                            message_id: mid.clone(),
                        })
                    });
                    let items = page
                        .items
                        .into_iter()
                        .map(|m| RoomPostEntry {
                            id: m.id,
                            sequence: m.sequence,
                            at: m.at,
                            author: m.author,
                            text: m.content.text,
                            reply_to: m.reply_to,
                            mentions: m.mentions,
                            deliveries: m.deliveries,
                        })
                        .collect();
                    Some(SessionTranscript::Room {
                        items,
                        before_cursor,
                        after_cursor,
                    })
                }
                HistoryPage::Ready { .. } => None,
            }
        } else {
            let (through, pos, hist_view, is_raw, include_thinking) = if let Some(row) = input.row {
                let inc_thinking = row.field == wire::HistoryField::Thinking;
                (
                    Some(row.through.unwrap_or(observed.through)),
                    wire::Position::Row {
                        position: row.position,
                        field: row.field,
                    },
                    wire::HistoryView::Text,
                    true,
                    inc_thinking,
                )
            } else if let Some(cur) = cursor.as_deref() {
                let explicit_raw = matches!(input.view, SessionTranscriptView::Raw);
                match decode_cursor(cur)? {
                    OpaqueSessionCursor::AgentBefore {
                        through,
                        cursor,
                        raw,
                        include_thinking,
                    } => {
                        let use_raw = raw || explicit_raw;
                        let view = if use_raw {
                            wire::HistoryView::Text
                        } else {
                            wire::HistoryView::Conversation
                        };
                        (
                            through,
                            wire::Position::Before { cursor },
                            view,
                            use_raw,
                            include_thinking,
                        )
                    }
                    OpaqueSessionCursor::AgentAfter {
                        through,
                        cursor,
                        raw,
                        include_thinking,
                    } => {
                        let use_raw = raw || explicit_raw;
                        let view = if use_raw {
                            wire::HistoryView::Text
                        } else {
                            wire::HistoryView::Conversation
                        };
                        (
                            through,
                            wire::Position::After { cursor },
                            view,
                            use_raw,
                            include_thinking,
                        )
                    }
                    _ => return Err("Cursor belongs to a Room, not an Agent session".into()),
                }
            } else {
                let use_raw = matches!(input.view, SessionTranscriptView::Raw);
                let view = if use_raw {
                    wire::HistoryView::Text
                } else {
                    wire::HistoryView::Conversation
                };
                let p = match input.position.unwrap_or(SessionWindowPosition::Tail) {
                    SessionWindowPosition::Tail => wire::Position::Tail,
                    SessionWindowPosition::Start => wire::Position::Start,
                };
                (None, p, view, use_raw, false)
            };

            let page = service::history_read_for_tool(
                self,
                scope,
                History {
                    session_id: session_id.clone(),
                    through,
                    position: pos,
                    include_thinking,
                    view: hist_view,
                },
            )
            .await
            .map_err(humanize_agent_error)?;

            match page {
                HistoryPage::Ready {
                    through,
                    chunks,
                    before,
                    after,
                } => {
                    let before_cursor = before.and_then(|cursor| {
                        encode_cursor(&OpaqueSessionCursor::AgentBefore {
                            through,
                            cursor,
                            raw: is_raw,
                            include_thinking,
                        })
                    });
                    let after_cursor = after.and_then(|cursor| {
                        encode_cursor(&OpaqueSessionCursor::AgentAfter {
                            through,
                            cursor,
                            raw: is_raw,
                            include_thinking,
                        })
                    });
                    let items = chunks
                        .into_iter()
                        .filter_map(|c| chunk_to_entry(&session_id, c, is_raw, include_thinking))
                        .collect();
                    Some(SessionTranscript::Agent {
                        items,
                        before_cursor,
                        after_cursor,
                    })
                }
                HistoryPage::Room { .. } => None,
            }
        };

        Ok(SessionReadOutput {
            session: summary,
            run: run_overview,
            pending_interactions,
            queued_messages,
            queue_revision,
            live_output_preview,
            transcript,
        })
    }

    pub async fn render_session_markdown(
        self: &Arc<Self>,
        session_id: &str,
        through: Option<u64>,
        scope: &Scope,
    ) -> Result<(String, Option<u64>), String> {
        let observed = service::history_observation_for_tool(
            self,
            scope,
            SessionRead {
                session_id: session_id.to_owned(),
            },
        )
        .await
        .map_err(humanize_agent_error)?;

        let pinned_through = through.unwrap_or(observed.through);
        let summary = SessionSummary::from(observed.session);
        let mut out = String::new();

        match summary.kind {
            SessionKind::Room => {
                out.push_str(&format!(
                    "# Room: {} (maka://session/{})
Workspace: {}

",
                    summary.title, summary.id, summary.workspace_path
                ));
                let mut all_posts: Vec<RoomPostEntry> = Vec::new();
                let mut pos = wire::Position::Tail;
                let mut older_message_id = None;
                for _ in 0..4 {
                    let page = service::history_read_for_tool(
                        self,
                        scope,
                        History {
                            session_id: session_id.to_owned(),
                            through: Some(pinned_through),
                            position: pos,
                            include_thinking: false,
                            view: wire::HistoryView::Conversation,
                        },
                    )
                    .await
                    .map_err(humanize_agent_error)?;
                    let HistoryPage::Room { page } = page else {
                        break;
                    };
                    let mut batch: Vec<RoomPostEntry> = page
                        .items
                        .into_iter()
                        .map(|m| RoomPostEntry {
                            id: m.id,
                            sequence: m.sequence,
                            at: m.at,
                            author: m.author,
                            text: m.content.text,
                            reply_to: m.reply_to,
                            mentions: m.mentions,
                            deliveries: m.deliveries,
                        })
                        .collect();
                    older_message_id = page.before;
                    batch.extend(all_posts);
                    all_posts = batch;
                    let Some(mid) = older_message_id.clone() else {
                        break;
                    };
                    pos = wire::Position::BeforeMessage { message_id: mid };
                }
                if let Some(mid) = older_message_id
                    && let Some(cur) = encode_cursor(&OpaqueSessionCursor::RoomBefore {
                        through: pinned_through,
                        message_id: mid,
                    })
                {
                    let more_call = serde_json::json!({
                        "sessionId": session_id,
                        "cursor": cur,
                    });
                    out.push_str(&format!(
                        "> Earlier Room messages omitted; call SessionRead({more_call}) for older posts.

"
                    ));
                }
                if all_posts.is_empty() {
                    out.push_str(
                        "(No messages in this Room yet.)
",
                    );
                } else {
                    for post in all_posts {
                        let author = match &post.author {
                            RoomAuthor::Human => "Human".to_owned(),
                            RoomAuthor::Session { execution } => {
                                format!("Agent {}", execution.session_id)
                            }
                        };
                        out.push_str(&format!(
                            "### [{} · #{} · {}]",
                            post.id, post.sequence, author
                        ));
                        if let Some(reply) = &post.reply_to {
                            out.push_str(&format!(" (replyTo: {reply})"));
                        }
                        out.push('\n');
                        out.push_str(&post.text);
                        if !post.text.ends_with('\n') {
                            out.push('\n');
                        }
                        out.push('\n');
                    }
                }
            }
            SessionKind::Agent => {
                out.push_str(&format!(
                    "# Conversation: {} (maka://session/{})
Workspace: {}

",
                    summary.title, summary.id, summary.workspace_path
                ));
                let mut all_entries: Vec<AgentTranscriptEntry> = Vec::new();
                let mut pos = wire::Position::Tail;
                let mut older_wire_cursor = None;
                let mut effective_through = Some(pinned_through);
                for _ in 0..6 {
                    let page = service::history_read_for_tool(
                        self,
                        scope,
                        History {
                            session_id: session_id.to_owned(),
                            through: effective_through,
                            position: pos,
                            include_thinking: false,
                            view: wire::HistoryView::Conversation,
                        },
                    )
                    .await
                    .map_err(humanize_agent_error)?;
                    let HistoryPage::Ready {
                        through: page_through,
                        chunks,
                        before,
                        ..
                    } = page
                    else {
                        break;
                    };
                    effective_through = page_through.or(effective_through);
                    older_wire_cursor = before;
                    let mut batch: Vec<AgentTranscriptEntry> = chunks
                        .into_iter()
                        .filter_map(|c| chunk_to_entry(session_id, c, false, false))
                        .collect();
                    batch.extend(all_entries);
                    all_entries = batch;
                    let Some(cursor) = older_wire_cursor.clone() else {
                        break;
                    };
                    pos = wire::Position::Before { cursor };
                }
                if let Some(cursor) = older_wire_cursor
                    && let Some(cur) = encode_cursor(&OpaqueSessionCursor::AgentBefore {
                        through: effective_through,
                        cursor,
                        raw: false,
                        include_thinking: false,
                    })
                {
                    let more_call = serde_json::json!({
                        "sessionId": session_id,
                        "cursor": cur,
                    });
                    out.push_str(&format!(
                        "> Earlier turns omitted; call SessionRead({more_call}) for older turns.

"
                    ));
                }
                if all_entries.is_empty() {
                    out.push_str(
                        "(No messages in this Conversation yet.)
",
                    );
                } else {
                    for entry in all_entries {
                        match entry.role.as_str() {
                            "user" => {
                                out.push_str(
                                    "### User
",
                                );
                                out.push_str(&entry.text);
                                if !entry.text.ends_with('\n') {
                                    out.push('\n');
                                }
                                out.push('\n');
                            }
                            "assistant" => {
                                out.push_str(
                                    "### Assistant
",
                                );
                                out.push_str(&entry.text);
                                if !entry.text.ends_with('\n') {
                                    out.push('\n');
                                }
                                out.push('\n');
                            }
                            "failure" => {
                                out.push_str(
                                    "### Failure
",
                                );
                                out.push_str(&entry.text);
                                if !entry.text.ends_with('\n') {
                                    out.push('\n');
                                }
                                out.push('\n');
                            }
                            "compaction" => {
                                out.push_str(
                                    "### Context Summary
",
                                );
                                out.push_str(&entry.text);
                                if !entry.text.ends_with('\n') {
                                    out.push('\n');
                                }
                                out.push('\n');
                            }
                            "tool" => {
                                let name = entry.tool_name.as_deref().unwrap_or("tool");
                                let st = entry.status.as_deref().unwrap_or("done");
                                if let Some(path) = &entry.result_path {
                                    out.push_str(&format!(
                                        "- [Tool {name} · {st}]: {} (output: {path})
",
                                        entry.text
                                    ));
                                } else {
                                    out.push_str(&format!(
                                        "- [Tool {name} · {st}]: {}
",
                                        entry.text
                                    ));
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        Ok((out, Some(pinned_through)))
    }

    pub async fn session_create_tool(
        self: &Arc<Self>,
        input: SessionCreateInput,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<SessionCreateOutput>, String> {
        if let Some(fork_source) = input.fork_from {
            if input.kind.is_some()
                || input.workspace.is_some()
                || input.preset_id.is_some()
                || input.backend.is_some()
                || input.tools.is_some()
                || input.automatic_title.is_some()
            {
                return Err(
                    "forkFrom clones the source conversation's workspace, backend, and tool configuration; omit workspace, kind, presetId, backend, tools, and automaticTitle when forking".into(),
                );
            }
            let expected_revision = match fork_source.expected_revision {
                Some(rev) => rev,
                None => {
                    self.scoped_session(scope, &fork_source.session_id)
                        .await
                        .map_err(humanize_agent_error)?
                        .revision
                }
            };
            let position = match fork_source.turn_id.filter(|t| !t.trim().is_empty()) {
                Some(turn_id) => ForkPosition::ThroughTurn { turn_id },
                None => ForkPosition::End,
            };
            return self
                .fork_for_session_create(
                    Fork {
                        session_id: fork_source.session_id,
                        expected_revision,
                        position,
                        title: input.title,
                        labels: input.labels,
                    },
                    operation,
                    scope,
                )
                .await
                .map_err(humanize_agent_error);
        }

        let kind = input.kind.unwrap_or(SessionKind::Agent);
        let workspace_target = input.workspace.unwrap_or(SessionWorkspaceTarget::Same);
        let automatic_title = input.automatic_title.unwrap_or(false);

        let workspace = match workspace_target {
            SessionWorkspaceTarget::Same => {
                let caller_id = scope
                    .identity
                    .agent()
                    .map(|e| e.session_id.clone())
                    .ok_or_else(|| {
                        "workspace must specify a directory when called outside an Agent session"
                            .to_owned()
                    })?;
                WorkspaceSelection::Session {
                    session_id: caller_id,
                }
            }
            SessionWorkspaceTarget::Worktree { path } => {
                let repo_path = match path.filter(|p| !p.trim().is_empty()) {
                    Some(p) => p,
                    None => {
                        let caller_id = scope
                            .identity
                            .agent()
                            .map(|e| e.session_id.clone())
                            .ok_or_else(|| {
                                "workspace.path is required for worktree outside an Agent session"
                                    .to_owned()
                            })?;
                        self.scoped_session(scope, &caller_id)
                            .await
                            .map_err(humanize_agent_error)?
                            .configuration
                            .workspace
                            .path
                    }
                };
                WorkspaceSelection::IsolatedGit { path: repo_path }
            }
            SessionWorkspaceTarget::Directory { path } => WorkspaceSelection::Directory { path },
            SessionWorkspaceTarget::Session { session_id } => {
                WorkspaceSelection::Session { session_id }
            }
            SessionWorkspaceTarget::Project { project_id, path } => {
                WorkspaceSelection::Project { project_id, path }
            }
        };

        let backend = match input.backend {
            Some(explicit) => Some(explicit),
            None if matches!(kind, SessionKind::Agent) && input.preset_id.is_none() => {
                if let Some(caller) = scope.identity.agent()
                    && !self.bot.is(&caller.session_id)
                {
                    self.return_route(caller)
                        .await
                        .ok()
                        .map(|route| route.backend.preference())
                } else {
                    None
                }
            }
            None => None,
        };

        self.create_for_session_tool(
            Create {
                kind,
                preset_id: input.preset_id,
                backend,
                automatic_title,
                tools: input.tools,
                title: input.title,
                labels: input.labels,
                workspace,
            },
            operation,
            scope,
        )
        .await
        .map_err(humanize_agent_error)
    }

    pub async fn session_send_tool(
        self: &Arc<Self>,
        input: SessionSendInput,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<SendResult>, String> {
        let is_room = self
            .rooms()?
            .exists(&input.session_id)
            .await
            .map_err(|e| e.to_string())?;
        let on_complete = match input.on_complete {
            Some(SessionNotifyMode::NotifyCaller) => Some(OnComplete::NotifyCaller),
            Some(SessionNotifyMode::None) => None,
            None => {
                if !is_room
                    && scope
                        .identity
                        .agent()
                        .is_some_and(|caller| caller.session_id != input.session_id)
                {
                    Some(OnComplete::NotifyCaller)
                } else {
                    None
                }
            }
        };
        self.send(
            Send {
                session_id: input.session_id,
                message: input.message,
                delivery: input.delivery,
                on_complete,
                backend: input.backend,
                expected_run_id: input.expected_run_id,
                attachments: input.attachments,
                mentions: input.mentions,
                reply_to: input.reply_to,
            },
            operation,
            scope,
        )
        .await
        .map_err(humanize_agent_error)
    }

    pub async fn session_stop_tool(
        self: &Arc<Self>,
        input: SessionStopInput,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<SessionStopOutput>, String> {
        if !self
            .may_control(scope, &input.session_id)
            .await
            .map_err(humanize_agent_error)?
        {
            return Ok(NativeMutation::Returned(SessionStopOutput {
                requested: false,
                run_id: None,
            }));
        }
        let target_run = match input.run_id {
            Some(run) => Some(run),
            None => {
                match self
                    .durable
                    .latest_run(input.session_id.clone())
                    .await
                    .map_err(|e| e.to_string())?
                {
                    Some(run) => {
                        let view = self.session_run(&input.session_id, run).await?;
                        view.filter(|v| v.terminal.is_none() && !v.stopped)
                            .map(|_| run)
                    }
                    None => None,
                }
            }
        };
        let Some(run_id) = target_run else {
            return Ok(NativeMutation::Returned(SessionStopOutput {
                requested: false,
                run_id: None,
            }));
        };
        self.prepare_session_stop(&input.session_id, run_id, operation)
            .await
            .map_err(humanize_agent_error)
    }

    pub async fn session_manage_tool(
        self: &Arc<Self>,
        input: SessionManageInput,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<SessionManageOutput>, String> {
        let session_id = input.session_id;
        match input.action {
            SessionManageAction::Update {
                title,
                labels,
                pinned,
                expected_revision,
            } => {
                if scope.identity.agent().is_some()
                    && !self
                        .may_control(scope, &session_id)
                        .await
                        .map_err(humanize_agent_error)?
                {
                    return Err(humanize_agent_error("agent_not_your_worker".into()));
                }
                let current = self
                    .scoped_session(scope, &session_id)
                    .await
                    .map_err(humanize_agent_error)?;
                let rev = expected_revision.unwrap_or(current.revision);
                let new_title = title.unwrap_or_else(|| current.configuration.title.clone());
                let new_labels = labels.unwrap_or_else(|| current.configuration.labels.clone());
                let res = self
                    .metadata(
                        Metadata {
                            session_id,
                            expected_revision: rev,
                            title: new_title,
                            labels: new_labels,
                            pinned,
                            permissions: None,
                        },
                        scope,
                        operation,
                    )
                    .await
                    .map_err(humanize_agent_error)?;
                res.map_fixed(|m| match m {
                    MetadataResult::Committed { session } => SessionManageOutput::Updated {
                        session: Box::new(SessionSummary::from(*session)),
                    },
                    MetadataResult::RevisionConflict { expected, actual } => {
                        SessionManageOutput::RevisionConflict { expected, actual }
                    }
                    MetadataResult::Rejected { reason } => SessionManageOutput::Rejected { reason },
                })
            }
            SessionManageAction::Archive { expected_revision }
            | SessionManageAction::Restore { expected_revision }
            | SessionManageAction::Remove { expected_revision } => {
                if scope.identity.agent().is_some()
                    && !self
                        .may_control(scope, &session_id)
                        .await
                        .map_err(humanize_agent_error)?
                {
                    return Err(humanize_agent_error("agent_not_your_worker".into()));
                }
                let action = match input.action {
                    SessionManageAction::Archive { .. } => SessionAction::Archive,
                    SessionManageAction::Restore { .. } => SessionAction::Restore,
                    SessionManageAction::Remove { .. } => SessionAction::Remove,
                    _ => unreachable!(),
                };
                let rev = match expected_revision {
                    Some(r) => r,
                    None => {
                        self.canonical_catalog()?
                            .record(&session_id)
                            .await
                            .map_err(|e| e.to_string())?
                            .ok_or_else(|| {
                                humanize_agent_error("agent_session_unavailable".into())
                            })?
                            .metadata
                            .revision
                    }
                };
                let res = self
                    .change_session(
                        ChangeSession {
                            session_id,
                            expected_revision: rev,
                            action,
                        },
                        operation,
                    )
                    .await
                    .map_err(humanize_agent_error)?;
                res.map_fixed(|c| match c {
                    SessionChanged::Changed { session } => SessionManageOutput::Updated {
                        session: Box::new(SessionSummary::from(*session)),
                    },
                    SessionChanged::Removed { session_id } => {
                        SessionManageOutput::Removed { session_id }
                    }
                    SessionChanged::RevisionConflict { expected, actual } => {
                        SessionManageOutput::RevisionConflict { expected, actual }
                    }
                    SessionChanged::Rejected { reason } => SessionManageOutput::Rejected { reason },
                })
            }
            SessionManageAction::EditQueue {
                edit,
                expected_revision,
            } => {
                let rev = match expected_revision {
                    Some(r) => r,
                    None => {
                        self.queue(&session_id)
                            .await
                            .map_err(humanize_agent_error)?
                            .revision
                    }
                };
                let res = self
                    .edit_queue(
                        QueueMutation {
                            session_id,
                            expected_revision: rev,
                            edit,
                        },
                        operation,
                        scope,
                    )
                    .await
                    .map_err(humanize_agent_error)?;
                res.map_fixed(|result| SessionManageOutput::QueueEdited { result })
            }
            SessionManageAction::ContinueRun {
                model,
                thinking_level,
                source_run_id,
                source_high_water,
            } => {
                let run_id = match source_run_id {
                    Some(r) => r,
                    None => self
                        .durable
                        .latest_run(session_id.clone())
                        .await
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| {
                            "No previous Run exists on this Session to continue".to_owned()
                        })?,
                };
                let high_water = match source_high_water {
                    Some(hw) => hw,
                    None => {
                        self.session_run(&session_id, run_id)
                            .await?
                            .ok_or_else(|| "Source Run was not found on this Session".to_owned())?
                            .revision
                    }
                };
                let res = self
                    .continue_run(
                        ContinueRun {
                            session_id,
                            source_run_id: run_id,
                            source_high_water: high_water,
                            model,
                            thinking_level,
                        },
                        operation,
                        scope,
                    )
                    .await
                    .map_err(humanize_agent_error)?;
                res.map_fixed(|c| match c {
                    ContinuationResult::Started { execution } => {
                        SessionManageOutput::ContinuationStarted {
                            execution: Box::new(execution),
                        }
                    }
                    ContinuationResult::Rejected { reason } => {
                        SessionManageOutput::ContinuationRejected { reason }
                    }
                })
            }
        }
    }
}
