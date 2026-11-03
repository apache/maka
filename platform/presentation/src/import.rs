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

use crate::{Content, Hidden, Message, ProjectionError, Thinking, ToolContent, ToolMetadata};
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::import;
use serde_json::json;

pub(super) fn project(
    event: &RuntimeEvent,
    record: &import::Record,
    ts: u64,
) -> Result<Vec<Message>, ProjectionError> {
    record.validate().map_err(ProjectionError::Invalid)?;
    let make = |id, content| Message {
        id,
        turn_id: event.invocation.turn_id.clone(),
        ts: record.timestamp.unwrap_or(ts),
        content,
    };
    let content = match &record.content {
        import::Content::User { text } => Content::User {
            origin: None,
            text: text.clone(),
            imported: true,
            display_text: None,
            attachments: None,
            quotes: None,
            directory_references: None,
            inline_references: None,
        },
        import::Content::Assistant {
            text,
            model,
            thinking,
        } => Content::Assistant {
            text: text.clone(),
            imported: true,
            model_id: model.clone().unwrap_or_default(),
            interrupted: false,
            thinking: thinking.as_ref().map(|text| Thinking {
                text: text.clone(),
                provider_options: None,
            }),
            provider_options: None,
        },
        import::Content::Note { text } => Content::SystemNote {
            kind: crate::message::ImportedNoteKind::Imported,
            data: crate::message::ImportedNote { text: text.clone() },
        },
        import::Content::ToolCall {
            call_id,
            name,
            input,
        } => {
            return Ok(vec![make(
                import::tool_call_id(&event.invocation.session_id, call_id),
                Content::ToolCall {
                    tool_name: name.clone(),
                    args: input.clone().unwrap_or_else(|| json!({})),
                    step_id: None,
                    provider_options: None,
                    provider_executed: None,
                    metadata: ToolMetadata::Imported {
                        model_visibility: Hidden::Hidden,
                    },
                },
            )]);
        }
        import::Content::ToolResult {
            call_id,
            output,
            is_error,
        } => Content::ToolResult {
            settlement: None,
            tool_use_id: import::tool_call_id(&event.invocation.session_id, call_id),
            is_error: *is_error,
            content: ToolContent::Json {
                value: output.clone(),
            },
            images: Vec::new(),
            metadata: ToolMetadata::Imported {
                model_visibility: Hidden::Hidden,
            },
        },
    };
    Ok(vec![make(event.id.clone(), content)])
}
