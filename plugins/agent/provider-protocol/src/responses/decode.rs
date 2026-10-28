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
    Citation, Error, Event as OutputEvent, ItemMetadata, PartMetadata, ReasoningMode, Result,
    ToolInput,
};
use crate::output::{Stop, TextKind, Usage as OutputUsage};
use serde::Deserialize;
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
    Summary { item_id: String, delta: String },
    #[serde(rename = "response.reasoning_text.delta")]
    Reasoning { item_id: String, delta: String },
    #[serde(rename = "response.function_call_arguments.delta")]
    FunctionInput { item_id: String, delta: String },
    #[serde(rename = "response.custom_tool_call_input.delta")]
    CustomInput { item_id: String, delta: String },
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

    fn invalid(message: &str) -> Error {
        Error::Invalid(message.into())
    }
    fn observe(&mut self, item: &Item, added: bool, out: &mut Vec<OutputEvent>) -> Result<()> {
        let (id, identity) = item.identity()?;
        if id.is_empty() {
            return Err(Self::invalid("invalid Responses item identity"));
        }
        if let Some(previous) = self.items.get(id) {
            if added || previous.identity != identity {
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
            if identity == Identity::Search {
                self.pending_effects.insert(id.into());
                let name = self
                    .search_name
                    .clone()
                    .ok_or_else(|| Self::invalid("unrequested Responses web search"))?;
                self.observed_output = true;
                self.replay_safe = false;
                out.push(OutputEvent::ToolCall {
                    id: id.into(),
                    name,
                    input: ToolInput::Function("{}".into()),
                    provider_executed: true,
                    metadata: ItemMetadata {
                        id: id.into(),
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
    fn start(&mut self, id: &str, kind: TextKind, out: &mut Vec<OutputEvent>) -> Result<()> {
        if id.is_empty() || !self.seen.insert(id.into()) {
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
        out.push(OutputEvent::PartStarted {
            id: id.into(),
            kind,
        });
        Ok(())
    }
    fn delta(
        &mut self,
        id: String,
        text: String,
        kind: TextKind,
        out: &mut Vec<OutputEvent>,
    ) -> Result<()> {
        let part = self
            .open
            .get_mut(&id)
            .ok_or_else(|| Self::invalid("Responses delta has no open item"))?;
        if part.kind != kind {
            return Err(Self::invalid("Responses delta has invalid kind"));
        }
        part.text.push_str(&text);
        out.push(OutputEvent::PartDelta { id, text });
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
            self.start(&id, kind, out)?;
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
            self.delta(id.clone(), text[part.text.len()..].into(), kind, out)?;
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
        id: String,
        annotation: Annotation,
        out: &mut Vec<OutputEvent>,
    ) -> Result<()> {
        if let Annotation::Url {
            url,
            title,
            start_index,
            end_index,
        } = annotation
            && self.citations.insert(id.clone())
        {
            self.replay_safe = false;
            out.push(OutputEvent::Citation(Citation {
                id,
                url,
                title,
                start_index,
                end_index,
            }));
        }
        Ok(())
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
                    Some(PartMetadata::Item(metadata(&id))),
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
                let name = self
                    .search_name
                    .clone()
                    .ok_or_else(|| Self::invalid("unrequested Responses web search"))?;
                // A terminal response can contain unfinished provider work.
                // Retain its call without fabricating a settlement; the strict
                // step assembler then keeps the outcome unknown.
                if matches!(status.as_str(), "completed" | "failed") {
                    self.pending_effects.remove(&id);
                    let metadata = metadata(&id);
                    out.push(OutputEvent::ToolResult {
                        id,
                        name,
                        action,
                        is_error: status == "failed",
                        metadata,
                    });
                }
            }
            Item::Other => return Err(Self::invalid("unsupported Responses output item")),
        }
        Ok(())
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
            let id = if value["type"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("response.web_search_call."))
            {
                value["item_id"].as_str().unwrap_or("")
            } else {
                ""
            }; // Unknown remote effects have no replayable completion contract.
            self.pending_effects.insert(id.into());
        }
        let mut replay = BTreeMap::new();
        if self.reasoning == ReasoningMode::Encrypted {
            let finalized = value["type"] == "response.output_item.done";
            let values: Vec<&Value> = if finalized {
                vec![&value["item"]]
            } else {
                value["response"]["output"]
                    .as_array()
                    .map(|items| items.iter().collect())
                    .unwrap_or_default()
            };
            for item in values {
                if let Some(id) = item["id"].as_str()
                    && !self.done.contains(id)
                    && let Some(template) = super::replay::capture(item)
                {
                    replay.insert(id.to_owned(), template);
                }
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
                self.observe(&item, true, &mut out)?;
                match item {
                    Item::Message { id, .. } => self.start(&id, TextKind::Text, &mut out)?,
                    Item::Reasoning { id, .. } => self.start(&id, TextKind::Reasoning, &mut out)?,
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
            Event::Done { item } => {
                let template = replay.remove(item.identity()?.0);
                self.final_item(item, template, &mut out)?;
            }
            Event::Text { item_id, delta } => {
                self.delta(item_id, delta, TextKind::Text, &mut out)?
            }
            Event::Summary { item_id, delta } => {
                if self.reasoning != ReasoningMode::PlaintextContent {
                    self.delta(item_id, delta, TextKind::Reasoning, &mut out)?;
                }
            }
            Event::Reasoning { item_id, delta } => {
                if self.reasoning == ReasoningMode::PlaintextContent {
                    self.delta(item_id, delta, TextKind::Reasoning, &mut out)?;
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
                    let template = replay.remove(item.identity()?.0);
                    self.final_item(item, template, &mut out)?;
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
                            .and_then(|details| details.cached_tokens),
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
        Error::Provider {
            code: error.code,
            message: error.message,
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
