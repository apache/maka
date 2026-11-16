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
}
impl MessageOrigin {
    pub fn prompt_header(&self, language: crate::language::Language) -> String {
        let mut header = format!(
            "{}{}]\n",
            Self::prompt_header_prefix(language),
            serde_json::to_string(self).expect("message origin is serializable")
        );
        if let Self::Room {
            session_id,
            message_id,
            author,
            ..
        } = self
        {
            use crate::{language::Language, room::RoomAuthor};
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
            let history = serde_json::json!({
                "sessionId": session_id,
                "position": {"kind": "before_message", "messageId": message_id},
            });
            let reply = serde_json::json!({"sessionId": session_id, "replyTo": message_id});
            let instruction = match language {
                Language::ZhCn => format!(
                    "如果这条消息引用了房间里之前的内容，先调用 SessionHistory({history}) 读取 @ 你之前的消息。用 SessionSend 回这个房间，地址参数为 {reply}，在 message 里填答复。\n"
                ),
                Language::ZhTw => format!(
                    "如果這則訊息引用了房間裡先前的內容，先呼叫 SessionHistory({history}) 讀取 @ 你之前的訊息。用 SessionSend 回覆這個房間，地址參數為 {reply}，在 message 裡填答覆。\n"
                ),
                _ => format!(
                    "If the mention refers to earlier Room context, call SessionHistory({history}) to read the messages before it. Reply in the Room using SessionSend with {reply} and your response in message.\n"
                ),
            };
            header.push_str(&sender);
            header.push('\n');
            header.push_str(&instruction);
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
            Self::BotWorker { session_id } => crate::interaction::entity_id(session_id),
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
