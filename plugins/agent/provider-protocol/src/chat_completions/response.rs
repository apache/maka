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
use std::collections::{BTreeMap, HashMap, hash_map::Entry};

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
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Annotation {
    UrlCitation {
        url_citation: UrlCitation,
    },
    #[serde(other)]
    Other,
}
#[derive(Debug, Deserialize)]
pub(super) struct UrlCitation {
    url: String,
    title: Option<String>,
    start_index: Option<u64>,
    pub(super) end_index: Option<u64>,
}

/// Cumulative scalar ends in visible content. Reasoning contributes no offsets.
pub(super) struct TextSpan<T> {
    pub part: T,
    pub end: u64,
}

impl UrlCitation {
    pub(super) fn source<T: Clone>(
        self,
        spans: &[TextSpan<T>],
        next_id: &mut dyn FnMut() -> String,
    ) -> (output::Source, Option<output::CitationAnchor<T>>) {
        let anchor = self
            .start_index
            .zip(self.end_index)
            .and_then(|(start, end)| {
                let index = spans.partition_point(|span| span.end <= start);
                let span = spans.get(index)?;
                let base = index.checked_sub(1).map_or(0, |i| spans[i].end);
                (start < end && end <= span.end).then(|| output::CitationAnchor::Range {
                    part: span.part.clone(),
                    start: start - base,
                    end: end - base,
                })
            });
        (
            output::Source::Url {
                id: next_id(),
                url: self.url,
                title: self.title,
                extensions: None,
            },
            anchor,
        )
    }
}
#[derive(Debug, Default, Deserialize)]
pub(super) struct Message {
    pub role: Option<String>,
    pub content: Option<Content>,
    pub annotations: Option<Vec<Annotation>>,
    pub reasoning_content: Option<String>,
    pub reasoning: Option<String>,
    pub tool_calls: Option<Vec<CallEntry>>,
    #[serde(default)]
    pub executed_tools: Option<Vec<ExecutedTool>>,
}

#[derive(Debug)]
pub(super) enum CallEntry {
    Local(ToolDelta),
    Server(ExecutedTool),
}
impl<'de> Deserialize<'de> for CallEntry {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> std::result::Result<Self, D::Error> {
        use serde::de::Error as _;
        let raw = Value::deserialize(decoder)?;
        if raw["execution"] == "client" && raw["provider_executed"] == true
            || raw["execution"] == "server" && raw["provider_executed"] == false
        {
            return Err(D::Error::custom("conflicting tool execution owners"));
        }
        if raw["execution"] == "server" || raw["provider_executed"] == true {
            return serde_json::from_value(raw)
                .map(Self::Server)
                .map_err(D::Error::custom);
        }
        if raw
            .get("type")
            .is_some_and(|v| !v.is_null() && v != "function")
        {
            return Err(D::Error::custom("unsupported client tool call type"));
        }
        serde_json::from_value(raw)
            .map(Self::Local)
            .map_err(D::Error::custom)
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct ExecutedTool {
    #[serde(alias = "tool_call_id")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(flatten)]
    fields: serde_json::Map<String, Value>,
}
#[derive(Default)]
pub(super) struct ReportedCalls(HashMap<String, Option<String>>);

impl ReportedCalls {
    pub(super) fn observe(
        &mut self,
        tool: ExecutedTool,
    ) -> (Option<output::ToolCall>, Option<output::ToolResult>) {
        let Some(id) = tool.id.as_deref().filter(|id| !id.is_empty()) else {
            // Some providers supply only a per-response index or usage counter.
            return (None, None);
        };
        let (call, open) = match self.0.entry(id.to_owned()) {
            Entry::Vacant(entry) => {
                let call = tool.call(id);
                let open = entry.insert(Some(call.name.clone()));
                (Some(call), open)
            }
            Entry::Occupied(entry) => (None, entry.into_mut()),
        };
        let Some(name) = open.as_deref() else {
            return (None, None);
        };
        let result = tool.result(name);
        if result.is_some() {
            *open = None;
        }
        (call, result)
    }
}
impl ExecutedTool {
    pub fn call(&self, id: &str) -> output::ToolCall {
        let function = self.fields.get("function");
        let name = function
            .and_then(|v| v["name"].as_str())
            .or_else(|| self.fields.get("name").and_then(Value::as_str))
            .or(self.kind.as_deref())
            .unwrap_or("provider_tool");
        let input = self
            .fields
            .get("arguments")
            .or_else(|| function.and_then(|v| v.get("arguments")));
        output::ToolCall {
            id: id.into(),
            name: name.into(),
            input: match input {
                Some(Value::String(v)) => v.clone(),
                Some(v) => v.to_string(),
                None => "{}".into(),
            },
            provider_executed: true,
            dynamic: false,
            extensions: None,
        }
    }
    fn result(self, name: &str) -> Option<output::ToolResult> {
        let status = self.fields.get("status").and_then(Value::as_str);
        let error = self.fields.get("is_error") == Some(&Value::Bool(true))
            || self.fields.get("error").is_some_and(|v| !v.is_null());
        let is_error = match status {
            Some("completed") => error,
            Some("failed" | "incomplete") => true,
            None if error
                || [
                    "output",
                    "result",
                    "search_results",
                    "browser_results",
                    "code_results",
                ]
                .iter()
                .any(|key| self.fields.get(*key).is_some_and(|v| !v.is_null())) =>
            {
                error
            }
            _ => return None,
        };
        Some(output::ToolResult {
            id: self.id.expect("identified provider call"),
            name: name.into(),
            is_error,
            dynamic: false,
            extensions: None,
            value: Value::Object(self.fields),
        })
    }
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
        let result = Self::deserialize(raw)
            .map_err(|_| Error::invalid("Invalid Chat Completions response.", raw.clone()))?;
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
                        .any(|v| matches!(v, CallEntry::Local(v) if v.function.name.is_none() || v.function.arguments.is_none())))
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
    let mut spans = Vec::new();
    let mut end = 0;
    for (kind, text) in texts {
        if kind == TextKind::Text && message.annotations.is_some() {
            end += text.chars().count() as u64;
            spans.push(TextSpan {
                part: parts.len(),
                end,
            });
        }
        parts.push(Part::Text {
            kind,
            text,
            citations: vec![],
            extensions: None,
        });
    }
    for annotation in message.annotations.into_iter().flatten() {
        if let Annotation::UrlCitation { url_citation } = annotation {
            let (source, anchor) = url_citation.source(&spans, generate_id);
            parts.push(Part::Source { source, anchor });
        }
    }
    let mut reported = ReportedCalls::default();
    for entry in message.tool_calls.into_iter().flatten().chain(
        message
            .executed_tools
            .into_iter()
            .flatten()
            .map(CallEntry::Server),
    ) {
        let tool = match entry {
            CallEntry::Local(tool) => tool,
            CallEntry::Server(tool) => {
                let (call, result) = reported.observe(tool);
                parts.extend(call.map(Part::ToolCall));
                parts.extend(result.map(Part::ToolResult));
                continue;
            }
        };
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
