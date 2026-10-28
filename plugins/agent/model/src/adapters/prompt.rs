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

//! Consume canonical projections into provider protocol input without a JSON bridge.
use crate::{ModelError, prompt as facts};
use maka_agent_facts::model::ToolInput;
use maka_provider_protocol::input as wire;
use serde_json::Value;

pub(super) fn extensions(value: Option<Value>) -> Result<wire::Extensions, ModelError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(value)) => Ok(Some(value.into_iter().collect())),
        _ => Err(ModelError::Adapter(
            "provider options must be an object".into(),
        )),
    }
}
pub(super) fn messages(messages: Vec<facts::Message>) -> Result<Vec<wire::Message>, ModelError> {
    messages
        .into_iter()
        .map(|message| {
            Ok(match message {
                facts::Message::System {
                    content,
                    provider_options,
                } => wire::Message::System {
                    text: content,
                    extensions: extensions(provider_options)?,
                },
                facts::Message::User {
                    content,
                    provider_options,
                } => wire::Message::User {
                    parts: content.into_iter().map(part).collect::<Result<_, _>>()?,
                    extensions: extensions(provider_options)?,
                },
                facts::Message::Assistant {
                    content,
                    provider_options,
                } => wire::Message::Assistant {
                    parts: content
                        .into_iter()
                        .map(assistant)
                        .collect::<Result<_, _>>()?,
                    extensions: extensions(provider_options)?,
                },
                facts::Message::Tool {
                    content,
                    provider_options,
                } => wire::Message::Tool {
                    results: content
                        .into_iter()
                        .map(|result| {
                            Ok(wire::ToolResult {
                                id: result.tool_call_id,
                                name: result.tool_name,
                                output: output(result.output)?,
                                extensions: extensions(result.provider_options)?,
                            })
                        })
                        .collect::<Result<_, ModelError>>()?,
                    extensions: extensions(provider_options)?,
                },
            })
        })
        .collect()
}
fn part(part: facts::ContentPart) -> Result<wire::UserPart, ModelError> {
    Ok(match part {
        facts::ContentPart::Text {
            text,
            provider_options,
        } => wire::UserPart::Text {
            text,
            extensions: extensions(provider_options)?,
        },
        facts::ContentPart::File {
            data: facts::FileData::Data(data),
            media_type,
            provider_options,
        } => wire::UserPart::File(wire::File {
            media_type,
            filename: None,
            source: wire::FileSource::Inline(wire::InlineData::Base64(data)),
            extensions: extensions(provider_options)?,
        }),
    })
}
fn assistant(part: facts::AssistantPart) -> Result<wire::AssistantPart, ModelError> {
    Ok(match part {
        facts::AssistantPart::Text {
            text,
            provider_options,
        } => wire::AssistantPart::Text {
            text,
            extensions: extensions(provider_options)?,
        },
        facts::AssistantPart::Reasoning {
            text,
            provider_options,
        } => wire::AssistantPart::Reasoning {
            text,
            extensions: extensions(provider_options)?,
        },
        facts::AssistantPart::ToolCall {
            tool_call_id,
            tool_name,
            input,
            provider_executed,
            provider_options,
        } => wire::AssistantPart::ToolCall(wire::ToolCall {
            id: tool_call_id,
            name: tool_name,
            input: match input {
                ToolInput::Json(value) => value,
                ToolInput::InvalidJson { .. } => serde_json::json!({}),
            },
            provider_executed: provider_executed.unwrap_or(false),
            extensions: extensions(provider_options)?,
        }),
        facts::AssistantPart::ToolResult {
            tool_call_id,
            tool_name,
            output: result,
            provider_options,
        } => wire::AssistantPart::ToolResult(wire::ToolResult {
            id: tool_call_id,
            name: tool_name,
            output: output(result)?,
            extensions: extensions(provider_options)?,
        }),
    })
}
fn output(output: facts::ToolOutput) -> Result<wire::ToolOutput, ModelError> {
    Ok(wire::ToolOutput {
        extensions: None,
        value: match output {
            facts::ToolOutput::Text(value) => wire::ToolValue::Text(value),
            facts::ToolOutput::Json(value) => wire::ToolValue::Json(value),
            facts::ToolOutput::ErrorText(value) => wire::ToolValue::ErrorText(value),
            facts::ToolOutput::ErrorJson(value) => wire::ToolValue::ErrorJson(value),
            facts::ToolOutput::Content(parts) => {
                wire::ToolValue::Content(parts.into_iter().map(part).collect::<Result<_, _>>()?)
            }
        },
    })
}
