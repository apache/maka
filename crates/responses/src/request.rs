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

use crate::{Error, Result};
use maka_runtime::{
    model::{
        PlaintextReasoningReplay, PlaintextResponses,
        prompt::{AssistantPart, ContentPart, FileData, Message, ToolOutput},
    },
    tools::ToolDefinition,
};
use serde::Serialize;
use serde_json::{Value, json};

/// Protocol input only. Credential resolution and history ownership remain with Host.
pub struct Request<'a> {
    pub model: &'a str,
    pub prompt: &'a [Message],
    pub tools: &'a [ToolDefinition],
    pub options: &'a Value,
    pub max_output_tokens: Option<u64>,
    pub plaintext: Option<PlaintextResponses>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Input {
    System {
        role: &'static str,
        content: String,
    },
    Message {
        role: &'static str,
        content: Vec<Content>,
    },
    Item(Item),
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Content {
    InputText { text: String },
    OutputText { text: String },
    InputImage { image_url: String, detail: String },
    InputAudio { audio_url: String },
    InputFile { file_data: String, filename: String },
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Item {
    Reasoning {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        summary: Vec<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        encrypted_content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Vec<Value>>,
    },
    FunctionCall {
        call_id: String,
        name: String,
        arguments: String,
    },
    FunctionCallOutput {
        call_id: String,
        output: Value,
    },
    CustomToolCall {
        call_id: String,
        name: String,
        input: String,
    },
    CustomToolCallOutput {
        call_id: String,
        output: Value,
    },
    #[serde(rename = "item_reference")]
    Reference {
        id: String,
    },
}
#[derive(Serialize)]
struct Function<'a> {
    r#type: &'static str,
    name: &'a str,
    description: &'a str,
    parameters: &'a Value,
    strict: bool,
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
fn content(part: &ContentPart) -> Result<Content> {
    Ok(match part {
        ContentPart::Text { text, .. } => Content::InputText { text: text.clone() },
        ContentPart::File {
            data: FileData::Data(data),
            media_type,
            provider_options,
        } => {
            if media_type.starts_with("image/") {
                Content::InputImage {
                    image_url: format!("data:{media_type};base64,{data}"),
                    detail: provider_options
                        .as_ref()
                        .and_then(|v| v["openai"]["imageDetail"].as_str())
                        .unwrap_or("auto")
                        .into(),
                }
            } else if media_type.starts_with("audio/") {
                Content::InputAudio {
                    audio_url: format!("data:{media_type};base64,{data}"),
                }
            } else if media_type == "application/pdf" {
                Content::InputFile {
                    file_data: format!("data:{media_type};base64,{data}"),
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
fn output(value: &ToolOutput) -> Result<Value> {
    Ok(match value {
        ToolOutput::Text(text) | ToolOutput::ErrorText(text) => Value::String(text.clone()),
        ToolOutput::Json(value) | ToolOutput::ErrorJson(value) => Value::String(value.to_string()),
        ToolOutput::Content(parts) => {
            serde_json::to_value(parts.iter().map(content).collect::<Result<Vec<_>>>()?)
                .map_err(|e| Error::Invalid(e.to_string()))?
        }
    })
}
fn metadata(options: &Option<Value>, namespace: &str, key: &str) -> Option<String> {
    options.as_ref()?[namespace][key]
        .as_str()
        .map(str::to_owned)
}
impl Request<'_> {
    pub fn encode(&self) -> Result<Value> {
        let namespace = if self.plaintext.is_some() {
            "openResponses"
        } else {
            "openai"
        };
        let empty = json!({});
        let options = self.options.get(namespace).unwrap_or(&empty);
        if !options.is_object() {
            return Err(Error::Invalid("Responses options must be an object".into()));
        }
        // Call kind belongs to historical calls, even if the current catalog changed.
        let custom_calls: std::collections::HashSet<&str> = self
            .prompt
            .iter()
            .flat_map(|message| match message {
                Message::Assistant { content, .. } => content.as_slice(),
                _ => &[],
            })
            .filter_map(|part| match part {
                AssistantPart::ToolCall {
                    tool_call_id,
                    tool_name,
                    input,
                    provider_options,
                    ..
                } if input.is_string()
                    && (metadata(provider_options, "openai", "toolKind").as_deref()
                        == Some("custom")
                        || metadata(provider_options, "openResponses", "toolKind").as_deref()
                            == Some("custom")
                        || self
                            .tools
                            .iter()
                            .any(|tool| tool.name == *tool_name && tool.freeform.is_some())) =>
                {
                    Some(tool_call_id.as_str())
                }
                _ => None,
            })
            .collect();
        let mut input = Vec::new();
        for message in self.prompt {
            match message {
                Message::System { content, .. } => {
                    input.push(Input::System {
                        role: "system",
                        content: content.clone(),
                    });
                }
                Message::User { content: parts, .. } => input.push(Input::Message {
                    role: "user",
                    content: parts.iter().map(content).collect::<Result<_>>()?,
                }),
                Message::Assistant { content: parts, .. } => {
                    for part in parts {
                        match part {
                            AssistantPart::Text { text, .. } => input.push(Input::Message {
                                role: "assistant",
                                content: vec![Content::OutputText { text: text.clone() }],
                            }),
                            AssistantPart::Reasoning {
                                text,
                                provider_options,
                            } => match self.plaintext {
                                Some(contract)
                                    if contract.reasoning_replay
                                        == PlaintextReasoningReplay::PlaintextContent =>
                                {
                                    if !text.is_empty() {
                                        input.push(Input::Item(Item::Reasoning {
                                            id: None,
                                            summary: vec![],
                                            encrypted_content: None,
                                            content: Some(vec![
                                                json!({"type":"reasoning_text","text":text}),
                                            ]),
                                        }));
                                    }
                                }
                                Some(_) => {
                                    let Some(options) = provider_options
                                        .as_ref()
                                        .and_then(|v| v.get("openResponses"))
                                    else {
                                        continue;
                                    };
                                    let Some(summary) = options["reasoningSummary"].as_array()
                                    else {
                                        continue;
                                    };
                                    input.push(Input::Item(Item::Reasoning {
                                        id: options["itemId"].as_str().map(str::to_owned),
                                        summary: summary.clone(),
                                        encrypted_content: None,
                                        content: None,
                                    }));
                                }
                                None => {
                                    let id = metadata(provider_options, "openai", "itemId");
                                    let encrypted_content = metadata(
                                        provider_options,
                                        "openai",
                                        "reasoningEncryptedContent",
                                    );
                                    if encrypted_content.is_some() {
                                        input.push(Input::Item(Item::Reasoning {
                                            id,
                                            summary: vec![],
                                            encrypted_content,
                                            content: None,
                                        }));
                                    } else if options["store"] != false
                                        && let Some(id) = id
                                    {
                                        input.push(Input::Item(Item::Reference { id }));
                                    }
                                }
                            },
                            AssistantPart::ToolCall {
                                tool_call_id,
                                tool_name,
                                input: args,
                                provider_executed,
                                provider_options,
                            } => {
                                if *provider_executed == Some(true) {
                                    if options["store"] != false
                                        && let Some(id) =
                                            metadata(provider_options, namespace, "itemId")
                                    {
                                        input.push(Input::Item(Item::Reference { id }));
                                    }
                                } else if self.plaintext.is_none()
                                    && custom_calls.contains(tool_call_id.as_str())
                                {
                                    input.push(Input::Item(Item::CustomToolCall {
                                        call_id: tool_call_id.clone(),
                                        name: wire_name(tool_name).into(),
                                        input: args.as_str().unwrap().into(),
                                    }));
                                } else {
                                    input.push(Input::Item(Item::FunctionCall {
                                        call_id: tool_call_id.clone(),
                                        name: wire_name(tool_name).into(),
                                        arguments: if tool_name == "exec"
                                            && custom_calls.contains(tool_call_id.as_str())
                                        {
                                            json!({"code":args}).to_string()
                                        } else {
                                            args.to_string()
                                        },
                                    }));
                                }
                            }
                            AssistantPart::ToolResult { .. } => {}
                        }
                    }
                }
                Message::Tool { content, .. } => {
                    for result in content {
                        let custom = result.is_custom()
                            || custom_calls.contains(result.tool_call_id.as_str());
                        if result.is_notification() && (self.plaintext.is_some() || !custom) {
                            if let ToolOutput::Text(text) = &result.output {
                                input.push(Input::Message {
                                    role: "user",
                                    content: vec![Content::InputText {
                                        text: format!(
                                            "[Notification from exec {}]\n{text}",
                                            result.tool_call_id
                                        ),
                                    }],
                                });
                            }
                            continue;
                        }
                        input.push(Input::Item(if custom && self.plaintext.is_none() {
                            Item::CustomToolCallOutput {
                                call_id: result.tool_call_id.clone(),
                                output: output(&result.output)?,
                            }
                        } else {
                            Item::FunctionCallOutput {
                                call_id: result.tool_call_id.clone(),
                                output: output(&result.output)?,
                            }
                        }));
                    }
                }
            }
        }
        let mut body = json!({"model":self.model,"input":input,"stream":true});
        let object = body.as_object_mut().unwrap();
        if let Some(maximum) = self.max_output_tokens {
            object.insert("max_output_tokens".into(), json!(maximum));
        }
        for (source, target) in [
            ("store", "store"),
            ("previousResponseId", "previous_response_id"),
            ("instructions", "instructions"),
            ("parallelToolCalls", "parallel_tool_calls"),
            ("user", "user"),
            ("metadata", "metadata"),
            ("serviceTier", "service_tier"),
            ("promptCacheKey", "prompt_cache_key"),
            ("promptCacheRetention", "prompt_cache_retention"),
            ("truncation", "truncation"),
            ("maxToolCalls", "max_tool_calls"),
            ("safetyIdentifier", "safety_identifier"),
        ] {
            if let Some(value) = options.get(source) {
                object.insert(target.into(), value.clone());
            }
        }
        let mut reasoning = serde_json::Map::new();
        for (source, target) in [
            ("reasoningEffort", "effort"),
            ("reasoningSummary", "summary"),
        ] {
            if let Some(value) = options.get(source) {
                reasoning.insert(target.into(), value.clone());
            }
        }
        if !reasoning.is_empty() {
            object.insert("reasoning".into(), Value::Object(reasoning));
        }
        if let Some(verbosity) = options.get("textVerbosity") {
            object.insert("text".into(), json!({"verbosity":verbosity}));
        }
        let mut include = options
            .get("include")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if self.plaintext.is_none()
            && options["store"] == false
            && !include.contains(&json!("reasoning.encrypted_content"))
        {
            include.push(json!("reasoning.encrypted_content"));
        }
        if !include.is_empty() {
            object.insert("include".into(), Value::Array(include));
        }
        if !self.tools.is_empty() {
            let tools = self
                .tools
                .iter()
                .map(|tool| {
                    if let Some(provider) = &tool.provider {
                        let kind = provider.id.strip_prefix("openai.").ok_or_else(|| {
                            Error::Invalid(
                                "Responses provider tool belongs to another protocol".into(),
                            )
                        })?;
                        if !matches!(kind, "web_search" | "web_search_preview") {
                            return Err(Error::Invalid(format!(
                                "Unsupported provider-executed tool: openai.{kind}"
                            )));
                        }
                        let mut value = json!({"type":kind});
                        let args = provider.args.as_object().ok_or_else(|| {
                            Error::Invalid("provider tool arguments must be an object".into())
                        })?;
                        for (key, val) in args {
                            let key = match key.as_str() {
                                "searchContextSize" => "search_context_size",
                                "userLocation" => "user_location",
                                "externalWebAccess" => "external_web_access",
                                other => other,
                            };
                            if key == "type" {
                                return Err(Error::Invalid(
                                    "provider tool cannot override its type".into(),
                                ));
                            }
                            value[key] = val.clone();
                        }
                        Ok(value)
                    } else if self.plaintext.is_none() && let Some(format) = &tool.freeform {
                        let mut format = serde_json::to_value(format).map_err(|e| Error::Invalid(e.to_string()))?;
                        format["type"] = json!("grammar");
                        Ok(json!({"type":"custom", "name":wire_name(&tool.name), "description":tool.description, "format":format}))
                    } else {
                        serde_json::to_value(Function {
                            r#type: "function",
                            name: wire_name(&tool.name),
                            description: &tool.description,
                            parameters: &tool.input_schema,
                            strict: false,
                        })
                        .map_err(|e| Error::Invalid(e.to_string()))
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            object.insert("tools".into(), json!(tools));
            object.insert("tool_choice".into(), json!("auto"));
        }
        if self
            .plaintext
            .is_some_and(|contract| contract.compatibility.is_some())
        {
            object.insert("store".into(), json!(false));
        }
        Ok(body)
    }
}
