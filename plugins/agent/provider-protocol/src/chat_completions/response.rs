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

//! Decoding at the wire boundary; the rest of the protocol consumes native data.
use crate::{
    Error, Result,
    input::Extensions,
    output::{self, Part, Stop, TextKind},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct Usage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub prompt_tokens_details: Option<InputDetails>,
    pub completion_tokens_details: Option<OutputDetails>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct InputDetails {
    pub cached_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct OutputDetails {
    pub reasoning_tokens: Option<u64>,
    pub accepted_prediction_tokens: Option<u64>,
    pub rejected_prediction_tokens: Option<u64>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}
impl Usage {
    pub fn normalized(&self, raw: Value) -> output::Usage {
        let output = self.completion_tokens.unwrap_or(0);
        let cache = self
            .prompt_tokens_details
            .as_ref()
            .and_then(|v| v.cached_tokens)
            .or_else(|| {
                self.extensions
                    .get("prompt_cache_hit_tokens")
                    .and_then(Value::as_u64)
            });
        let cache_write = self
            .prompt_tokens_details
            .as_ref()
            .and_then(|v| v.cache_write_tokens);
        let reasoning = self
            .completion_tokens_details
            .as_ref()
            .and_then(|v| v.reasoning_tokens)
            .unwrap_or(0);
        output::Usage {
            input: self.prompt_tokens,
            uncached_input: self.prompt_tokens.zip(cache).map(|(input, cache)| {
                i128::from(input) - i128::from(cache) - i128::from(cache_write.unwrap_or(0))
            }),
            cache_read: cache,
            cache_write,
            output: Some(output),
            reasoning: Some(reasoning),
            text: Some(i128::from(output.saturating_sub(reasoning))),
            raw: Some(raw),
            ..Default::default()
        }
    }
}
pub fn usage(bytes: &[u8]) -> Result<Option<output::Usage>> {
    let raw: Value = serde_json::from_slice(bytes)
        .map_err(|e| Error::json(&String::from_utf8_lossy(bytes), e))?;
    let parsed: Option<Usage> = decode(raw.clone())?;
    Ok(parsed.map(|v| v.normalized(raw)))
}
pub(super) fn extensions(usage: Option<&Usage>, namespace: &str) -> Extensions {
    let mut counters = serde_json::Map::new();
    if let Some(details) = usage.and_then(|v| v.completion_tokens_details.as_ref()) {
        if let Some(n) = details.accepted_prediction_tokens {
            counters.insert("acceptedPredictionTokens".into(), json!(n));
        }
        if let Some(n) = details.rejected_prediction_tokens {
            counters.insert("rejectedPredictionTokens".into(), json!(n));
        }
    }
    Some(BTreeMap::from([(
        namespace.into(),
        Value::Object(counters),
    )]))
}
pub(super) fn stop(reason: Option<&str>) -> Stop {
    match reason {
        Some("stop") => Stop::Stop,
        Some("length") => Stop::Length,
        Some("tool_calls" | "function_call") => Stop::ToolCalls,
        Some("content_filter") => Stop::ContentFilter,
        _ => Stop::Other,
    }
}
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub(super) struct Function {
    pub name: Option<String>,
    pub arguments: Option<String>,
}
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub(super) struct ToolDelta {
    pub id: Option<String>,
    pub index: Option<f64>,
    pub function: Function,
    pub extra_content: Option<ExtraContent>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct ExtraContent {
    pub google: Option<Google>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct Google {
    pub thought_signature: Option<String>,
}
impl ToolDelta {
    pub fn signature(&self, namespace: &str) -> Extensions {
        self.extra_content
            .as_ref()
            .and_then(|v| v.google.as_ref())
            .and_then(|v| v.thought_signature.as_ref())
            .filter(|v| !v.is_empty())
            .map(|s| BTreeMap::from([(namespace.into(), json!({"thoughtSignature":s}))]))
    }
}
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum Content {
    Text(String),
    Parts(Vec<ContentPart>),
}
/// Compatibility endpoints may send arbitrary vendor content blocks. Only the
/// block discriminator is universal; fields of extensions remain opaque.
#[derive(Debug, Deserialize)]
pub(super) struct ContentPart {
    #[serde(rename = "type")]
    kind: String,
    #[serde(flatten)]
    fields: BTreeMap<String, Value>,
}
impl Content {
    pub fn text(self) -> Vec<(TextKind, String)> {
        match self {
            Self::Text(text) => {
                if text.is_empty() {
                    vec![]
                } else {
                    vec![(TextKind::Text, text)]
                }
            }
            Self::Parts(parts) => parts
                .into_iter()
                .filter_map(|part| {
                    let (kind, text) = match part.kind.as_str() {
                        "text" => (
                            TextKind::Text,
                            part.fields.get("text")?.as_str()?.to_owned(),
                        ),
                        "thinking" => (
                            TextKind::Reasoning,
                            part.fields
                                .get("thinking")?
                                .as_array()?
                                .iter()
                                .filter(|v| v.get("type").and_then(Value::as_str) == Some("text"))
                                .filter_map(|v| v.get("text").and_then(Value::as_str))
                                .collect(),
                        ),
                        _ => return None,
                    };
                    (!text.is_empty()).then_some((kind, text))
                })
                .collect(),
        }
    }
}
#[derive(Debug, Default, Deserialize)]
pub(super) struct Message {
    pub role: Option<String>,
    pub content: Option<Content>,
    pub reasoning_content: Option<String>,
    pub reasoning: Option<String>,
    pub tool_calls: Option<Vec<ToolDelta>>,
}
#[derive(Debug, Deserialize)]
pub(super) struct Choice {
    pub message: Option<Message>,
    pub delta: Option<Message>,
    pub finish_reason: Option<String>,
}
#[derive(Debug, Deserialize)]
pub(super) struct Envelope {
    pub id: Option<String>,
    pub model: Option<String>,
    pub created: Option<f64>,
    pub choices: Vec<Choice>,
    pub usage: Option<Usage>,
}
pub(super) fn decode<T: serde::de::DeserializeOwned>(raw: Value) -> Result<T> {
    serde_json::from_value(raw.clone())
        .map_err(|_| Error::invalid("Invalid Chat Completions response.", raw))
}
impl Envelope {
    pub fn parse(raw: &Value, streaming: bool) -> Result<Self> {
        let result: Self = decode(raw.clone())?;
        for choice in &result.choices {
            let message = if streaming {
                choice.delta.as_ref()
            } else {
                choice.message.as_ref()
            };
            let Some(message) = message else {
                if streaming {
                    continue;
                }
                return Err(Error::invalid(
                    "Invalid Chat Completions response.",
                    raw.clone(),
                ));
            };
            if message
                .role
                .as_deref()
                .is_some_and(|v| v != "assistant" && !(streaming && v.is_empty()))
                || (!streaming
                    && message
                        .tool_calls
                        .iter()
                        .flatten()
                        .any(|v| v.function.name.is_none() || v.function.arguments.is_none()))
            {
                return Err(Error::invalid(
                    "Invalid Chat Completions response.",
                    raw.clone(),
                ));
            }
        }
        Ok(result)
    }
    pub fn timestamp(&self) -> Option<f64> {
        self.created.filter(|v| *v != 0.0)
    }
}
pub fn generate(
    bytes: &[u8],
    namespace: &str,
    generate_id: &mut dyn FnMut() -> String,
) -> Result<output::Response> {
    let raw: Value = serde_json::from_slice(bytes)
        .map_err(|e| Error::json(&String::from_utf8_lossy(bytes), e))?;
    let mut envelope = Envelope::parse(&raw, false)?;
    let timestamp = envelope.timestamp();
    if envelope.choices.is_empty() {
        return Err(Error::invalid("Response did not contain any choices.", raw));
    }
    let choice = envelope.choices.remove(0);
    let message = choice.message.expect("validated full message");
    let mut parts = vec![];
    let reasoning = message.reasoning_content.or(message.reasoning);
    let texts = reasoning
        .filter(|v| !v.is_empty())
        .map(|v| (TextKind::Reasoning, v))
        .into_iter()
        .chain(message.content.into_iter().flat_map(Content::text));
    parts.extend(texts.map(|(kind, text)| Part::Text {
        kind,
        text,
        citations: vec![],
        extensions: None,
    }));
    for tool in message.tool_calls.into_iter().flatten() {
        let extensions = tool.signature(namespace);
        parts.push(Part::ToolCall(output::ToolCall {
            id: tool
                .id
                .filter(|v| !v.is_empty())
                .unwrap_or_else(&mut *generate_id),
            name: tool.function.name.expect("validated function name"),
            input: tool.function.arguments.expect("validated arguments"),
            provider_executed: false,
            dynamic: false,
            extensions,
        }));
    }
    let finish = output::Finish {
        reason: stop(choice.finish_reason.as_deref()),
        raw_reason: choice.finish_reason,
        usage: envelope
            .usage
            .as_ref()
            .map(|v| v.normalized(raw["usage"].clone())),
        extensions: extensions(envelope.usage.as_ref(), namespace),
    };
    Ok(output::Response {
        id: envelope.id,
        model: envelope.model,
        created_at_unix_seconds: timestamp,
        parts,
        finish,
        raw,
    })
}
