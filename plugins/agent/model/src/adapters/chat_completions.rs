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
