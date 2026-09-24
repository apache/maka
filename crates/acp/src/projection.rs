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

//! Bounded ACP presentation of public observations and durable transcript rows.
use agent_client_protocol::schema::{MaybeUndefined, v2 as acp};
use maka_protocol::subscription::{
    AssistantStreamKind, SessionAssistantDelta, SessionToolEvent, ToolResultStatus,
};
use serde_json::{Value, json};
use std::collections::HashMap;

mod messages;
mod tools;

const IDENTITIES: usize = 4096;
const TOTAL_BYTES: usize = 16 * 1024 * 1024;
const TOOL_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum MessageKind {
    User,
    Text,
    Thinking,
}

struct Message {
    text: String,
    meta: acp::Meta,
    bytes: usize,
}

#[derive(Default)]
pub struct Projection {
    streams: HashMap<(String, String, MessageKind), Message>,
    tools: HashMap<String, Tool>,
    bytes: usize,
}

struct Tool {
    turn: String,
    card: acp::ToolCallUpdate,
    published: Option<acp::ToolCallUpdate>,
    published_bytes: usize,
    authoritative: bool,
    announced: bool,
}

impl Projection {
    pub fn row(&mut self, row: &Value) -> Result<Vec<acp::SessionUpdate>, crate::Error> {
        let id = required(row, "id")?;
        let turn = required(row, "turnId")?;
        match required(row, "type")? {
            "assistant" => {
                let mut updates = self.text(
                    turn,
                    id,
                    MessageKind::Thinking,
                    row["thinking"]["text"].as_str().unwrap_or(""),
                    true,
                    message_meta(turn, id),
                )?;
                updates.extend(self.text(
                    turn,
                    id,
                    MessageKind::Text,
                    required(row, "text")?,
                    true,
                    message_meta(turn, id),
                )?);
                Ok(updates)
            }
            "user" => {
                let mut meta = message_meta(turn, id);
                if let Some(attachments) = row["attachments"].as_array().filter(|a| !a.is_empty()) {
                    // Host storage references are not client-readable resource URIs.
                    meta["maka"]["attachments"] = bounded_value(&Value::Array(attachments.iter().map(|a| {
                        json!({"name":a["name"], "mimeType":a["mimeType"], "bytes":a["bytes"], "kind":a["kind"]})
                    }).collect()));
                }
                self.text(
                    turn,
                    id,
                    MessageKind::User,
                    row["displayText"]
                        .as_str()
                        .or_else(|| row["text"].as_str())
                        .unwrap_or(""),
                    true,
                    meta,
                )
            }
            "tool_call" | "tool_result" => self.tool_row(row, turn, id),
            _ => Ok(vec![]),
        }
    }
}

fn message_meta(turn: &str, id: &str) -> acp::Meta {
    acp::Meta::from_iter([("maka".into(), json!({"hostMessageId":id,"turnId":turn}))])
}
fn required<'a>(row: &'a Value, key: &str) -> Result<&'a str, crate::Error> {
    row[key]
        .as_str()
        .ok_or_else(|| format!("Transcript {key} is missing").into())
}
fn bounded(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let suffix = "\n[Presentation truncated]";
    let mut end = max - suffix.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}", &text[..end])
}
fn bounded_value(value: &Value) -> Value {
    let encoded = value.to_string();
    if encoded.len() <= TOOL_BYTES {
        value.clone()
    } else {
        json!({"truncated":true,"preview":bounded(&encoded, TOOL_BYTES)})
    }
}
