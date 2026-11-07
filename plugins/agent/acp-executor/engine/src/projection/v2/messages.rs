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
    pub(super) async fn message(
        &mut self,
        id: String,
        content: MaybeUndefined<Vec<acp::ContentBlock>>,
        append: bool,
        thought: bool,
        sink: &dyn OutputSink,
    ) -> Result<(), Error> {
        identity(&id)?;
        if !self.messages.iter().any(|message| message.id == id) {
            emit(
                sink,
                Output::MessageStart {
                    message_id: id.clone(),
                },
            )
            .await?;
            self.messages.push(Message {
                id: id.clone(),
                thought,
                ..Default::default()
            });
        }
        let message = self
            .messages
            .iter_mut()
            .find(|message| message.id == id)
            .unwrap();
        if message.ended {
            return Err(Error::Invalid("ACP updated a completed message"));
        }
        if message.thought != thought {
            return Err(Error::Invalid("ACP message changed role"));
        }
        match content {
            MaybeUndefined::Undefined => {}
            MaybeUndefined::Null => message.text.clear(),
            MaybeUndefined::Value(content) => {
                let mut text = String::new();
                for block in content {
                    match block {
                        acp::ContentBlock::Text(block) => text.push_str(&block.text),
                        _ => {
                            return Err(Error::Invalid(
                                "ACP sent unsupported non-text message content",
                            ));
                        }
                    }
                }
                if append {
                    message.text.push_str(&text);
                } else {
                    message.text = text;
                }
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::super::tests::{Sink, update};
    use super::*;
    #[tokio::test]
    async fn stable_messages_replace_clear_append_and_preserve_arrival_order() {
        let sink = Sink::default();
        let mut projection = Projection::new("s".into(), "turn".into());
        for value in [
            serde_json::json!({"sessionUpdate":"agent_message_chunk", "messageId":"z", "content":{"type":"text","text":"obsolete"}}),
            serde_json::json!({"sessionUpdate":"agent_message", "messageId":"a", "content":[{"type":"text","text":"second"}]}),
            serde_json::json!({"sessionUpdate":"agent_message", "messageId":"z", "content":[{"type":"text","text":"first"}]}),
            serde_json::json!({"sessionUpdate":"agent_message", "messageId":"z"}),
            serde_json::json!({"sessionUpdate":"agent_message_chunk", "messageId":"z", "content":{"type":"text","text":"!"}}),
            serde_json::json!({"sessionUpdate":"agent_message", "messageId":"a", "content":null}),
        ] {
            update(&mut projection, &sink, value).await;
        }
        assert_eq!(projection.last_body_message_id(), None);
        assert_eq!(
            serde_json::to_value(&*sink.0.lock().unwrap()).unwrap(),
            serde_json::json!([
                {"type":"message_start", "messageId":"z"},
                {"type":"message_start", "messageId":"a"}
            ])
        );
        projection.finish(&sink, true).await.unwrap();
        assert_eq!(projection.last_body_message_id().as_deref(), Some("z"));
        assert_eq!(
            serde_json::to_value(&*sink.0.lock().unwrap()).unwrap(),
            serde_json::json!([
                {"type":"message_start", "messageId":"z"},
                {"type":"message_start", "messageId":"a"},
                {"type":"output_delta", "messageId":"z", "text":"first!"},
                {"type":"message_end", "messageId":"z"},
                {"type":"message_end", "messageId":"a"}
            ])
        );
    }
    #[tokio::test]
    async fn final_pointer_selects_last_body_native_id_and_reserves_seats_around_tools() {
        let sink = Sink::default();
        let mut projection = Projection::new("s".into(), "turn".into());
        for value in [
            serde_json::json!({"sessionUpdate":"agent_message", "messageId":"commentary", "content":[{"type":"text","text":"checking"}]}),
            serde_json::json!({"sessionUpdate":"tool_call_update", "toolCallId":"t", "name":"read", "status":"completed"}),
            serde_json::json!({"sessionUpdate":"agent_message", "messageId":"answer", "content":[{"type":"text","text":"final"}]}),
            serde_json::json!({"sessionUpdate":"agent_thought_chunk", "messageId":"thought", "content":{"type":"text","text":"done"}}),
        ] {
            update(&mut projection, &sink, value).await;
        }
        projection.finish(&sink, true).await.unwrap();
        projection.finish(&sink, true).await.unwrap();
        assert_eq!(projection.last_body_message_id().as_deref(), Some("answer"));
        let events: Vec<_> = sink
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|event| !matches!(event, Output::ToolProgress { .. }))
            .cloned()
            .collect();
        let mut events = serde_json::to_value(&events).unwrap();
        events[4]["text"] = serde_json::from_str(events[4]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            events,
            serde_json::json!([
                {"type":"message_start", "messageId":"commentary"},
                {"type":"tool_start", "toolCallId":"4:turn:t", "name":"read", "input":null},
                {"type":"message_start", "messageId":"answer"},
                {"type":"message_start", "messageId":"thought"},
                {"type":"tool_result", "toolCallId":"4:turn:t", "text":{"name":"read","status":"completed","toolCallId":"t"}, "isError":false},
                {"type":"output_delta", "messageId":"commentary", "text":"checking"},
                {"type":"message_end", "messageId":"commentary"},
                {"type":"output_delta", "messageId":"answer", "text":"final"},
                {"type":"message_end", "messageId":"answer"},
                {"type":"thinking_delta", "messageId":"thought", "text":"done"},
                {"type":"message_end", "messageId":"thought"}
            ])
        );
    }

    #[tokio::test]
    async fn unconfirmed_snapshots_are_not_completed_and_thought_only_has_no_final_body() {
        for confirmed in [false, true] {
            let sink = Sink::default();
            let mut projection = Projection::new("s".into(), "turn".into());
            projection.finish(&sink, confirmed).await.unwrap();
            assert_eq!(projection.last_body_message_id(), None);
            assert!(sink.0.lock().unwrap().is_empty());
            update(&mut projection, &sink, serde_json::json!({"sessionUpdate":"agent_thought", "messageId":"thought", "content":[{"type":"text","text":"thinking"}]})).await;
            projection.finish(&sink, confirmed).await.unwrap();
            assert_eq!(projection.last_body_message_id(), None);
            let events = sink.0.lock().unwrap();
            if confirmed {
                assert_eq!(
                    serde_json::to_value(&*events).unwrap(),
                    serde_json::json!([
                        {"type":"message_start", "messageId":"thought"},
                        {"type":"thinking_delta", "messageId":"thought", "text":"thinking"},
                        {"type":"message_end", "messageId":"thought"}
                    ])
                );
            } else {
                assert_eq!(
                    serde_json::to_value(&*events).unwrap(),
                    serde_json::json!([
                        {"type":"message_start", "messageId":"thought"}
                    ])
                );
            }
        }
    }
}
