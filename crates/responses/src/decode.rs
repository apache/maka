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
use maka_runtime::model::{
    ModelEvent, ModelFinishReason, ModelSource, ModelToolCall, ModelUsage,
    PlaintextReasoningReplay, PlaintextResponses, TextKind,
};
use maka_runtime::tools::ToolDefinition;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

const MAX_ITEMS: usize = 128;
const MAX_TEXT: usize = 10_000_000;

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Event {
    #[serde(rename = "response.created")]
    Created { response: Response },
    #[serde(rename = "response.output_item.added")]
    Added { item: Item },
    #[serde(rename = "response.output_item.done")]
    Done { item: Item },
    #[serde(
        rename = "response.output_text.delta",
        alias = "response.refusal.delta"
    )]
    Text { item_id: String, delta: String },
    #[serde(rename = "response.reasoning_summary_text.delta")]
    Summary { item_id: String, delta: String },
    #[serde(rename = "response.reasoning_text.delta")]
    Reasoning { item_id: String, delta: String },
    #[serde(rename = "response.output_text.annotation.added")]
    Annotation {
        item_id: String,
        annotation_index: u64,
        annotation: Annotation,
    },
    #[serde(rename = "response.completed", alias = "response.done")]
    Completed { response: Response },
    #[serde(rename = "response.incomplete")]
    Incomplete { response: Response },
    #[serde(rename = "response.failed")]
    Failed { response: Response },
    #[serde(rename = "error")]
    Error { error: ProviderError },
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
#[serde(tag = "type")]
enum Item {
    #[serde(rename = "message")]
    Message {
        id: String,
        #[serde(default)]
        content: Vec<Text>,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        id: String,
        #[serde(default)]
        summary: Vec<Text>,
        #[serde(default)]
        content: Vec<Text>,
        encrypted_content: Option<String>,
    },
    #[serde(rename = "function_call")]
    Function {
        id: String,
        call_id: String,
        name: String,
        arguments: String,
    },
    #[serde(rename = "custom_tool_call")]
    Custom {
        id: String,
        call_id: String,
        name: String,
        input: String,
    },
    #[serde(rename = "web_search_call")]
    Search {
        id: String,
        #[serde(default)]
        action: Value,
        status: String,
    },
    #[serde(other)]
    Other,
}

#[derive(PartialEq, Eq)]
enum Identity {
    Message,
    Reasoning,
    Function { call_id: String, name: String },
    Custom { call_id: String, name: String },
    Search,
}
impl Item {
    fn identity(&self) -> Result<(&str, Identity)> {
        Ok(match self {
            Self::Message { id, .. } => (id, Identity::Message),
            Self::Reasoning { id, .. } => (id, Identity::Reasoning),
            Self::Function {
                id, call_id, name, ..
            } => (
                id,
                Identity::Function {
                    call_id: call_id.clone(),
                    name: name.clone(),
                },
            ),
            Self::Custom {
                id, call_id, name, ..
            } => (
                id,
                Identity::Custom {
                    call_id: call_id.clone(),
                    name: name.clone(),
                },
            ),
            Self::Search { id, .. } => (id, Identity::Search),
            Self::Other => return Err(Error::Invalid("unsupported Responses output item".into())),
        })
    }
}
#[derive(Deserialize)]
struct Text {
    r#type: String,
    #[serde(alias = "refusal")]
    text: String,
    #[serde(default)]
    annotations: Vec<Annotation>,
}
#[derive(Deserialize)]
#[serde(tag = "type")]
enum Annotation {
    #[serde(rename = "url_citation")]
    Url {
        url: String,
        title: Option<String>,
        start_index: Option<u64>,
        end_index: Option<u64>,
    },
    #[serde(other)]
    Other,
}
#[derive(Default, Deserialize)]
struct Response {
    id: Option<String>,
    model: Option<String>,
    created_at: Option<f64>,
    #[serde(default)]
    output: Vec<Item>,
    usage: Option<Usage>,
    error: Option<ProviderError>,
    incomplete_details: Option<IncompleteDetails>,
}
#[derive(Deserialize)]
struct IncompleteDetails {
    reason: String,
}
#[derive(Deserialize)]
struct Usage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    input_tokens_details: Option<InputTokens>,
    output_tokens_details: Option<OutputTokens>,
}
#[derive(Deserialize)]
struct InputTokens {
    cached_tokens: Option<u64>,
}
#[derive(Deserialize)]
struct OutputTokens {
    reasoning_tokens: Option<u64>,
}
#[derive(Deserialize)]
pub(crate) struct ProviderError {
    pub code: Option<String>,
    pub message: String,
}
struct Part {
    kind: TextKind,
    text: String,
}
pub struct Decoder {
    plaintext: Option<PlaintextResponses>,
    open: BTreeMap<String, Part>,
    seen: HashSet<String>,
    items: BTreeMap<String, Identity>,
    text_bytes: usize,
    done: HashSet<String>,
    citations: HashSet<String>,
    response_id: Option<String>,
    tool_calls: bool,
    search_name: Option<String>,
    finished: bool,
    pub observed_output: bool,
    pub replay_safe: bool,
}
impl Decoder {
    pub fn new(plaintext: Option<PlaintextResponses>, tools: &[ToolDefinition]) -> Self {
        Self {
            plaintext,
            open: BTreeMap::new(),
            seen: HashSet::new(),
            items: BTreeMap::new(),
            text_bytes: 0,
            done: HashSet::new(),
            citations: HashSet::new(),
            response_id: None,
            tool_calls: false,
            finished: false,
            observed_output: false,
            replay_safe: true,
            search_name: tools
                .iter()
                .find(|tool| {
                    tool.provider.as_ref().is_some_and(|p| {
                        matches!(
                            p.id.as_str(),
                            "openai.web_search" | "openai.web_search_preview"
                        )
                    })
                })
                .map(|tool| tool.name.clone()),
        }
    }
    pub fn finished(&self) -> bool {
        self.finished
    }
    pub fn end(&self) -> Result<()> {
        if self.finished {
            Ok(())
        } else {
            Err(Error::Truncated {
                replay_safe: self.replay_safe,
            })
        }
    }
    fn invalid(message: &str) -> Error {
        Error::Invalid(message.into())
    }
    fn observe(&mut self, item: &Item, added: bool, out: &mut Vec<ModelEvent>) -> Result<()> {
        let (id, identity) = item.identity()?;
        if id.is_empty() || id.len() > 2048 {
            return Err(Self::invalid("invalid Responses item identity"));
        }
        if let Some(previous) = self.items.get(id) {
            if added || previous != &identity {
                return Err(Self::invalid(
                    "Responses item identity changed or duplicated",
                ));
            }
        } else {
            if self.items.len() >= MAX_ITEMS {
                return Err(Self::invalid("Responses item count exceeds limit"));
            }
            if let Identity::Function { call_id, name } | Identity::Custom { call_id, name } =
                &identity
                && (call_id.is_empty()
                    || call_id.len() > 2048
                    || name.is_empty()
                    || name.len() > 256)
            {
                return Err(Self::invalid("invalid Responses tool identity"));
            }
            if identity == Identity::Search {
                let name = self
                    .search_name
                    .clone()
                    .ok_or_else(|| Self::invalid("unrequested Responses web search"))?;
                self.observed_output = true;
                self.replay_safe = false;
                out.push(ModelEvent::ToolCall(ModelToolCall {
                    id: id.into(),
                    name,
                    input: json!({}),
                    provider_executed: true,
                    provider_options: Some(json!({"openai":{"itemId":id}})),
                }));
            }
            self.items.insert(id.into(), identity);
        }
        Ok(())
    }
    fn start(&mut self, id: &str, kind: TextKind, out: &mut Vec<ModelEvent>) -> Result<()> {
        if id.is_empty()
            || id.len() > 2048
            || self.seen.len() >= MAX_ITEMS
            || !self.seen.insert(id.into())
        {
            return Err(Self::invalid("invalid or duplicate Responses output item"));
        }
        self.observed_output = true;
        self.open.insert(
            id.into(),
            Part {
                kind,
                text: String::new(),
            },
        );
        out.push(ModelEvent::PartStarted {
            id: id.into(),
            text_kind: kind,
            provider_options: None,
        });
        Ok(())
    }
    fn delta(
        &mut self,
        id: String,
        text: String,
        kind: TextKind,
        out: &mut Vec<ModelEvent>,
    ) -> Result<()> {
        let part = self
            .open
            .get_mut(&id)
            .ok_or_else(|| Self::invalid("Responses delta has no open item"))?;
        if part.kind != kind || self.text_bytes.saturating_add(text.len()) > MAX_TEXT {
            return Err(Self::invalid(
                "Responses delta has invalid kind or exceeds text bound",
            ));
        }
        self.text_bytes += text.len();
        part.text.push_str(&text);
        out.push(ModelEvent::PartDelta {
            id,
            text,
            provider_options: None,
        });
        Ok(())
    }
    fn finish_part(
        &mut self,
        id: String,
        text: String,
        kind: TextKind,
        options: Option<Value>,
        out: &mut Vec<ModelEvent>,
    ) -> Result<()> {
        if !self.seen.contains(&id) {
            self.start(&id, kind, out)?;
        }
        let part = self
            .open
            .get(&id)
            .ok_or_else(|| Self::invalid("Responses item was already finalized"))?;
        if part.kind != kind || text.len() > MAX_TEXT || !text.starts_with(&part.text) {
            return Err(Self::invalid(
                "final Responses item disagrees with streamed text",
            ));
        }
        if text.len() > part.text.len() {
            self.delta(id.clone(), text[part.text.len()..].into(), kind, out)?;
        }
        self.open.remove(&id);
        self.done.insert(id.clone());
        out.push(ModelEvent::PartFinished {
            id,
            provider_options: options,
        });
        Ok(())
    }
    fn citation(
        &mut self,
        id: String,
        annotation: Annotation,
        out: &mut Vec<ModelEvent>,
    ) -> Result<()> {
        if self.citations.len() >= 512 && !self.citations.contains(&id) {
            return Err(Self::invalid("Responses citation count exceeds limit"));
        }
        if let Annotation::Url {
            url,
            title,
            start_index,
            end_index,
        } = annotation
            && self.citations.insert(id.clone())
        {
            out.push(ModelEvent::Source(ModelSource::Url {
                id,
                url,
                title,
                provider_options: Some(
                    json!({"openai":{"startIndex":start_index,"endIndex":end_index}}),
                ),
            }));
        }
        Ok(())
    }
    fn final_item(&mut self, item: Item, out: &mut Vec<ModelEvent>) -> Result<()> {
        self.observe(&item, false, out)?;
        if self.done.contains(item.identity()?.0) {
            return Err(Self::invalid("duplicate Responses item finalization"));
        }
        match item {
            Item::Message { id, content } => {
                let mut text = String::new();
                for (index, part) in content.into_iter().enumerate() {
                    if !matches!(part.r#type.as_str(), "output_text" | "refusal") {
                        return Err(Self::invalid("unsupported Responses message content"));
                    }
                    text.push_str(&part.text);
                    for (annotation_index, annotation) in part.annotations.into_iter().enumerate() {
                        self.citation(format!("{id}:{index}:{annotation_index}"), annotation, out)?;
                    }
                }
                if self.done.contains(&id) {
                    return Ok(());
                }
                self.finish_part(
                    id.clone(),
                    text,
                    TextKind::Text,
                    Some(json!({"openai":{"itemId":id}})),
                    out,
                )?;
            }
            Item::Reasoning {
                id,
                summary,
                content,
                encrypted_content,
            } => {
                if self.done.contains(&id) {
                    return Ok(());
                }
                let (parts, carrier) = match self.plaintext {
                    Some(p) if p.reasoning_replay == PlaintextReasoningReplay::PlaintextContent => {
                        (content, "reasoning_text")
                    }
                    _ => (summary, "summary_text"),
                };
                if parts.len() > MAX_ITEMS || parts.iter().any(|p| p.r#type != carrier) {
                    return Err(Self::invalid(
                        "invalid finalized Responses reasoning carrier",
                    ));
                }
                let text = parts.iter().map(|p| p.text.as_str()).collect::<String>();
                let options = match self.plaintext {
                    Some(p) if p.reasoning_replay == PlaintextReasoningReplay::PlaintextSummary => {
                        Some(json!({
                            "makaResponses": {"version":1,"profile":p.profile(),"itemId":id,
                                "summaryPartLengths":parts.iter().map(|p| p.text.encode_utf16().count()).collect::<Vec<_>>()}
                        }))
                    }
                    Some(_) => None,
                    None => {
                        let mut value = json!({"openai":{"itemId":id}});
                        if let Some(encrypted) = encrypted_content {
                            value["openai"]["reasoningEncryptedContent"] = json!(encrypted);
                        }
                        Some(value)
                    }
                };
                self.finish_part(id, text, TextKind::Thinking, options, out)?;
            }
            Item::Function {
                id,
                call_id,
                name,
                arguments,
            } => {
                if !self.done.insert(id.clone()) {
                    return Err(Self::invalid("duplicate Responses tool finalization"));
                }
                self.tool_calls = true;
                self.observed_output = true;
                let input = serde_json::from_str(&arguments)
                    .map_err(|_| Self::invalid("invalid Responses function arguments"))?;
                out.push(ModelEvent::ToolCall(ModelToolCall {
                    id: call_id,
                    name: crate::request::local_name(&name).into(),
                    input,
                    provider_executed: false,
                    provider_options: Some(json!({"openai":{"itemId":id}})),
                }));
            }
            Item::Custom {
                id,
                call_id,
                name,
                input,
            } => {
                if !self.done.insert(id.clone()) {
                    return Err(Self::invalid(
                        "duplicate Responses custom tool finalization",
                    ));
                }
                self.tool_calls = true;
                self.observed_output = true;
                out.push(ModelEvent::ToolCall(ModelToolCall {
                    id: call_id,
                    name,
                    input: json!(input),
                    provider_executed: false,
                    provider_options: Some(json!({"openai":{"itemId":id}})),
                }));
            }
            Item::Search { id, action, status } => {
                if !self.done.insert(id.clone()) {
                    return Err(Self::invalid("duplicate Responses provider result"));
                }
                self.observed_output = true;
                self.replay_safe = false;
                let name = self
                    .search_name
                    .clone()
                    .ok_or_else(|| Self::invalid("unrequested Responses web search"))?;
                // A terminal response can contain unfinished provider work.
                // Retain its call without fabricating a settlement; the strict
                // step assembler then keeps the outcome unknown.
                if matches!(status.as_str(), "completed" | "failed") {
                    out.push(ModelEvent::ProviderToolResult {
                        id,
                        name,
                        output: json!({"action":action}),
                        is_error: status == "failed",
                        provider_options: None,
                    });
                }
            }
            Item::Other => return Err(Self::invalid("unsupported Responses output item")),
        }
        Ok(())
    }
    pub fn push(&mut self, value: Value) -> Result<Vec<ModelEvent>> {
        if self.finished {
            return Err(Self::invalid("event after Responses completion"));
        }
        if value
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|name| {
                name.starts_with("response.")
                    && (name.contains("_call.") || name.contains("tool_call"))
            })
        {
            self.observed_output = true;
            // Provider-executed tools may have produced effects even if their
            // final result has not arrived. Function input deltas are local only.
            self.replay_safe = false;
        }
        let event: Event = serde_json::from_value(value)
            .map_err(|e| Error::Invalid(format!("invalid Responses event: {e}")))?;
        let incomplete = matches!(event, Event::Incomplete { .. });
        let mut out = Vec::new();
        match event {
            Event::Created { response } => {
                self.response_id = response.id.clone();
                out.push(ModelEvent::ResponseMetadata {
                    id: response.id,
                    model: response.model,
                    timestamp: response
                        .created_at
                        .filter(|seconds| {
                            seconds.is_finite() && seconds.abs() <= 8_640_000_000_000.0
                        })
                        .and_then(|seconds| {
                            chrono::DateTime::from_timestamp_millis((seconds * 1000.0) as i64)
                        })
                        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                });
            }
            Event::Added { item } => {
                self.observe(&item, true, &mut out)?;
                match item {
                    Item::Message { id, .. } => self.start(&id, TextKind::Text, &mut out)?,
                    Item::Reasoning { id, .. } => self.start(&id, TextKind::Thinking, &mut out)?,
                    Item::Search { .. } => {
                        self.observed_output = true;
                        self.replay_safe = false;
                    }
                    Item::Function { .. } | Item::Custom { .. } => {
                        self.observed_output = true;
                    }
                    Item::Other => return Err(Self::invalid("unsupported Responses output item")),
                }
            }
            Event::Done { item } => self.final_item(item, &mut out)?,
            Event::Text { item_id, delta } => {
                self.delta(item_id, delta, TextKind::Text, &mut out)?
            }
            Event::Summary { item_id, delta } => {
                if !self.plaintext.is_some_and(|p| {
                    p.reasoning_replay == PlaintextReasoningReplay::PlaintextContent
                }) {
                    self.delta(item_id, delta, TextKind::Thinking, &mut out)?;
                }
            }
            Event::Reasoning { item_id, delta } => {
                if self.plaintext.is_some_and(|p| {
                    p.reasoning_replay == PlaintextReasoningReplay::PlaintextContent
                }) {
                    self.delta(item_id, delta, TextKind::Thinking, &mut out)?;
                }
            }
            Event::Annotation {
                item_id,
                annotation_index,
                annotation,
            } => self.citation(
                format!("{item_id}:0:{annotation_index}"),
                annotation,
                &mut out,
            )?,
            Event::Error { error } => return Err(self.provider(error)),
            Event::Failed { response } => {
                return Err(self.provider(response.error.unwrap_or(ProviderError {
                    code: None,
                    message: "Responses request failed".into(),
                })));
            }
            Event::Completed { response } | Event::Incomplete { response } => {
                let length = match response
                    .incomplete_details
                    .as_ref()
                    .map(|d| d.reason.as_str())
                {
                    None => incomplete,
                    Some("max_output_tokens") => true,
                    Some(_) => {
                        return Err(Self::invalid(
                            "Responses ended with an unsupported incomplete reason",
                        ));
                    }
                };
                // Terminal output may repeat already-finalized items or contain
                // the only complete items. Sparse Codex terminals are also valid.
                for item in response.output {
                    self.observe(&item, false, &mut out)?;
                    let id = match &item {
                        Item::Message { id, .. }
                        | Item::Reasoning { id, .. }
                        | Item::Function { id, .. }
                        | Item::Custom { id, .. }
                        | Item::Search { id, .. } => Some(id),
                        Item::Other => None,
                    };
                    if id.is_some_and(|id| self.done.contains(id)) {
                        continue;
                    }
                    self.final_item(item, &mut out)?;
                }
                if self.items.len() != self.done.len() || !self.open.is_empty() {
                    return Err(Self::invalid("Responses completed with unfinished output"));
                }
                self.finished = true;
                self.replay_safe = false;
                let usage = response
                    .usage
                    .map(|u| ModelUsage {
                        input_tokens: u.input_tokens,
                        output_tokens: u.output_tokens,
                        cache_read_tokens: u.input_tokens_details.and_then(|d| d.cached_tokens),
                        cache_write_tokens: None,
                        reasoning_tokens: u.output_tokens_details.and_then(|d| d.reasoning_tokens),
                    })
                    .unwrap_or_default();
                let id = response.id.or_else(|| self.response_id.clone());
                out.push(ModelEvent::Finished {
                    reason: if length {
                        ModelFinishReason::Length
                    } else if self.tool_calls {
                        ModelFinishReason::ToolCalls
                    } else {
                        ModelFinishReason::Stop
                    },
                    usage,
                    provider_options: id.map(|id| json!({"openai":{"responseId":id}})),
                });
            }
            Event::Other => {}
        }
        Ok(out)
    }
    fn provider(&self, error: ProviderError) -> Error {
        Error::Provider {
            code: error.code,
            message: error.message,
            observed_output: self.observed_output,
            replay_safe: self.replay_safe,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn function(id: &str, call: &str) -> Value {
        json!({"type":"function_call", "id":id, "call_id":call, "name":"Read", "arguments":"{}"})
    }
    #[test]
    fn streamed_item_identity_and_bounded_finalization_cannot_be_reinterpreted() {
        let mut decoder = Decoder::new(None, &[]);
        decoder
            .push(json!({"type":"response.output_item.added","item":function("a","raw|1")}))
            .unwrap();
        assert!(
            decoder
                .push(json!({"type":"response.output_item.done","item":function("a","raw|2")}))
                .is_err()
        );
        let mut decoder = Decoder::new(None, &[]);
        for id in 0..MAX_ITEMS {
            decoder.push(json!({"type":"response.output_item.done","item":function(&id.to_string(), &format!("call-{id}"))})).unwrap();
        }
        assert!(decoder.push(json!({"type":"response.output_item.done","item":function("overflow","call-overflow")})).is_err());
        let mut decoder = Decoder::new(None, &[]);
        decoder
            .push(json!({"type":"response.output_item.added","item":function("pending","raw|1")}))
            .unwrap();
        assert!(
            decoder
                .push(json!({"type":"response.completed","response":{"output":[]}}))
                .is_err()
        );
    }
    #[test]
    fn refusal_streams_as_text_and_sparse_completion_preserves_usage() {
        let mut decoder = Decoder::new(None, &[]);
        decoder.push(json!({"type":"response.output_item.added","item":{"type":"message","id":"msg","content":[]}})).unwrap();
        let delta = decoder
            .push(json!({"type":"response.refusal.delta","item_id":"msg","delta":"Cannot comply."}))
            .unwrap();
        assert!(
            matches!(&delta[0], ModelEvent::PartDelta { text, .. } if text == "Cannot comply.")
        );
        decoder.push(json!({"type":"response.output_item.done","item":{"type":"message","id":"msg","content":[{"type":"refusal","refusal":"Cannot comply."}]}})).unwrap();
        let end = decoder.push(json!({"type":"response.completed","response":{"output":[],"usage":{"input_tokens":5,"output_tokens":3}}})).unwrap();
        assert!(
            matches!(&end[0], ModelEvent::Finished { reason: ModelFinishReason::Stop, usage, .. } if usage.input_tokens == Some(5))
        );
        decoder.end().unwrap();
    }

    #[test]
    fn incomplete_terminals_preserve_started_search_without_inventing_its_result() {
        let tool = ToolDefinition {
            name: "Research".into(),
            description: "search".into(),
            input_schema: json!({}),
            provider: Some(maka_runtime::tools::ProviderTool {
                id: "openai.web_search".into(),
                args: json!({}),
            }),
        };
        for (status, settled) in [
            ("in_progress", false),
            ("completed", true),
            ("failed", true),
        ] {
            let mut decoder = Decoder::new(None, std::slice::from_ref(&tool));
            let start = decoder
                .push(json!({"type":"response.output_item.added",
                "item":{"type":"web_search_call","id":"search","status":"in_progress"}}))
                .unwrap();
            assert!(matches!(&start[..], [ModelEvent::ToolCall(call)] if call.provider_executed));
            assert!(!decoder.replay_safe);
            let end = decoder
                .push(json!({"type":"response.incomplete","response":{"output":[
                {"type":"web_search_call","id":"search","status":status}]}}))
                .unwrap();
            assert!(
                !end.iter()
                    .any(|event| matches!(event, ModelEvent::ToolCall(_)))
            );
            assert_eq!(
                end.iter()
                    .any(|event| matches!(event, ModelEvent::ProviderToolResult { .. })),
                settled
            );
            assert!(matches!(
                end.last(),
                Some(ModelEvent::Finished {
                    reason: ModelFinishReason::Length,
                    ..
                })
            ));
        }
    }
}
