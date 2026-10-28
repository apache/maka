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

use super::{Error, ItemMetadata, ReasoningMode, Replay, Result, ToolInput};
use serde_json::{Value, json};

pub struct Request<'a> {
    pub model: &'a str,
    pub input: &'a [Input],
    pub tools: &'a [Tool],
    pub options: &'a Value,
    pub max_output_tokens: Option<u64>,
    pub reasoning: ReasoningMode,
}

#[derive(Debug, Clone)]
pub enum Input {
    System(String),
    User(Vec<Content>),
    AssistantText {
        text: String,
        replay: Option<Replay>,
    },
    Reasoning(Reasoning),
    ToolCall {
        id: String,
        name: String,
        input: ToolInput,
        provider_executed: bool,
        metadata: Option<ItemMetadata>,
    },
    ToolOutput {
        id: String,
        custom: bool,
        output: ToolOutput,
    },
    ProviderResult {
        replay: Option<Replay>,
        action: Value,
    },
}
#[derive(Debug, Clone)]
pub enum Content {
    Text(String),
    Image { url: String, detail: String },
    Audio { url: String },
    File { data: String, filename: String },
}
#[derive(Debug, Clone)]
pub struct Reasoning {
    pub text: String,
    pub item_id: Option<String>,
    pub encrypted_content: Option<String>,
    pub summary: Option<Vec<Value>>,
    pub replay: Option<Replay>,
}
#[derive(Debug, Clone)]
pub enum ToolOutput {
    Text(String),
    Json(Value),
    Content(Vec<Content>),
}
#[derive(Debug, Clone)]
pub enum Tool {
    Function {
        name: String,
        description: String,
        parameters: Value,
    },
    Custom {
        name: String,
        description: String,
        format: Value,
    },
    WebSearch {
        kind: SearchKind,
        args: Value,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchKind {
    Search,
    Preview,
}

impl Content {
    fn encode(&self) -> Value {
        match self {
            Self::Text(text) => json!({"type":"input_text", "text":text}),
            Self::Image { url, detail } => {
                json!({"type":"input_image", "image_url":url, "detail":detail})
            }
            Self::Audio { url } => json!({"type":"input_audio", "audio_url":url}),
            Self::File { data, filename } => {
                json!({"type":"input_file", "file_data":data, "filename":filename})
            }
        }
    }
}
impl ToolOutput {
    fn encode(&self) -> Value {
        match self {
            Self::Text(text) => Value::String(text.clone()),
            Self::Json(value) => Value::String(value.to_string()),
            Self::Content(parts) => Value::Array(parts.iter().map(Content::encode).collect()),
        }
    }
}
impl Tool {
    fn encode(&self) -> Result<Value> {
        Ok(match self {
            Self::Function {
                name,
                description,
                parameters,
            } => {
                json!({"type":"function", "name":name, "description":description, "parameters":parameters, "strict":false})
            }
            Self::Custom {
                name,
                description,
                format,
            } => {
                let mut format = format
                    .as_object()
                    .cloned()
                    .ok_or_else(|| Error::Invalid("custom tool format must be an object".into()))?;
                format.insert("type".into(), json!("grammar"));
                json!({"type":"custom", "name":name, "description":description, "format":format})
            }
            Self::WebSearch { kind, args } => {
                let mut value = json!({"type": match kind { SearchKind::Search => "web_search", SearchKind::Preview => "web_search_preview" }});
                let args = args.as_object().ok_or_else(|| {
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
                value
            }
        })
    }
}
static EMPTY_OPTIONS: Value = Value::Null;
fn options(options: &Value, reasoning: ReasoningMode) -> Result<&Value> {
    let namespace = if reasoning.is_plaintext() {
        "openResponses"
    } else {
        "openai"
    };
    match options.get(namespace) {
        Some(value) if !value.is_object() => {
            Err(Error::Invalid("Responses options must be an object".into()))
        }
        Some(value) => Ok(value),
        None => Ok(&EMPTY_OPTIONS),
    }
}

pub fn encode_input(
    input: &[Input],
    reasoning: ReasoningMode,
    provider_options: &Value,
) -> Result<Vec<Value>> {
    encode_items(input, reasoning, options(provider_options, reasoning)?)
}

fn encode_items(input: &[Input], reasoning: ReasoningMode, options: &Value) -> Result<Vec<Value>> {
    let mut items = Vec::new();
    for item in input {
        match item {
            Input::System(text) => items.push(json!({"role":"system", "content":text})),
            Input::User(content) => items.push(json!({"role":"user", "content":content.iter().map(Content::encode).collect::<Vec<_>>()})),
            Input::AssistantText { text, replay } => {
                items.push(if reasoning == ReasoningMode::Encrypted && let Some(replay) = replay {
                    replay.text(text, "message", None)?
                } else {
                    json!({"role":"assistant", "content":[{"type":"output_text", "text":text}]})
                });
            }
            Input::Reasoning(part) => match reasoning {
                ReasoningMode::PlaintextContent => {
                    if !part.text.is_empty() {
                        items.push(json!({"type":"reasoning", "summary":[], "content":[{"type":"reasoning_text", "text":part.text}]}));
                    }
                }
                ReasoningMode::PlaintextSummary => {
                    if let Some(summary) = &part.summary {
                        let mut item = json!({"type":"reasoning", "summary":summary});
                        if let Some(id) = &part.item_id { item["id"] = json!(id); }
                        items.push(item);
                    }
                }
                ReasoningMode::Encrypted => {
                    if let Some(replay) = &part.replay {
                        items.push(replay.text(&part.text, "reasoning", part.encrypted_content.as_deref())?);
                    } else if let Some(encrypted_content) = &part.encrypted_content {
                        let mut item = json!({"type":"reasoning", "summary":[], "encrypted_content":encrypted_content});
                        if let Some(id) = &part.item_id { item["id"] = json!(id); }
                        items.push(item);
                    } else if options["store"] != false && let Some(id) = &part.item_id {
                        items.push(json!({"type":"item_reference", "id":id}));
                    }
                }
            },
            Input::ToolCall { id, name, input, provider_executed, metadata } => {
                if *provider_executed {
                    if options["store"] != false && let Some(metadata) = metadata && !metadata.id.is_empty() {
                        items.push(json!({"type":"item_reference", "id":metadata.id}));
                    }
                    continue;
                }
                let (kind, field, payload) = match input {
                    ToolInput::Function(arguments) => ("function_call", "arguments", arguments),
                    ToolInput::Custom(source) => ("custom_tool_call", "input", source),
                };
                let replay = if reasoning == ReasoningMode::Encrypted { metadata.as_ref().and_then(|metadata| metadata.replay.as_ref()) } else { None };
                items.push(if let Some(replay) = replay {
                    replay.call(kind, id, name, payload)?
                } else {
                    let mut item = json!({"type":kind, "call_id":id, "name":name});
                    item[field] = json!(payload);
                    item
                });
            }
            Input::ToolOutput { id, custom, output } => items.push(json!({"type": if *custom && reasoning == ReasoningMode::Encrypted { "custom_tool_call_output" } else { "function_call_output" }, "call_id":id, "output":output.encode()})),
            Input::ProviderResult { replay, action } => {
                if reasoning == ReasoningMode::Encrypted && options["store"] == false && let Some(replay) = replay {
                    items.push(replay.provider(action)?);
                }
            }
        }
    }
    Ok(items)
}

impl Request<'_> {
    pub fn encode(&self) -> Result<Value> {
        let options = options(self.options, self.reasoning)?;
        let input = encode_items(self.input, self.reasoning, options)?;
        let mut body = json!({"model":self.model,"input":input,"stream":true});
        let object = body
            .as_object_mut()
            .expect("Responses envelope is an object");
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
        if self.reasoning == ReasoningMode::Encrypted
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
                .map(Tool::encode)
                .collect::<Result<Vec<_>>>()?;
            object.insert("tools".into(), json!(tools));
            object.insert("tool_choice".into(), json!("auto"));
        }
        Ok(body)
    }
}
