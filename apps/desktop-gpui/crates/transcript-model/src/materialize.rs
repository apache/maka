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

//! Durable rows to Turn views, and the live overlay on top of them.
//!
//! Ported from `packages/ui/src/materialize.ts`:
//!
//! - [`materialize_turn`] is the per-Turn part of `materializeTurns`, with
//!   `materializeTools` and `deriveTurnRecords` (`packages/core/src/session.ts`);
//! - [`build_timeline`] is `buildTurnTimeline`;
//! - [`overlay_live_turn`] is `overlayLiveTurn`, with
//!   `mergeLiveOverPersisted`.
//!
//! Skipped in this phase: system notes, token totals,
//! shell-run folding (`foldShellRunToolActivities`), the context-compaction
//! row, and the timestamp splice of steering messages the live stream missed.

use std::collections::HashMap;

use host_protocol::{StoredMessage, TurnStateMessage, TurnStatus};
use serde_json::Value;

use crate::live::{ContentKind, LiveTurn};
use crate::view::{
    ItemKey, TextItem, ThinkingItem, ToolItem, ToolStatus, TurnFailure, TurnItem, TurnView,
    TurnViewStatus, UserItem,
};

/// A Turn view built from durable rows, plus whether its status is recorded
/// evidence (`TurnRecord.statusSource === 'recorded'`).
pub(crate) struct Materialized {
    pub view: TurnView,
    pub recorded: bool,
    pub durable_status: TurnStatus,
}

/// Builds one Turn from its rows in storage order.
pub(crate) fn materialize_turn(turn_id: &str, rows: &[&StoredMessage]) -> Materialized {
    let latest_state = rows.iter().rev().find_map(|row| match row {
        StoredMessage::TurnState(state) => Some(state),
        _ => None,
    });
    let durable_status =
        latest_state.map_or_else(|| infer_legacy_status(rows), |state| state.status.clone());
    let tools = materialize_tools(rows, &durable_status);
    let mut items = Vec::new();
    if let Some(user) = rows.iter().find_map(|row| match row {
        StoredMessage::User(user) => Some(user),
        _ => None,
    }) {
        items.push(TurnItem::User(user_item(user)));
    }
    items.extend(build_timeline(rows, &tools));
    let started_at = rows.iter().filter_map(|row| row.ts()).min().unwrap_or_default();
    let model_id = rows.iter().rev().find_map(|row| match row {
        StoredMessage::Assistant(assistant) => Some(assistant.model_id.clone()),
        _ => None,
    });
    Materialized {
        view: TurnView {
            turn_id: turn_id.to_owned(),
            status: view_status(&durable_status),
            failure: latest_state.and_then(failure_of),
            items,
            started_at,
            model_id,
            provider_retry: None,
        },
        recorded: latest_state.is_some(),
        durable_status,
    }
}

/// An empty view for a Turn that exists only live (`overlayLiveTurn` with no
/// settled Turn): it has not ended.
pub(crate) fn live_only_turn(live: &LiveTurn) -> TurnView {
    TurnView {
        turn_id: live.turn_id.clone(),
        status: TurnViewStatus::Running,
        failure: None,
        items: Vec::new(),
        started_at: live.started_at.unwrap_or_default(),
        model_id: None,
        provider_retry: None,
    }
}

fn view_status(status: &TurnStatus) -> TurnViewStatus {
    match status {
        TurnStatus::Running => TurnViewStatus::Running,
        TurnStatus::Aborted => TurnViewStatus::Cancelled,
        TurnStatus::Failed => TurnViewStatus::Failed,
        _ => TurnViewStatus::Completed,
    }
}

fn failure_of(state: &TurnStateMessage) -> Option<TurnFailure> {
    (state.status == TurnStatus::Failed).then(|| TurnFailure {
        class: state.error_class.clone().unwrap_or_else(|| "runtime_error".to_owned()),
        message: state.failure_message.clone(),
    })
}

/// `inferLegacyTurnStatus` for Turns written before `turn_state` rows.
fn infer_legacy_status(rows: &[&StoredMessage]) -> TurnStatus {
    let aborted = rows.iter().any(|row| {
        matches!(row, StoredMessage::Other(value)
            if value.get("type").and_then(Value::as_str) == Some("system_note")
                && value.get("kind").and_then(Value::as_str) == Some("abort"))
    });
    if aborted {
        TurnStatus::Aborted
    } else if rows.iter().any(|row| matches!(row, StoredMessage::Assistant(_))) {
        TurnStatus::Completed
    } else if rows
        .iter()
        .any(|row| matches!(row, StoredMessage::ToolResult(result) if result.is_error))
    {
        TurnStatus::Failed
    } else {
        TurnStatus::Completed
    }
}

fn user_item(user: &host_protocol::UserMessage) -> UserItem {
    UserItem {
        message_id: user.id.clone(),
        content: user.content(),
        ts: Some(user.ts),
        host_origin: user.origin.clone(),
    }
}

/// `materializeTools`: one item per `tool_call`, settled by its
/// `tool_result`, or by the Turn's status when there is none.
fn materialize_tools(
    rows: &[&StoredMessage],
    turn_status: &TurnStatus,
) -> HashMap<String, ToolItem> {
    let results: HashMap<&str, &host_protocol::ToolResultMessage> = rows
        .iter()
        .filter_map(|row| match row {
            StoredMessage::ToolResult(result) => Some((result.tool_use_id.as_str(), result)),
            _ => None,
        })
        .collect();
    rows.iter()
        .filter_map(|row| match row {
            StoredMessage::ToolCall(call) => Some(call),
            _ => None,
        })
        .map(|call| {
            let result = results.get(call.id.as_str());
            let status = match result {
                Some(result) => tool_result_status(result.is_error, &result.content),
                // `unfinishedToolActivityStatus`.
                None if *turn_status == TurnStatus::Running => ToolStatus::Running,
                None => ToolStatus::Interrupted,
            };
            let item = ToolItem {
                tool_use_id: call.id.clone(),
                tool_name: call.tool_name.clone(),
                display_name: call.display_name.clone(),
                activity_kind: call.activity_kind.clone(),
                intent: call.intent.clone(),
                args: call.args.clone(),
                args_preview: None,
                step_id: call.step_id.clone(),
                status,
                result: result.map(|result| result.content.clone()),
                duration_ms: result.and_then(|result| result.duration_ms),
                output: Vec::new(),
            };
            (call.id.clone(), item)
        })
        .collect()
}

/// `toolResultActivityStatus` with `isCancelledToolResultContent`.
fn tool_result_status(is_error: bool, content: &Value) -> ToolStatus {
    if !is_error {
        return ToolStatus::Completed;
    }
    let kind = content.get("kind").and_then(Value::as_str);
    let cancelled = matches!(kind, Some("terminal" | "shell_run" | "agent_swarm"))
        && content.get("status").and_then(Value::as_str) == Some("cancelled");
    if cancelled { ToolStatus::Interrupted } else { ToolStatus::Errored }
}

/// `buildTurnTimeline`: interleaves each assistant step's text with its
/// Tools in production order. The Turn's first user message is not part of
/// it; later user messages (steering) are.
pub(crate) fn build_timeline(
    rows: &[&StoredMessage],
    tools: &HashMap<String, ToolItem>,
) -> Vec<TurnItem> {
    let mut out = Vec::new();
    let mut pending: Vec<ToolItem> = Vec::new();
    let mut saw_user = false;
    let flush = |out: &mut Vec<TurnItem>, items: Vec<ToolItem>| {
        out.extend(items.into_iter().map(TurnItem::Tool));
    };
    for row in rows {
        match row {
            StoredMessage::User(user) => {
                if !saw_user {
                    saw_user = true;
                    continue;
                }
                flush(&mut out, std::mem::take(&mut pending));
                out.push(TurnItem::User(user_item(user)));
            }
            StoredMessage::ToolCall(call) => {
                if let Some(item) = tools.get(&call.id) {
                    pending.push(item.clone());
                }
            }
            StoredMessage::Assistant(assistant) => {
                let row_id = assistant.id.as_str();
                let taken = std::mem::take(&mut pending);
                let (legacy, rest): (Vec<_>, Vec<_>) =
                    taken.into_iter().partition(|tool| tool.step_id.is_none());
                let (matched, orphaned): (Vec<_>, Vec<_>) =
                    rest.into_iter().partition(|tool| tool.step_id.as_deref() == Some(row_id));
                // Tools of an earlier pure-Tool step ran before this row.
                flush(&mut out, orphaned);
                let thinking = assistant.thinking_text().map(|text| {
                    TurnItem::Thinking(ThinkingItem {
                        message_id: assistant.id.clone(),
                        text: text.to_owned(),
                        streaming: false,
                        truncated: false,
                    })
                });
                let text = (!assistant.text.is_empty() || assistant.interrupted).then(|| {
                    TurnItem::Text(TextItem {
                        message_id: assistant.id.clone(),
                        text: assistant.text.clone(),
                        streaming: false,
                        interrupted: assistant.interrupted,
                        truncated: false,
                        ts: Some(assistant.ts),
                    })
                });
                match assistant.content_order.as_deref() {
                    Some(order) if !order.is_empty() => {
                        flush(&mut out, legacy);
                        let (mut thinking, mut text) = (thinking, text);
                        let mut matched = Some(matched);
                        let kinds = order
                            .iter()
                            .map(|kind| kind.as_str().to_owned())
                            .chain(["thinking", "text", "tools"].into_iter().map(str::to_owned));
                        for kind in kinds {
                            match kind.as_str() {
                                "thinking" => out.extend(thinking.take()),
                                "text" => out.extend(text.take()),
                                "tools" => {
                                    if let Some(matched) = matched.take() {
                                        flush(&mut out, matched);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {
                        // Legacy rows: thinking, legacy Tools, text, matched Tools.
                        out.extend(thinking);
                        flush(&mut out, legacy);
                        out.extend(text);
                        flush(&mut out, matched);
                    }
                }
            }
            _ => {}
        }
    }
    flush(&mut out, pending);
    out
}

/// `overlayLiveTurn`: live entries replace their settled counterparts in
/// place, in live production order; settled entries the live stream does
/// not know stay where they are.
pub(crate) fn overlay_live_turn(
    mut base: TurnView,
    live: &LiveTurn,
    recorded_ended: bool,
) -> TurnView {
    if live.steps.is_empty() {
        return base;
    }
    let mut tools: HashMap<String, ToolItem> = base
        .items
        .iter()
        .filter_map(|item| match item {
            TurnItem::Tool(tool) => Some((tool.tool_use_id.clone(), tool.clone())),
            _ => None,
        })
        .collect();
    let mut live_text_keys = Vec::new();
    for step in &live.steps {
        if step.thinking.is_some() {
            live_text_keys.push(ItemKey::Thinking(step.step_id.clone()));
        }
        if step.text.is_some() {
            live_text_keys.push(ItemKey::Text(step.step_id.clone()));
        }
        for live_tool in &step.tools {
            let merged = match tools.get(&live_tool.tool_use_id) {
                Some(persisted) => merge_live_over_persisted(persisted, live_tool, recorded_ended),
                None => live_tool.clone(),
            };
            tools.insert(live_tool.tool_use_id.clone(), merged);
        }
    }
    let mut live_entries: Vec<TurnItem> = Vec::new();
    for step in &live.steps {
        if let Some(steering) = &step.steering {
            live_entries.push(TurnItem::User(UserItem {
                message_id: steering.message_id.clone(),
                content: steering.content.clone(),
                ts: Some(steering.ts),
                host_origin: None,
            }));
        }
        let order = if step.content_order.is_empty() {
            let mut inferred = Vec::new();
            if step.thinking.is_some() {
                inferred.push(ContentKind::Thinking);
            }
            if step.text.is_some() {
                inferred.push(ContentKind::Text);
            }
            if !step.tools.is_empty() {
                inferred.push(ContentKind::Tools);
            }
            inferred
        } else {
            step.content_order.clone()
        };
        for kind in order {
            match kind {
                ContentKind::Thinking => {
                    if let Some(thinking) =
                        step.thinking.as_ref().filter(|thinking| !thinking.text.is_empty())
                    {
                        live_entries.push(TurnItem::Thinking(ThinkingItem {
                            message_id: step.step_id.clone(),
                            text: thinking.text.clone(),
                            streaming: !thinking.complete,
                            truncated: thinking.truncated,
                        }));
                    }
                }
                ContentKind::Text => {
                    if let Some(text) =
                        step.text.as_ref().filter(|text| !text.text.is_empty() || text.interrupted)
                    {
                        live_entries.push(TurnItem::Text(TextItem {
                            message_id: step.step_id.clone(),
                            text: text.text.clone(),
                            streaming: !text.complete,
                            interrupted: text.interrupted,
                            truncated: text.truncated,
                            ts: None,
                        }));
                    }
                }
                ContentKind::Tools => {
                    for tool in &step.tools {
                        if let Some(projected) = tools.get(&tool.tool_use_id) {
                            live_entries.push(TurnItem::Tool(projected.clone()));
                        }
                    }
                }
            }
        }
    }
    let live_index: HashMap<ItemKey, usize> =
        live_entries.iter().enumerate().map(|(index, item)| (item.key(), index)).collect();
    let live_count = live_entries.len();
    let mut items = Vec::with_capacity(base.items.len() + live_count);
    let mut next_live = 0;
    let mut live_entries = live_entries.into_iter().map(Some).collect::<Vec<_>>();
    let mut append_live_through =
        |items: &mut Vec<TurnItem>, index: usize, next_live: &mut usize| {
            while *next_live <= index {
                if let Some(entry) = live_entries[*next_live].take() {
                    items.push(entry);
                }
                *next_live += 1;
            }
        };
    for item in std::mem::take(&mut base.items) {
        let key = item.key();
        if let Some(&position) = live_index.get(&key) {
            append_live_through(&mut items, position, &mut next_live);
        } else if !live_text_keys.contains(&key) {
            items.push(item);
        }
    }
    if live_count > 0 {
        append_live_through(&mut items, live_count - 1, &mut next_live);
    }
    base.items = items;
    base
}

/// `mergeLiveOverPersisted`: live owns transient state; the durable row
/// fills arguments and settled results, and a Turn that has ended settles a
/// frozen `running` status.
fn merge_live_over_persisted(
    persisted: &ToolItem,
    live: &ToolItem,
    turn_settled: bool,
) -> ToolItem {
    let mut merged = ToolItem {
        tool_use_id: live.tool_use_id.clone(),
        tool_name: live.tool_name.clone(),
        display_name: live.display_name.clone().or_else(|| persisted.display_name.clone()),
        activity_kind: live.activity_kind.clone().or_else(|| persisted.activity_kind.clone()),
        intent: live.intent.clone().or_else(|| persisted.intent.clone()),
        args: live.args.clone().or_else(|| persisted.args.clone()),
        args_preview: live.args_preview.clone().or_else(|| persisted.args_preview.clone()),
        step_id: live.step_id.clone().or_else(|| persisted.step_id.clone()),
        status: live.status,
        result: live.result.clone().or_else(|| persisted.result.clone()),
        duration_ms: live.duration_ms.or(persisted.duration_ms),
        output: if live.output.is_empty() { persisted.output.clone() } else { live.output.clone() },
    };
    if turn_settled && live.status.is_in_flight() {
        merged.status = persisted.status;
    }
    if live.tool_name == "Tool" {
        merged.tool_name = persisted.tool_name.clone();
        merged.activity_kind = persisted.activity_kind.clone();
        merged.display_name = persisted.display_name.clone();
        merged.intent = persisted.intent.clone();
        merged.args = persisted.args.clone();
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rows(values: Vec<Value>) -> Vec<StoredMessage> {
        values.into_iter().map(|value| serde_json::from_value(value).expect("row")).collect()
    }

    #[test]
    fn a_tool_step_renders_tools_then_the_answer() {
        let rows = rows(vec![
            json!({"type": "user", "id": "t", "turnId": "t", "ts": 1, "text": "list files"}),
            json!({"type": "tool_call", "id": "c1", "turnId": "t", "ts": 2, "toolName": "Bash",
                   "args": {"command": "ls"}, "stepId": "s1"}),
            json!({"type": "tool_result", "id": "r1", "turnId": "t", "ts": 3, "toolUseId": "c1",
                   "isError": false, "content": {"kind": "text", "text": "a"}}),
            json!({"type": "assistant", "id": "s1", "turnId": "t", "ts": 4, "text": "",
                   "contentOrder": ["tools"], "modelId": "m"}),
            json!({"type": "assistant", "id": "s2", "turnId": "t", "ts": 5, "text": "One file.",
                   "contentOrder": ["text"], "modelId": "m"}),
            json!({"type": "turn_state", "id": "e", "turnId": "t", "ts": 6, "status": "completed"}),
        ]);
        let refs: Vec<&StoredMessage> = rows.iter().collect();
        let turn = materialize_turn("t", &refs);
        let keys: Vec<String> = turn.view.items.iter().map(|item| item.key().to_string()).collect();
        assert_eq!(keys, ["user:t", "tool:c1", "text:s2"]);
        assert_eq!(turn.view.status, TurnViewStatus::Completed);
        assert!(turn.recorded);
        let TurnItem::Tool(tool) = &turn.view.items[1] else { panic!("expected tool") };
        assert_eq!(tool.status, ToolStatus::Completed);
        assert_eq!(tool.result_text(), Some("a"));
    }

    #[test]
    fn unfinished_tools_follow_the_turn_status() {
        let rows = rows(vec![
            json!({"type": "tool_call", "id": "c1", "turnId": "t", "ts": 2, "toolName": "Bash", "args": {}}),
            json!({"type": "turn_state", "id": "e", "turnId": "t", "ts": 6, "status": "aborted"}),
        ]);
        let refs: Vec<&StoredMessage> = rows.iter().collect();
        let turn = materialize_turn("t", &refs);
        assert_eq!(turn.view.status, TurnViewStatus::Cancelled);
        let TurnItem::Tool(tool) = &turn.view.items[0] else { panic!("expected tool") };
        assert_eq!(tool.status, ToolStatus::Interrupted);
    }

    #[test]
    fn reasoning_is_its_own_item_in_content_order() {
        let rows = rows(vec![
            json!({"type": "user", "id": "t", "turnId": "t", "ts": 1, "text": "why"}),
            json!({"type": "tool_call", "id": "c1", "turnId": "t", "ts": 2, "toolName": "Read",
                   "args": {}, "stepId": "s1"}),
            json!({"type": "assistant", "id": "s1", "turnId": "t", "ts": 3, "text": "Because.",
                   "thinking": {"text": "Let me look first."},
                   "contentOrder": ["thinking", "tools", "text"], "modelId": "m"}),
            // Legacy row: reasoning first, then the text.
            json!({"type": "assistant", "id": "s2", "turnId": "t", "ts": 4, "text": "Done.",
                   "thinking": {"text": "Check again."}, "modelId": "m"}),
            // An empty reasoning block makes no item.
            json!({"type": "assistant", "id": "s3", "turnId": "t", "ts": 5, "text": "End.",
                   "thinking": {"text": ""}, "contentOrder": ["thinking", "text"],
                   "modelId": "m"}),
        ]);
        let refs: Vec<&StoredMessage> = rows.iter().collect();
        let view = materialize_turn("t", &refs).view;
        let keys: Vec<String> = view.items.iter().map(|item| item.key().to_string()).collect();
        assert_eq!(
            keys,
            ["user:t", "thinking:s1", "tool:c1", "text:s1", "thinking:s2", "text:s2", "text:s3"]
        );
        let TurnItem::Thinking(thinking) = &view.items[1] else { panic!("reasoning") };
        assert_eq!(thinking.text, "Let me look first.");
        let TurnItem::Text(text) = &view.items[3] else { panic!("text") };
        assert_eq!(text.text, "Because.", "reasoning never enters the text");
    }

    #[test]
    fn legacy_rows_without_content_order_put_tools_after_text() {
        let rows = rows(vec![
            json!({"type": "tool_call", "id": "c1", "turnId": "t", "ts": 2, "toolName": "Read",
                   "args": {}, "stepId": "s1"}),
            json!({"type": "assistant", "id": "s1", "turnId": "t", "ts": 4, "text": "Reading.",
                   "modelId": "m"}),
        ]);
        let refs: Vec<&StoredMessage> = rows.iter().collect();
        let keys: Vec<String> = materialize_turn("t", &refs)
            .view
            .items
            .iter()
            .map(|item| item.key().to_string())
            .collect();
        assert_eq!(keys, ["text:s1", "tool:c1"]);
    }
}
