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

pub(crate) struct ModelMetadataUpdate {
    key: (MessageIdentity, MessageKind),
    meta: Meta,
    pub update: Update,
}

impl Projection {
    pub fn pending_model_positions(
        &self,
        steps: Option<&HashSet<(StepId, ModelAttemptId)>>,
    ) -> Vec<(
        maka_agent_ports::session::history::RowPosition,
        HistoryField,
    )> {
        let rows: Vec<_> = if let Some(steps) = steps {
            steps
                .iter()
                .filter_map(|step| self.pending_models.get(step))
                .collect()
        } else {
            self.pending_models.values().collect()
        };
        rows.into_iter()
            .flat_map(|rows| rows.iter())
            .map(|(position, kind)| {
                (
                    position.clone(),
                    if *kind == MessageKind::Thinking {
                        HistoryField::Thinking
                    } else {
                        HistoryField::Body
                    },
                )
            })
            .collect()
    }

    pub fn acknowledge_models(&mut self, steps: Option<&HashSet<(StepId, ModelAttemptId)>>) {
        if let Some(steps) = steps {
            for step in steps {
                self.pending_models.remove(step);
            }
        } else {
            self.pending_models.clear();
        }
    }

    pub fn prepare_model_metadata(
        &self,
        chunk: &HistoryChunk,
    ) -> Result<Option<ModelMetadataUpdate>, crate::Error> {
        let kind = if chunk.field == HistoryField::Thinking {
            MessageKind::Thinking
        } else {
            MessageKind::Text
        };
        let identity = MessageIdentity::history(chunk);
        let key = (identity.clone(), kind);
        let message = self
            .streams
            .get(&key)
            .ok_or("Model metadata has no canonical message")?;
        let model = chunk.model.as_ref().map(serde_json::to_value).transpose()?;
        if message.meta["maka"].get("model") == model.as_ref() {
            return Ok(None);
        }
        let mut meta = message.meta.clone();
        let metadata = meta
            .get_mut("maka")
            .and_then(Value::as_object_mut)
            .expect("message metadata");
        if let Some(model) = model {
            metadata.insert("model".into(), model);
        } else {
            metadata.remove("model");
        }
        let update = Update::Message {
            id: identity.presentation_id(kind)?,
            kind,
            text: Text::Metadata,
            meta: meta.clone(),
        };
        Ok(Some(ModelMetadataUpdate { key, meta, update }))
    }

    pub fn commit_model_metadata(&mut self, update: ModelMetadataUpdate) {
        self.streams
            .get_mut(&update.key)
            .expect("retained canonical message")
            .meta = update.meta;
    }

    pub(super) fn replace_text(
        &mut self,
        identity: MessageIdentity,
        kind: MessageKind,
        next: &str,
        meta: Meta,
    ) -> Result<Vec<Update>, crate::Error> {
        let key = (identity.clone(), kind);
        let previous = self.streams.get(&key);
        if previous.is_some_and(|p| p.text == next && p.meta == meta)
            || (previous.is_none()
                && next.is_empty()
                && kind != MessageKind::User
                && !matches!(&identity, MessageIdentity::Row(_)))
        {
            return Ok(vec![]);
        }
        let message_id = identity.presentation_id(kind)?;
        let update = Update::Message {
            id: message_id,
            kind,
            text: Text::Snapshot(next.into()),
            meta: meta.clone(),
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
        Ok(vec![update])
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ids() -> (RunId, StepId, ModelAttemptId) {
        serde_json::from_value(json!([
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
            "00000000-0000-4000-8000-000000000003"
        ]))
        .unwrap()
    }
    fn position() -> maka_agent_ports::session::history::RowPosition {
        maka_agent_ports::session::history::RowPosition::Live {
            sequence: 1,
            fact: serde_json::from_value(json!("00000000-0000-4000-8000-000000000004")).unwrap(),
            item_index: 0,
        }
    }
    fn preview_page(revision: u64, offset: u64, total_bytes: u64, text: &str) -> PreviewPage {
        PreviewPage::Cut {
            host_epoch: "epoch".into(),
            run_id: ids().0,
            turn_id: "turn".into(),
            step_id: ids().1,
            attempt_id: ids().2,
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
        let seed = crate::presentation::wire(&seed[0]).unwrap();
        assert_eq!(seed["sessionUpdate"], "agent_message");
        assert_eq!(seed["content"][0]["text"], "🦀中!");
        let suffix = projection.preview(&preview_page(2, 8, 9, "?")).unwrap();
        let suffix = crate::presentation::wire(&suffix[0]).unwrap();
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
    fn unfinished_canonical_message_fences_preview_until_complete_replacement() {
        let mut projection = Projection::default();
        let preview = projection.preview(&preview_page(1, 0, 5, "draft")).unwrap();
        assert_eq!(
            crate::presentation::wire(&preview[0]).unwrap()["content"][0]["text"],
            "draft"
        );
        let mut chunk = HistoryChunk {
            imported_turn: None,
            run_id: None,
            model_part: None,
            final_output: false,
            has_references: false,
            model: None,
            origin: None,
            compaction: None,
            attachments: Vec::new(),
            timing: None,
            field: HistoryField::Body,
            message_id: Some("message".into()),
            turn_id: Some("turn".into()),
            timestamp: Some(0),
            role: Role::Assistant,
            order: maka_agent_ports::session::history::HistoryOrder {
                path: vec![1],
                item_index: 0,
            },
            position: position(),
            offset: 0,
            total_bytes: 9,
            text: "can".into(),
            tool: None,
        };
        assert!(projection.chunk(&chunk).unwrap().is_empty());
        assert!(
            projection
                .preview(&preview_page(2, 5, 6, "!"))
                .unwrap()
                .is_empty()
        );
        chunk.offset = 3;
        chunk.text = "onical".into();
        let complete = projection.chunk(&chunk).unwrap();
        let complete = crate::presentation::wire(&complete[0]).unwrap();
        assert_eq!(complete["sessionUpdate"], "agent_message");
        assert_eq!(complete["messageId"], "message");
        assert_eq!(complete["content"][0]["text"], "canonical");
        assert!(
            projection
                .preview(&preview_page(3, 0, 5, "stale"))
                .unwrap()
                .is_empty()
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
        projection.commit_preview(ids().0, ids().1, ids().2, Some("message"));
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
        projection.commit_preview(ids().0, ids().1, ids().2, None);
        assert!(
            projection
                .preview(&preview_page(1, 0, 8, "🦀中!"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn unicode_stream_and_canonical_history_keep_the_same_message() {
        let mut projection = Projection::default();
        projection.append("t", "m", &ContentKind::Text, "🦀中");
        let update = projection.append("t", "m", &ContentKind::Text, "!");
        assert_eq!(
            crate::presentation::wire(&update[0]).unwrap()["content"]["text"],
            "!"
        );
        let mut chunk = HistoryChunk {
            imported_turn: None,
            run_id: None,
            model_part: None,
            final_output: false,
            has_references: false,
            model: None,
            origin: None,
            compaction: None,
            attachments: Vec::new(),
            timing: None,
            field: HistoryField::Body,
            message_id: Some("m".into()),
            turn_id: Some("t".into()),
            timestamp: Some(0),
            role: Role::Assistant,
            order: maka_agent_ports::session::history::HistoryOrder {
                path: vec![1],
                item_index: 0,
            },
            position: position(),
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
        let update = crate::presentation::wire(&projection.chunk(&chunk).unwrap()[0]).unwrap();
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
        let thinking = crate::presentation::wire(&projection.chunk(&chunk).unwrap()[0]).unwrap();
        assert_eq!(thinking["sessionUpdate"], "agent_thought");
        assert_eq!(thinking["content"][0]["text"], "Check");
        assert_eq!(thinking["_meta"]["maka"]["model"], expected);
    }
    #[test]
    fn missing_history_fragment_is_rejected() {
        let mut projection = Projection::default();
        let chunk = HistoryChunk {
            imported_turn: None,
            run_id: None,
            model_part: None,
            final_output: false,
            has_references: false,
            model: None,
            origin: None,
            compaction: None,
            attachments: Vec::new(),
            timing: None,
            field: HistoryField::Body,
            message_id: Some("m".into()),
            turn_id: Some("t".into()),
            timestamp: Some(0),
            role: Role::Assistant,
            order: maka_agent_ports::session::history::HistoryOrder {
                path: vec![1],
                item_index: 0,
            },
            position: position(),
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
            imported_turn: None,
            run_id: None,
            model_part: None,
            final_output: false,
            has_references: false,
            model: None,
            origin: Some(maka_agent_facts::message::MessageOrigin::Session {
                execution: maka_agent_facts::durable::ExecutionIdentity {
                    session_id: "source-session".into(),
                    turn_id: "source-turn".into(),
                    run_id: ids().0,
                },
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
            message_id: Some("u".into()),
            turn_id: Some("t".into()),
            timestamp: Some(0),
            role: Role::User,
            order: maka_agent_ports::session::history::HistoryOrder {
                path: vec![1],
                item_index: 0,
            },
            position: position(),
            offset: 0,
            total_bytes: 0,
            text: String::new(),
            tool: None,
        };
        let update = crate::presentation::wire(&projection.chunk(&chunk).unwrap()[0]).unwrap();
        assert_eq!(update["sessionUpdate"], "user_message");
        assert_eq!(
            update["_meta"]["maka"]["origin"],
            serde_json::json!({
                "kind": "session", "execution": {
                    "sessionId": "source-session", "turnId": "source-turn", "runId": ids().0
                }
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
            imported_turn: None,
            run_id: None,
            model_part: None,
            final_output: false,
            has_references: false,
            model: None,
            origin: None,
            compaction: None,
            attachments: Vec::new(),
            timing: None,
            field: HistoryField::Body,
            message_id: None,
            turn_id: None,
            timestamp: Some(0),
            role: Role::Failure,
            order: maka_agent_ports::session::history::HistoryOrder {
                path: vec![1],
                item_index: 0,
            },
            position: position(),
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
        let update = crate::presentation::wire(&updates[0]).unwrap();
        assert_eq!(update["sessionUpdate"], "agent_message");
        assert_eq!(update["content"][0]["text"], "Provider offline");
        assert_eq!(update["_meta"]["maka"]["role"], "failure");
        assert!(update["_meta"]["maka"].get("hostMessageId").is_none());
        assert!(update["_meta"]["maka"].get("turnId").is_none());
        assert_eq!(
            update["_meta"]["maka"]["historyPosition"],
            serde_json::to_value(position()).unwrap()
        );
        chunk.offset = 0;
        chunk.text = "Provider offline".into();
        assert!(projection.chunk(&chunk).unwrap().is_empty());
        chunk.role = Role::Compaction;
        chunk.text.clear();
        chunk.total_bytes = 0;
        assert!(projection.chunk(&chunk).unwrap().is_empty());
    }

    #[test]
    fn late_model_metadata_updates_the_accepted_body_without_replaying_it() {
        let mut projection = Projection::default();
        let mut chunk: HistoryChunk = serde_json::from_value(json!({
            "messageId":"accepted", "turnId":"turn", "timestamp":1,
            "order":{"path":[10],"itemIndex":0},
            "position":{"kind":"live","sequence":10,"fact":"00000000-0000-4000-8000-000000000004","itemIndex":0},
            "field":"body","role":"assistant","offset":0,"totalBytes":7,"text":"你好!",
            "modelPart":{"stepId":ids().1,"attemptId":ids().2,"ordinal":0},
            "model":{"kind":"native","requestedModelId":"alias","reportedModelId":null}
        }))
        .unwrap();
        projection.chunk(&chunk).unwrap();
        assert_eq!(
            projection.pending_model_positions(None),
            vec![(chunk.position.clone(), HistoryField::Body)]
        );
        chunk.text = "你".into();
        chunk.model = Some(maka_agent_ports::session::history::HistoryModel::Native {
            requested_model_id: "alias".into(),
            reported_model_id: Some("concrete".into()),
        });
        let update = projection.prepare_model_metadata(&chunk).unwrap().unwrap();
        let value = crate::presentation::wire(&update.update).unwrap();
        assert_eq!(value["messageId"], "accepted");
        assert_eq!(
            value["_meta"]["maka"]["model"]["reportedModelId"],
            "concrete"
        );
        assert!(value.get("content").is_none());
        assert!(projection.prepare_model_metadata(&chunk).unwrap().is_some());
        projection.commit_model_metadata(update);
        assert!(projection.prepare_model_metadata(&chunk).unwrap().is_none());
        projection.acknowledge_models(None);
        assert!(projection.pending_model_positions(None).is_empty());
    }
}
