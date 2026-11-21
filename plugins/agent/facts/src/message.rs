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

//! Durable message provenance shared by admission, execution and recovery.
use crate::input::{DeliveredMessage, MessageInput};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Trusted producer attribution, preserved independently of editable content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MessageOrigin {
    SessionCompletion {
        session_id: String,
        message_id: String,
    },
    Session {
        execution: crate::durable::ExecutionIdentity,
    },
    Room {
        session_id: String,
        message_id: String,
        author: crate::room::RoomAuthor,
        reply_to: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        mentions: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hop_count: Option<u8>,
    },
    Automation {
        automation_id: String,
        title: String,
    },
    Goal {
        goal_id: String,
        objective: String,
    },
    /// A worker conversation created by the Bot finished a run.
    BotWorker {
        session_id: String,
    },
    /// A scheduled investigation submitted findings for the Bot to review.
    DiscoveryReport {
        session_id: String,
    },
}
impl MessageOrigin {
    pub fn prompt_header(&self, language: crate::language::Language) -> String {
        use crate::{language::Language, room::RoomAuthor};
        let mut header = format!(
            "{}{}]\n",
            Self::prompt_header_prefix(language),
            serde_json::to_string(self).expect("message origin is serializable")
        );
        match self {
            Self::Room {
                session_id,
                message_id,
                author,
                ..
            } => {
                let sender = match (language, author) {
                    (Language::ZhCn, RoomAuthor::Human) => "用户在房间里 @ 了你。".into(),
                    (Language::ZhTw, RoomAuthor::Human) => "使用者在房間裡 @ 了你。".into(),
                    (_, RoomAuthor::Human) => "The user mentioned you in a Room.".into(),
                    (Language::ZhCn, RoomAuthor::Session { execution }) => {
                        format!("Agent 会话 {} 在房间里 @ 了你。", execution.session_id)
                    }
                    (Language::ZhTw, RoomAuthor::Session { execution }) => {
                        format!("Agent 對話 {} 在房間裡 @ 了你。", execution.session_id)
                    }
                    (_, RoomAuthor::Session { execution }) => format!(
                        "Agent session {} mentioned you in a Room.",
                        execution.session_id
                    ),
                };
                let read_room = serde_json::json!({"path": format!("maka://session/{session_id}")});
                let session_read = serde_json::json!({
                    "sessionId": session_id,
                    "messageId": message_id,
                    "anchor": "before",
                });
                let reply = serde_json::json!({"sessionId": session_id, "replyTo": message_id});
                let instruction = match language {
                    Language::ZhCn => format!(
                        "若需查看更早的房间记录，调用 Read({read_room})（无 Read 权限时调用 SessionRead({session_read})）。向房间回复请调用 SessionSend，带上 {reply} 并在 message 中填写回复内容；若只需轻量确认收到（无需刷屏回复），可调用 SessionManage 的 room_react 添加表情（如 ✅ 或 👀）。仅在本会话中直接回复不会同步到房间。\n"
                    ),
                    Language::ZhTw => format!(
                        "若需查看更早的房間紀錄，呼叫 Read({read_room})（無 Read 權限時呼叫 SessionRead({session_read})）。向房間回覆請呼叫 SessionSend，帶上 {reply} 並在 message 中填寫回覆內容；若只需輕量確認收到（無需洗版回覆），可呼叫 SessionManage 的 room_react 添加表情（如 ✅ 或 👀）。僅在本對話中直接回覆不會同步到房間。\n"
                    ),
                    _ => format!(
                        "If you need earlier Room context, call Read({read_room}) (or SessionRead({session_read}) when Read is unavailable). Reply in the Room using SessionSend with {reply} and your response in message; for lightweight acknowledgement without posting a full reply, use SessionManage with room_react (e.g. ✅ or 👀). Answering only in this private session will not post to the Room.\n"
                    ),
                };
                header.push_str(&sender);
                header.push('\n');
                header.push_str(&instruction);
            }
            Self::Session { execution } => {
                let guidance = match language {
                    Language::ZhCn => format!(
                        "这条消息来自 Agent 会话 {}。请直接在本会话内完成工作并输出最终回复，无需调用 SessionSend 回传给发送方。\n",
                        execution.session_id
                    ),
                    Language::ZhTw => format!(
                        "這則訊息來自 Agent 對話 {}。請直接在本對話內完成工作並輸出最終回覆，無需呼叫 SessionSend 回傳給發送方。\n",
                        execution.session_id
                    ),
                    _ => format!(
                        "This message was sent by Agent session {}. Complete the work and reply normally in this conversation; do not call SessionSend back to the sender.\n",
                        execution.session_id
                    ),
                };
                header.push_str(&guidance);
            }
            Self::Automation { title, .. } => {
                let guidance = match language {
                    Language::ZhCn => format!("定时任务 {title:?} 已触发，请按下方消息执行。\n"),
                    Language::ZhTw => format!("排程任務 {title:?} 已觸發，請依下方訊息執行。\n"),
                    _ => format!(
                        "Scheduled automation {title:?} triggered; handle the message below.\n"
                    ),
                };
                header.push_str(&guidance);
            }
            Self::Goal { objective, .. } => {
                let guidance = match language {
                    Language::ZhCn => format!(
                        "持久目标 {objective:?} 进入新一轮推进；完成后用 GoalStatus 更新进展或终态。\n"
                    ),
                    Language::ZhTw => format!(
                        "持久目標 {objective:?} 進入新一輪推進；完成後用 GoalStatus 更新進展或終態。\n"
                    ),
                    _ => format!(
                        "Persistent Goal {objective:?} started a continuation turn; advance the objective and update GoalStatus when appropriate.\n"
                    ),
                };
                header.push_str(&guidance);
            }
            Self::SessionCompletion { .. }
            | Self::BotWorker { .. }
            | Self::DiscoveryReport { .. } => {}
        }
        header
    }

    pub fn prompt_header_prefix(language: crate::language::Language) -> &'static str {
        use crate::language::Language;
        match language {
            Language::En => "[Message source (Host-provided): ",
            Language::ZhCn => "[消息来源（Host 提供）：",
            Language::ZhTw => "[訊息來源（Host 提供）：",
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::SessionCompletion {
                session_id,
                message_id,
            } => {
                crate::interaction::entity_id(session_id)?;
                crate::interaction::entity_id(message_id)
            }
            Self::Session { execution } => {
                crate::interaction::entity_id(&execution.session_id)?;
                crate::interaction::entity_id(&execution.turn_id)?;
                Ok(())
            }
            Self::Room {
                session_id,
                message_id,
                author,
                reply_to,
                mentions,
                hop_count: _,
            } => {
                crate::interaction::entity_id(session_id)?;
                crate::interaction::entity_id(message_id)?;
                if let crate::room::RoomAuthor::Session { execution } = author {
                    crate::interaction::entity_id(&execution.session_id)?;
                    crate::interaction::entity_id(&execution.turn_id)?;
                }
                if let Some(message) = reply_to {
                    crate::interaction::entity_id(message)?;
                }
                for mention in mentions {
                    crate::interaction::entity_id(mention)?;
                }
                Ok(())
            }
            Self::Goal { goal_id, objective } => {
                crate::interaction::entity_id(goal_id)?;
                if objective.trim().is_empty() {
                    return Err("Goal objective is empty");
                }
                Ok(())
            }
            Self::Automation {
                automation_id,
                title,
            } => {
                crate::interaction::entity_id(automation_id)?;
                if title.trim().is_empty() {
                    return Err("Automation title is empty");
                }
                Ok(())
            }
            Self::BotWorker { session_id } | Self::DiscoveryReport { session_id } => {
                crate::interaction::entity_id(session_id)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Placement {
    CurrentTurn,
    NextTurn,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmittedTurnIntent {
    pub input_selections: crate::input::Selections,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_selection_sources: crate::input::SelectionSources,
}
impl SubmittedTurnIntent {
    /// Source shape is not admission: Host verifies actual providers before use.
    pub fn is_exact_turn(&self) -> bool {
        crate::input::has_unbound_selections(&self.input_selections, &self.input_selection_sources)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        crate::input::validate_selection_sources(
            &self.input_selections,
            &self.input_selection_sources,
        )?;
        if self.input_selections.is_empty() {
            return Err("invalid submitted Turn intent");
        }
        Ok(())
    }
}

/// Current delivery disposition; promotion may change it to Steering while
/// submitted_placement preserves the original requested placement.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageDisposition {
    TurnStarted,
    Steering,
    Followup,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootSourceMessage {
    #[serde(flatten)]
    pub message: DeliveredMessage,
    /// Input before plugin preparation, including the last accepted queue edit.
    /// Unlike the original submission digest, this follows edits to delivery.
    pub unprepared_content: MessageInput,
    pub submitted_placement: Placement,
    pub disposition: MessageDisposition,
    pub submitted_intent: Option<SubmittedTurnIntent>,
}

/// A Session-owned editing view, not proof that the Session admitted this message.
/// Reusing its content requires a fresh message identity and current preparation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditableMessage {
    pub message_id: String,
    pub turn_id: String,
    pub content: MessageInput,
    pub intent: Option<SubmittedTurnIntent>,
}

impl RootSourceMessage {
    /// Host-only provenance is not part of the visible text used by inline offsets.
    pub fn into_attributed_input(self, language: crate::language::Language) -> MessageInput {
        let DeliveredMessage {
            mut content,
            origin,
            ..
        } = self.message;
        if let Some(origin) = origin {
            content
                .display_text
                .get_or_insert_with(|| content.text.clone());
            content.text.insert_str(0, &origin.prompt_header(language));
        }
        content
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        self.message.validate()?;
        if !self.unprepared_content.preparation.is_empty() {
            return Err("invalid unprepared source content");
        }
        if let Some(intent) = &self.submitted_intent {
            intent.validate()?;
            if intent.is_exact_turn() && self.submitted_placement != Placement::CurrentTurn {
                return Err("exact Turn intent requires current_turn");
            }
        }
        Ok(())
    }
}

/// The canonical opening must consume exactly its ordered source batch.
pub fn validate_sources(
    content: &MessageInput,
    sources: &[RootSourceMessage],
) -> Result<(), &'static str> {
    crate::input::validate_receipts(&content.preparation)?;
    if sources.is_empty() {
        return Ok(());
    }
    let mut ids = HashSet::new();
    let started = sources[0].disposition == MessageDisposition::TurnStarted;
    for source in sources {
        source.validate()?;
        if !ids.insert(&source.message.message_id)
            || (sources.len() != 1
                && if started {
                    source.disposition != MessageDisposition::TurnStarted
                        || source.submitted_placement != Placement::CurrentTurn
                } else {
                    source.disposition == MessageDisposition::TurnStarted
                        || source
                            .submitted_intent
                            .as_ref()
                            .is_some_and(SubmittedTurnIntent::is_exact_turn)
                })
        {
            return Err("conflicting root message sources");
        }
    }
    if aggregate(sources.iter().map(|s| &s.message.content)) != *content {
        return Err("root content differs from its source messages");
    }
    Ok(())
}

/// Matches the client-source aggregate, including UTF-16 inline reference offsets.
pub fn aggregate<'a>(contents: impl IntoIterator<Item = &'a MessageInput>) -> MessageInput {
    let mut result = MessageInput::from("");
    let mut display = String::new();
    let mut offset = 0u64;
    for (index, content) in contents.into_iter().enumerate() {
        if index > 0 {
            result.text.push_str("\n\n");
            display.push_str("\n\n");
        }
        result.text.push_str(&content.text);
        result
            .preparation
            .extend(content.preparation.iter().cloned());
        let visible = content.display_text.as_deref().unwrap_or(&content.text);
        display.push_str(visible);
        append(&mut result.attachments, content.attachments.as_deref());
        append(&mut result.quotes, content.quotes.as_deref());
        append(
            &mut result.directory_references,
            content.directory_references.as_deref(),
        );
        if let Some(references) = &content.inline_references {
            let target = result.inline_references.get_or_insert_with(Vec::new);
            for reference in references {
                let mut reference = reference.clone();
                reference.start = reference.start.saturating_add(offset);
                target.push(reference);
            }
        }
        offset = offset.saturating_add(visible.encode_utf16().count() as u64 + 2);
    }
    if display != result.text {
        result.display_text = Some(display);
    }
    result
}
fn append<T: Clone>(target: &mut Option<Vec<T>>, source: Option<&[T]>) {
    if let Some(source) = source.filter(|items| !items.is_empty()) {
        target
            .get_or_insert_with(Vec::new)
            .extend_from_slice(source);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_starts_preserve_intent_without_accepting_mixed_queue_sources() {
        let mut sources: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|text| {
                let content = MessageInput::from(text);
                RootSourceMessage {
                    message: DeliveredMessage {
                        origin: None,
                        message_id: text.into(),
                        submitted_content_digest: content.content_digest().unwrap(),
                        content: content.clone(),
                    },
                    unprepared_content: content,
                    submitted_placement: Placement::CurrentTurn,
                    disposition: MessageDisposition::TurnStarted,
                    submitted_intent: Some(SubmittedTurnIntent {
                        input_selections: std::collections::BTreeMap::from([(
                            "example".into(),
                            vec![text.into()],
                        )]),
                        input_selection_sources: Default::default(),
                    }),
                }
            })
            .collect();
        let content = aggregate(sources.iter().map(|s| &s.message.content));
        assert!(validate_sources(&content, &sources).is_ok());
        sources[0].message.origin = Some(MessageOrigin::BotWorker {
            session_id: "invalid/id".into(),
        });
        assert!(validate_sources(&content, &sources).is_err());
        sources[0].message.origin = None;
        sources[1].submitted_intent = None;
        sources[1].submitted_placement = Placement::NextTurn;
        assert!(validate_sources(&content, &sources).is_err());
        sources[1].disposition = MessageDisposition::Followup;
        assert!(validate_sources(&content, &sources).is_err());
        sources.reverse();
        let reversed = aggregate(sources.iter().map(|s| &s.message.content));
        assert!(validate_sources(&reversed, &sources).is_err());
        sources[1].disposition = MessageDisposition::Steering;
        assert!(validate_sources(&reversed, &sources).is_err());
        sources[1].submitted_intent = None;
        assert!(validate_sources(&reversed, &sources).is_ok());
        sources[0].disposition = MessageDisposition::TurnStarted;
        assert!(
            validate_sources(&sources[0].message.content, &sources[..1]).is_ok(),
            "an ordinary NextTurn submit may start an idle Session"
        );
    }
}
