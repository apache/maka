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

use maka_model::prompt::{ContentPart, Message, ToolOutput, ToolResult};

/// Chat serializes tool content as text. Expose already materialized media in
/// a user message, after all responses in the tool batch have been delivered.
pub(crate) fn project(messages: Vec<Message>) -> Vec<Message> {
    let mut projected = Vec::with_capacity(messages.len());
    let mut images = Vec::new();
    for mut message in messages {
        if let Message::Tool { content, .. } = &mut message {
            for result in content {
                extract(result, &mut images);
            }
        } else {
            flush(&mut projected, &mut images);
        }
        projected.push(message);
    }
    flush(&mut projected, &mut images);
    projected
}

fn flush(messages: &mut Vec<Message>, images: &mut Vec<ContentPart>) {
    if !images.is_empty() {
        messages.push(Message::User {
            content: std::mem::take(images),
            provider_options: None,
        });
    }
}

fn media(part: &ContentPart) -> bool {
    matches!(part, ContentPart::File { media_type, .. } if media_type.starts_with("image/") || media_type.starts_with("audio/"))
}

fn label(value: &str) -> String {
    value.chars().take(128).collect()
}

fn extract(result: &mut ToolResult, images: &mut Vec<ContentPart>) {
    let ToolOutput::Content(parts) = &mut result.output else {
        return;
    };
    if !parts.iter().any(media) {
        return;
    }
    let kind = if parts.iter().any(|part| matches!(part, ContentPart::File { media_type, .. } if media_type.starts_with("audio/"))) { "Media" } else { "Images" };
    images.push(ContentPart::text(format!(
        "{kind} from tool {} (toolCallId: {}):",
        label(&result.tool_name),
        label(&result.tool_call_id)
    )));
    let mut retained = Vec::new();
    for part in std::mem::take(parts) {
        if media(&part) {
            images.push(part);
        } else {
            retained.push(part);
        }
    }
    if retained.is_empty() {
        retained.push(ContentPart::text(format!(
            "Tool {} are supplied in the following user message.",
            kind.to_ascii_lowercase()
        )));
    }
    *parts = retained;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn result(id: &str, parts: Value) -> Value {
        json!({"type":"tool-result","toolCallId":id,"toolName":format!("tool-{id}"),
            "providerOptions":{"openai":{"test":"result"}},
            "output":{"type":"content","value":parts}})
    }

    fn file(data: &str) -> Value {
        json!({"type":"file","mediaType":"image/png",
            "data":{"type":"data","data":data},
            "providerOptions":{"openai":{"imageDetail":"low"}}})
    }

    #[test]
    fn images_follow_complete_tool_batch_and_keep_metadata() {
        let first = result(
            "one",
            json!([
                {"type":"text","text":"before"}, file("first-image"),
                {"type":"file","mediaType":"application/pdf","data":{"type":"data","data":"pdf"}},
                {"type":"text","text":"after"}
            ]),
        );
        let second = result("two", json!([file("second-image")]));
        let messages = vec![
            json!({"role":"assistant","content":[
                {"type":"tool-call","toolCallId":"one","toolName":"tool-one","input":{}},
                {"type":"tool-call","toolCallId":"two","toolName":"tool-two","input":{}}
            ]}),
            json!({"role":"tool","providerOptions":{"test":"message"},"content":[first]}),
            json!({"role":"tool","content":[second]}),
            json!({"role":"assistant","content":[
                {"type":"tool-call","toolCallId":"three","toolName":"tool-three","input":{}},
                {"type":"tool-call","toolCallId":"four","toolName":"tool-four","input":{}}
            ]}),
            json!({"role":"tool","content":[
                result("three", json!([file("third-image")])),
                result("four", json!([file("fourth-image")]))
            ]}),
        ];
        let projected =
            serde_json::to_value(project(serde_json::from_value(json!(messages)).unwrap()))
                .unwrap();
        assert_eq!(projected.as_array().unwrap().len(), 7);
        assert_eq!(projected[1]["role"], "tool");
        assert_eq!(projected[2]["role"], "tool");
        assert_eq!(projected[3]["role"], "user");
        assert_eq!(projected[4]["role"], "assistant");
        assert_eq!(projected[1]["providerOptions"], json!({"test":"message"}));
        for (index, id) in [(1, "one"), (2, "two")] {
            assert_eq!(projected[index]["content"][0]["toolCallId"], id);
            assert_eq!(
                projected[index]["content"][0]["providerOptions"],
                json!({"openai":{"test":"result"}})
            );
        }
        assert_eq!(
            projected[1]["content"][0]["output"]["value"],
            json!([
                {"type":"text","text":"before"},
                {"type":"file","mediaType":"application/pdf","data":{"type":"data","data":"pdf"}},
                {"type":"text","text":"after"}
            ])
        );
        assert_eq!(
            projected[2]["content"][0]["output"]["value"][0]["type"],
            "text"
        );
        assert_eq!(
            projected[3]["content"],
            json!([
                {"type":"text","text":"Images from tool tool-one (toolCallId: one):"}, file("first-image"),
                {"type":"text","text":"Images from tool tool-two (toolCallId: two):"}, file("second-image")
            ])
        );
        assert_eq!(projected[5]["role"], "tool");
        assert_eq!(projected[6]["role"], "user");
        assert_eq!(
            projected[6]["content"],
            json!([
                {"type":"text","text":"Images from tool tool-three (toolCallId: three):"}, file("third-image"),
                {"type":"text","text":"Images from tool tool-four (toolCallId: four):"}, file("fourth-image")
            ])
        );
        let encoded = serde_json::to_string(&projected).unwrap();
        for data in ["first-image", "second-image", "third-image", "fourth-image"] {
            assert_eq!(encoded.matches(data).count(), 1);
        }
    }

    #[test]
    fn opaque_json_and_unrelated_messages_are_unchanged() {
        let messages = vec![
            json!({"role":"user","content":[file("user-image")]}),
            json!({"role":"tool","content":[{
                "type":"tool-result","toolCallId":"opaque","toolName":"tool",
                "output":{"type":"json","value":{"kind":"image","parts":[file("opaque")]}}
            }, result("text", json!([{"type":"text","text":"plain"}]))]}),
        ];
        assert_eq!(
            serde_json::to_value(project(serde_json::from_value(json!(messages)).unwrap()))
                .unwrap(),
            json!(messages)
        );
    }
}
