// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements. See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership. The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License. You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

use super::*;
impl Projection {
    pub(super) fn message(
        &mut self,
        id: String,
        content: MaybeUndefined<Vec<acp::ContentBlock>>,
        append: bool,
        thought: bool,
    ) -> Result<(), Error> {
        identity(&id)?;
        if !self.messages.iter().any(|message| message.id == id) {
            if self.messages.len() >= 1024 {
                return Err(Error::Invalid("ACP turn exceeds 1024 messages"));
            }
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
        if self
            .messages
            .iter()
            .map(|message| message.text.len())
            .sum::<usize>()
            > 1024 * 1024 - 64
        {
            return Err(Error::Invalid("ACP message output exceeds 1 MiB"));
        }
        if serde_json::to_vec(&self.text())?.len() > 1024 * 1024 - 64 {
            return Err(Error::Invalid("ACP final output exceeds 1 MiB"));
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
        assert_eq!(projection.text(), "first!");
        assert!(sink.0.lock().unwrap().is_empty());
        projection.finish(&sink, true).await.unwrap();
        assert!(
            matches!(&sink.0.lock().unwrap()[0], Output::OutputDelta {text} if text == "first!")
        );
    }
}
