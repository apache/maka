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

use crate::{
    Error, ExactPart, ExactRecord, ExactSink, ExactTranscript,
    access::ReadSource,
    exact::{
        content,
        lines::{Rows, unchanged},
    },
};
use maka_agent_facts::history_snapshot::HistoricalRole;
use maka_capabilities::filesystem::PinnedFile;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum TurnKey {
    Foreign(String),
    Derived(u64),
}
#[derive(Default)]
struct Turns {
    current: Option<TurnKey>,
    order: Vec<TurnKey>,
    active: BTreeSet<TurnKey>,
    assistant_seen: bool,
    explicit: bool,
}
impl Turns {
    fn observe(&mut self, row: &Value, number: u64) -> Result<TurnKey, Error> {
        let payload = row.get("payload").unwrap_or(&Value::Null);
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "thread_rolled_back" {
            let count = payload
                .get("num_turns")
                .and_then(Value::as_u64)
                .ok_or(Error::Invalid("invalid Codex rollback count"))?;
            let keep = self
                .order
                .len()
                .saturating_sub(usize::try_from(count).unwrap_or(usize::MAX));
            for removed in self.order.drain(keep..) {
                self.active.remove(&removed);
            }
            self.current = None;
            self.explicit = false;
            self.assistant_seen = false;
        }
        let source_turn = source_turn_id(row)?;
        if let Some(turn) = source_turn {
            self.current = Some(TurnKey::Foreign(turn.into()));
            self.explicit = true;
            self.assistant_seen = false;
        } else if matches!(kind, "task_started" | "turn_started") {
            self.current = None;
            self.explicit = false;
            self.assistant_seen = false;
        }
        let category = category(row).map(|(_, category, _)| category);
        if !self.explicit && category == Some("user") && self.assistant_seen {
            self.current = None;
            self.assistant_seen = false;
        }
        if category.is_none()
            && !matches!(
                kind,
                "task_started"
                    | "turn_started"
                    | "task_complete"
                    | "turn_complete"
                    | "turn_aborted"
            )
            && source_turn.is_none()
        {
            return Ok(self.current.clone().unwrap_or(TurnKey::Derived(number)));
        }
        let turn = self.current.get_or_insert(TurnKey::Derived(number)).clone();
        if category.is_some() && self.active.insert(turn.clone()) {
            self.order.push(turn.clone());
        }
        if matches!(category, Some("assistant" | "reasoning" | "tool")) {
            self.assistant_seen = true;
        }
        if matches!(kind, "task_complete" | "turn_complete" | "turn_aborted") {
            self.current = None;
            self.explicit = false;
            self.assistant_seen = false;
        }
        Ok(turn)
    }
}
fn source_turn_id(row: &Value) -> Result<Option<&str>, Error> {
    let payload = &row["payload"];
    if row["type"] == "turn_context"
        || (row["type"] == "event_msg"
            && matches!(
                payload["type"].as_str(),
                Some(
                    "task_started"
                        | "turn_started"
                        | "item_completed"
                        | "task_complete"
                        | "turn_complete"
                        | "turn_aborted"
                )
            ))
    {
        content::source_id(payload.get("turn_id"))
    } else {
        Ok(None)
    }
}
fn category(row: &Value) -> Option<(u8, &'static str, &Value)> {
    let payload = row.get("payload")?;
    let kind = payload.get("type")?.as_str()?;
    match row.get("type")?.as_str()? {
        "response_item" => match kind {
            "message" => match payload.get("role")?.as_str()? {
                "user" => Some((2, "user", payload)),
                "assistant" => Some((2, "assistant", payload)),
                "system" | "developer" => Some((2, "system", payload)),
                _ => None,
            },
            "reasoning" => Some((2, "reasoning", payload)),
            "function_call"
            | "custom_tool_call"
            | "function_call_output"
            | "custom_tool_call_output" => Some((2, "tool", payload)),
            _ => None,
        },
        "event_msg" => match kind {
            "user_message" => Some((0, "user", payload)),
            "agent_message" => Some((0, "assistant", payload)),
            "agent_reasoning" | "agent_reasoning_raw_content" => Some((0, "reasoning", payload)),
            "item_completed" => {
                let item = payload.get("item")?;
                let category = match item.get("type")?.as_str()? {
                    "UserMessage" | "usermessage" | "user_message" => "user",
                    "AgentMessage" | "agentmessage" | "agent_message" | "Plan" | "plan" => {
                        "assistant"
                    }
                    "Reasoning" | "reasoning" => "reasoning",
                    _ => return None,
                };
                Some((1, category, item))
            }
            _ => None,
        },
        _ => None,
    }
}

pub async fn read(
    views: &(impl ReadSource + ?Sized),
    file: &PinnedFile,
    expected: &str,
    sink: &mut dyn ExactSink,
) -> Result<ExactTranscript, Error> {
    crate::transcript::identity(expected)?;
    let mut plan = Turns::default();
    let mut preferred = BTreeMap::<(TurnKey, String), Preference>::new();
    let mut cwd = None;
    let mut matched = false;
    let mut rows = Rows::new(file);
    while let Some(raw) = rows.next().await {
        if let Some(row) = raw.value {
            let turn = plan.observe(&row, raw.number)?;
            if row["type"] == "session_meta" {
                let payload = row
                    .get("payload")
                    .ok_or(Error::Invalid("Codex metadata payload is absent"))?;
                if payload
                    .get("session_id")
                    .or_else(|| payload.get("id"))
                    .and_then(Value::as_str)
                    != Some(expected)
                {
                    return Err(Error::Invalid(
                        "Codex session metadata differs from selected session",
                    ));
                }
                matched = true;
                if cwd.is_none() {
                    cwd = crate::transcript::source_cwd(
                        payload
                            .get("cwd")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    );
                }
            }
            if let Some((priority, category, item)) = category(&row)
                && category != "tool"
            {
                let claims = if matches!(category, "user" | "system") {
                    let item = item.clone();
                    tokio::task::spawn_blocking(move || media_claims(&item)).await??
                } else {
                    BTreeSet::new()
                };
                let entry = preferred.entry((turn, category.into())).or_default();
                entry.all.extend(claims.iter().copied());
                if priority > entry.priority {
                    entry.priority = priority;
                    entry.selected = claims;
                } else if priority == entry.priority {
                    entry.selected.extend(claims);
                }
            }
        }
    }
    let fingerprint = rows.finish().await?;
    if !matched {
        return Err(Error::Invalid("Codex session metadata is missing"));
    }
    for ((turn, _), preference) in &preferred {
        if plan.active.contains(turn) && !preference.all.is_subset(&preference.selected) {
            return Err(Error::Unsupported(
                "Codex message mirrors contain media absent from the selected full record".into(),
            ));
        }
    }
    let mut turns = Turns::default();
    let mut turn_ordinals = BTreeMap::new();
    let mut last_ordinal = None;
    let mut calls = BTreeMap::new();
    let mut rows = Rows::new(file);
    let mut title = None;
    let mut readable = false;
    while let Some(raw) = rows.next().await {
        let mut messages = Vec::new();
        if let Some(row) = &raw.value {
            let turn = turns.observe(row, raw.number)?;
            if let Some((priority, category, item)) = category(row) {
                let retained = plan.active.contains(&turn);
                let preferred = category == "tool"
                    || preferred
                        .get(&(turn.clone(), category.into()))
                        .is_some_and(|entry| entry.priority == priority);
                if retained && preferred {
                    let id = content::source_id(item.get("client_id"))?
                        .or(content::source_id(item.get("id"))?);
                    let timestamp = content::timestamp(row.get("timestamp"), true)?;
                    let mut parts = Vec::new();
                    match category {
                        "user" | "system" => {
                            let role = if category == "user" {
                                HistoricalRole::User
                            } else {
                                HistoricalRole::System
                            };
                            if let Some(body) = item.get("content") {
                                for block in blocks(body) {
                                    parts.push((
                                        role,
                                        content::input(views, block, cwd.as_deref()).await?,
                                    ));
                                }
                            } else if let Some(text) = item.get("message").and_then(Value::as_str) {
                                parts.push((
                                    role,
                                    ExactPart::Input {
                                        content: text.to_owned().into(),
                                        media: vec![],
                                    },
                                ));
                            }
                            for field in ["images", "local_images", "audio", "local_audio"] {
                                if let Some(media) = item.get(field).filter(|v| !v.is_null()) {
                                    let media = media.as_array().ok_or(Error::Invalid(
                                        "Codex input media is not an array",
                                    ))?;
                                    for value in media {
                                        let block = if let Some(uri) = value.as_str() {
                                            if uri.starts_with("data:") {
                                                json!({"type":"input_image","image_url":uri})
                                            } else {
                                                json!({"type":"file","path":uri})
                                            }
                                        } else {
                                            value.clone()
                                        };
                                        parts.push((
                                            role,
                                            content::input(views, &block, cwd.as_deref()).await?,
                                        ));
                                    }
                                }
                            }
                            for (_, part) in &parts {
                                if title.is_none()
                                    && let ExactPart::Input { content, .. } = part
                                    && !content.text.trim().is_empty()
                                {
                                    title = Some(crate::transcript::title(&content.text));
                                }
                            }
                        }
                        "assistant" => {
                            if row["type"] == "response_item" {
                                let body = item.get("content").and_then(Value::as_array).ok_or(
                                    Error::Invalid(
                                        "Codex response message content is not an array",
                                    ),
                                )?;
                                let mut text = String::new();
                                for block in body {
                                    let field = match content::string(block, "type")? {
                                        "output_text" | "text" => "text",
                                        "refusal" => "refusal",
                                        kind => {
                                            return Err(Error::Unsupported(format!(
                                                "Codex assistant response block {kind}"
                                            )));
                                        }
                                    };
                                    text.push_str(content::string(block, field)?);
                                }
                                parts.push((
                                    HistoricalRole::Assistant,
                                    content::text(&text, false, content::responses_options(item)?),
                                ));
                            } else if let Some(body) = item.get("content") {
                                for block in blocks(body) {
                                    let part = if let Some(text) = block.as_str() {
                                        content::text(text, false, content::options(item))
                                    } else {
                                        content::assistant(block, &mut calls, "codex")?
                                    };
                                    parts.push((HistoricalRole::Assistant, part));
                                }
                            } else {
                                let text = item
                                    .get("message")
                                    .or_else(|| item.get("text"))
                                    .and_then(Value::as_str)
                                    .ok_or(Error::Invalid("Codex assistant text is absent"))?;
                                parts.push((
                                    HistoricalRole::Assistant,
                                    content::text(text, false, content::options(item)),
                                ));
                            }
                        }
                        "reasoning" => {
                            let body = item
                                .get("summary")
                                .or_else(|| item.get("summary_text"))
                                .or_else(|| item.get("content"))
                                .or_else(|| item.get("raw_content"))
                                .or_else(|| item.get("text"));
                            let options = if row["type"] == "response_item" {
                                content::responses_options(item)?
                            } else {
                                content::options(item)
                            };
                            let mut text = String::new();
                            if let Some(body) = body {
                                for block in blocks(body) {
                                    text.push_str(
                                        block
                                            .as_str()
                                            .or_else(|| block.get("text").and_then(Value::as_str))
                                            .ok_or_else(|| {
                                                Error::Unsupported(
                                                    "Codex non-text reasoning content".into(),
                                                )
                                            })?,
                                    );
                                }
                            } else if options.is_none() {
                                return Err(Error::Unsupported(
                                    "Codex reasoning has no readable content".into(),
                                ));
                            }
                            parts.push((
                                HistoricalRole::Assistant,
                                content::text(&text, true, options),
                            ));
                        }
                        "tool" => match content::string(item, "type")? {
                            "function_call" | "custom_tool_call" => parts.push((
                                HistoricalRole::Assistant,
                                content::assistant(item, &mut calls, "codex")?,
                            )),
                            "function_call_output" | "custom_tool_call_output" => {
                                let call = content::string(item, "call_id")?;
                                let name = calls.remove(call).ok_or_else(|| {
                                    Error::Unsupported(format!(
                                        "Codex tool result has no original call {call}"
                                    ))
                                })?;
                                parts.push((
                                    HistoricalRole::Tool,
                                    content::tool_result(
                                        views,
                                        call,
                                        name,
                                        item.get("output")
                                            .ok_or(Error::Invalid("Codex tool output is absent"))?,
                                        item.get("is_error")
                                            .and_then(Value::as_bool)
                                            .unwrap_or(false),
                                        cwd.as_deref(),
                                    )
                                    .await?,
                                ));
                            }
                            _ => unreachable!(),
                        },
                        _ => unreachable!(),
                    }
                    let mut metadata = content::metadata(row);
                    metadata
                        .as_object_mut()
                        .expect("metadata is an object")
                        .insert(
                            "originalProviderRole".into(),
                            Value::String(
                                item.get("role")
                                    .and_then(Value::as_str)
                                    .unwrap_or(category)
                                    .into(),
                            ),
                        );
                    if !parts.is_empty() {
                        let ordinal = match turn_ordinals.entry(turn.clone()) {
                            std::collections::btree_map::Entry::Occupied(entry) => *entry.get(),
                            std::collections::btree_map::Entry::Vacant(entry) => {
                                let ordinal = content::next_turn(last_ordinal)?;
                                last_ordinal = Some(ordinal);
                                *entry.insert(ordinal)
                            }
                        };
                        let source_turn = match &turn {
                            TurnKey::Foreign(id) => Some(id.as_str()),
                            TurnKey::Derived(_) => None,
                        };
                        messages = content::messages(
                            parts,
                            id,
                            source_turn,
                            ordinal,
                            timestamp,
                            &metadata,
                        );
                    }
                    readable |= !messages.is_empty();
                }
            } else if row["type"] == "response_item" {
                return Err(Error::Unsupported(format!(
                    "Codex response item {}",
                    row["payload"]["type"]
                )));
            }
        }
        sink.record(ExactRecord {
            raw_record: raw.raw_record,
            messages,
        })
        .await?;
    }
    unchanged(&fingerprint, rows.finish().await?)?;
    if !readable {
        return Err(Error::Invalid("source contains no readable conversation"));
    }
    Ok(ExactTranscript {
        source: maka_agent_facts::import::Source {
            adapter: "codex".into(),
            session_id: expected.into(),
        },
        cwd,
        title: title.unwrap_or_else(|| expected.into()),
        fingerprint,
    })
}
fn blocks(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(values) => values.iter().collect(),
        value => vec![value],
    }
}

#[derive(Default)]
struct Preference {
    priority: u8,
    all: BTreeSet<[u8; 32]>,
    selected: BTreeSet<[u8; 32]>,
}
fn media_claims(item: &Value) -> Result<BTreeSet<[u8; 32]>, Error> {
    let mut claims = BTreeSet::new();
    let mut observe = |value: &Value| -> Result<(), Error> {
        let source = value.get("source").unwrap_or(value);
        let locator = value
            .as_str()
            .or_else(|| {
                value.get("image_url").and_then(|value| {
                    value
                        .as_str()
                        .or_else(|| value.get("url").and_then(Value::as_str))
                })
            })
            .or_else(|| source.get("url").and_then(Value::as_str))
            .or_else(|| value.get("path").and_then(Value::as_str))
            .or_else(|| value.get("image_path").and_then(Value::as_str));
        let mut hash = Sha256::new();
        if let Some(locator) = locator {
            hash.update(
                locator
                    .strip_prefix("file://")
                    .unwrap_or(locator)
                    .as_bytes(),
            );
        } else if let Some(data) = source.get("data").and_then(Value::as_str) {
            let mime = source
                .get("media_type")
                .or_else(|| source.get("mime_type"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    Error::Unsupported("Codex mirrored media has no original MIME identity".into())
                })?;
            hash.update(b"data:");
            hash.update(mime.as_bytes());
            hash.update(b";base64,");
            hash.update(data.as_bytes());
        } else {
            return Err(Error::Unsupported(
                "Codex mirrored media has no exact source identity".into(),
            ));
        }
        claims.insert(hash.finalize().into());
        Ok(())
    };
    for field in ["images", "local_images", "audio", "local_audio"] {
        if let Some(values) = item.get(field).filter(|value| !value.is_null()) {
            for value in values
                .as_array()
                .ok_or(Error::Invalid("Codex source media is not an array"))?
            {
                observe(value)?;
            }
        }
    }
    if let Some(values) = item.get("content").and_then(Value::as_array) {
        for value in values {
            if matches!(
                value.get("type").and_then(Value::as_str),
                Some(
                    "image"
                        | "input_image"
                        | "local_image"
                        | "Image"
                        | "LocalImage"
                        | "audio"
                        | "input_audio"
                        | "Audio"
                        | "document"
                        | "file"
                )
            ) {
                observe(value)?;
            }
        }
    }
    Ok(claims)
}
