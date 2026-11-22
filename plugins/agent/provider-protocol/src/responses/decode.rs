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

use super::{
    Citation, Error, Event as OutputEvent, ItemMetadata, MessagePhase, PartMetadata, ReasoningMode,
    Result, ToolInput,
};
use crate::output::{Stop, TextKind, Usage as OutputUsage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

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
    Summary {
        item_id: String,
        #[serde(default)]
        summary_index: usize,
        delta: String,
    },
    #[serde(rename = "response.reasoning_text.delta")]
    Reasoning { item_id: String, delta: String },
    #[serde(rename = "response.function_call_arguments.delta")]
    FunctionInput { item_id: String, delta: String },
    #[serde(rename = "response.custom_tool_call_input.delta")]
    CustomInput { item_id: String, delta: String },
    #[serde(rename = "response.output_text.annotation.added")]
    Annotation {
        item_id: String,
        #[serde(default)]
        content_index: usize,
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
        phase: Option<MessagePhase>,
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
    #[serde(untagged)]
    Hosted(HostedItem),
}

// A protocol item type or an explicit execution owner identifies remote work.
// Function/custom calls are decoded above and always require client admission.
#[derive(Deserialize, Serialize)]
struct HostedItem {
    #[serde(rename = "type")]
    kind: String,
    id: Option<String>,
    #[serde(flatten)]
    fields: serde_json::Map<String, Value>,
}
impl HostedItem {
    fn item_id(&self) -> &str {
        self.id.as_deref().unwrap_or_else(|| self.call_id())
    }
    fn call_id(&self) -> &str {
        self.fields
            .get("call_id")
            .and_then(Value::as_str)
            .unwrap_or(self.id.as_deref().unwrap_or(""))
    }
    fn name(&self) -> &str {
        self.fields
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or(&self.kind)
    }
    fn into_wire(mut self) -> Value {
        self.fields.insert("type".into(), Value::String(self.kind));
        if let Some(id) = self.id {
            self.fields.insert("id".into(), Value::String(id));
        }
        Value::Object(self.fields)
    }
    fn settlement(&self) -> Option<bool> {
        let error = self.fields.get("error").is_some_and(|v| !v.is_null());
        match self.fields.get("status").and_then(Value::as_str) {
            Some("completed") => Some(error),
            Some("failed" | "incomplete") => Some(true),
            None if error
                || ["output", "outputs", "results", "result", "tools"]
                    .iter()
                    .any(|key| self.fields.get(*key).is_some_and(|v| !v.is_null())) =>
            {
                Some(error)
            }
            _ => None,
        }
    }
    fn is_hosted(&self) -> bool {
        if matches!(
            self.kind.as_str(),
            "function_call"
                | "custom_tool_call"
                | "computer_call"
                | "local_shell_call"
                | "apply_patch_call"
                | "mcp_approval_request"
        ) {
            return false;
        }
        match self.fields.get("execution").and_then(Value::as_str) {
            Some(owner) => owner == "server" && self.kind.ends_with("_call"),
            None if self.kind == "shell_call" => self
                .fields
                .get("environment")
                .is_some_and(|v| v["type"] == "container_reference"),
            None => matches!(
                self.kind.as_str(),
                "file_search_call"
                    | "code_interpreter_call"
                    | "image_generation_call"
                    | "mcp_call"
                    | "mcp_list_tools"
                    | "x_search_call"
            ),
        }
    }
}

#[derive(PartialEq, Eq)]
enum Identity {
    Message,
    Reasoning,
    Function {
        call_id: String,
        name: String,
    },
    Custom {
        call_id: String,
        name: String,
    },
    Search,
    Hosted {
        kind: String,
        call_id: String,
        name: String,
    },
}
struct ObservedItem {
    identity: Identity,
    input_started: bool,
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
            Self::Hosted(item) if item.is_hosted() => (
                item.item_id(),
                Identity::Hosted {
                    kind: item.kind.clone(),
                    call_id: item.call_id().into(),
                    name: item.name().into(),
                },
            ),
            Self::Hosted(_) => {
                return Err(Error::Invalid("unsupported Responses output item".into()));
            }
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
    cache_write_tokens: Option<u64>,
}
#[derive(Deserialize)]
struct OutputTokens {
    reasoning_tokens: Option<u64>,
}
#[derive(Deserialize, Serialize)]
pub(crate) struct ProviderError {
    pub code: Option<Value>,
    pub message: String,
    #[serde(flatten)]
    pub fields: BTreeMap<String, Value>,
}
struct Part {
    kind: TextKind,
    text: String,
    summary_index: Option<usize>,
    summary_breaks: Vec<usize>,
    annotations: BTreeMap<(usize, u64), Annotation>,
}
pub struct Decoder {
    reasoning: ReasoningMode,
    open: BTreeMap<String, Part>,
    seen: HashSet<String>,
    items: BTreeMap<String, ObservedItem>,
    done: HashSet<String>,
    citations: HashSet<String>,
    response_id: Option<String>,
    tool_calls: bool,
    search_name: Option<String>,
    finished: bool,
    pub observed_output: bool,
    pub replay_safe: bool,
    pending_effects: HashSet<String>,
    pending_receipts: BTreeMap<String, HostedItem>,
    receipt_ids: HashSet<String>,
}
impl Decoder {
    pub fn new(reasoning: ReasoningMode, search_name: Option<String>) -> Self {
        Self {
            reasoning,
            open: BTreeMap::new(),
            seen: HashSet::new(),
            items: BTreeMap::new(),
            done: HashSet::new(),
            citations: HashSet::new(),
            response_id: None,
            tool_calls: false,
            finished: false,
            observed_output: false,
            replay_safe: true,
            pending_effects: HashSet::new(),
            pending_receipts: BTreeMap::new(),
            receipt_ids: HashSet::new(),
            search_name,
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
                retained_output_safe: self.retained_output_safe(),
            })
        }
    }
    pub fn retained_output_safe(&self) -> bool {
        !self.finished && self.pending_effects.is_empty()
    }

    fn search_name(&self) -> &str {
        self.search_name.as_deref().unwrap_or("web_search")
    }

    fn invalid(message: &str) -> Error {
        Error::Invalid(message.into())
    }
    fn observe(&mut self, item: &Item, added: bool, out: &mut Vec<OutputEvent>) -> Result<()> {
        let (id, identity) = item.identity()?;
        if id.is_empty() {
            return Err(Self::invalid("invalid Responses item identity"));
        }
        if let Some(previous) = self.items.get(id) {
            let matches = match (&previous.identity, &identity) {
                (
                    Identity::Hosted {
                        kind,
                        call_id,
                        name,
                    },
                    Identity::Hosted {
                        kind: next_kind,
                        call_id: next_id,
                        name: next_name,
                    },
                ) => {
                    kind == next_kind
                        && call_id == next_id
                        && (name == next_name || name == kind || next_name == kind)
                }
                (first, next) => first == next,
            };
            if added || !matches {
                return Err(Self::invalid(
                    "Responses item identity changed or duplicated",
                ));
            }
        } else {
            if let Identity::Function { call_id, name } | Identity::Custom { call_id, name } =
                &identity
                && (call_id.is_empty() || name.is_empty())
            {
                return Err(Self::invalid("invalid Responses tool identity"));
            }
            let hosted = match item {
                Item::Search { .. } => Some((id, self.search_name(), "{}".to_owned())),
                Item::Hosted(item) => Some((
                    item.call_id(),
                    item.name(),
                    match item.fields.get("arguments") {
                        Some(Value::String(arguments)) => arguments.clone(),
                        Some(arguments) => arguments.to_string(),
                        None => "{}".into(),
                    },
                )),
                _ => None,
            };
            if let Some((call_id, name, arguments)) = hosted {
                if call_id.is_empty() || name.is_empty() {
                    return Err(Self::invalid("invalid Responses tool identity"));
                }
                let name = name.to_owned();
                self.pending_effects.insert(id.into());
                self.observed_output = true;
                self.replay_safe = false;
                out.push(OutputEvent::ToolCall {
                    id: call_id.into(),
                    name,
                    input: ToolInput::Function(arguments),
                    provider_executed: true,
                    metadata: ItemMetadata {
                        id: match item {
                            Item::Hosted(item) => item.id.clone().unwrap_or_default(),
                            _ => id.into(),
                        },
                        replay: None,
                        encrypted_content: None,
                    },
                });
            }
            let mut input_started = false;
            if let Identity::Function { call_id, name } | Identity::Custom { call_id, name } =
                &identity
                && added
            {
                input_started = true;
                out.push(OutputEvent::ToolInputStarted {
                    id: call_id.clone(),
                    name: name.clone(),
                });
            }
            self.items.insert(
                id.into(),
                ObservedItem {
                    identity,
                    input_started,
                },
            );
        }
        Ok(())
    }
    fn input_delta(
        &self,
        item_id: &str,
        text: String,
        custom: bool,
        out: &mut Vec<OutputEvent>,
    ) -> Result<()> {
        let Some(item) = self.items.get(item_id) else {
            // A display-only delta cannot identify a call; its complete item can.
            return Ok(());
        };
        if !item.input_started {
            return Err(Self::invalid("Responses input delta has no open tool item"));
        }
        let call_id = match &item.identity {
            Identity::Function { call_id, .. } if !custom => call_id,
            Identity::Custom { call_id, .. } if custom => call_id,
            _ => return Err(Self::invalid("Responses input delta has invalid tool kind")),
        };
        out.push(OutputEvent::ToolInputDelta {
            id: call_id.clone(),
            text,
        });
        Ok(())
    }
    fn finish_input(&mut self, item_id: &str, call_id: &str, out: &mut Vec<OutputEvent>) {
        if self
            .items
            .get_mut(item_id)
            .is_some_and(|item| std::mem::take(&mut item.input_started))
        {
            out.push(OutputEvent::ToolInputFinished { id: call_id.into() });
        }
    }
    fn start(
        &mut self,
        id: &str,
        kind: TextKind,
        phase: Option<MessagePhase>,
        out: &mut Vec<OutputEvent>,
    ) -> Result<()> {
        if id.is_empty() || !self.seen.insert(id.into()) {
            return Err(Self::invalid("invalid or duplicate Responses output item"));
        }
        self.observed_output = true;
        self.open.insert(
            id.into(),
            Part {
                kind,
                text: String::new(),
                summary_index: None,
                summary_breaks: Vec::new(),
                annotations: BTreeMap::new(),
            },
        );
        out.push(OutputEvent::PartStarted {
            id: id.into(),
            kind,
            phase,
        });
        Ok(())
    }
    fn delta(
        &mut self,
        id: String,
        text: String,
        kind: TextKind,
        summary_index: Option<usize>,
        out: &mut Vec<OutputEvent>,
    ) -> Result<()> {
        let part = self
            .open
            .get_mut(&id)
            .ok_or_else(|| Self::invalid("Responses delta has no open item"))?;
        if part.kind != kind {
            return Err(Self::invalid("Responses delta has invalid kind"));
        }
        let summary_breaks = summary_index.and_then(|index| {
            let changed = part.summary_index.is_some_and(|previous| previous != index);
            part.summary_index = Some(index);
            if changed {
                part.summary_breaks.push(part.text.len());
                Some(part.summary_breaks.clone())
            } else {
                None
            }
        });
        part.text.push_str(&text);
        out.push(OutputEvent::PartDelta {
            id,
            text,
            summary_breaks,
        });
        Ok(())
    }
    fn finish_part(
        &mut self,
        id: String,
        text: String,
        kind: TextKind,
        metadata: Option<PartMetadata>,
        out: &mut Vec<OutputEvent>,
    ) -> Result<()> {
        if !self.seen.contains(&id) {
            self.start(&id, kind, None, out)?;
        }
        let part = self
            .open
            .get(&id)
            .ok_or_else(|| Self::invalid("Responses item was already finalized"))?;
        if part.kind != kind || !text.starts_with(&part.text) {
            return Err(Self::invalid(
                "final Responses item disagrees with streamed text",
            ));
        }
        if text.len() > part.text.len() {
            self.delta(id.clone(), text[part.text.len()..].into(), kind, None, out)?;
        }
        if metadata.is_some() {
            self.replay_safe = false;
        }
        self.open.remove(&id);
        self.done.insert(id.clone());
        out.push(OutputEvent::PartFinished { id, metadata });
        Ok(())
    }
    fn citation(
        &mut self,
        item_id: &str,
        content_index: usize,
        annotation_index: u64,
        annotation: Annotation,
        span: Option<&std::ops::Range<u64>>,
        out: &mut Vec<OutputEvent>,
    ) {
        let id = format!("{item_id}:{content_index}:{annotation_index}");
        if let Annotation::Url {
            url,
            title,
            start_index,
            end_index,
        } = annotation
            && self.citations.insert(id.clone())
        {
            self.replay_safe = false;
            let anchor = span.and_then(|span| {
                let (start, end) = start_index.zip(end_index)?;
                (start < end && end <= span.end - span.start).then(|| {
                    crate::output::CitationAnchor::Range {
                        part: item_id.to_owned(),
                        start: span.start + start,
                        end: span.start + end,
                    }
                })
            });
            out.push(OutputEvent::Citation(Citation {
                id,
                item_id: item_id.to_owned(),
                content_index,
                anchor,
                url,
                title,
                start_index,
                end_index,
            }));
        }
    }
    fn message_citations(
        &mut self,
        id: &str,
        content: Vec<Text>,
        mut annotations: BTreeMap<(usize, u64), Annotation>,
        out: &mut Vec<OutputEvent>,
    ) {
        if annotations.is_empty() && content.iter().all(|part| part.annotations.is_empty()) {
            return;
        }
        let mut offset = 0;
        let spans: Vec<_> = content
            .into_iter()
            .enumerate()
            .map(|(index, part)| {
                let start = offset;
                offset += part.text.chars().count() as u64;
                annotations.extend(
                    part.annotations
                        .into_iter()
                        .enumerate()
                        .map(|(i, annotation)| ((index, i as u64), annotation)),
                );
                start..offset
            })
            .collect();
        for ((content_index, annotation_index), annotation) in annotations {
            self.citation(
                id,
                content_index,
                annotation_index,
                annotation,
                spans.get(content_index),
                out,
            );
        }
    }
    fn final_item(
        &mut self,
        item: Item,
        replay: Option<super::Replay>,
        out: &mut Vec<OutputEvent>,
    ) -> Result<()> {
        self.observe(&item, false, out)?;
        if self.done.contains(item.identity()?.0) {
            return Err(Self::invalid("duplicate Responses item finalization"));
        }
        let metadata = |id: &str| ItemMetadata {
            id: id.into(),
            replay: replay.clone(),
            encrypted_content: None,
        };
        match item {
            Item::Message { id, phase, content } => {
                let mut text = String::new();
                for part in &content {
                    if !matches!(part.r#type.as_str(), "output_text" | "refusal") {
                        return Err(Self::invalid("unsupported Responses message content"));
                    }
                    text.push_str(&part.text);
                }
                let annotations = self
                    .open
                    .get_mut(&id)
                    .map(|part| std::mem::take(&mut part.annotations))
                    .unwrap_or_default();
                let item = metadata(&id);
                let metadata = match phase {
                    Some(phase @ (MessagePhase::Commentary | MessagePhase::FinalAnswer)) => {
                        PartMetadata::Message { item, phase }
                    }
                    _ => PartMetadata::Item(item),
                };
                self.finish_part(id.clone(), text, TextKind::Text, Some(metadata), out)?;
                self.message_citations(&id, content, annotations, out);
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
                let (parts, carrier) = match self.reasoning {
                    ReasoningMode::PlaintextContent => (content, "reasoning_text"),
                    ReasoningMode::Encrypted | ReasoningMode::PlaintextSummary => {
                        (summary, "summary_text")
                    }
                };
                if parts.iter().any(|part| part.r#type != carrier) {
                    return Err(Self::invalid(
                        "invalid finalized Responses reasoning carrier",
                    ));
                }
                let text = parts
                    .iter()
                    .map(|part| part.text.as_str())
                    .collect::<String>();
                let metadata = match self.reasoning {
                    ReasoningMode::PlaintextSummary => Some(PartMetadata::PlaintextSummary {
                        item_id: id.clone(),
                        summary_part_lengths: parts
                            .iter()
                            .map(|part| part.text.encode_utf16().count())
                            .collect(),
                    }),
                    ReasoningMode::PlaintextContent => None,
                    ReasoningMode::Encrypted => {
                        let mut value = metadata(&id);
                        value.encrypted_content = encrypted_content;
                        Some(PartMetadata::Item(value))
                    }
                };
                self.finish_part(id, text, TextKind::Reasoning, metadata, out)?;
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
                self.replay_safe = false; // The emitted call includes opaque provider metadata.
                let input = ToolInput::Function(arguments);
                self.finish_input(&id, &call_id, out);
                out.push(OutputEvent::ToolCall {
                    id: call_id,
                    name,
                    input,
                    provider_executed: false,
                    metadata: metadata(&id),
                });
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
                self.replay_safe = false; // The emitted call includes opaque provider metadata.
                self.finish_input(&id, &call_id, out);
                out.push(OutputEvent::ToolCall {
                    id: call_id,
                    name,
                    input: ToolInput::Custom(input),
                    provider_executed: false,
                    metadata: metadata(&id),
                });
            }
            Item::Search { id, action, status } => {
                if !self.done.insert(id.clone()) {
                    return Err(Self::invalid("duplicate Responses provider result"));
                }
                self.observed_output = true;
                self.replay_safe = false;
                // A terminal response can contain unfinished provider work.
                // Retain its call without fabricating a settlement; the strict
                // step assembler then keeps the outcome unknown.
                if matches!(status.as_str(), "completed" | "failed") {
                    self.pending_effects.remove(&id);
                    let metadata = metadata(&id);
                    out.push(OutputEvent::ToolResult {
                        id,
                        name: self.search_name().to_owned(),
                        action,
                        is_error: status == "failed",
                        metadata,
                    });
                }
            }
            Item::Hosted(item) => {
                self.done.insert(item.item_id().to_owned());
                if matches!(item.kind.as_str(), "shell_call" | "tool_search_call")
                    && item.settlement() != Some(true)
                {
                    self.pending_receipts
                        .insert(item.call_id().to_owned(), item);
                } else if let Some(is_error) = item.settlement() {
                    self.settle_hosted(item, None, is_error, out);
                }
            }
        }
        Ok(())
    }
    fn settle_hosted(
        &mut self,
        call: HostedItem,
        receipt: Option<HostedItem>,
        is_error: bool,
        out: &mut Vec<OutputEvent>,
    ) {
        self.pending_effects.remove(call.item_id());
        let id = call.call_id().to_owned();
        let Identity::Hosted { name, .. } = &self.items[call.item_id()].identity else {
            unreachable!("observed hosted call")
        };
        let name = name.clone();
        let mut items = vec![call.into_wire()];
        if let Some(receipt) = receipt {
            if !receipt.item_id().is_empty() {
                self.receipt_ids.insert(receipt.item_id().into());
            }
            items.push(receipt.into_wire());
        }
        out.push(OutputEvent::HostedResult {
            id,
            name,
            items,
            is_error,
        });
    }

    fn take_call(&mut self, item: Item, done: bool, out: &mut Vec<OutputEvent>) -> Option<Item> {
        let Item::Hosted(record) = item else {
            return Some(item);
        };
        if record.item_id().is_empty() && record.is_hosted() {
            // No stable identity is available for this server activity.
            self.observed_output = true;
            self.replay_safe = false;
            return None;
        }
        let call_kind = match record.kind.as_str() {
            "shell_call_output" => "shell_call",
            "tool_search_output" => "tool_search_call",
            _ => return Some(Item::Hosted(record)),
        };
        let owner = record.fields.get("execution").and_then(Value::as_str);
        if owner.is_some_and(|owner| owner != "server") {
            return Some(Item::Hosted(record));
        }
        if self.receipt_ids.contains(record.item_id()) {
            return None;
        }
        let key = record.fields.get("call_id").and_then(Value::as_str);
        let paired = key.filter(|k| {
            self.pending_receipts
                .get(*k)
                .is_some_and(|c| c.kind == call_kind)
        });
        if paired.is_none() && owner != Some("server") {
            return Some(Item::Hosted(record));
        }
        self.observed_output = true;
        self.replay_safe = false;
        if done
            && let Some(is_error) = record.settlement()
            && let Some(call) = paired.and_then(|key| self.pending_receipts.remove(key))
        {
            self.settle_hosted(call, Some(record), is_error, out);
        }
        None
    }
    pub fn push(&mut self, value: Value) -> Result<Vec<OutputEvent>> {
        if self.finished {
            return Err(Self::invalid("event after Responses completion"));
        }
        if value
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|name| {
                name.starts_with("response.")
                    && (name.contains("_call.") || name.contains("tool_call"))
                    && !name.starts_with("response.custom_tool_call_input.")
            })
        {
            self.observed_output = true;
            // Provider-executed tools may have produced effects even if their
            // final result has not arrived. Function input deltas are local only.
            self.replay_safe = false;
            let id = value["item_id"].as_str().unwrap_or("");
            self.pending_effects.insert(id.into());
        }
        let mut replay = BTreeMap::new();
        let items = if value["type"] == "response.output_item.done" {
            std::slice::from_ref(&value["item"])
        } else {
            value["response"]["output"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
        };
        for item in items {
            if (self.reasoning == ReasoningMode::Encrypted || item["type"] == "web_search_call")
                && let Some(id) = item["id"].as_str()
                && !self.done.contains(id)
                && let Some(template) = super::replay::capture(item)
            {
                replay.insert(id.to_owned(), template);
            }
        }
        let event: Event = serde_json::from_value(value)
            .map_err(|e| Error::Invalid(format!("invalid Responses event: {e}")))?;
        let incomplete = matches!(event, Event::Incomplete { .. });
        let mut out = Vec::new();
        match event {
            Event::Created { response } => {
                self.response_id = response.id.clone();
                out.push(OutputEvent::ResponseMetadata {
                    id: response.id,
                    model: response.model,
                    created_at_unix_seconds: response.created_at,
                });
            }
            Event::Added { item } => {
                let Some(item) = self.take_call(item, false, &mut out) else {
                    return Ok(out);
                };
                self.observe(&item, true, &mut out)?;
                match item {
                    Item::Message { id, phase, .. } => {
                        self.start(&id, TextKind::Text, phase, &mut out)?
                    }
                    Item::Reasoning { id, .. } => {
                        self.start(&id, TextKind::Reasoning, None, &mut out)?
                    }
                    Item::Search { .. } => {
                        self.observed_output = true;
                        self.replay_safe = false;
                    }
                    Item::Function { .. } | Item::Custom { .. } => {
                        self.observed_output = true;
                    }
                    Item::Hosted(_) => {}
                }
            }
            Event::Done { item } => {
                let Some(item) = self.take_call(item, true, &mut out) else {
                    return Ok(out);
                };
                let template = replay.remove(item.identity()?.0);
                self.final_item(item, template, &mut out)?;
            }
            Event::Text { item_id, delta } => {
                self.delta(item_id, delta, TextKind::Text, None, &mut out)?
            }
            Event::Summary {
                item_id,
                summary_index,
                delta,
            } => {
                if self.reasoning != ReasoningMode::PlaintextContent {
                    self.delta(
                        item_id,
                        delta,
                        TextKind::Reasoning,
                        Some(summary_index),
                        &mut out,
                    )?;
                }
            }
            Event::Reasoning { item_id, delta } => {
                if self.reasoning == ReasoningMode::PlaintextContent {
                    self.delta(item_id, delta, TextKind::Reasoning, None, &mut out)?;
                }
            }
            Event::FunctionInput { item_id, delta } => {
                self.input_delta(&item_id, delta, false, &mut out)?;
            }
            Event::CustomInput { item_id, delta } => {
                self.input_delta(&item_id, delta, true, &mut out)?;
            }
            Event::Annotation {
                item_id,
                content_index,
                annotation_index,
                annotation,
            } => {
                if let Some(part) = self.open.get_mut(&item_id) {
                    if matches!(annotation, Annotation::Url { .. }) {
                        self.replay_safe = false;
                        part.annotations
                            .insert((content_index, annotation_index), annotation);
                    }
                } else {
                    self.citation(
                        &item_id,
                        content_index,
                        annotation_index,
                        annotation,
                        None,
                        &mut out,
                    );
                }
            }
            Event::Error { error } => return Err(self.provider(error)),
            Event::Failed { response } => {
                return Err(self.provider(response.error.unwrap_or(ProviderError {
                    code: None,
                    fields: BTreeMap::new(),
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
                    let Some(item) = self.take_call(item, true, &mut out) else {
                        continue;
                    };
                    self.observe(&item, false, &mut out)?;
                    if self.done.contains(item.identity()?.0) {
                        if let Item::Message { id, content, .. } = item {
                            self.message_citations(&id, content, BTreeMap::new(), &mut out);
                        }
                        continue;
                    }
                    let template = replay.remove(item.identity()?.0);
                    self.final_item(item, template, &mut out)?;
                }
                for (_, call) in std::mem::take(&mut self.pending_receipts) {
                    // The provider confirmed completion even when it omitted a separate output.
                    if let Some(is_error) = call.settlement() {
                        self.settle_hosted(call, None, is_error, &mut out);
                    }
                }
                if self.items.len() != self.done.len() || !self.open.is_empty() {
                    return Err(Self::invalid("Responses completed with unfinished output"));
                }
                self.finished = true;
                self.replay_safe = false;
                let usage = response
                    .usage
                    .map(|usage| OutputUsage {
                        input: usage.input_tokens,
                        output: usage.output_tokens,
                        cache_read: usage
                            .input_tokens_details
                            .as_ref()
                            .and_then(|details| details.cached_tokens),
                        cache_write: usage
                            .input_tokens_details
                            .and_then(|details| details.cache_write_tokens),
                        reasoning: usage
                            .output_tokens_details
                            .and_then(|details| details.reasoning_tokens),
                        ..Default::default()
                    })
                    .unwrap_or_default();
                let response_id = response.id.or_else(|| self.response_id.clone());
                out.push(OutputEvent::Finished {
                    reason: if length {
                        Stop::Length
                    } else if self.tool_calls {
                        Stop::ToolCalls
                    } else {
                        Stop::Stop
                    },
                    usage,
                    response_id,
                });
            }
            Event::Other => {}
        }
        Ok(out)
    }
    fn provider(&self, error: ProviderError) -> Error {
        let data = serde_json::to_value(&error).expect("provider error contains only JSON fields");
        Error::Provider {
            error: Box::new(crate::output::ProviderError {
                kind: data.get("type").and_then(Value::as_str).map(str::to_owned),
                code: error.code,
                message: Some(error.message),
                status: None,
                retryable: None,
                data,
            }),
            observed_output: self.observed_output,
            replay_safe: self.replay_safe,
            retained_output_safe: self.retained_output_safe(),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hosted_output_items_settle_once_without_dispatching_a_local_tool() {
        for kind in [
            "file_search_call",
            "code_interpreter_call",
            "image_generation_call",
            "mcp_call",
            "mcp_list_tools",
        ] {
            let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
            let call = json!({"type":kind,"id":"i","name":"same","status":"in_progress"});
            let done = json!({"type":kind,"id":"i","name":"same","status":"completed","output":"evidence"});
            let events = decoder
                .push(json!({"type":"response.output_item.added","item":call}))
                .unwrap();
            assert!(
                matches!(&events[..],[OutputEvent::ToolCall{id,name,provider_executed:true,..}] if id=="i" && name=="same")
            );
            assert!(!decoder.retained_output_safe());
            let events = decoder
                .push(json!({"type":"response.output_item.done","item":done}))
                .unwrap();
            assert!(
                matches!(&events[..],[OutputEvent::HostedResult{id,items,is_error:false,..}] if id=="i" && items==std::slice::from_ref(&done))
            );
            assert!(decoder.retained_output_safe());
            let events = decoder
                .push(json!({"type":"response.completed","response":{"output":[done]}}))
                .unwrap();
            assert!(matches!(
                &events[..],
                [OutputEvent::Finished {
                    reason: Stop::Stop,
                    ..
                }]
            ));
        }
    }

    #[test]
    fn split_server_output_is_bound_by_call_id_and_client_requests_stay_local() {
        let mut decoder = Decoder::new(ReasoningMode::PlaintextContent, None);
        let call = json!({"type":"shell_call","execution":"server","id":"item","call_id":"remote","name":"same","status":"in_progress","arguments":{"cmd":"status"}});
        let receipt =
            json!({"type":"shell_call_output","call_id":"remote","output":[{"stdout":"ok"}]});
        let local = json!({"type":"function_call","id":"item2","call_id":"local","name":"same","arguments":"{}"});
        let events = decoder
            .push(json!({"type":"response.completed","response":{"output":[call,receipt,local]}}))
            .unwrap();
        assert!(
            matches!(&events[..],[OutputEvent::ToolCall{id,..},OutputEvent::HostedResult{id:r,items,..},OutputEvent::ToolCall{id:l,provider_executed:false,..},OutputEvent::Finished{reason:Stop::ToolCalls,..}] if id=="remote" && r==id && l=="local" && *items==vec![call,receipt])
        );
        let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
        assert!(decoder.push(json!({"type":"response.output_item.done","item":{"type":"computer_call","id":"x","name":"mcp_call","status":"completed"}})).is_err());
    }

    #[test]
    fn deepseek_search_results_and_citations_survive_plaintext_responses() {
        use super::super::request::{Input, Request, SearchKind, Tool};

        let reasoning = ReasoningMode::PlaintextContent;
        for (model, kind, wire_type, action, citation) in [
            (
                "deepseek-v4-pro",
                SearchKind::Search,
                "web_search",
                json!({"type":"search","queries":["official Python site","ws_call_id=fixture"]}),
                None,
            ),
            (
                "deepseek-flash",
                SearchKind::Deepseek,
                "deepseek_web_search",
                json!({"type":"search","sources":[{"url":"https://www.python.org/","title":"Python"}]}),
                Some(
                    json!({"type":"url_citation","url":"https://www.python.org/","title":"Python","start_index":0,"end_index":6}),
                ),
            ),
        ] {
            let mut decoder = Decoder::new(reasoning, Some("WebSearch".into()));
            let mut item = json!({
                "type":"web_search_call","id":"ws_fixture","status":"completed","action":action
            });
            if kind == SearchKind::Deepseek {
                item["kind"] = json!("search");
            }
            decoder
                .push(json!({
                    "type":"response.output_item.added",
                    "item":{"type":"web_search_call","id":"ws_fixture","status":"in_progress"}
                }))
                .unwrap();
            let events = decoder
                .push(json!({"type":"response.output_item.done","item":item}))
                .unwrap();
            let [
                OutputEvent::ToolResult {
                    action, metadata, ..
                },
            ] = events.as_slice()
            else {
                panic!("expected a settled search call, got {events:?}");
            };
            let request = Request {
                model,
                input: &[Input::ProviderResult {
                    replay: metadata.replay.clone(),
                    action: action.clone(),
                }],
                tools: &[Tool::WebSearch {
                    kind,
                    args: json!({}),
                }],
                tool_choice: Default::default(),
                options: &json!({"openResponses":{}}),
                max_output_tokens: None,
                reasoning,
            }
            .encode()
            .unwrap();
            assert_eq!(request["tools"], json!([{"type":wire_type}]));
            assert_eq!(request["input"], json!([item]));
            if let Some(annotation) = citation {
                let events = decoder
                    .push(json!({
                        "type":"response.output_text.annotation.added",
                        "item_id":"msg_fixture","annotation_index":0,"annotation":annotation
                    }))
                    .unwrap();
                assert!(matches!(events.as_slice(), [OutputEvent::Citation(c)]
                    if c.url == "https://www.python.org/" && c.title.as_deref() == Some("Python")));
            }
        }
    }

    #[test]
    fn summary_deltas_retain_item_boundaries_without_rewriting_replay_text() {
        let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
        decoder
            .push(json!({"type":"response.output_item.added","item":{
                "type":"reasoning","id":"r","summary":[]
            }}))
            .unwrap();
        let mut deltas = Vec::new();
        for (index, delta) in [(0, "**检查"), (0, "🙂**"), (1, "**Build**")] {
            for event in decoder
                .push(json!({"type":"response.reasoning_summary_text.delta",
                "item_id":"r","summary_index":index,"delta":delta}))
                .unwrap()
            {
                if let OutputEvent::PartDelta {
                    text,
                    summary_breaks,
                    ..
                } = event
                {
                    deltas.push((text, summary_breaks));
                }
            }
        }
        assert_eq!(
            deltas,
            [
                ("**检查".into(), None),
                ("🙂**".into(), None),
                ("**Build**".into(), Some(vec![14]))
            ]
        );
        let original = json!({"type":"reasoning","id":"r","summary":[
            {"type":"summary_text","text":"**检查🙂**"},
            {"type":"summary_text","text":"**Build**"}
        ],"encrypted_content":"opaque"});
        let events = decoder
            .push(json!({"type":"response.output_item.done","item":original}))
            .unwrap();
        let replayed = events
            .into_iter()
            .find_map(|event| {
                let OutputEvent::PartFinished {
                    metadata: Some(PartMetadata::Item(metadata)),
                    ..
                } = event
                else {
                    return None;
                };
                Some(
                    metadata
                        .replay
                        .unwrap()
                        .text(
                            "**检查🙂****Build**",
                            "reasoning",
                            metadata.encrypted_content.as_deref(),
                        )
                        .unwrap(),
                )
            })
            .unwrap();
        assert_eq!(replayed, original);
    }

    fn function(id: &str, call_id: &str) -> Value {
        json!({"type":"function_call","id":id,"call_id":call_id,"name":"Read","arguments":"{}"})
    }

    #[test]
    fn unassociated_input_previews_preserve_complete_calls_and_retry_safety() {
        for (kind, item, expected_input) in [
            (
                "response.function_call_arguments.delta",
                function("item", "call"),
                ToolInput::Function("{}".into()),
            ),
            (
                "response.custom_tool_call_input.delta",
                json!({"type":"custom_tool_call","id":"item","call_id":"call","name":"Read","input":"complete input"}),
                ToolInput::Custom("complete input".into()),
            ),
        ] {
            let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
            assert!(
                decoder
                    .push(json!({"type":kind,"item_id":"item","delta":"unassociated preview"}))
                    .unwrap()
                    .is_empty()
            );
            assert!(!decoder.observed_output);
            assert!(decoder.replay_safe);
            assert!(decoder.retained_output_safe());
            let expected_replay = super::super::replay::capture(&item).unwrap();
            let events = decoder
                .push(json!({"type":"response.output_item.done","item":item}))
                .unwrap();
            let [
                OutputEvent::ToolCall {
                    id,
                    name,
                    input,
                    provider_executed,
                    metadata,
                },
            ] = &events[..]
            else {
                panic!("expected one complete tool call");
            };
            assert_eq!(id, "call");
            assert_eq!(name, "Read");
            assert_eq!(input, &expected_input);
            assert!(!*provider_executed);
            assert_eq!(metadata.id, "item");
            assert_eq!(
                serde_json::to_value(metadata.replay.as_ref().unwrap()).unwrap(),
                serde_json::to_value(expected_replay).unwrap()
            );
            assert!(metadata.encrypted_content.is_none());
            assert!(decoder.observed_output);
            assert!(!decoder.replay_safe);
            assert!(decoder.retained_output_safe());
        }
    }

    #[test]
    fn observed_input_deltas_require_open_matching_tools_and_never_replace_complete_calls() {
        let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
        decoder
            .push(json!({"type":"response.output_item.added","item":function("item","call")}))
            .unwrap();
        assert!(decoder.push(json!({"type":"response.custom_tool_call_input.delta","item_id":"item","delta":"{"})).is_err());
        let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
        let start = decoder
            .push(json!({"type":"response.output_item.added","item":function("item","call")}))
            .unwrap();
        assert!(
            matches!(&start[..], [OutputEvent::ToolInputStarted { id, name }] if id == "call" && name == "Read")
        );
        let delta = decoder.push(json!({"type":"response.function_call_arguments.delta","item_id":"item","delta":"{\"path\":\"你"})).unwrap();
        assert!(
            matches!(&delta[..], [OutputEvent::ToolInputDelta { id, text }] if id == "call" && text == "{\"path\":\"你")
        );
        let final_events = decoder
            .push(json!({"type":"response.output_item.done","item":function("item","call")}))
            .unwrap();
        assert!(
            matches!(&final_events[..], [OutputEvent::ToolInputFinished { id }, OutputEvent::ToolCall { id: call_id, input: ToolInput::Function(input), .. }]
            if id == "call" && call_id == "call" && input == "{}")
        );
        assert!(decoder.push(json!({"type":"response.function_call_arguments.delta","item_id":"item","delta":"好\"}"})).is_err());
        let end = decoder.push(json!({"type":"response.completed","response":{"output":[function("item","call")]}})).unwrap();
        assert!(matches!(
            &end[..],
            [OutputEvent::Finished {
                reason: Stop::ToolCalls,
                ..
            }]
        ));
    }

    #[test]
    fn streamed_item_identity_and_finalization_cannot_be_reinterpreted() {
        let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
        decoder
            .push(json!({"type":"response.output_item.added","item":function("a","raw|1")}))
            .unwrap();
        assert!(
            decoder
                .push(json!({"type":"response.output_item.done","item":function("a","raw|2")}))
                .is_err()
        );
        let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
        for id in 0..130 {
            decoder.push(json!({"type":"response.output_item.done","item":function(&id.to_string(), &format!("call-{id}"))})).unwrap();
        }
        let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
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
        let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
        decoder.push(json!({"type":"response.output_item.added","item":{"type":"message","id":"msg","content":[]}})).unwrap();
        let delta = decoder
            .push(json!({"type":"response.refusal.delta","item_id":"msg","delta":"Cannot comply."}))
            .unwrap();
        assert!(
            matches!(&delta[..], [OutputEvent::PartDelta { text, .. }] if text == "Cannot comply.")
        );
        decoder.push(json!({"type":"response.output_item.done","item":{"type":"message","id":"msg","content":[{"type":"refusal","refusal":"Cannot comply."}]}})).unwrap();
        let end = decoder.push(json!({"type":"response.completed","response":{"output":[],"usage":{"input_tokens":5,"output_tokens":3}}})).unwrap();
        assert!(
            matches!(&end[..], [OutputEvent::Finished { reason: Stop::Stop, usage, .. }] if usage.input == Some(5) && usage.output == Some(3))
        );
        decoder.end().unwrap();
    }

    #[test]
    fn completion_preserves_reported_cache_reads_and_writes() {
        for (details, read, write) in [
            (json!({}), None, None),
            (
                json!({"cached_tokens":0,"cache_write_tokens":80}),
                Some(0),
                Some(80),
            ),
            (
                json!({"cached_tokens":80,"cache_write_tokens":0}),
                Some(80),
                Some(0),
            ),
        ] {
            let end = Decoder::new(ReasoningMode::Encrypted, None)
                .push(
                    json!({"type":"response.completed","response":{"output":[],"usage":{
                        "input_tokens":100,"input_tokens_details":details
                    }}}),
                )
                .unwrap();
            assert!(matches!(&end[..], [OutputEvent::Finished { usage, .. }]
                if (usage.input, usage.cache_read, usage.cache_write) == (Some(100), read, write)));
        }
    }

    #[test]
    fn undeclared_hosted_search_settles_once_and_allows_the_response_to_finish() {
        let mut decoder = Decoder::new(ReasoningMode::Encrypted, None);
        let item = json!({
            "type":"web_search_call","id":"ws_returned","status":"completed",
            "action":{"type":"search","query":"rust"}
        });
        let start = decoder
            .push(json!({
                "type":"response.output_item.added",
                "item":{"type":"web_search_call","id":"ws_returned","status":"in_progress"}
            }))
            .unwrap();
        assert!(
            matches!(&start[..], [OutputEvent::ToolCall { id, name, provider_executed: true, .. }]
            if id == "ws_returned" && name == "web_search")
        );
        let done = decoder
            .push(json!({"type":"response.output_item.done","item":item}))
            .unwrap();
        assert!(
            matches!(&done[..], [OutputEvent::ToolResult { id, name, action, is_error: false, .. }]
            if id == "ws_returned" && name == "web_search" && *action == item["action"])
        );
        let end = decoder
            .push(json!({"type":"response.completed","response":{"output":[item]}}))
            .unwrap();
        assert!(matches!(
            &end[..],
            [OutputEvent::Finished {
                reason: Stop::Stop,
                ..
            }]
        ));
    }

    #[test]
    fn incomplete_terminals_preserve_started_search_without_inventing_its_result() {
        for (status, settled) in [
            ("in_progress", false),
            ("completed", true),
            ("failed", true),
        ] {
            let mut decoder = Decoder::new(ReasoningMode::Encrypted, Some("Research".into()));
            let start = decoder.push(json!({"type":"response.output_item.added", "item":{"type":"web_search_call","id":"search","status":"in_progress"}})).unwrap();
            assert!(
                matches!(&start[..], [OutputEvent::ToolCall { provider_executed: true, name, .. }] if name == "Research")
            );
            assert!(!decoder.replay_safe);
            assert!(!decoder.retained_output_safe());
            let end = decoder.push(json!({"type":"response.incomplete","response":{"output":[{"type":"web_search_call","id":"search","status":status}]}})).unwrap();
            assert!(
                !end.iter()
                    .any(|event| matches!(event, OutputEvent::ToolCall { .. }))
            );
            assert_eq!(
                end.iter()
                    .any(|event| matches!(event, OutputEvent::ToolResult { .. })),
                settled
            );
            assert!(matches!(
                end.last(),
                Some(OutputEvent::Finished {
                    reason: Stop::Length,
                    ..
                })
            ));
        }
    }
}
