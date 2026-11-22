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

//! OpenCode's selected-session snapshot. The database reader must obtain these
//! rows in one read transaction; conversion never opens an ambient source path.
mod exact;
pub use exact::read as read_exact;
mod database;
mod wire;
use crate::{
    Error, Fingerprint, Transcript, jsonl,
    transcript::{Records, identity, source_cwd, title},
};
pub use database::read;
use maka_agent_facts::import::Content;
use maka_agent_facts::import::Record;
use maka_agent_facts::import::Source;
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use wire::{Part as ContentPart, Role, Status};

/// Raw SQL cells, not a provider export or a second canonical message model.
pub struct Snapshot {
    pub session: Session,
    pub messages: Vec<Message>,
    pub parts: Vec<Part>,
}
#[derive(Serialize)]
pub struct Session {
    pub id: String,
    pub parent_id: Option<String>,
    pub directory: Option<String>,
    pub title: Option<String>,
    pub revert: Option<Revert>,
}
#[derive(Deserialize, Serialize)]
pub struct Revert {
    #[serde(rename = "messageID")]
    pub message_id: String,
    #[serde(rename = "partID")]
    pub part_id: Option<String>,
}
#[derive(Serialize)]
pub struct Message {
    pub id: String,
    pub created_at: Option<u64>,
    pub data: Box<RawValue>,
}
#[derive(Serialize)]
pub struct Part {
    pub id: String,
    pub message_id: String,
    pub created_at: Option<u64>,
    pub data: Box<RawValue>,
}

pub fn convert(mut snapshot: Snapshot, expected_session_id: &str) -> Result<Transcript, Error> {
    identity(expected_session_id)?;
    if snapshot.session.id != expected_session_id {
        return Err(Error::Invalid(
            "OpenCode source does not match the selected session",
        ));
    }
    if snapshot
        .session
        .parent_id
        .as_ref()
        .is_some_and(|id| !id.is_empty())
    {
        return Err(Error::Invalid("OpenCode source is a child session"));
    }

    let mut fingerprint = Evidence::default();
    fingerprint.record(&snapshot.session)?;
    let mut message_ids = BTreeSet::new();
    for message in &snapshot.messages {
        identity(&message.id)?;
        timestamp(message.created_at)?;
        if !message_ids.insert(message.id.as_str()) {
            return Err(Error::Invalid("duplicate OpenCode message identity"));
        }
        fingerprint.record(message)?;
    }
    let mut part_ids = BTreeSet::new();
    for part in &snapshot.parts {
        identity(&part.id)?;
        identity(&part.message_id)?;
        timestamp(part.created_at)?;
        if !part_ids.insert(part.id.as_str()) || !message_ids.contains(part.message_id.as_str()) {
            return Err(Error::Invalid("duplicate or orphaned OpenCode part"));
        }
        fingerprint.record(part)?;
    }
    drop(message_ids);
    drop(part_ids);
    snapshot.messages.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    snapshot.parts.sort_by(|a, b| {
        a.message_id
            .cmp(&b.message_id)
            .then_with(|| a.id.cmp(&b.id))
    });
    if let Some(revert) = &snapshot.session.revert {
        identity(&revert.message_id)?;
        let index = snapshot
            .messages
            .iter()
            .position(|message| message.id == revert.message_id)
            .ok_or(Error::Invalid("OpenCode revert message is missing"))?;
        if let Some(part_id) = &revert.part_id {
            identity(part_id)?;
            let boundary = snapshot
                .parts
                .iter()
                .position(|part| part.id == *part_id && part.message_id == revert.message_id)
                .ok_or(Error::Invalid("OpenCode revert part is missing"))?;
            // A partial-message revert retains only parts preceding its boundary.
            let mut at = 0;
            snapshot.parts.retain(|part| {
                let keep = part.message_id != revert.message_id || at < boundary;
                at += 1;
                keep
            });
            snapshot.messages.truncate(index + 1);
        } else {
            snapshot.messages.truncate(index);
        }
    }
    let mut parts = BTreeMap::<&str, Vec<(usize, &Part)>>::new();
    for (index, part) in snapshot.parts.iter().enumerate() {
        parts
            .entry(&part.message_id)
            .or_default()
            .push((index, part));
    }
    let mut records = Records::default();
    let mut turn = None;
    for (message_index, message) in snapshot.messages.iter().enumerate() {
        let data: wire::Message = jsonl::decode(&message.data, message_index as u64 + 1)?;
        if matches!(data.role, Role::User) || turn.is_none() {
            turn = Some(message.id.clone());
        }
        let turn = turn.as_ref().expect("message opens a source turn");
        let ts = data
            .time
            .as_ref()
            .and_then(|time| time.created.as_ref())
            .and_then(|time| time.millis())
            .or(message.created_at);
        if let Some(model) = &data.model {
            identity(model)?;
        }
        for (part_index, part) in parts.remove(message.id.as_str()).unwrap_or_default() {
            let content: ContentPart = jsonl::decode(&part.data, part_index as u64 + 1)?;
            let record_id = format!("part:{part_index}");
            let mut append = |suffix: &str, content| {
                records.push(Record {
                    source_message_id: format!("{record_id}:{suffix}"),
                    source_turn_id: turn.clone(),
                    timestamp: ts,
                    content,
                })
            };
            match content {
                ContentPart::Text { text, synthetic } => {
                    if text.is_empty() {
                        continue;
                    }
                    append(
                        "text",
                        match data.role {
                            Role::User if synthetic => Content::Note { text },
                            Role::User => Content::User { text },
                            Role::Assistant => Content::Assistant {
                                text,
                                model: data.model.clone(),
                                thinking: None,
                            },
                        },
                    )?;
                }
                ContentPart::Reasoning { text } if matches!(data.role, Role::Assistant) => {
                    if !text.is_empty() {
                        append(
                            "thinking",
                            Content::Assistant {
                                text: String::new(),
                                model: data.model.clone(),
                                thinking: Some(text),
                            },
                        )?;
                    }
                }
                ContentPart::Tool {
                    call_id,
                    tool,
                    state,
                } if matches!(data.role, Role::Assistant) => {
                    identity(&call_id)?;
                    identity(&tool)?;
                    // A source may reuse callID in another message. The durable
                    // part identity, normalized to its snapshot position, owns pairing.
                    append(
                        "call",
                        Content::ToolCall {
                            call_id: record_id.clone(),
                            name: tool,
                            input: state.input,
                        },
                    )?;
                    let output = match state.status {
                        Status::Completed => Some((
                            state
                                .output
                                .ok_or(Error::Invalid("completed OpenCode tool has no output"))?,
                            false,
                        )),
                        Status::Error => Some((
                            state
                                .error
                                .ok_or(Error::Invalid("failed OpenCode tool has no error"))?,
                            true,
                        )),
                        Status::Pending | Status::Running => None,
                    };
                    if let Some((output, is_error)) = output {
                        append(
                            "result",
                            Content::ToolResult {
                                call_id: record_id.clone(),
                                output: Value::String(output),
                                is_error,
                            },
                        )?;
                    }
                }
                ContentPart::File { filename, mime } => {
                    let label = filename.as_deref().or(mime.as_deref()).unwrap_or("file");
                    let text = format!("[Attachment: {label}]");
                    append(
                        "attachment",
                        if matches!(data.role, Role::User) {
                            Content::User { text }
                        } else {
                            Content::Note { text }
                        },
                    )?;
                }
                ContentPart::Compaction => append(
                    "compaction",
                    Content::Note {
                        text: "Source context was compacted.".into(),
                    },
                )?,
                _ => {}
            }
        }
        if let Some(error) = data.error {
            records.push(Record {
                source_message_id: format!("message:{message_index}:error"),
                source_turn_id: turn.clone(),
                timestamp: ts,
                content: Content::Note {
                    text: format!("Source error: {}", error.name),
                },
            })?;
        }
        if let Some(finish) = data.finish {
            records.push(Record {
                source_message_id: format!("message:{message_index}:finish"),
                source_turn_id: turn.clone(),
                timestamp: ts,
                content: Content::Note {
                    text: format!("Source finish: {finish}"),
                },
            })?;
        }
    }
    let records = records.finish()?;
    let name = snapshot
        .session
        .title
        .as_deref()
        .map(title)
        .filter(|name| !name.is_empty())
        .or_else(|| {
            records.iter().find_map(|record| match &record.content {
                Content::User { text } if !text.trim().is_empty() => Some(title(text)),
                _ => None,
            })
        })
        .unwrap_or_else(|| expected_session_id.into());
    Ok(Transcript {
        source: Source {
            adapter: "opencode".into(),
            session_id: expected_session_id.into(),
        },
        cwd: source_cwd(snapshot.session.directory),
        title: name,
        records,
        fingerprint: Fingerprint {
            bytes: fingerprint.bytes,
            sha256: hex::encode(fingerprint.hash.finalize()),
            incomplete_tail: false,
        },
    })
}
fn timestamp(value: Option<u64>) -> Result<(), Error> {
    if value.is_some_and(|value| value > 9_007_199_254_740_991) {
        Err(Error::Invalid("invalid OpenCode timestamp"))
    } else {
        Ok(())
    }
}

/// Framed JSON rows retain the exact selected source bytes, without allocating
/// a second transcript-sized serialization just to calculate its evidence.
#[derive(Default)]
struct Evidence {
    bytes: u64,
    hash: Sha256,
}
impl Evidence {
    fn record(&mut self, value: &impl Serialize) -> Result<(), Error> {
        use std::io::Write;
        serde_json::to_writer(&mut *self, value)
            .map_err(|_| Error::Invalid("invalid source snapshot"))?;
        self.write_all(b"\n")
            .map_err(|_| Error::Invalid("invalid source snapshot"))
    }
}
impl std::io::Write for Evidence {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes += bytes.len() as u64;
        self.hash.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
