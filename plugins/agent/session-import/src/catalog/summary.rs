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

use super::{Entry, Format};
use crate::{
    Error, jsonl,
    transcript::{source_cwd, title},
};
use maka_capabilities::filesystem::FileInfo;
use maka_capabilities::filesystem::ReadViewInput;
use maka_capabilities::filesystem::Reader;
use maka_capabilities::filesystem::Symlinks;
use maka_capabilities::filesystem::entries::ReadFile;
use serde::Deserialize;
use serde_json::value::RawValue;

pub(super) fn read(
    reader: &Reader<'_>,
    format: Format,
    path: String,
    archived: bool,
    info: FileInfo,
) -> Result<Option<Entry>, Error> {
    let budget = match format {
        Format::Codex => 512 * 1024,
        Format::ClaudeCode => 256 * 1024,
    };
    let head = window(reader, &path, 0, budget)?;
    let mut scan = Scan::default();
    let complete = info.length <= head.len() as u64;
    observe(&head, complete, format, &mut scan);
    if format == Format::ClaudeCode {
        if scan.cwd.is_none() {
            scan.cwd = top_string(&head, "cwd");
        }
        if scan.id.is_none() {
            scan.id = top_string(&head, "sessionId");
        }
        if info.length > head.len() as u64 {
            let offset = (info.length.saturating_sub(budget as u64)).max(head.len() as u64);
            let tail = window(reader, &path, offset, budget)?;
            // Discard the first partial row unless the two windows touch at a newline.
            let start = if offset == head.len() as u64 && head.last() == Some(&b'\n') {
                0
            } else {
                tail.iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(tail.len(), |at| at + 1)
            };
            observe(&tail[start..], true, format, &mut scan);
        }
    }
    if scan.sidechain {
        return Ok(None);
    }
    let filename = path.rsplit('/').next().unwrap_or(&path);
    let id = match format {
        Format::Codex => {
            let Some(id) = scan
                .id
                .filter(|id| safe_id(id, false) && filename.ends_with(&format!("-{id}.jsonl")))
            else {
                return Ok(None);
            };
            id
        }
        Format::ClaudeCode => {
            let id = filename.strip_suffix(".jsonl").unwrap_or("");
            if !safe_id(id, true) || scan.id.as_ref().is_some_and(|observed| observed != id) {
                return Ok(None);
            }
            if scan.records == 0 && info.length < budget as u64 {
                return Ok(None);
            }
            id.into()
        }
    };
    Ok(Some(Entry {
        title: scan.title.unwrap_or_else(|| id.clone()),
        id,
        path,
        cwd: source_cwd(scan.cwd),
        updated_at: info.modified_at,
        archived,
    }))
}
pub(super) fn safe_id(id: &str, claude: bool) -> bool {
    !id.is_empty()
        && id.bytes().all(|byte| {
            byte == b'-'
                || if claude {
                    byte.is_ascii_hexdigit()
                } else {
                    byte.is_ascii_alphanumeric() || byte == b'_'
                }
        })
}
fn window(reader: &Reader<'_>, path: &str, offset: u64, limit: usize) -> Result<Vec<u8>, Error> {
    Ok(reader
        .read(ReadViewInput {
            file: ReadFile {
                path: path.into(),
                offset,
                limit,
            },
            symlinks: Symlinks::Reject,
        })?
        .bytes)
}
#[derive(Default)]
struct Scan {
    id: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    title_priority: u8,
    sidechain: bool,
    records: usize,
}
impl Scan {
    fn title(&mut self, priority: u8, text: Option<String>) {
        if priority >= self.title_priority
            && let Some(text) =
                text.filter(|text| !text.trim().is_empty() && !crate::synthetic::instructions(text))
        {
            self.title = Some(title(&text));
            self.title_priority = priority;
        }
    }
}
fn observe(bytes: &[u8], last_complete: bool, format: Format, scan: &mut Scan) {
    for row in bytes.split_inclusive(|byte| *byte == b'\n') {
        if row.last() != Some(&b'\n') && !last_complete {
            continue;
        }
        let Ok(head) = serde_json::from_slice::<Head<'_>>(row) else {
            continue;
        };
        scan.records += 1;
        match format {
            Format::Codex => {
                let Some(payload) = head.payload else {
                    continue;
                };
                if head.kind == Kind::Meta {
                    let Ok(meta) = jsonl::decode::<Meta>(payload, 0) else {
                        continue;
                    };
                    if !meta.source.as_ref().is_none_or(Origin::supported) {
                        scan.sidechain = true;
                        continue;
                    }
                    if let Some(id) = meta.session_id.or(meta.id) {
                        if scan.id.as_ref().is_some_and(|previous| previous != &id) {
                            scan.sidechain = true;
                        }
                        scan.id = Some(id);
                    }
                    scan.cwd = meta.cwd.or(scan.cwd.take());
                } else if head.kind == Kind::Event && scan.title.is_none() {
                    let Ok(event) = jsonl::decode::<UserEvent>(payload, 0) else {
                        continue;
                    };
                    let text = match event.kind {
                        EventKind::User => event.message,
                        EventKind::ItemCompleted => event
                            .item
                            .filter(|item| item.kind == ItemKind::User)
                            .and_then(|item| item.content.map(Text::text)),
                        EventKind::Other => None,
                    };
                    scan.title(1, text);
                }
            }
            Format::ClaudeCode => {
                scan.sidechain |= head.is_sidechain;
                if scan.cwd.is_none() {
                    scan.cwd = head.cwd;
                }
                if let Some(id) = head.session_id {
                    if scan.id.as_ref().is_some_and(|previous| previous != &id) {
                        scan.sidechain = true;
                    }
                    scan.id = Some(id);
                }
                scan.title(5, head.custom_title);
                scan.title(
                    4,
                    head.ai_title
                        .or_else(|| (head.kind == Kind::AiTitle).then_some(head.title).flatten()),
                );
                scan.title(
                    3,
                    head.last_prompt.or_else(|| {
                        (head.kind == Kind::LastPrompt)
                            .then_some(head.prompt)
                            .flatten()
                    }),
                );
                scan.title(2, head.summary);
                if scan.title_priority < 1
                    && head.kind == Kind::User
                    && !head.is_meta
                    && !head.is_compact_summary
                    && let Some(message) = head.message
                    && let Ok(message) = jsonl::decode::<Message>(message, 0)
                {
                    let text = message.content.map(Text::text);
                    scan.title(1, text.filter(|text| !crate::claude::synthetic(text)));
                }
            }
        }
    }
}
#[derive(Deserialize, PartialEq, Eq)]
enum Kind {
    #[serde(rename = "session_meta")]
    Meta,
    #[serde(rename = "event_msg")]
    Event,
    #[serde(rename = "user")]
    User,
    #[serde(rename = "ai-title")]
    AiTitle,
    #[serde(rename = "last-prompt")]
    LastPrompt,
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Head<'a> {
    #[serde(rename = "type")]
    kind: Kind,
    #[serde(borrow)]
    payload: Option<&'a RawValue>,
    #[serde(borrow)]
    message: Option<&'a RawValue>,
    session_id: Option<String>,
    cwd: Option<String>,
    #[serde(default)]
    is_sidechain: bool,
    #[serde(default)]
    is_meta: bool,
    #[serde(default)]
    is_compact_summary: bool,
    custom_title: Option<String>,
    ai_title: Option<String>,
    title: Option<String>,
    last_prompt: Option<String>,
    prompt: Option<String>,
    summary: Option<String>,
}
#[derive(Deserialize)]
struct Meta {
    id: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    source: Option<Origin>,
}
#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum Origin {
    Text(String),
    Object { custom: Option<String> },
}
impl Origin {
    pub(super) fn supported(&self) -> bool {
        fn supported(value: &str) -> bool {
            matches!(value, "cli" | "exec" | "vscode" | "atlas" | "chatgpt")
        }
        match self {
            Self::Text(value) if supported(value) => true,
            Self::Text(value) => serde_json::from_str::<Origin>(value).ok().is_some_and(|origin|
                matches!(origin, Self::Object { custom: Some(value) } if supported(&value))),
            Self::Object { custom: Some(value) } => supported(value),
            _ => false,
        }
    }
}
#[derive(Deserialize)]
struct UserEvent {
    #[serde(rename = "type")]
    kind: EventKind,
    message: Option<String>,
    item: Option<Item>,
}
#[derive(Deserialize)]
enum EventKind {
    #[serde(rename = "user_message")]
    User,
    #[serde(rename = "item_completed")]
    ItemCompleted,
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
struct Item {
    #[serde(rename = "type")]
    kind: ItemKind,
    content: Option<Text>,
}
#[derive(Deserialize, PartialEq, Eq)]
enum ItemKind {
    #[serde(rename = "UserMessage", alias = "usermessage", alias = "user_message")]
    User,
    #[serde(other)]
    Other,
}
#[derive(Deserialize)]
struct Message {
    content: Option<Text>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Text {
    Text(String),
    Parts(Vec<Part>),
}
#[derive(Deserialize)]
#[serde(tag = "type")]
enum Part {
    #[serde(rename = "text", alias = "input_text", alias = "output_text")]
    Text { text: String },
    #[serde(other)]
    Other,
}
impl Text {
    fn text(self) -> String {
        match self {
            Self::Text(text) => text,
            Self::Parts(parts) => parts
                .into_iter()
                .filter_map(|part| match part {
                    Part::Text { text } => Some(text),
                    Part::Other => None,
                })
                .collect::<Vec<_>>()
                .join(""),
        }
    }
}

/// Only a complete top-level string is usable when the opening JSONL record is
/// larger than the catalog window. Nested cwd fields and encoded folder names
/// cannot stand in for it.
fn top_string(bytes: &[u8], field: &str) -> Option<String> {
    for line in bytes.split(|byte| *byte == b'\n') {
        let mut index = 0;
        let mut depth = 0;
        let mut key = false;
        while index < line.len() {
            match line[index] {
                b'{' | b'[' => {
                    depth += 1;
                    key = depth == 1 && line[index] == b'{';
                }
                b'}' | b']' => {
                    depth -= 1;
                    key = false;
                }
                b',' if depth == 1 => key = true,
                b'"' => {
                    let end = string_end(line, index)?;
                    if depth == 1 && key {
                        let name: String = serde_json::from_slice(&line[index..end]).ok()?;
                        let mut value = end;
                        while line.get(value).is_some_and(u8::is_ascii_whitespace) {
                            value += 1;
                        }
                        if line.get(value) != Some(&b':') {
                            break;
                        }
                        value += 1;
                        while line.get(value).is_some_and(u8::is_ascii_whitespace) {
                            value += 1;
                        }
                        if name == field && line.get(value) == Some(&b'"') {
                            let end = string_end(line, value)?;
                            return serde_json::from_slice(&line[value..end]).ok();
                        }
                        key = false;
                    }
                    index = end;
                    continue;
                }
                _ => {}
            }
            index += 1;
        }
    }
    None
}
fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}
