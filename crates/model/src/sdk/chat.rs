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

/// Chat has text-only tool messages. Keep the entire result group together and
/// carry media in the following user message, never between parallel results.
pub(super) fn project(messages: Vec<Message>) -> Vec<Message> {
    let mut projected = Vec::with_capacity(messages.len());
    let mut images = Vec::new();
    for mut message in messages {
        if let Message::Tool { content, .. } = &mut message {
            for result in content {
                let ToolOutput::Content(parts) = &mut result.output else {
                    continue;
                };
                let mut labelled = false;
                for part in parts {
                    if matches!(part, ContentPart::File { media_type, .. } if media_type.starts_with("image/") || media_type.starts_with("audio/"))
                    {
                        let kind = if matches!(part, ContentPart::File { media_type, .. } if media_type.starts_with("audio/"))
                        {
                            "Audio"
                        } else {
                            "Image"
                        };
                        if !labelled {
                            images.push(ContentPart::text(format!(
                                "{kind} from tool {} ({}):",
                                result.tool_name, result.tool_call_id
                            )));
                            labelled = true;
                        }
                        images.push(std::mem::replace(
                            part,
                            ContentPart::text(format!("{kind} supplied below.")),
                        ));
                    }
                }
            }
        } else if !images.is_empty() {
            projected.push(Message::User {
                content: std::mem::take(&mut images),
                provider_options: None,
            });
        }
        projected.push(message);
    }
    if !images.is_empty() {
        projected.push(Message::User {
            content: images,
            provider_options: None,
        });
    }
    projected
}
