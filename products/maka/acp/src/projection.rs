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

//! ACP presentation of public observations and durable transcript rows.
use crate::presentation::{MessageKind, Meta, Text, ToolCard, ToolStatus, Update};
use maka_agent_api::contract::{ContentKind, HistoryChunk, PreviewField, PreviewPage};
use maka_agent_ports::session::history::HistoryField;
use maka_agent_ports::session::history::Role;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

mod messages;
mod tools;

struct Message {
    text: String,
    meta: Meta,
    canonical: bool,
}

#[derive(Default)]
pub struct Projection {
    streams: HashMap<(String, String, MessageKind), Message>,
    tools: HashMap<String, Tool>,
    pending_models:
        HashMap<String, HashSet<(maka_agent_ports::session::history::RowPosition, MessageKind)>>,
    preview_epoch: Option<String>,
    preview_attempt: Option<(String, String)>,
    preview_seed: HashMap<(String, String, MessageKind), String>,
    committed_parts: HashSet<(String, String, String)>,
    closed_steps: HashSet<(String, String)>,
    assembly: Option<CanonicalAssembly>,
}

struct CanonicalAssembly {
    turn_id: String,
    message_id: String,
    position: maka_agent_ports::session::history::RowPosition,
    field: HistoryField,
    text: String,
    meta: Meta,
}

struct Tool {
    turn: String,
    card: ToolCard,
    published: Option<ToolCard>,
    authoritative: bool,
    position: Option<maka_agent_ports::session::history::RowPosition>,
}

impl Projection {
    pub fn chunk(&mut self, chunk: &HistoryChunk) -> Result<Vec<Update>, crate::Error> {
        if chunk.offset == 0 {
            self.preview_seed
                .retain(|(turn, id, _), _| turn != &chunk.turn_id || id != &chunk.message_id);
            let mut meta = message_meta(&chunk.turn_id, &chunk.message_id);
            if let Some(model) = &chunk.model {
                meta["maka"]["model"] = serde_json::to_value(model)?;
            }
            if let Some(origin) = &chunk.origin {
                meta["maka"]["origin"] = serde_json::to_value(origin)?;
            }
            if !chunk.attachments.is_empty() {
                meta["maka"]["attachments"] = serde_json::to_value(&chunk.attachments)?;
            }
            self.assembly = Some(CanonicalAssembly {
                turn_id: chunk.turn_id.clone(),
                message_id: chunk.message_id.clone(),
                position: chunk.position,
                field: chunk.field,
                text: String::new(),
                meta,
            });
        }
        let CanonicalAssembly {
            position,
            field,
            text,
            ..
        } = self
            .assembly
            .as_mut()
            .ok_or("History field starts with a missing fragment")?;
        if *position != chunk.position || *field != chunk.field || text.len() as u64 != chunk.offset
        {
            return Err("History field fragments are discontinuous".into());
        }
        if text.len() + chunk.text.len() > chunk.total_bytes as usize {
            return Err("History field exceeds its declared size".into());
        }
        text.push_str(&chunk.text);
        if text.len() as u64 != chunk.total_bytes {
            return Ok(vec![]);
        }
        let CanonicalAssembly { text, mut meta, .. } =
            self.assembly.take().expect("complete field");
        let kind = match (chunk.role, chunk.field) {
            (Role::User, _) => MessageKind::User,
            (Role::Assistant, HistoryField::Thinking) => MessageKind::Thinking,
            (Role::Assistant, HistoryField::Body) => MessageKind::Text,
            (Role::Failure, _) => {
                meta["maka"]["role"] = json!("failure");
                MessageKind::Text
            }
            (Role::ToolCall | Role::ToolResult, _) => return self.tool_chunk(chunk, &text),
            (Role::Compaction, _) => return Ok(vec![]),
        };
        let updates = self.replace_text(&chunk.turn_id, &chunk.message_id, kind, &text, meta);
        if let Some(message) =
            self.streams
                .get_mut(&(chunk.turn_id.clone(), chunk.message_id.clone(), kind))
        {
            if !message.canonical
                && matches!(
                    chunk.model,
                    Some(maka_agent_ports::session::history::HistoryModel::Native { .. })
                )
                && let Some(part) = &chunk.model_part
            {
                self.pending_models
                    .entry(part.step_id.clone())
                    .or_default()
                    .insert((chunk.position, kind));
            }
            message.canonical = true;
        }
        Ok(updates)
    }
    pub fn commit_preview(&mut self, invocation: &str, step: &str, message: Option<&str>) {
        if let Some(message) = message {
            self.committed_parts
                .insert((invocation.into(), step.into(), message.into()));
            self.preview_seed.retain(|(_, id, _), _| id != message);
        } else {
            self.closed_steps.insert((invocation.into(), step.into()));
            if self
                .preview_attempt
                .as_ref()
                .is_some_and(|(i, s)| i == invocation && s == step)
            {
                self.preview_seed.clear();
            }
        }
    }

    pub fn preview(&mut self, page: &PreviewPage) -> Result<Vec<Update>, crate::Error> {
        let PreviewPage::Cut {
            host_epoch,
            invocation_id,
            turn_id,
            step_id,
            parts,
            ..
        } = page
        else {
            self.preview_seed.clear();
            self.preview_attempt = None;
            return Ok(vec![]);
        };
        if self
            .preview_epoch
            .as_ref()
            .is_some_and(|epoch| epoch != host_epoch)
        {
            self.committed_parts.clear();
            self.closed_steps.clear();
            self.preview_seed.clear();
        }
        self.preview_epoch = Some(host_epoch.clone());
        let attempt = (invocation_id.clone(), step_id.clone());
        if self.preview_attempt.as_ref() != Some(&attempt) {
            self.preview_seed.clear();
            self.committed_parts
                .retain(|(i, s, _)| i == invocation_id && s == step_id);
            self.closed_steps
                .retain(|(i, s)| i == invocation_id && s == step_id);
            self.preview_attempt = Some(attempt.clone());
        }
        if self.closed_steps.contains(&attempt) {
            return Ok(vec![]);
        }
        let mut updates = Vec::new();
        for part in parts {
            if self.assembly.as_ref().is_some_and(|assembly| {
                &assembly.turn_id == turn_id && assembly.message_id == part.message_id
            }) || self.committed_parts.contains(&(
                invocation_id.clone(),
                step_id.clone(),
                part.message_id.clone(),
            )) {
                continue;
            }
            let PreviewField::Text { text_kind } = &part.field else {
                continue;
            };
            let kind = match text_kind {
                ContentKind::Text => MessageKind::Text,
                ContentKind::Thinking => MessageKind::Thinking,
            };
            let key = (turn_id.clone(), part.message_id.clone(), kind);
            if self
                .streams
                .get(&key)
                .is_some_and(|message| message.canonical)
            {
                continue;
            }
            if part.offset == 0 {
                self.preview_seed.insert(key.clone(), String::new());
            }
            if let Some(text) = self.preview_seed.get_mut(&key) {
                if text.len() as u64 != part.offset {
                    return Err("Preview seed fragments are discontinuous".into());
                }
                text.push_str(&part.text);
                if text.len() as u64 > part.total_bytes {
                    return Err("Preview seed exceeds its declared size".into());
                }
                if text.len() as u64 == part.total_bytes {
                    let text = self
                        .preview_seed
                        .remove(&key)
                        .expect("complete preview seed");
                    updates.extend(self.replace_text(
                        turn_id,
                        &part.message_id,
                        kind,
                        &text,
                        message_meta(turn_id, &part.message_id),
                    ));
                }
            } else {
                if self
                    .streams
                    .get(&key)
                    .map(|message| message.text.len() as u64)
                    != Some(part.offset)
                {
                    return Err("Preview suffix has no complete prefix".into());
                }
                if part.offset + part.text.len() as u64 > part.total_bytes {
                    return Err("Preview suffix exceeds its declared size".into());
                }
                updates.extend(self.append(turn_id, &part.message_id, text_kind, &part.text));
            }
        }
        Ok(updates)
    }

    pub fn append(&mut self, turn: &str, id: &str, kind: &ContentKind, delta: &str) -> Vec<Update> {
        let message_kind = match kind {
            ContentKind::Text => MessageKind::Text,
            ContentKind::Thinking => MessageKind::Thinking,
        };
        let key = (turn.to_owned(), id.to_owned(), message_kind);
        let meta = message_meta(turn, id);
        if delta.is_empty()
            && self
                .streams
                .get(&key)
                .is_none_or(|message| message.meta == meta)
        {
            return vec![];
        }
        let message = self.streams.entry(key).or_insert_with(|| Message {
            text: String::new(),
            meta: meta.clone(),
            canonical: false,
        });
        message.text.push_str(delta);
        message.meta = meta.clone();
        let update = Update::Message {
            id: if message_kind == MessageKind::Thinking {
                format!("thinking:{id}")
            } else {
                id.into()
            },
            kind: message_kind,
            text: Text::Delta(delta.into()),
            meta,
        };
        vec![update]
    }
}

fn message_meta(turn: &str, id: &str) -> Meta {
    Meta::from_iter([("maka".into(), json!({"hostMessageId":id,"turnId":turn}))])
}
