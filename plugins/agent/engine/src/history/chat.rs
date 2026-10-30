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

use maka_agent_facts::language::Language;

use maka_model::prompt::{ContentPart, Message, ToolOutput, ToolResult};

/// Chat serializes tool content as text. Expose already materialized media in
/// a user message, after all responses in the tool batch have been delivered.
pub(crate) fn project(messages: Vec<Message>, language: Language) -> Vec<Message> {
    let mut state = Projection::new(language);
    let mut projected = Vec::new();
    for message in messages {
        projected.extend(state.push(message));
    }
    projected.extend(state.finish());
    projected
}

/// Cross-page state is only the media deferred until its tool batch closes.
/// Page boundaries never cause an extra user role or move media before a result.
pub(super) struct Projection {
    language: Language,
    images: Vec<ContentPart>,
}

impl Projection {
    pub(super) fn new(language: Language) -> Self {
        Self {
            language,
            images: Vec::new(),
        }
    }

    pub(super) fn push(&mut self, mut message: Message) -> Vec<Message> {
        let mut projected = Vec::new();
        if let Message::Tool { content, .. } = &mut message {
            for result in content {
                extract(result, &mut self.images, self.language);
            }
        } else {
            flush(&mut projected, &mut self.images);
        }
        projected.push(message);
        projected
    }

    pub(super) fn finish(&mut self) -> Vec<Message> {
        let mut projected = Vec::new();
        flush(&mut projected, &mut self.images);
        projected
    }
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

fn extract(result: &mut ToolResult, images: &mut Vec<ContentPart>, language: Language) {
    let ToolOutput::Content(parts) = &mut result.output else {
        return;
    };
    if !parts.iter().any(media) {
        return;
    }
    let kind = if parts.iter().any(|part| matches!(part, ContentPart::File { media_type, .. } if media_type.starts_with("audio/"))) { "Media" } else { "Images" };
    images.push(ContentPart::text(match language {
        Language::En => format!(
            "{kind} from tool {} (toolCallId: {}):",
            label(&result.tool_name),
            label(&result.tool_call_id)
        ),
        Language::ZhCn => format!(
            "工具 {} 提供的{}（toolCallId: {}）：",
            label(&result.tool_name),
            if kind == "Images" { "图片" } else { "媒体" },
            label(&result.tool_call_id)
        ),
        Language::ZhTw => format!(
            "工具 {} 提供的{}（toolCallId: {}）：",
            label(&result.tool_name),
            if kind == "Images" { "圖片" } else { "媒體" },
            label(&result.tool_call_id)
        ),
    }));
    let mut retained = Vec::new();
    for part in std::mem::take(parts) {
        if media(&part) {
            images.push(part);
        } else {
            retained.push(part);
        }
    }
    if retained.is_empty() {
        retained.push(ContentPart::text(match language {
            Language::En => format!(
                "Tool {} are supplied in the following user message.",
                kind.to_ascii_lowercase()
            ),
            Language::ZhCn => format!(
                "工具{}见下一条用户消息。",
                if kind == "Images" { "图片" } else { "媒体" }
            ),
            Language::ZhTw => format!(
                "工具{}見下一則使用者訊息。",
                if kind == "Images" { "圖片" } else { "媒體" }
            ),
        }));
    }
    *parts = retained;
}
