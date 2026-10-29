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
    pub(super) fn replace_text(
        &mut self,
        turn: &str,
        id: &str,
        kind: MessageKind,
        next: &str,
        meta: acp::Meta,
    ) -> Vec<acp::SessionUpdate> {
        let key = (turn.to_owned(), id.to_owned(), kind);
        let previous = self.streams.get(&key);
        if previous.is_some_and(|p| p.text == next && p.meta == meta)
            || (previous.is_none() && next.is_empty() && kind != MessageKind::User)
        {
            return vec![];
        }
        let message_id = match kind {
            MessageKind::Thinking => format!("thinking:{id}"),
            _ => id.to_owned(),
        };
        let content = MaybeUndefined::Value(vec![acp::ContentBlock::from(next)]);
        let metadata = MaybeUndefined::Value(meta.clone());
        let update = match kind {
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
        };
        let canonical = previous.is_some_and(|message| message.canonical);
        self.streams.insert(
            key,
            Message {
                text: next.to_owned(),
                meta,
                canonical,
            },
        );
        vec![update]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn preview_page(revision: u64, offset: u64, total_bytes: u64, text: &str) -> PreviewPage {
        PreviewPage::Cut {
            host_epoch: "epoch".into(),
            invocation_id: "invocation".into(),
            turn_id: "turn".into(),
            step_id: "step".into(),
            revision,
            depends_on: 17,
            first: offset == 0,
            last: offset + text.len() as u64 == total_bytes,
            parts: vec![maka_agent_api::contract::PreviewPart {
                ordinal: Some(0),
                message_id: "message".into(),
                provider_part_id: Some("part".into()),
                started_at: 0.0,
                field: PreviewField::Text {
                    text_kind: ContentKind::Text,
                },
                offset,
                total_bytes,
                text: text.into(),
            }],
        }
    }

    #[test]
    fn paginated_preview_seed_replaces_once_then_suffix_appends_without_duplication() {
        let mut projection = Projection::default();
        assert!(
            projection
                .preview(&preview_page(1, 0, 8, "🦀"))
                .unwrap()
                .is_empty()
        );
        let seed = projection.preview(&preview_page(1, 4, 8, "中!")).unwrap();
        let seed = serde_json::to_value(&seed[0]).unwrap();
        assert_eq!(seed["sessionUpdate"], "agent_message");
        assert_eq!(seed["content"][0]["text"], "🦀中!");
        let suffix = projection.preview(&preview_page(2, 8, 9, "?")).unwrap();
        let suffix = serde_json::to_value(&suffix[0]).unwrap();
        assert_eq!(suffix["sessionUpdate"], "agent_message_chunk");
        assert_eq!(suffix["content"]["text"], "?");
        assert!(
            projection
                .preview(&preview_page(2, 0, 9, "🦀中!?"))
                .unwrap()
                .is_empty(),
            "reconnect seed must replace the same ID without replaying its prefix"
        );
    }

    #[test]
    fn committed_message_and_closed_step_discard_unfinished_old_seed() {
        let mut projection = Projection::default();
        assert!(
            projection
                .preview(&preview_page(1, 0, 8, "🦀"))
                .unwrap()
                .is_empty()
        );
        projection.commit_preview("invocation", "step", Some("message"));
        assert!(
            projection
                .preview(&preview_page(1, 4, 8, "中!"))
                .unwrap()
                .is_empty()
        );
        assert!(
            projection
                .preview(&preview_page(2, 0, 9, "🦀中!?"))
                .unwrap()
                .is_empty()
        );
        let mut projection = Projection::default();
        projection.commit_preview("invocation", "step", None);
        assert!(
            projection
                .preview(&preview_page(1, 0, 8, "🦀中!"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn long_sessions_keep_every_message_instead_of_rejecting_total_history_size() {
        let mut projection = Projection::default();
        let text = "x".repeat(4096);
        for i in 0..4200 {
            let updates =
                projection.append("turn", &format!("message-{i}"), &ContentKind::Text, &text);
            assert_eq!(updates.len(), 1);
            let update = serde_json::to_value(&updates[0]).unwrap();
            assert_eq!(update["sessionUpdate"], "agent_message_chunk");
            assert_eq!(update["messageId"], format!("message-{i}"));
            assert_eq!(update["content"]["text"], text);
        }
        // Revisit an early message after the complete history has passed through.
        let update = projection.append("turn", "message-0", &ContentKind::Text, "尾");
        let update = serde_json::to_value(&update[0]).unwrap();
        assert_eq!(update["messageId"], "message-0");
        assert_eq!(update["content"]["text"], "尾");
        let canonical = format!("{text}尾");
        let chunk = HistoryChunk {
            model_part: None,
            final_output: false,
            model: None,
            origin: None,
            compaction: None,
            attachments: Vec::new(),
            timing: None,
            field: HistoryField::Body,
            message_id: "message-0".into(),
            turn_id: "turn".into(),
            timestamp: 0,
            role: Role::Assistant,
            position: maka_agent_ports::session::history::RowPosition {
                source_sequence: 1,
                item_index: 0,
            },
            offset: 0,
            total_bytes: canonical.len() as u64,
            text: canonical,
            tool: None,
        };
        assert!(
            projection.chunk(&chunk).unwrap().is_empty(),
            "canonical replay must not duplicate the retained early message"
        );
    }

    #[test]
    fn unicode_stream_and_canonical_history_keep_the_same_message() {
        let mut projection = Projection::default();
        projection.append("t", "m", &ContentKind::Text, "🦀中");
        let update = projection.append("t", "m", &ContentKind::Text, "!");
        assert_eq!(
            serde_json::to_value(&update[0]).unwrap()["content"]["text"],
            "!"
        );
        let mut chunk = HistoryChunk {
            model_part: None,
            final_output: false,
            model: None,
            origin: None,
            compaction: None,
            attachments: Vec::new(),
            timing: None,
            field: HistoryField::Body,
            message_id: "m".into(),
            turn_id: "t".into(),
            timestamp: 0,
            role: Role::Assistant,
            position: maka_agent_ports::session::history::RowPosition {
                source_sequence: 1,
                item_index: 0,
            },
            offset: 0,
            total_bytes: 8,
            text: "🦀中".into(),
            tool: None,
        };
        assert!(projection.chunk(&chunk).unwrap().is_empty());
        chunk.offset = 7;
        chunk.text = "!".into();
        assert!(projection.chunk(&chunk).unwrap().is_empty());
        chunk.offset = 0;
        chunk.model = Some(maka_agent_ports::session::history::HistoryModel::Native {
            requested_model_id: "requested-alias".into(),
            reported_model_id: Some("reported-concrete".into()),
        });
        chunk.text = "re".into();
        chunk.total_bytes = 7;
        assert!(projection.chunk(&chunk).unwrap().is_empty());
        chunk.offset = 2;
        chunk.text = "vised".into();
        let update = serde_json::to_value(&projection.chunk(&chunk).unwrap()[0]).unwrap();
        assert_eq!(update["sessionUpdate"], "agent_message");
        assert_eq!(update["messageId"], "m");
        assert_eq!(update["content"][0]["text"], "revised");
        assert!(update["_meta"]["maka"].get("origin").is_none());
        let expected = serde_json::json!({"kind":"native","requestedModelId":"requested-alias","reportedModelId":"reported-concrete"});
        assert_eq!(update["_meta"]["maka"]["model"], expected);
        chunk.offset = 0;
        chunk.field = HistoryField::Thinking;
        chunk.text = "Check".into();
        chunk.total_bytes = 5;
        let thinking = serde_json::to_value(&projection.chunk(&chunk).unwrap()[0]).unwrap();
        assert_eq!(thinking["sessionUpdate"], "agent_thought");
        assert_eq!(thinking["content"][0]["text"], "Check");
        assert_eq!(thinking["_meta"]["maka"]["model"], expected);
    }
    #[test]
    fn missing_history_fragment_is_rejected() {
        let mut projection = Projection::default();
        let chunk = HistoryChunk {
            model_part: None,
            final_output: false,
            model: None,
            origin: None,
            compaction: None,
            attachments: Vec::new(),
            timing: None,
            field: HistoryField::Body,
            message_id: "m".into(),
            turn_id: "t".into(),
            timestamp: 0,
            role: Role::Assistant,
            position: maka_agent_ports::session::history::RowPosition {
                source_sequence: 1,
                item_index: 0,
            },
            offset: 2,
            total_bytes: 3,
            text: "a".into(),
            tool: None,
        };
        assert!(projection.chunk(&chunk).is_err());
    }
    #[test]
    fn attachment_only_user_message_keeps_safe_descriptions_during_replay() {
        let mut projection = Projection::default();
        let chunk = HistoryChunk {
            model_part: None,
            final_output: false,
            model: None,
            origin: Some(maka_agent_facts::message::MessageOrigin::WorkhubTask {
                task_id: "task-original".into(),
            }),
            compaction: None,
            attachments: vec![maka_agent_api::contract::HistoryAttachment {
                name: "photo.png".into(),
                mime_type: "image/png".into(),
                bytes: 30,
                kind: maka_agent_facts::attachment::AttachmentKind::Image,
            }],
            timing: None,
            field: HistoryField::Body,
            message_id: "u".into(),
            turn_id: "t".into(),
            timestamp: 0,
            role: Role::User,
            position: maka_agent_ports::session::history::RowPosition {
                source_sequence: 1,
                item_index: 0,
            },
            offset: 0,
            total_bytes: 0,
            text: String::new(),
            tool: None,
        };
        let update = serde_json::to_value(&projection.chunk(&chunk).unwrap()[0]).unwrap();
        assert_eq!(update["sessionUpdate"], "user_message");
        assert_eq!(
            update["_meta"]["maka"]["origin"],
            serde_json::json!({
                "kind": "workhub_task", "taskId": "task-original"
            })
        );
        assert_eq!(update["_meta"]["maka"]["hostMessageId"], "u");
        assert_eq!(update["_meta"]["maka"]["turnId"], "t");
        assert_eq!(
            update["_meta"]["maka"]["attachments"][0]["name"],
            "photo.png"
        );
        assert!(
            update["_meta"]["maka"]["attachments"][0]
                .get("ref")
                .is_none()
        );
        assert!(projection.chunk(&chunk).unwrap().is_empty());
    }
    #[test]
    fn diagnostic_history_replays_as_marked_text_without_tool_metadata() {
        let mut projection = Projection::default();
        let mut chunk = HistoryChunk {
            model_part: None,
            final_output: false,
            model: None,
            origin: None,
            compaction: None,
            attachments: Vec::new(),
            timing: None,
            field: HistoryField::Body,
            message_id: "failure".into(),
            turn_id: "turn".into(),
            timestamp: 0,
            role: Role::Failure,
            position: maka_agent_ports::session::history::RowPosition {
                source_sequence: 1,
                item_index: 0,
            },
            offset: 0,
            total_bytes: 16,
            text: "Provider ".into(),
            tool: None,
        };
        assert!(projection.chunk(&chunk).unwrap().is_empty());
        chunk.offset = 9;
        chunk.text = "offline".into();
        let updates = projection.chunk(&chunk).unwrap();
        assert_eq!(updates.len(), 1);
        let update = serde_json::to_value(&updates[0]).unwrap();
        assert_eq!(update["sessionUpdate"], "agent_message");
        assert_eq!(update["content"][0]["text"], "Provider offline");
        assert_eq!(update["_meta"]["maka"]["role"], "failure");
        chunk.offset = 0;
        chunk.text = "Provider offline".into();
        assert!(projection.chunk(&chunk).unwrap().is_empty());
        chunk.role = Role::Compaction;
        chunk.text.clear();
        chunk.total_bytes = 0;
        assert!(projection.chunk(&chunk).unwrap().is_empty());
    }
}
