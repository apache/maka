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
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelSource;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::model::PlaintextReasoningReplay;
use maka_agent_facts::model::PlaintextResponses;
use maka_agent_facts::model::TextKind;
use maka_agent_facts::model::ToolInput;
use maka_agent_facts::tools::ToolDefinition;
use serde::Deserialize;
use serde_json::{Value, json};
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
    plaintext: Option<PlaintextResponses>,
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
    pub fn new(plaintext: Option<PlaintextResponses>, tools: &[ToolDefinition]) -> Self {
        Self {
            plaintext,
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
    fn observe(&mut self, item: &Item, added: bool, out: &mut Vec<ModelEvent>) -> Result<()> {
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
                out.push(ModelEvent::ToolCall(ModelToolCall {
                    id: id.into(),
                    name,
                    input: ToolInput::Json(json!({})),
                    provider_executed: true,
                    provider_options: Some(json!({"openai":{"itemId":id}})),
                }));
            }
            let mut input_started = false;
            if let Identity::Function { call_id, name } | Identity::Custom { call_id, name } =
                &identity
                && added
            {
                input_started = true;
                out.push(ModelEvent::ToolInputStarted {
                    id: call_id.clone(),
                    name: crate::request::local_name(name).into(),
                    provider_executed: false,
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
        out: &mut Vec<ModelEvent>,
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
        out.push(ModelEvent::ToolInputDelta {
            id: call_id.clone(),
            text,
        });
        Ok(())
    }
    fn finish_input(&mut self, item_id: &str, call_id: &str, out: &mut Vec<ModelEvent>) {
        if self
            .items
            .get_mut(item_id)
            .is_some_and(|item| std::mem::take(&mut item.input_started))
        {
            out.push(ModelEvent::ToolInputFinished { id: call_id.into() });
        }
    }
    fn start(&mut self, id: &str, kind: TextKind, out: &mut Vec<ModelEvent>) -> Result<()> {
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
        if part.kind != kind {
            return Err(Self::invalid(
                "Responses delta has invalid kind or exceeds text bound",
            ));
        }
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
        if part.kind != kind || !text.starts_with(&part.text) {
            return Err(Self::invalid(
                "final Responses item disagrees with streamed text",
            ));
        }
        if text.len() > part.text.len() {
            self.delta(id.clone(), text[part.text.len()..].into(), kind, out)?;
        }
        // The canonical retry boundary cannot discard opaque replay carriers.
        // Plain text deltas remain replayable; finalized provider metadata does not.
        if options.as_ref().is_some_and(|value| {
            !value.is_null() && value.as_object().is_none_or(|fields| !fields.is_empty())
        }) {
            self.replay_safe = false;
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
        if let Annotation::Url {
            url,
            title,
            start_index,
            end_index,
        } = annotation
            && self.citations.insert(id.clone())
        {
            self.replay_safe = false;
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
    fn final_item(
        &mut self,
        item: Item,
        replay: Option<Value>,
        out: &mut Vec<ModelEvent>,
    ) -> Result<()> {
        self.observe(&item, false, out)?;
        if self.done.contains(item.identity()?.0) {
            return Err(Self::invalid("duplicate Responses item finalization"));
        }
        let options = |id: &str| {
            let mut options = json!({"openai":{"itemId":id}});
            if let Some(replay) = &replay {
                options["openai"]["responsesReplay"] = replay.clone();
            }
            options
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
                self.finish_part(id.clone(), text, TextKind::Text, Some(options(&id)), out)?;
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
                if parts.iter().any(|p| p.r#type != carrier) {
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
                        let mut value = options(&id);
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
                self.replay_safe = false; // The emitted call includes opaque provider metadata.
                let input = ToolInput::from_json(arguments);
                self.finish_input(&id, &call_id, out);
                out.push(ModelEvent::ToolCall(ModelToolCall {
                    id: call_id,
                    name: crate::request::local_name(&name).into(),
                    input,
                    provider_executed: false,
                    provider_options: Some(options(&id)),
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
                self.replay_safe = false; // The emitted call includes opaque provider metadata.
                self.finish_input(&id, &call_id, out);
                out.push(ModelEvent::ToolCall(ModelToolCall {
                    id: call_id,
                    name: crate::request::local_name(&name).into(),
                    input: ToolInput::Json(json!(input)),
                    provider_executed: false,
                    provider_options: Some({
                        let mut options = options(&id);
                        options["openai"]["toolKind"] = json!("custom");
                        options
                    }),
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
                    self.pending_effects.remove(&id);
                    let provider_options = Some(options(&id));
                    out.push(ModelEvent::ProviderToolResult {
                        id,
                        name,
                        output: json!({"action":action}),
                        is_error: status == "failed",
                        provider_options,
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
        if self.plaintext.is_none() {
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
                    && let Some(template) = crate::replay::capture(item)
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
                out.push(ModelEvent::ResponseMetadata {
                    id: response.id,
                    model: response.model,
                    timestamp: response
                        .created_at
                        .filter(|seconds| {
                            seconds.is_finite() && seconds.abs() <= 8_640_000_000_000.0
                        })
                        .and_then(|seconds| {
                            jiff::Timestamp::from_millisecond((seconds * 1000.0) as i64).ok()
                        })
                        .map(|value| format!("{value:.3}")),
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
            Event::Done { item } => {
                let template = replay.remove(item.identity()?.0);
                self.final_item(item, template, &mut out)?;
            }
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
            retained_output_safe: self.retained_output_safe(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn freeform_source_and_call_kind_survive_decode_and_history_replay_without_catalog() {
        use maka_agent_facts::model::prompt::AssistantPart;
        use maka_agent_facts::model::prompt::Message;
        use maka_agent_facts::model::prompt::ToolOutput;
        use maka_agent_facts::tools::FreeformGrammar;
        let source =
            "// @exec: {\"max_output_tokens\":1000}\ntext(await tools.echo({text:'你好'}));";
        let tool = ToolDefinition {
            name: "exec".into(),
            description: "JavaScript module".into(),
            provider: None,
            input_schema: json!({"type":"object","properties":{"code":{"type":"string"}},"required":["code"]}),
            freeform: Some(FreeformGrammar::Lark {
                definition: "start: /[\\s\\S]+/".into(),
            }),
            output_schema: None,
        };
        let definitions = [tool];
        let options = json!({"openai":{"store":false}});
        let request = crate::request::Request {
            language: maka_agent_facts::language::Language::En,
            model: "fixture",
            prompt: &[],
            tools: &definitions,
            options: &options,
            max_output_tokens: None,
            plaintext: None,
        };
        let encoded = request.encode().unwrap();
        assert_eq!(encoded["tools"][0]["type"], "custom");
        assert_eq!(encoded["tools"][0]["format"]["syntax"], "lark");
        let mut decoder = Decoder::new(None, &definitions);
        let events = decoder
            .push(json!({"type":"response.output_item.done","item":{
                "type":"custom_tool_call","id":"item","call_id":"call","name":"exec","input":source
            }}))
            .unwrap();
        let ModelEvent::ToolCall(call) = &events[0] else {
            panic!("missing tool call")
        };
        assert_eq!(call.input, ToolInput::Json(json!(source)));
        let prompt = [
            Message::Assistant {
                content: vec![AssistantPart::ToolCall {
                    tool_call_id: call.id.clone(),
                    tool_name: call.name.clone(),
                    input: call.input.clone(),
                    provider_executed: None,
                    provider_options: call.provider_options.clone(),
                }],
                provider_options: None,
            },
            {
                let mut result = Message::tool("call", "exec", ToolOutput::Text("done".into()));
                if let Message::Tool { content, .. } = &mut result {
                    content[0].provider_options = Some(json!({"openai":{"toolKind":"custom"}}));
                }
                result
            },
        ];
        let replay = crate::request::Request {
            language: maka_agent_facts::language::Language::En,
            prompt: &prompt,
            tools: &[],
            ..request
        }
        .encode()
        .unwrap();
        assert_eq!(
            replay["input"],
            json!([
                {"type":"custom_tool_call","id":"item","call_id":"call","name":"exec","input":source},
                {"type":"custom_tool_call_output","call_id":"call","output":"done"}
            ])
        );
        let fallback = crate::request::Request {
            language: maka_agent_facts::language::Language::En,
            prompt: &prompt,
            tools: &definitions,
            plaintext: Some(maka_agent_facts::model::PlaintextResponses {
                reasoning_replay:
                    maka_agent_facts::model::PlaintextReasoningReplay::PlaintextContent,
                compatibility: None,
            }),
            ..request
        }
        .encode()
        .unwrap();
        assert_eq!(fallback["tools"][0]["type"], "function");
        assert_eq!(fallback["input"][0]["type"], "function_call");
        assert_eq!(
            serde_json::from_str::<Value>(fallback["input"][0]["arguments"].as_str().unwrap())
                .unwrap(),
            json!({"code":source})
        );
        assert_eq!(fallback["input"][1]["type"], "function_call_output");
        assert_eq!(
            call.provider_options.as_ref().unwrap()["openai"]["toolKind"],
            "custom"
        );
    }
    #[test]
    fn function_argument_strings_are_classified_without_relaxing_the_envelope() {
        for (raw, expected) in [
            ("null", ToolInput::Json(json!(null))),
            ("7", ToolInput::Json(json!(7))),
            ("\"abc\"", ToolInput::Json(json!("abc"))),
            (
                r#"{"kind":"invalid_json","data":{"raw":"x"}}"#,
                ToolInput::Json(json!({"kind":"invalid_json","data":{"raw":"x"}})),
            ),
        ] {
            let mut decoder = Decoder::new(None, &[]);
            let events = decoder.push(json!({"type":"response.output_item.done","item":{
                "type":"function_call","id":"item","call_id":"call","name":"echo","arguments":raw
            }})).unwrap();
            let ModelEvent::ToolCall(call) = &events[0] else {
                panic!("expected call")
            };
            assert_eq!(call.input, expected);
            assert_eq!(call.id, "call");
            assert_eq!(call.name, "echo");
            assert_eq!(
                call.provider_options,
                Some(
                    json!({"openai":{"itemId":"item","responsesReplay":{"version":1,"fields":{"type":"function_call","id":"item","call_id":"call","name":"echo"}}}})
                )
            );
        }
        for arguments in [json!(null), json!(7), json!({}), json!([])] {
            let mut decoder = Decoder::new(None, &[]);
            assert!(decoder.push(json!({"type":"response.output_item.done","item":{
                "type":"function_call","id":"item","call_id":"call","name":"echo","arguments":arguments
            }})).is_err());
        }
        let mut decoder = Decoder::new(None, &[]);
        assert!(
            decoder
                .push(json!({"type":"response.output_item.done","item":{
                    "type":"function_call","id":"item","call_id":"call","name":"echo"
                }}))
                .is_err()
        );
    }

    #[test]
    fn function_arguments_and_true_custom_calls_keep_their_historical_kind() {
        use maka_agent_facts::model::prompt::{AssistantPart, Message, ToolOutput};
        let source = "text('same source');";
        let raw = " {\"n\":\n";
        let definitions = [ToolDefinition {
            name: "exec".into(),
            description: "JavaScript".into(),
            provider: None,
            input_schema: json!({"type":"object"}),
            output_schema: None,
            freeform: Some(maka_agent_facts::tools::FreeformGrammar::Lark {
                definition: "start: /[\\s\\S]+/".into(),
            }),
        }];
        let items = [
            json!({"type":"function_call","id":"f","call_id":"function","name":"exec","arguments":json!(source).to_string()}),
            json!({"type":"custom_tool_call","id":"c","call_id":"custom","name":"exec","input":source}),
            json!({"type":"function_call","id":"b","call_id":"broken","name":"exec","arguments":raw}),
            json!({"type":"function_call","id":"s","call_id":"string","name":"echo","arguments":"\"abc\""}),
        ];
        let mut decoder = Decoder::new(None, &definitions);
        let mut prompt = Vec::new();
        let mut calls = Vec::new();
        for item in items {
            let events = decoder
                .push(json!({"type":"response.output_item.done","item":item}))
                .unwrap();
            let ModelEvent::ToolCall(call) = &events[0] else {
                panic!("expected call")
            };
            calls.push(call.clone());
            prompt.push(Message::Assistant {
                content: vec![AssistantPart::ToolCall {
                    tool_call_id: call.id.clone(),
                    tool_name: call.name.clone(),
                    input: call.input.clone(),
                    provider_executed: None,
                    provider_options: call.provider_options.clone(),
                }],
                provider_options: None,
            });
            let mut result = Message::tool(
                &call.id,
                &call.name,
                ToolOutput::ErrorText("refused".into()),
            );
            if call
                .provider_options
                .as_ref()
                .is_some_and(|options| options["openai"]["toolKind"] == "custom")
                && let Message::Tool { content, .. } = &mut result
            {
                content[0].provider_options = Some(json!({"openai":{"toolKind":"custom"}}));
            }
            prompt.push(result);
        }
        assert_eq!(calls[0].input, ToolInput::Json(json!(source)));
        assert_eq!(calls[1].input, ToolInput::Json(json!(source)));
        assert_eq!(calls[2].input, ToolInput::InvalidJson { raw: raw.into() });
        assert_eq!(calls[3].input, ToolInput::Json(json!("abc")));
        let options = json!({"openai":{"store":false}});
        let request = crate::request::Request {
            language: maka_agent_facts::language::Language::En,
            model: "fixture",
            prompt: &prompt,
            tools: &definitions,
            options: &options,
            max_output_tokens: None,
            plaintext: None,
        };
        let encoded = request.encode().unwrap();
        assert_eq!(
            encoded["input"],
            json!([
                {"type":"function_call","id":"f","call_id":"function","name":"exec","arguments":json!(source).to_string()},
                {"type":"function_call_output","call_id":"function","output":"refused"},
                {"type":"custom_tool_call","id":"c","call_id":"custom","name":"exec","input":source},
                {"type":"custom_tool_call_output","call_id":"custom","output":"refused"},
                {"type":"function_call","id":"b","call_id":"broken","name":"exec","arguments":raw},
                {"type":"function_call_output","call_id":"broken","output":"refused"},
                {"type":"function_call","id":"s","call_id":"string","name":"echo","arguments":"\"abc\""},
                {"type":"function_call_output","call_id":"string","output":"refused"}
            ])
        );
        let fallback = crate::request::Request {
            language: maka_agent_facts::language::Language::En,
            plaintext: Some(maka_agent_facts::model::PlaintextResponses {
                reasoning_replay:
                    maka_agent_facts::model::PlaintextReasoningReplay::PlaintextContent,
                compatibility: None,
            }),
            ..request
        }
        .encode()
        .unwrap();
        assert_eq!(fallback["input"][0]["arguments"], json!(source).to_string());
        assert_eq!(
            fallback["input"][2]["arguments"],
            json!({"code":source}).to_string()
        );
        assert_eq!(fallback["input"][4]["arguments"], raw);
        assert_eq!(fallback["input"][6]["arguments"], "\"abc\"");
    }

    #[test]
    fn repeated_call_ids_keep_each_historical_call_and_result_kind() {
        use maka_agent_facts::model::prompt::{AssistantPart, Message, ToolOutput};
        let raw = " {\"n\":\n";
        let source = "text('custom');";
        for custom_first in [true, false] {
            let mut prompt = Vec::new();
            let mut expected = Vec::new();
            for custom in [custom_first, !custom_first] {
                let item = if custom {
                    json!({"type":"custom_tool_call","id":"custom-item","call_id":"call","name":"exec","input":source})
                } else {
                    json!({"type":"function_call","id":"function-item","call_id":"call","name":"exec","arguments":raw})
                };
                // IDs are scoped to a model step, so each step has its own decoder.
                let events = Decoder::new(None, &[])
                    .push(json!({"type":"response.output_item.done","item":item}))
                    .unwrap();
                let ModelEvent::ToolCall(call) = &events[0] else {
                    panic!("expected call")
                };
                prompt.push(Message::Assistant {
                    content: vec![AssistantPart::ToolCall {
                        tool_call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        input: call.input.clone(),
                        provider_executed: None,
                        provider_options: call.provider_options.clone(),
                    }],
                    provider_options: None,
                });
                let mut result =
                    Message::tool("call", "exec", ToolOutput::ErrorText("refused".into()));
                if custom && let Message::Tool { content, .. } = &mut result {
                    content[0].provider_options = Some(json!({"openai":{"toolKind":"custom"}}));
                }
                prompt.push(result);
                expected.extend(if custom {
                    vec![json!({"type":"custom_tool_call","id":"custom-item","call_id":"call","name":"exec","input":source}),
                        json!({"type":"custom_tool_call_output","call_id":"call","output":"refused"})]
                } else {
                    vec![json!({"type":"function_call","id":"function-item","call_id":"call","name":"exec","arguments":raw}),
                        json!({"type":"function_call_output","call_id":"call","output":"refused"})]
                });
            }
            let options = json!({"openai":{"store":false}});
            let request = crate::request::Request {
                language: maka_agent_facts::language::Language::En,
                model: "fixture",
                prompt: &prompt,
                tools: &[],
                options: &options,
                max_output_tokens: None,
                plaintext: None,
            };
            assert_eq!(request.encode().unwrap()["input"], json!(expected));
            let fallback = crate::request::Request {
                language: maka_agent_facts::language::Language::En,
                plaintext: Some(maka_agent_facts::model::PlaintextResponses {
                    reasoning_replay:
                        maka_agent_facts::model::PlaintextReasoningReplay::PlaintextContent,
                    compatibility: None,
                }),
                ..request
            }
            .encode()
            .unwrap();
            for (index, custom) in [custom_first, !custom_first].into_iter().enumerate() {
                assert_eq!(
                    fallback["input"][index * 2],
                    json!({"type":"function_call","call_id":"call","name":"exec",
                    "arguments":if custom {json!({"code":source}).to_string()} else {raw.into()}})
                );
                assert_eq!(
                    fallback["input"][index * 2 + 1],
                    json!({"type":"function_call_output","call_id":"call","output":"refused"})
                );
            }
        }
    }

    fn function(id: &str, call: &str) -> Value {
        json!({"type":"function_call", "id":id, "call_id":call, "name":"Read", "arguments":"{}"})
    }
    #[test]
    fn unassociated_input_previews_preserve_complete_calls_and_retry_safety() {
        for (kind, item, input, mut options) in [
            (
                "response.function_call_arguments.delta",
                function("item", "call"),
                ToolInput::Json(json!({})),
                json!({"openai":{"itemId":"item"}}),
            ),
            (
                "response.custom_tool_call_input.delta",
                json!({"type":"custom_tool_call","id":"item","call_id":"call","name":"Read","input":"complete input"}),
                ToolInput::Json(json!("complete input")),
                json!({"openai":{"itemId":"item","toolKind":"custom"}}),
            ),
        ] {
            let mut decoder = Decoder::new(None, &[]);
            assert!(
                decoder
                    .push(json!({"type":kind,"item_id":"item","delta":"unassociated preview"}))
                    .unwrap()
                    .is_empty()
            );
            assert!(!decoder.observed_output);
            assert!(decoder.replay_safe);
            assert!(decoder.retained_output_safe());
            options["openai"]["responsesReplay"] = crate::replay::capture(&item).unwrap();
            assert_eq!(
                decoder
                    .push(json!({"type":"response.output_item.done","item":item}))
                    .unwrap(),
                vec![ModelEvent::ToolCall(ModelToolCall {
                    id: "call".into(),
                    name: "Read".into(),
                    input,
                    provider_executed: false,
                    provider_options: Some(options),
                })]
            );
            assert!(decoder.observed_output);
            assert!(!decoder.replay_safe);
            assert!(decoder.retained_output_safe());
        }
    }
    #[test]
    fn observed_input_deltas_require_open_matching_tools_and_never_replace_complete_calls() {
        let mut decoder = Decoder::new(None, &[]);
        decoder
            .push(json!({"type":"response.output_item.added","item":function("item","call")}))
            .unwrap();
        assert!(
            decoder
                .push(json!({"type":"response.custom_tool_call_input.delta","item_id":"item","delta":"{"}))
                .is_err()
        );
        let mut decoder = Decoder::new(None, &[]);
        assert_eq!(
            decoder
                .push(json!({"type":"response.output_item.added","item":function("item","call")}))
                .unwrap(),
            vec![ModelEvent::ToolInputStarted {
                id: "call".into(),
                name: "Read".into(),
                provider_executed: false,
            }]
        );
        decoder
            .push(json!({"type":"response.function_call_arguments.delta","item_id":"item","delta":"{\"path\":\"你"}))
            .unwrap();
        let final_events = decoder
            .push(json!({"type":"response.output_item.done","item":function("item","call")}))
            .unwrap();
        assert!(
            matches!(&final_events[..], [ModelEvent::ToolInputFinished { id }, ModelEvent::ToolCall(call)]
            if id == "call" && call.id == "call" && call.input == ToolInput::Json(json!({})))
        );
        assert!(decoder.push(json!({"type":"response.function_call_arguments.delta","item_id":"item","delta":"好\"}"})).is_err());
        let end = decoder
            .push(json!({"type":"response.completed","response":{"output":[function("item","call")]}}))
            .unwrap();
        assert!(matches!(
            &end[..],
            [ModelEvent::Finished {
                reason: ModelFinishReason::ToolCalls,
                ..
            }]
        ));
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
        for id in 0..129 {
            decoder.push(json!({"type":"response.output_item.done","item":function(&id.to_string(), &format!("call-{id}"))})).unwrap();
        }
        decoder.push(json!({"type":"response.output_item.done","item":function("additional","call-additional")})).unwrap();
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
            freeform: None,
            output_schema: None,
            name: "Research".into(),
            description: "search".into(),
            input_schema: json!({}),
            provider: Some(maka_agent_facts::tools::ProviderTool {
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
