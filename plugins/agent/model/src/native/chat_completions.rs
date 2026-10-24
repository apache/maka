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

use crate::prompt::{ContentPart, Message, ToolOutput};
use maka_agent_facts::language::Language;

/// Chat has text-only tool messages. Keep the entire result group together and
/// carry media in the following user message, never between parallel results.
#[cfg(test)]
pub(super) fn project(messages: Vec<Message>, language: Language) -> Vec<Message> {
    let mut projector = Projector::new(language);
    let mut projected = Vec::new();
    for message in messages {
        projected.extend(projector.push(message));
    }
    projected.extend(projector.finish());
    projected
}

/// Carries only the pending tool media across consecutive result messages.
/// The request encoder drains each returned message before reading more history.
pub(super) struct Projector {
    language: Language,
    images: Vec<ContentPart>,
}

impl Projector {
    pub(super) fn new(language: Language) -> Self {
        Self {
            language,
            images: Vec::new(),
        }
    }

    pub(super) fn push(&mut self, mut message: Message) -> Vec<Message> {
        let language = self.language;
        let mut projected = Vec::new();
        if let Message::Tool { content, .. } = &mut message {
            for result in content {
                let ToolOutput::Content(parts) = &mut result.output else {
                    continue;
                };
                let mut labelled = false;
                for part in parts {
                    if matches!(part, ContentPart::File { media_type, .. } if media_type.starts_with("image/") || media_type.starts_with("audio/"))
                    {
                        let audio = matches!(part, ContentPart::File { media_type, .. } if media_type.starts_with("audio/"));
                        let kind = match (language, audio) {
                            (Language::En, true) => "Audio",
                            (Language::En, false) => "Image",
                            (Language::ZhCn, true) => "音频",
                            (Language::ZhCn, false) => "图像",
                            (Language::ZhTw, true) => "音訊",
                            (Language::ZhTw, false) => "影像",
                        };
                        if !labelled {
                            let name = &result.tool_name;
                            let id = &result.tool_call_id;
                            self.images.push(ContentPart::text(match language {
                                Language::En => format!("{kind} from tool {name} ({id}):"),
                                Language::ZhCn => format!("来自工具 {name}（{id}）的{kind}："),
                                Language::ZhTw => format!("來自工具 {name}（{id}）的{kind}："),
                            }));
                            labelled = true;
                        }
                        self.images.push(std::mem::replace(
                            part,
                            ContentPart::text(match language {
                                Language::En => format!("{kind} supplied below."),
                                Language::ZhCn => format!("{kind}见下方。"),
                                Language::ZhTw => format!("{kind}見下方。"),
                            }),
                        ));
                    }
                }
            }
        } else {
            projected.extend(self.take_media());
        }
        projected.push(message);
        projected
    }

    fn take_media(&mut self) -> Option<Message> {
        (!self.images.is_empty()).then(|| Message::User {
            content: std::mem::take(&mut self.images),
            provider_options: None,
        })
    }

    pub(super) fn finish(mut self) -> Option<Message> {
        self.take_media()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::FileData;

    #[test]
    fn tool_media_projection_uses_captured_language_and_keeps_payload() {
        let media = ContentPart::File {
            data: FileData::Data("aW1hZ2U=".into()),
            media_type: "image/png".into(),
            provider_options: None,
        };
        for (language, expected) in [
            (Language::ZhCn, "来自工具 read（call-原文）的图像："),
            (Language::ZhTw, "來自工具 read（call-原文）的影像："),
        ] {
            let messages = project(
                vec![Message::tool(
                    "call-原文",
                    "read",
                    ToolOutput::Content(vec![ContentPart::text("Tool result 原文"), media.clone()]),
                )],
                language,
            );
            let Message::User { content, .. } = &messages[1] else {
                panic!("media user message")
            };
            assert_eq!(content, &[ContentPart::text(expected), media.clone()]);
            let Message::Tool { content, .. } = &messages[0] else {
                panic!("settled tool result")
            };
            let ToolOutput::Content(parts) = &content[0].output else {
                panic!("tool content")
            };
            assert_eq!(parts[0], ContentPart::text("Tool result 原文"));
            assert_eq!(content[0].tool_call_id, "call-原文");
        }
    }
}
