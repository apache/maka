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
use agent_client_protocol::schema::{MaybeUndefined, v2 as acp};
use maka_agent_api::contract::{ContentKind, HistoryChunk};
use maka_agent_ports::session::history::HistoryField;
use maka_agent_ports::session::history::Role;
use serde_json::{Value, json};
use std::collections::HashMap;

mod messages;
mod tools;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum MessageKind {
    User,
    Text,
    Thinking,
}

struct Message {
    text: String,
    meta: acp::Meta,
}

#[derive(Default)]
pub struct Projection {
    streams: HashMap<(String, String, MessageKind), Message>,
    tools: HashMap<String, Tool>,
    assembly: Option<(
        maka_agent_ports::session::history::RowPosition,
        HistoryField,
        String,
        acp::Meta,
    )>,
}

struct Tool {
    turn: String,
    card: acp::ToolCallUpdate,
    published: Option<acp::ToolCallUpdate>,
    authoritative: bool,
}

impl Projection {
    pub fn chunk(&mut self, chunk: &HistoryChunk) -> Result<Vec<acp::SessionUpdate>, crate::Error> {
        if chunk.offset == 0 {
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
            self.assembly = Some((chunk.position, chunk.field, String::new(), meta));
        }
        let (sequence, field, text, _) = self
            .assembly
            .as_mut()
            .ok_or("History field starts with a missing fragment")?;
        if *sequence != chunk.position || *field != chunk.field || text.len() as u64 != chunk.offset
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
        let (_, _, text, mut meta) = self.assembly.take().expect("complete field");
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
        Ok(self.replace_text(&chunk.turn_id, &chunk.message_id, kind, &text, meta))
    }
    pub fn append(
        &mut self,
        turn: &str,
        id: &str,
        kind: &ContentKind,
        delta: &str,
    ) -> Vec<acp::SessionUpdate> {
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
        });
        message.text.push_str(delta);
        message.meta = meta.clone();
        let update = match kind {
            ContentKind::Text => acp::SessionUpdate::AgentMessageChunk(
                acp::ContentChunk::new(delta.into(), id).meta(meta),
            ),
            ContentKind::Thinking => acp::SessionUpdate::AgentThoughtChunk(
                acp::ContentChunk::new(delta.into(), format!("thinking:{id}")).meta(meta),
            ),
        };
        vec![update]
    }
}

fn message_meta(turn: &str, id: &str) -> acp::Meta {
    acp::Meta::from_iter([("maka".into(), json!({"hostMessageId":id,"turnId":turn}))])
}
