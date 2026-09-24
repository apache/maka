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

use super::*;

impl Projection {
    pub fn delta(
        &mut self,
        delta: &SessionAssistantDelta,
    ) -> Result<Vec<acp::SessionUpdate>, crate::Error> {
        let kind = match delta.kind {
            AssistantStreamKind::Text => MessageKind::Text,
            AssistantStreamKind::Thinking => MessageKind::Thinking,
        };
        let key = (delta.turn_id.clone(), delta.message_id.clone(), kind);
        let current = self
            .streams
            .get(&key)
            .map(|m| m.text.as_str())
            .unwrap_or("");
        if delta.reset.is_some() && delta.start_offset != 0 {
            return Err("Assistant reset has a nonzero offset".into());
        }
        let next = if delta.reset.is_some() {
            delta.text.clone()
        } else {
            let offset = utf16_byte_offset(current, delta.start_offset)
                .ok_or("Assistant offset is missing or splits a UTF-16 character")?;
            if current[offset..].starts_with(&delta.text) && delta.complete.is_none() {
                current.to_owned()
            } else {
                format!("{}{}", &current[..offset], delta.text)
            }
        };
        self.text(
            &delta.turn_id,
            &delta.message_id,
            kind,
            &next,
            delta.reset.is_some(),
            message_meta(&delta.turn_id, &delta.message_id),
        )
    }

    pub(super) fn text(
        &mut self,
        turn: &str,
        id: &str,
        kind: MessageKind,
        next: &str,
        replace: bool,
        meta: acp::Meta,
    ) -> Result<Vec<acp::SessionUpdate>, crate::Error> {
        let key = (turn.to_owned(), id.to_owned(), kind);
        let previous = self.streams.get(&key);
        if previous.is_some_and(|p| p.text == next && p.meta == meta)
            || (previous.is_none() && next.is_empty() && kind != MessageKind::User)
        {
            return Ok(vec![]);
        }
        if previous.is_none() && self.streams.len() + self.tools.len() >= IDENTITIES {
            return Err("ACP presentation identity limit exceeded".into());
        }
        let size = next.len() + serde_json::to_vec(&meta)?.len();
        let old_size = previous.map_or(0, |p| p.bytes);
        if self.bytes - old_size + size > TOTAL_BYTES {
            return Err("ACP text presentation limit exceeded".into());
        }
        let current = previous.map_or("", |p| p.text.as_str());
        let message_id = match kind {
            MessageKind::Thinking => format!("thinking:{id}"),
            _ => id.to_owned(),
        };
        let suffix = if replace {
            None
        } else {
            next.strip_prefix(current)
        };
        let update = match (kind, suffix) {
            (MessageKind::Text, Some(suffix)) => acp::SessionUpdate::AgentMessageChunk(
                acp::ContentChunk::new(suffix.into(), message_id).meta(meta.clone()),
            ),
            (MessageKind::Thinking, Some(suffix)) => acp::SessionUpdate::AgentThoughtChunk(
                acp::ContentChunk::new(suffix.into(), message_id).meta(meta.clone()),
            ),
            (kind, _) => {
                let content = MaybeUndefined::Value(vec![acp::ContentBlock::from(next)]);
                let metadata = MaybeUndefined::Value(meta.clone());
                match kind {
                    MessageKind::User => acp::SessionUpdate::UserMessage(
                        acp::UserMessage::new(message_id)
                            .content(content)
                            .meta(metadata),
                    ),
                    MessageKind::Text => acp::SessionUpdate::AgentMessage(
                        acp::AgentMessage::new(message_id)
                            .content(content)
                            .meta(metadata),
                    ),
                    MessageKind::Thinking => acp::SessionUpdate::AgentThought(
                        acp::AgentThought::new(message_id)
                            .content(content)
                            .meta(metadata),
                    ),
                }
            }
        };
        self.bytes = self.bytes - old_size + size;
        self.streams.insert(
            key,
            Message {
                text: next.to_owned(),
                meta,
                bytes: size,
            },
        );
        Ok(vec![update])
    }
}

fn utf16_byte_offset(text: &str, offset: u64) -> Option<usize> {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        if units == offset {
            return Some(index);
        }
        units += character.len_utf16() as u64;
    }
    (units == offset).then_some(text.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_protocol::subscription::TrueFlag;

    #[test]
    fn unicode_replay_and_durable_revision_keep_message_identity() {
        let mut projection = Projection::default();
        let mut delta = SessionAssistantDelta {
            kind: AssistantStreamKind::Text,
            turn_id: "t".into(),
            run_id: "r".into(),
            message_id: "m".into(),
            start_offset: 0,
            text: "🦀中".into(),
            reset: None,
            complete: None,
            interrupted: None,
        };
        assert!(matches!(
            projection.delta(&delta).unwrap()[0],
            acp::SessionUpdate::AgentMessageChunk(_)
        ));
        assert!(projection.delta(&delta).unwrap().is_empty());
        delta.start_offset = 1;
        assert!(projection.delta(&delta).is_err());
        delta.start_offset = 3;
        delta.text = "!".into();
        let update = serde_json::to_value(&projection.delta(&delta).unwrap()[0]).unwrap();
        assert_eq!(update["content"]["text"], "!");
        let row = json!({"type":"assistant","id":"m","turnId":"t","text":"🦀中!"});
        assert!(projection.row(&row).unwrap().is_empty());
        let mut changed = row;
        changed["text"] = json!("🦀中! durable suffix");
        let update = serde_json::to_value(&projection.row(&changed).unwrap()[0]).unwrap();
        assert_eq!(update["sessionUpdate"], "agent_message");
        assert_eq!(update["messageId"], "m");
        assert_eq!(update["content"][0]["text"], "🦀中! durable suffix");
        delta.start_offset = 0;
        delta.reset = Some(TrueFlag);
        delta.text.clear();
        let update = serde_json::to_value(&projection.delta(&delta).unwrap()[0]).unwrap();
        assert_eq!(update["sessionUpdate"], "agent_message");
        assert_eq!(update["messageId"], "m");
        assert_eq!(update["content"][0]["text"], "");
    }

    #[test]
    fn empty_user_attachment_is_a_full_deduplicated_message() {
        let mut projection = Projection::default();
        let mut row = json!({"type":"user","id":"u","turnId":"t","text":"","attachments":[{"name":"photo.png","mimeType":"image/png","bytes":30,"kind":"image","ref":{"kind":"session_file","relativePath":"private"}}]});
        let update = serde_json::to_value(&projection.row(&row).unwrap()[0]).unwrap();
        assert_eq!(update["sessionUpdate"], "user_message");
        assert_eq!(update["messageId"], "u");
        assert_eq!(update["content"][0]["text"], "");
        assert_eq!(
            update["_meta"]["maka"]["attachments"][0]["name"],
            "photo.png"
        );
        assert!(!update.to_string().contains("private"));
        assert!(projection.row(&row).unwrap().is_empty());
        row["attachments"][0]["name"] = json!("renamed.png");
        assert!(matches!(
            projection.row(&row).unwrap()[0],
            acp::SessionUpdate::UserMessage(_)
        ));
        assert!(projection.row(&row).unwrap().is_empty());
    }
}
