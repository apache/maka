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

use super::{Error, Result};
use maka_agent_facts::{
    language::Language,
    model::{
        PlaintextReasoningReplay, PlaintextResponses, ToolInput,
        prompt::{AssistantPart, ContentPart, FileData, Message, ToolOutput},
    },
    tools::ToolDefinition,
};
use maka_provider_protocol::responses::{
    self as wire, ItemMetadata, ReasoningMode, Replay,
    request::{Content, Input, Reasoning, SearchKind, Tool},
};
use serde_json::{Value, json};

/// Canonical projection for Responses. Network state belongs to the session.
pub struct Request<'a> {
    pub language: Language,
    pub model: &'a str,
    pub prompt: &'a [Message],
    pub tools: &'a [ToolDefinition],
    pub options: &'a Value,
    pub max_output_tokens: Option<u64>,
    pub plaintext: Option<PlaintextResponses>,
}

pub(super) fn reasoning_mode(plaintext: Option<PlaintextResponses>) -> ReasoningMode {
    match plaintext.map(|contract| contract.reasoning_replay) {
        None => ReasoningMode::Encrypted,
        Some(PlaintextReasoningReplay::PlaintextContent) => ReasoningMode::PlaintextContent,
        Some(PlaintextReasoningReplay::PlaintextSummary) => ReasoningMode::PlaintextSummary,
    }
}
fn namespace(plaintext: Option<PlaintextResponses>) -> &'static str {
    if plaintext.is_some() {
        "openResponses"
    } else {
        "openai"
    }
}
pub fn wire_name(name: &str) -> &str {
    if name == "tool_search" {
        "maka_tool_search"
    } else {
        name
    }
}
pub fn local_name(name: &str) -> &str {
    if name == "maka_tool_search" {
        "tool_search"
    } else {
        name
    }
}
fn field(options: &Option<Value>, namespace: &str, key: &str) -> Option<String> {
    options.as_ref()?[namespace][key]
        .as_str()
        .map(str::to_owned)
}
fn replay(options: &Option<Value>) -> Result<Option<Replay>> {
    options
        .as_ref()
        .and_then(|options| options["openai"].get("responsesReplay"))
        .map(|value| Replay::from_value(value.clone()).map_err(Error::from))
        .transpose()
}
fn item_metadata(options: &Option<Value>, namespace: &str) -> Result<Option<ItemMetadata>> {
    let id = field(options, namespace, "itemId");
    let replay = replay(options)?;
    let encrypted_content = field(options, namespace, "reasoningEncryptedContent");
    Ok(
        (id.is_some() || replay.is_some() || encrypted_content.is_some()).then(|| ItemMetadata {
            id: id.unwrap_or_default(),
            replay,
            encrypted_content,
        }),
    )
}
fn content(part: &ContentPart) -> Result<Content> {
    Ok(match part {
        ContentPart::Text { text, .. } => Content::Text(text.clone()),
        ContentPart::File {
            data: FileData::Data(data),
            media_type,
            provider_options,
        } => {
            let url = format!("data:{media_type};base64,{data}");
            if media_type.starts_with("image/") {
                Content::Image {
                    url,
                    detail: provider_options
                        .as_ref()
                        .and_then(|options| options["openai"]["imageDetail"].as_str())
                        .unwrap_or("auto")
                        .into(),
                }
            } else if media_type.starts_with("audio/") {
                Content::Audio { url }
            } else if media_type == "application/pdf" {
                Content::File {
                    data: url,
                    filename: "document.pdf".into(),
                }
            } else {
                return Err(Error::Invalid(format!(
                    "Responses does not support file media type {media_type}"
                )));
            }
        }
    })
}
fn output(value: &ToolOutput) -> Result<wire::request::ToolOutput> {
    Ok(match value {
        ToolOutput::Text(text) | ToolOutput::ErrorText(text) => {
            wire::request::ToolOutput::Text(text.clone())
        }
        ToolOutput::Json(value) | ToolOutput::ErrorJson(value) => {
            wire::request::ToolOutput::Text(value.to_string())
        }
        ToolOutput::Content(parts) => {
            wire::request::ToolOutput::Content(parts.iter().map(content).collect::<Result<_>>()?)
        }
    })
}
fn project(
    message: &Message,
    language: Language,
    plaintext: Option<PlaintextResponses>,
    options: &Value,
) -> Result<Vec<Input>> {
    let mut input = Vec::new();
    let namespace = namespace(plaintext);
    match message {
        Message::System { content, .. } => input.push(Input::System(content.clone())),
        Message::User { content: parts, .. } => input.push(Input::User(
            parts.iter().map(content).collect::<Result<_>>()?,
        )),
        Message::Assistant { content, .. } => {
            for part in content {
                match part {
                    AssistantPart::Text {
                        text,
                        provider_options,
                    } => input.push(Input::AssistantText {
                        text: text.clone(),
                        replay: if plaintext.is_none() {
                            replay(provider_options)?
                        } else {
                            None
                        },
                    }),
                    AssistantPart::Reasoning {
                        text,
                        provider_options,
                    } => input.push(Input::Reasoning(Reasoning {
                        text: text.clone(),
                        item_id: field(provider_options, namespace, "itemId"),
                        encrypted_content: field(
                            provider_options,
                            namespace,
                            "reasoningEncryptedContent",
                        ),
                        summary: provider_options
                            .as_ref()
                            .and_then(|options| options[namespace]["reasoningSummary"].as_array())
                            .cloned(),
                        replay: if plaintext.is_none() {
                            replay(provider_options)?
                        } else {
                            None
                        },
                    })),
                    AssistantPart::ToolCall {
                        tool_call_id,
                        tool_name,
                        input: arguments,
                        provider_executed,
                        provider_options,
                    } => {
                        let custom = matches!(arguments, ToolInput::Json(Value::String(_)))
                            && (field(provider_options, "openai", "toolKind").as_deref()
                                == Some("custom")
                                || field(provider_options, "openResponses", "toolKind").as_deref()
                                    == Some("custom"));
                        let arguments = match arguments {
                            ToolInput::Json(Value::String(source))
                                if custom && plaintext.is_none() =>
                            {
                                wire::ToolInput::Custom(source.clone())
                            }
                            ToolInput::Json(Value::String(source))
                                if custom && tool_name == "exec" =>
                            {
                                wire::ToolInput::Function(json!({"code":source}).to_string())
                            }
                            ToolInput::Json(value) => wire::ToolInput::Function(value.to_string()),
                            ToolInput::InvalidJson { raw } => {
                                wire::ToolInput::Function(raw.clone())
                            }
                        };
                        input.push(Input::ToolCall {
                            id: tool_call_id.clone(),
                            name: wire_name(tool_name).into(),
                            input: arguments,
                            provider_executed: *provider_executed == Some(true),
                            metadata: if *provider_executed == Some(true) {
                                field(provider_options, namespace, "itemId").map(|id| {
                                    ItemMetadata {
                                        id,
                                        replay: None,
                                        encrypted_content: None,
                                    }
                                })
                            } else if plaintext.is_none() {
                                item_metadata(provider_options, namespace)?
                            } else {
                                None
                            },
                        });
                    }
                    AssistantPart::ToolResult {
                        provider_options,
                        output,
                        ..
                    } => {
                        if plaintext.is_none() && options[namespace]["store"] == false {
                            let replay = replay(provider_options)?;
                            let action = match output {
                                ToolOutput::Json(value) | ToolOutput::ErrorJson(value) => {
                                    value["action"].clone()
                                }
                                _ if replay.is_none() => Value::Null,
                                _ => {
                                    return Err(Error::Invalid(
                                        "accepted Responses provider result is not JSON".into(),
                                    ));
                                }
                            };
                            input.push(Input::ProviderResult { replay, action });
                        }
                    }
                }
            }
        }
        Message::Tool { content, .. } => {
            for result in content {
                let custom = result.is_custom();
                if result.is_notification() && (plaintext.is_some() || !custom) {
                    if let ToolOutput::Text(text) = &result.output {
                        let id = &result.tool_call_id;
                        let text = match language {
                            Language::En => format!("[Notification from exec {id}]\n{text}"),
                            Language::ZhCn => format!("[来自 exec {id} 的通知]\n{text}"),
                            Language::ZhTw => format!("[來自 exec {id} 的通知]\n{text}"),
                        };
                        input.push(Input::User(vec![Content::Text(text)]));
                    }
                    continue;
                }
                input.push(Input::ToolOutput {
                    id: result.tool_call_id.clone(),
                    custom,
                    output: output(&result.output)?,
                });
            }
        }
    }
    Ok(input)
}
fn tool(tool: &ToolDefinition, plaintext: bool) -> Result<Tool> {
    if let Some(provider) = &tool.provider {
        let kind = match provider.id.as_str() {
            "openai.web_search" => SearchKind::Search,
            "openai.web_search_preview" => SearchKind::Preview,
            id if !id.starts_with("openai.") => {
                return Err(Error::Invalid(
                    "Responses provider tool belongs to another protocol".into(),
                ));
            }
            id => {
                return Err(Error::Invalid(format!(
                    "Unsupported provider-executed tool: {id}"
                )));
            }
        };
        Ok(Tool::WebSearch {
            kind,
            args: provider.args.clone(),
        })
    } else if !plaintext && let Some(format) = &tool.freeform {
        let format =
            serde_json::to_value(format).map_err(|error| Error::Invalid(error.to_string()))?;
        Ok(Tool::Custom {
            name: wire_name(&tool.name).into(),
            description: tool.description.clone(),
            format,
        })
    } else {
        Ok(Tool::Function {
            name: wire_name(&tool.name).into(),
            description: tool.description.clone(),
            parameters: tool.input_schema.clone(),
        })
    }
}
impl Request<'_> {
    pub fn encode(&self) -> Result<Value> {
        let input = self
            .prompt
            .iter()
            .map(|message| project(message, self.language, self.plaintext, self.options))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let tools = self
            .tools
            .iter()
            .map(|definition| tool(definition, self.plaintext.is_some()))
            .collect::<Result<Vec<_>>>()?;
        let mut body = wire::request::Request {
            model: self.model,
            input: &input,
            tools: &tools,
            options: self.options,
            max_output_tokens: self.max_output_tokens,
            reasoning: reasoning_mode(self.plaintext),
        }
        .encode()
        .map_err(Error::from)?;
        if self
            .plaintext
            .is_some_and(|contract| contract.compatibility.is_some())
        {
            body["store"] = Value::Bool(false);
        }
        Ok(body)
    }
}

/// Encode exactly one captured semantic message without retaining the envelope.
pub fn encode_message(
    message: &Message,
    language: Language,
    plaintext: Option<PlaintextResponses>,
    options: &Value,
) -> Result<Vec<Value>> {
    wire::request::encode_input(
        &project(message, language, plaintext, options)?,
        reasoning_mode(plaintext),
        options,
    )
    .map_err(Error::from)
}

/// Fingerprint frozen language, reasoning and effective reference policy.
pub fn wire_codec(
    language: Language,
    plaintext: Option<PlaintextResponses>,
    options: &Value,
) -> String {
    json!({"responses":1,"language":language,"plaintext":plaintext,"store":options[namespace(plaintext)]["store"] != false}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::language::Language;

    #[test]
    fn notification_adaptation_keeps_worker_text_and_call_identity() {
        let messages = [Message::notification("task-原文", "Result: unchanged 結果")];
        for (language, expected) in [
            (
                Language::ZhCn,
                "[来自 exec task-原文 的通知]\nResult: unchanged 結果",
            ),
            (
                Language::ZhTw,
                "[來自 exec task-原文 的通知]\nResult: unchanged 結果",
            ),
        ] {
            let encoded = Request {
                language,
                model: "fixture",
                prompt: &messages,
                tools: &[],
                options: &json!({}),
                max_output_tokens: None,
                plaintext: None,
            }
            .encode()
            .unwrap();
            assert_eq!(encoded["input"][0]["content"][0]["text"], expected);
            assert_eq!(encoded.get("language"), None);
        }
    }

    #[test]
    fn ignored_replay_metadata_is_not_parsed_for_references_or_plaintext() {
        let message = Message::Assistant {
            content: vec![AssistantPart::ToolCall {
                tool_call_id: "call".into(),
                tool_name: "exec".into(),
                input: ToolInput::Json(json!({"code":"1"})),
                provider_executed: Some(true),
                provider_options: Some(json!({"openai":{"itemId":"item","responsesReplay":false}})),
            }],
            provider_options: None,
        };
        assert_eq!(
            encode_message(&message, Language::En, None, &json!({})).unwrap(),
            vec![json!({"type":"item_reference","id":"item"})]
        );
        let message = Message::Assistant {
            content: vec![AssistantPart::ToolResult {
                tool_call_id: "call".into(),
                tool_name: "search".into(),
                output: ToolOutput::Text("ignored while stored".into()),
                provider_options: Some(json!({"openai":{"responsesReplay":false}})),
            }],
            provider_options: None,
        };
        assert!(
            encode_message(&message, Language::En, None, &json!({}))
                .unwrap()
                .is_empty()
        );
        assert!(
            encode_message(
                &message,
                Language::En,
                None,
                &json!({"openai":{"store":false}})
            )
            .is_err()
        );
        let message = Message::Assistant {
            content: vec![AssistantPart::ToolCall {
                tool_call_id: "call".into(),
                tool_name: "read".into(),
                input: ToolInput::Json(json!({})),
                provider_executed: None,
                provider_options: Some(json!({"openai":{"responsesReplay":false}})),
            }],
            provider_options: None,
        };
        let plaintext = PlaintextResponses {
            reasoning_replay: PlaintextReasoningReplay::PlaintextContent,
            compatibility: None,
        };
        assert_eq!(
            encode_message(&message, Language::En, Some(plaintext), &json!({})).unwrap(),
            vec![json!({"type":"function_call","call_id":"call","name":"read","arguments":"{}"})]
        );
    }
}
