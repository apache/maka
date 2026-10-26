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

//! Codex rollout conversion. Event messages own conversation; response items own
//! tool observations. Provider message mirrors never become duplicate history.
mod wire;
use crate::{
    Error, Transcript, jsonl,
    transcript::{Records, identity, source_cwd, title},
};
use maka_agent_facts::import::Content;
use maka_agent_facts::import::Record;
use maka_agent_facts::import::Source;
use maka_capabilities::filesystem::PinnedFile;
use std::collections::{BTreeMap, BTreeSet};
use wire::{Envelope, Event, ItemKind, Kind, Meta, Response, Turn, decode};

pub async fn read(file: &PinnedFile, expected_session_id: &str) -> Result<Transcript, Error> {
    identity(expected_session_id)?;
    let expected = expected_session_id.to_owned();
    let length = file.info().length;
    file.with_reader(move |reader| {
        Ok((|| {
            let mut converter = Converter::new(expected);
            let fingerprint = jsonl::scan(reader, length, |line| converter.accept(line))?;
            if !converter.has_meta {
                return Err(Error::Invalid("Codex session metadata is missing"));
            }
            let records = converter.records.finish()?;
            let title = records
                .iter()
                .find_map(|record| match &record.content {
                    Content::User { text } if !text.trim().is_empty() => Some(title(text)),
                    _ => None,
                })
                .unwrap_or_else(|| converter.expected.clone());
            Ok(Transcript {
                source: Source {
                    adapter: "codex".into(),
                    session_id: converter.expected,
                },
                cwd: converter.cwd,
                title,
                records,
                fingerprint,
            })
        })())
    })
    .await?
}

struct Call {
    key: String,
    turn: String,
    completed: bool,
}
struct Converter {
    expected: String,
    has_meta: bool,
    cwd: Option<String>,
    model: Option<String>,
    turn: Option<String>,
    explicit_turn: bool,
    turns: Vec<String>,
    calls: BTreeMap<String, Call>,
    records: Records,
}
impl Converter {
    fn new(expected: String) -> Self {
        Self {
            expected,
            has_meta: false,
            cwd: None,
            model: None,
            turn: None,
            explicit_turn: false,
            turns: Vec::new(),
            calls: BTreeMap::new(),
            records: Records::default(),
        }
    }
    fn accept(&mut self, line: jsonl::Line<'_>) -> Result<(), Error> {
        let envelope: Envelope<'_> = line.decode()?;
        if matches!(envelope.kind, Kind::Other) {
            return Ok(());
        }
        let payload = envelope
            .payload
            .ok_or(Error::Invalid("missing Codex record payload"))?;
        let timestamp = envelope
            .timestamp
            .as_ref()
            .and_then(|time| time.codex_millis());
        let mut source_id = None;
        let content = match envelope.kind {
            Kind::SessionMeta => {
                let meta: Meta = decode(payload, line.number)?;
                if meta.session_id.as_ref().or(meta.id.as_ref()) != Some(&self.expected) {
                    return Err(Error::Invalid(
                        "Codex session metadata does not match the selected session",
                    ));
                }
                if !self.has_meta {
                    self.cwd = source_cwd(meta.cwd);
                }
                self.has_meta = true;
                None
            }
            Kind::TurnContext => {
                let context: Turn = decode(payload, line.number)?;
                self.set_turn(context.turn_id)?;
                if context.model.is_some() {
                    self.model = context.model;
                }
                None
            }
            Kind::Event => {
                let event: Event = decode(payload, line.number)?;
                match event {
                    Event::Started { turn_id } => {
                        self.set_turn(turn_id)?;
                        None
                    }
                    Event::CompletedItem { turn_id, item } => {
                        self.set_turn(turn_id)?;
                        source_id = item.client_id.or(item.id);
                        match item.kind {
                            ItemKind::Plan => self.assistant(item.text.unwrap_or_default(), None),
                            ItemKind::User => self.user(
                                item.content
                                    .map(|content| content.user_text())
                                    .unwrap_or_default(),
                                line.number,
                            ),
                            ItemKind::Agent => self.assistant(
                                item.content
                                    .map(|content| content.text())
                                    .unwrap_or_default(),
                                None,
                            ),
                            ItemKind::Reasoning => {
                                let thinking = item
                                    .summary_text
                                    .map(|summary| summary.text())
                                    .filter(|text| !text.is_empty())
                                    .unwrap_or_else(|| {
                                        item.raw_content
                                            .map(|parts| parts.join("\n"))
                                            .or_else(|| item.content.map(|content| content.text()))
                                            .unwrap_or_default()
                                    });
                                self.assistant(String::new(), Some(thinking))
                            }
                            ItemKind::Other => None,
                        }
                    }
                    Event::User(user) => {
                        source_id = user.client_id.clone();
                        self.user(user.text(), line.number)
                    }
                    Event::Agent { message } => self.assistant(message, None),
                    Event::Reasoning { text } | Event::RawReasoning { text } => {
                        self.assistant(String::new(), Some(text))
                    }
                    Event::RolledBack { num_turns } => {
                        self.rollback(num_turns)?;
                        None
                    }
                    Event::Compacted => Some(Content::Note {
                        text: "Source context compacted".into(),
                    }),
                    Event::Error { message } => Some(Content::Note {
                        text: message.unwrap_or_else(|| "Source reported an error".into()),
                    }),
                    Event::Finished { turn_id, error } => {
                        self.set_turn(turn_id)?;
                        self.append(
                            line.number,
                            timestamp,
                            None,
                            Content::Note {
                                text: if error.is_some() {
                                    "Source turn ended with an error"
                                } else {
                                    "Source turn completed"
                                }
                                .into(),
                            },
                        )?;
                        self.turn = None;
                        self.explicit_turn = false;
                        None
                    }
                    Event::Aborted { turn_id, reason } => {
                        self.set_turn(turn_id)?;
                        self.append(
                            line.number,
                            timestamp,
                            None,
                            Content::Note {
                                text: reason
                                    .map(|reason| format!("Source turn aborted: {reason}"))
                                    .unwrap_or_else(|| "Source turn aborted".into()),
                            },
                        )?;
                        self.turn = None;
                        self.explicit_turn = false;
                        None
                    }
                    Event::Other => None,
                }
            }
            Kind::Response => {
                let response: Response = decode(payload, line.number)?;
                match response {
                    Response::Function {
                        call_id,
                        name,
                        namespace,
                        arguments,
                    } => Some(self.call(line.number, call_id, name, namespace, arguments)?),
                    Response::Custom {
                        call_id,
                        name,
                        namespace,
                        input,
                    } => Some(self.call(line.number, call_id, name, namespace, input)?),
                    Response::Output {
                        call_id,
                        output,
                        id,
                    } => {
                        identity(&call_id)?;
                        source_id = id;
                        let (key, turn) = match self.calls.get_mut(&call_id) {
                            Some(call) if !call.completed => {
                                call.completed = true;
                                (call.key.clone(), Some(call.turn.clone()))
                            }
                            Some(_) => return Err(Error::Invalid("duplicate Codex tool result")),
                            None => (format!("unmatched:{}", line.number), None),
                        };
                        let record = Record {
                            source_message_id: source_id
                                .unwrap_or_else(|| format!("line:{}", line.number)),
                            source_turn_id: turn.unwrap_or_else(|| self.turn(line.number)),
                            timestamp,
                            // Codex does not persist the success flag. Preserve the
                            // output body without guessing failure from its text.
                            content: Content::ToolResult {
                                call_id: key,
                                output,
                                is_error: false,
                            },
                        };
                        self.track_turn(&record.source_turn_id)?;
                        self.records.push(record)?;
                        return Ok(());
                    }
                    Response::Other => None,
                }
            }
            Kind::Compacted => {
                let compacted: wire::Compacted = decode(payload, line.number)?;
                Some(Content::Note {
                    text: compacted
                        .message
                        .unwrap_or_else(|| "Source context compacted".into()),
                })
            }
            Kind::Other => None,
        };
        if let Some(content) = content {
            self.append(line.number, timestamp, source_id, content)?;
        }
        Ok(())
    }
    fn call(
        &mut self,
        line: u64,
        id: String,
        name: String,
        namespace: Option<String>,
        input: Option<String>,
    ) -> Result<Content, Error> {
        identity(&id)?;
        identity(&name)?;
        if self.calls.get(&id).is_some_and(|call| !call.completed) {
            return Err(Error::Invalid("ambiguous overlapping Codex tool calls"));
        }
        let key = format!("call:{line}");
        let turn = self.turn(line);
        self.calls.insert(
            id,
            Call {
                key: key.clone(),
                turn,
                completed: false,
            },
        );
        let name = namespace
            .filter(|value| !value.is_empty())
            .map(|namespace| format!("{namespace}.{name}"))
            .unwrap_or(name);
        let input = input
            .map(
                |input| match serde_json::from_str::<&serde_json::value::RawValue>(&input) {
                    Ok(raw) => jsonl::decode(raw, line),
                    Err(_) => Ok(serde_json::Value::String(input)),
                },
            )
            .transpose()?;
        Ok(Content::ToolCall {
            call_id: key,
            name,
            input,
        })
    }
    fn set_turn(&mut self, turn: Option<String>) -> Result<(), Error> {
        if let Some(turn) = turn {
            identity(&turn)?;
            self.track_turn(&turn)?;
            self.turn = Some(turn);
            self.explicit_turn = true;
        }
        Ok(())
    }
    fn track_turn(&mut self, turn: &str) -> Result<(), Error> {
        if !self.turns.iter().any(|existing| existing == turn) {
            self.turns.push(turn.to_owned());
        }
        Ok(())
    }
    fn rollback(&mut self, count: u64) -> Result<(), Error> {
        let retain = self
            .turns
            .len()
            .saturating_sub(usize::try_from(count).unwrap_or(usize::MAX));
        let removed: BTreeSet<_> = self.turns.drain(retain..).collect();
        if !removed.is_empty() {
            self.records
                .retain(|record| !removed.contains(&record.source_turn_id));
            self.calls.retain(|_, call| !removed.contains(&call.turn));
        }
        self.turn = None;
        self.explicit_turn = false;
        self.model = None;
        Ok(())
    }
    fn turn(&mut self, line: u64) -> String {
        self.turn
            .get_or_insert_with(|| format!("turn:{line}"))
            .clone()
    }
    fn user(&mut self, text: String, line: u64) -> Option<Content> {
        if text.is_empty() {
            return None;
        }
        if !self.explicit_turn {
            self.turn = Some(format!("turn:{line}"));
        }
        Some(Content::User { text })
    }
    fn assistant(&self, text: String, thinking: Option<String>) -> Option<Content> {
        let thinking = thinking.filter(|value| !value.is_empty());
        if text.is_empty() && thinking.is_none() {
            return None;
        }
        Some(Content::Assistant {
            text,
            model: self.model.clone(),
            thinking,
        })
    }
    fn append(
        &mut self,
        line: u64,
        timestamp: Option<u64>,
        source_id: Option<String>,
        content: Content,
    ) -> Result<(), Error> {
        let source_turn_id = self.turn(line);
        self.track_turn(&source_turn_id)?;
        self.records.push(Record {
            source_message_id: source_id.unwrap_or_else(|| format!("line:{line}")),
            source_turn_id,
            timestamp,
            content,
        })
    }
}
