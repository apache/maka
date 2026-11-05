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

//! Claude JSONL lineage and response-fragment reconstruction. Every pass reads
//! the same pinned prefix and verifies its digest before returning any history.
mod lineage;
mod wire;
pub(crate) use wire::synthetic;

use crate::{
    Error, Fingerprint, Transcript, jsonl,
    transcript::{Records, identity, source_cwd, title},
};
use lineage::Index;
use maka_agent_facts::import::Content;
use maka_agent_facts::import::Record;
use maka_agent_facts::import::Source;
use maka_capabilities::filesystem::PinnedFile;
use std::{collections::BTreeMap, sync::Arc};
use wire::{Block, Kind, Message, Row, StopReason};

pub async fn read(file: &PinnedFile, expected_session_id: &str) -> Result<Transcript, Error> {
    identity(expected_session_id)?;
    let expected = expected_session_id.to_owned();
    let length = file.info().length;
    let id = expected.clone();
    let (index, metadata, fingerprint) = file
        .with_reader(move |reader| {
            Ok((|| {
                let mut index = Index::default();
                let mut metadata = Metadata::default();
                let fingerprint = jsonl::scan(reader, length, |line| {
                    let row: Row<'_> = line.decode()?;
                    metadata.accept(&row, &id)?;
                    index.accept(&row, &line)
                })?;
                if !metadata.matched {
                    return Err(Error::Invalid("Claude session identity is missing"));
                }
                Ok((Arc::new(index.resolve()), metadata, fingerprint))
            })())
        })
        .await??;

    let selection = index.clone();
    let expected_fingerprint = fingerprint.clone();
    let responses = file
        .with_reader(move |reader| {
            Ok((|| {
                let mut responses = Responses::default();
                let observed = jsonl::scan(reader, length, |line| {
                    let row: Row<'_> = line.decode()?;
                    if selection.keep(&row, line.number) && row.kind == Kind::Assistant {
                        responses.push(line.number, row.message(&line)?)?;
                    }
                    Ok(())
                })?;
                unchanged(&expected_fingerprint, &observed)?;
                Ok::<_, Error>(responses)
            })())
        })
        .await??;

    let expected_fingerprint = fingerprint.clone();
    let records = file
        .with_reader(move |reader| {
            Ok((|| {
                let mut converter = Converter {
                    responses,
                    records: Records::default(),
                    turn: None,
                    calls: BTreeMap::new(),
                    bootstrap: false,
                };
                let observed = jsonl::scan(reader, length, |line| {
                    let row: Row<'_> = line.decode()?;
                    if index.keep(&row, line.number) {
                        converter.accept(&row, &line)?;
                    }
                    Ok(())
                })?;
                unchanged(&expected_fingerprint, &observed)?;
                converter.records.finish()
            })())
        })
        .await??;
    let title = metadata
        .title
        .or_else(|| {
            records.iter().find_map(|record| match &record.content {
                Content::User { text } if !text.trim().is_empty() => Some(title(text)),
                _ => None,
            })
        })
        .unwrap_or_else(|| expected.clone());
    Ok(Transcript {
        source: Source {
            adapter: "claude-code".into(),
            session_id: expected,
        },
        cwd: metadata.cwd,
        title,
        records,
        fingerprint,
    })
}

fn unchanged(expected: &Fingerprint, observed: &Fingerprint) -> Result<(), Error> {
    if expected == observed {
        Ok(())
    } else {
        Err(Error::Invalid("Claude source changed between read passes"))
    }
}
#[derive(Default)]
struct Metadata {
    matched: bool,
    cwd: Option<String>,
    title: Option<String>,
    priority: u8,
}
impl Metadata {
    fn accept(&mut self, row: &Row<'_>, expected: &str) -> Result<(), Error> {
        if row.is_sidechain {
            return Err(Error::Invalid(
                "Claude subagent sidechains are not root sessions",
            ));
        }
        if let Some(id) = &row.session_id {
            if id != expected {
                return Err(Error::Invalid(
                    "Claude session identity does not match the selected session",
                ));
            }
            self.matched = true;
        }
        if self.cwd.is_none() {
            self.cwd = source_cwd(row.cwd.clone());
        }
        for (priority, text) in [
            (4, row.custom_title.as_ref()),
            (
                3,
                row.ai_title.as_ref().or_else(|| {
                    (row.kind == Kind::AiTitle)
                        .then_some(row.title.as_ref())
                        .flatten()
                }),
            ),
            (
                2,
                row.last_prompt.as_ref().or_else(|| {
                    (row.kind == Kind::LastPrompt)
                        .then_some(row.prompt.as_ref())
                        .flatten()
                }),
            ),
            (1, row.summary.as_ref()),
        ] {
            if priority >= self.priority
                && let Some(text) = text
                    .filter(|text| !text.trim().is_empty() && !crate::synthetic::instructions(text))
            {
                self.title = Some(title(text));
                self.priority = priority;
            }
        }
        Ok(())
    }
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum ResponseKey {
    Id(String),
    Line(u64),
}
impl ResponseKey {
    fn new(message: &Message, line: u64) -> Result<Self, Error> {
        match &message.id {
            Some(id) => {
                identity(id)?;
                Ok(Self::Id(id.clone()))
            }
            None => Ok(Self::Line(line)),
        }
    }
}
#[derive(Default)]
struct Responses {
    entries: BTreeMap<ResponseKey, Vec<(u64, Message)>>,
}
impl Responses {
    fn push(&mut self, line: u64, message: Message) -> Result<(), Error> {
        self.entries
            .entry(ResponseKey::new(&message, line)?)
            .or_default()
            .push((line, message));
        Ok(())
    }
}

struct Call {
    key: String,
    turn: String,
    completed: bool,
}
struct Converter {
    responses: Responses,
    records: Records,
    turn: Option<String>,
    calls: BTreeMap<String, Call>,
    bootstrap: bool,
}
impl Converter {
    fn accept(&mut self, row: &Row<'_>, line: &jsonl::Line<'_>) -> Result<(), Error> {
        let timestamp = row.timestamp.as_ref().and_then(|time| time.millis());
        let source = row
            .uuid
            .clone()
            .unwrap_or_else(|| format!("line:{}", line.number));
        if row.compacted() {
            self.append(
                &source,
                line.number,
                timestamp,
                Content::Note {
                    text: "Source context compacted".into(),
                },
            )?;
        }
        match row.kind {
            Kind::User => {
                let message = row.message(line)?;
                if message.content.has_results() {
                    let wire::Content::Blocks(blocks) = message.content else {
                        unreachable!()
                    };
                    for (part, block) in blocks.into_iter().enumerate() {
                        if let Block::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                        } = block
                        {
                            identity(&tool_use_id)?;
                            let (key, turn) = match self.calls.get_mut(&tool_use_id) {
                                Some(call) if !call.completed => {
                                    call.completed = true;
                                    (call.key.clone(), call.turn.clone())
                                }
                                Some(_) => {
                                    return Err(Error::Invalid("duplicate Claude tool result"));
                                }
                                None => (
                                    format!("unmatched:{}:{part}", line.number),
                                    self.turn(line.number),
                                ),
                            };
                            self.records.push(Record {
                                source_message_id: source.clone(),
                                source_turn_id: turn,
                                timestamp,
                                content: Content::ToolResult {
                                    call_id: key,
                                    output: content,
                                    is_error,
                                },
                            })?;
                        }
                    }
                } else {
                    if message.content.instructions() {
                        self.bootstrap = true;
                        return Ok(());
                    }
                    let text = message.content.user_text();
                    if !text.is_empty() {
                        let content =
                            if row.is_meta || row.is_compact_summary || wire::synthetic(&text) {
                                Content::Note { text }
                            } else {
                                self.bootstrap = false;
                                self.turn = Some(source.clone());
                                Content::User { text }
                            };
                        self.append(&source, line.number, timestamp, content)?;
                    }
                }
            }
            Kind::Assistant => {
                let message = row.message(line)?;
                let stop = message.stop_reason;
                let key = ResponseKey::new(&message, line.number)?;
                if let Some(fragments) = self.responses.entries.remove(&key) {
                    self.assistant(&source, line.number, timestamp, fragments)?;
                }
                // Terminal observations stay at their actual source position.
                // They are never synthesized into local execution end facts.
                if row.is_api_error_message {
                    self.append(
                        &source,
                        line.number,
                        timestamp,
                        Content::Note {
                            text: "Source reported an API error".into(),
                        },
                    )?;
                } else if !self.bootstrap
                    && let Some(stop) = stop
                {
                    let text = match stop {
                        StopReason::EndTurn | StopReason::StopSequence => {
                            Some("Source turn completed")
                        }
                        StopReason::MaxTokens => Some("Source response reached its output limit"),
                        StopReason::Other => None,
                    };
                    if let Some(text) = text {
                        self.append(
                            &source,
                            line.number,
                            timestamp,
                            Content::Note { text: text.into() },
                        )?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn assistant(
        &mut self,
        source: &str,
        line: u64,
        timestamp: Option<u64>,
        fragments: Vec<(u64, Message)>,
    ) -> Result<(), Error> {
        let mut text = Vec::new();
        let mut thinking = Vec::new();
        let mut calls = Vec::new();
        let mut model = None;
        for (fragment_line, fragment) in fragments {
            if let Some(value) = fragment.model {
                if model.as_ref().is_some_and(|model| model != &value) {
                    return Err(Error::Invalid(
                        "Claude response fragments disagree about their model",
                    ));
                }
                model = Some(value);
            }
            match fragment.content {
                wire::Content::Text(value) => {
                    if !value.is_empty() {
                        text.push(value);
                    }
                }
                wire::Content::Blocks(blocks) => {
                    for (part, block) in blocks.into_iter().enumerate() {
                        match block {
                            Block::Text { text: value } => {
                                if !value.is_empty() {
                                    text.push(value);
                                }
                            }
                            Block::Thinking { thinking: value } => {
                                if !value.is_empty() {
                                    thinking.push(value);
                                }
                            }
                            Block::ToolUse { id, name, input } => {
                                calls.push((fragment_line, part, id, name, input))
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        if !self.bootstrap && (!text.is_empty() || !thinking.is_empty()) {
            self.append(
                source,
                line,
                timestamp,
                Content::Assistant {
                    text: text.join("\n\n"),
                    model,
                    thinking: (!thinking.is_empty()).then(|| thinking.join("\n\n")),
                },
            )?;
        }
        for (fragment_line, part, id, name, input) in calls {
            identity(&id)?;
            identity(&name)?;
            if self.calls.get(&id).is_some_and(|call| !call.completed) {
                return Err(Error::Invalid("ambiguous overlapping Claude tool calls"));
            }
            let key = format!("call:{fragment_line}:{part}");
            let turn = self.turn(line);
            self.calls.insert(
                id,
                Call {
                    key: key.clone(),
                    turn,
                    completed: false,
                },
            );
            self.append(
                source,
                line,
                timestamp,
                Content::ToolCall {
                    call_id: key,
                    name,
                    input,
                },
            )?;
        }
        Ok(())
    }
    fn turn(&mut self, line: u64) -> String {
        self.turn
            .get_or_insert_with(|| format!("turn:{line}"))
            .clone()
    }
    fn append(
        &mut self,
        source: &str,
        line: u64,
        timestamp: Option<u64>,
        content: Content,
    ) -> Result<(), Error> {
        let source_turn_id = self.turn(line);
        self.records.push(Record {
            source_message_id: source.into(),
            source_turn_id,
            timestamp,
            content,
        })
    }
}
