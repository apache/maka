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

// Messages has no audio content type. Chat Completions supports WAV/MP3.
// Preserve an explicit observation instead of dropping media or fabricating bytes.
pub(super) fn audio_fallback(
    messages: &mut [crate::prompt::Message],
    language: maka_agent_facts::language::Language,
    anthropic: bool,
) {
    use crate::prompt::{ContentPart, FileData, Message, ToolOutput};
    use maka_agent_facts::language::Language;
    fn project(parts: &mut [ContentPart], language: Language, anthropic: bool) {
        for part in parts {
            if let ContentPart::File {
                media_type,
                data: FileData::Data(data),
                ..
            } = part
                && media_type.starts_with("audio/")
                && (anthropic
                    || !matches!(
                        media_type.as_str(),
                        "audio/wav" | "audio/mpeg" | "audio/mp3"
                    ))
            {
                let length = data.len();
                *part = ContentPart::text(match language {
                    Language::En => format!(
                        "Audio input ({media_type}, {length} base64 characters) is not supported by this model adapter. The audio remains in the tool evidence."
                    ),
                    Language::ZhCn => format!(
                        "此模型适配器不支持音频输入（{media_type}，{length} 个 base64 字符）。音频仍保留在工具证据中。"
                    ),
                    Language::ZhTw => format!(
                        "此模型介接器不支援音訊輸入（{media_type}，{length} 個 base64 字元）。音訊仍保留在工具證據中。"
                    ),
                });
            }
        }
    }
    for message in messages {
        match message {
            Message::User { content, .. } => project(content, language, anthropic),
            Message::Tool { content, .. } => {
                for result in content {
                    if let ToolOutput::Content(parts) = &mut result.output {
                        project(parts, language, anthropic);
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod language_tests {
    use super::*;
    use crate::prompt::{ContentPart, FileData, Message};
    use maka_agent_facts::language::Language;

    #[test]
    fn unsupported_audio_reports_original_metadata_in_captured_language() {
        for (language, expected) in [
            (
                Language::ZhCn,
                "不支持音频输入（audio/ogg，8 个 base64 字符）",
            ),
            (
                Language::ZhTw,
                "不支援音訊輸入（audio/ogg，8 個 base64 字元）",
            ),
        ] {
            let mut messages = vec![Message::User {
                content: vec![
                    ContentPart::text("Original user 原文"),
                    ContentPart::File {
                        data: FileData::Data("YXVkaW8=".into()),
                        media_type: "audio/ogg".into(),
                        provider_options: None,
                    },
                ],
                provider_options: None,
            }];
            audio_fallback(&mut messages, language, false);
            let Message::User { content, .. } = &messages[0] else {
                panic!("user message")
            };
            assert_eq!(content[0], ContentPart::text("Original user 原文"));
            let ContentPart::Text { text, .. } = &content[1] else {
                panic!("unsupported audio observation")
            };
            assert!(text.contains(expected));
        }
    }
}
