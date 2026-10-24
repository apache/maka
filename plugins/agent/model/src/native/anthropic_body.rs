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

//! Native Anthropic input cursors. Every lane reopens the same captured view.
use super::{media, prompt};
use crate::{
    ModelError,
    prompt::{Prompt, PromptCursor},
};
use maka_agent_facts::language::Language;
use maka_provider_protocol::input::Message;
use std::collections::VecDeque;

pub(super) struct Messages {
    cursor: Box<dyn PromptCursor>,
    pending: VecDeque<Message>,
    language: Language,
}
impl Messages {
    pub(super) fn new(source: &Prompt, language: Language) -> Self {
        Self {
            cursor: source.open(),
            pending: VecDeque::new(),
            language,
        }
    }
    pub(super) async fn next(&mut self) -> Result<Option<Message>, ModelError> {
        loop {
            if let Some(message) = self.pending.pop_front() {
                return Ok(Some(message));
            }
            let Some(message) = self.cursor.next().await? else {
                return Ok(None);
            };
            let mut messages = crate::prompt::notification_fallback(vec![message], self.language);
            media::audio_fallback(&mut messages, self.language, true);
            self.pending.extend(prompt::messages(messages)?);
        }
    }
}

use crate::prompt::{PreparedWire, WireChunk, WireCursor, WireFormat, WireSource};
use maka_agent_facts::model::prompt_source::{
    NextWire, NextWireMetadata, WireMetadata, WireMetadataCursor, WirePosition,
};
use maka_capabilities::http;
use maka_provider_protocol::anthropic::prompt::{
    prepared::{
        Decision, MetadataPrepass, Overlay, PartMetadata, PreparedChunks, PreparedEncoder,
        PreparedPart, Replay,
    },
    streaming::{Context, MessageInfo, Metadata, Selection, StreamOptions},
};
use maka_provider_protocol::json_stream::JsonChunks;
use serde_json::Value;
use std::sync::Arc;

type Position = (usize, usize);

/// Explicit small requests share the same wire codec, without a second body Vec.
pub(super) fn direct_wire(
    prompt: Prompt,
    language: Language,
    options: StreamOptions,
) -> PreparedWire {
    PreparedWire {
        format: WireFormat::Anthropic,
        codec: super::wire::anthropic_codec(language, &options).into(),
        identity: prompt.identity().into(),
        source: Arc::new(DirectSource {
            prompt,
            language,
            options,
        }),
    }
}
struct DirectSource {
    prompt: Prompt,
    language: Language,
    options: StreamOptions,
}
impl DirectSource {
    fn parts(&self) -> DirectParts {
        DirectParts {
            messages: Messages::new(&self.prompt, self.language),
            encoder: PreparedEncoder::new(self.options.clone()),
            active: None,
            index: 0,
        }
    }
}
impl WireSource for DirectSource {
    fn open(&self, start_message: usize) -> Box<dyn WireCursor> {
        Box::new(DirectCursor {
            parts: self.parts(),
            target: Some((start_message, 0)),
            current: None,
        })
    }
    fn open_at(&self, position: WirePosition) -> Option<Box<dyn WireCursor>> {
        Some(Box::new(DirectCursor {
            parts: self.parts(),
            target: Some((position.message_index, position.piece_index)),
            current: None,
        }))
    }
    fn open_metadata(&self, _: usize) -> Option<Box<dyn WireMetadataCursor>> {
        Some(Box::new(DirectMetadata(self.parts())))
    }
}
struct DirectParts {
    messages: Messages,
    encoder: PreparedEncoder,
    active: Option<(Message, usize, usize, usize)>,
    index: usize,
}
impl DirectParts {
    async fn next(&mut self) -> Result<Option<(usize, usize, PreparedPart)>, ModelError> {
        loop {
            if let Some((message, index, next, count)) = &mut self.active {
                if *next < *count {
                    let part = self.encoder.part(message, *next).map_err(super::failure)?;
                    let part_index = *next;
                    *next += 1;
                    return Ok(Some((*index, part_index, part)));
                }
                self.active = None;
            }
            let Some(message) = self.messages.next().await? else {
                return Ok(None);
            };
            let count = self.encoder.begin(&message).map_err(super::failure)?;
            self.active = Some((message, self.index, 0, count));
            self.index += 1;
        }
    }
}
struct DirectMetadata(DirectParts);
impl WireMetadataCursor for DirectMetadata {
    fn next(&mut self) -> NextWireMetadata<'_> {
        Box::pin(async move {
            let Some((message_index, piece_index, part)) = self.0.next().await? else {
                return Ok(None);
            };
            Ok(Some(WireMetadata {
                position: WirePosition {
                    message_index,
                    piece_index,
                },
                message_index,
                metadata: serde_json::to_value(part.metadata)
                    .map_err(|error| ModelError::Adapter(error.to_string()))?,
            }))
        })
    }
}
struct DirectCurrent {
    chunks: std::iter::Peekable<PreparedChunks>,
    metadata: Option<Value>,
    index: usize,
    first: bool,
}
struct DirectCursor {
    parts: DirectParts,
    target: Option<Position>,
    current: Option<DirectCurrent>,
}
impl WireCursor for DirectCursor {
    fn next(&mut self) -> NextWire<'_> {
        Box::pin(async move {
            loop {
                if let Some(current) = &mut self.current {
                    if let Some(bytes) = current.chunks.next() {
                        let item_start = std::mem::take(&mut current.first);
                        return Ok(Some(WireChunk {
                            bytes,
                            item_start,
                            item_end: current.chunks.peek().is_none(),
                            message_index: current.index,
                            metadata: if item_start {
                                current.metadata.take()
                            } else {
                                None
                            },
                        }));
                    }
                    self.current = None;
                }
                let Some((index, part_index, part)) = self.parts.next().await? else {
                    return Ok(None);
                };
                if self
                    .target
                    .is_some_and(|target| (index, part_index) < target)
                {
                    continue;
                }
                self.target = None;
                self.current = Some(DirectCurrent {
                    chunks: part.chunks.peekable(),
                    metadata: Some(
                        serde_json::to_value(part.metadata)
                            .map_err(|error| ModelError::Adapter(error.to_string()))?,
                    ),
                    index,
                    first: true,
                });
            }
        })
    }
}

pub(super) async fn metadata(
    wire: &PreparedWire,
    options: StreamOptions,
) -> Result<Metadata, ModelError> {
    let mut cursor = wire.source.open_metadata(0).ok_or_else(|| {
        ModelError::Adapter("Anthropic prepared metadata cursor is missing".into())
    })?;
    let mut prepass = MetadataPrepass::new(options);
    let mut next_index = 0;
    let mut index = 0;
    while let Some(record) = cursor.next().await? {
        let part: PartMetadata = serde_json::from_value(record.metadata)
            .map_err(|error| ModelError::Adapter(error.to_string()))?;
        if part.part_index == 0 {
            index = next_index;
            next_index += 1;
        }
        prepass.push(index, &part).map_err(super::failure)?;
    }
    Ok(prepass.finish())
}

struct Record {
    position: WirePosition,
    logical: Position,
    info: Option<MessageInfo>,
    metadata: PartMetadata,
    decision: Decision,
}
struct Lane {
    cursor: Box<dyn WireMetadataCursor>,
    replay: Replay,
    selection: Selection,
    next_index: usize,
    index: usize,
    pending: Option<Record>,
}
impl Lane {
    fn new(
        wire: &PreparedWire,
        context: Arc<Context>,
        selection: Selection,
    ) -> Result<Self, ModelError> {
        Ok(Self {
            cursor: wire.source.open_metadata(0).ok_or_else(|| {
                ModelError::Adapter("Anthropic prepared metadata cursor is missing".into())
            })?,
            replay: Replay::new(context),
            selection,
            next_index: 0,
            index: 0,
            pending: None,
        })
    }
    async fn next(&mut self) -> Result<Option<Record>, ModelError> {
        if let Some(record) = self.pending.take() {
            return Ok(Some(record));
        }
        let Some(record) = self.cursor.next().await? else {
            return Ok(None);
        };
        let metadata: PartMetadata = serde_json::from_value(record.metadata)
            .map_err(|error| ModelError::Adapter(error.to_string()))?;
        let info = if metadata.part_index == 0 {
            self.index = self.next_index;
            self.next_index += 1;
            Some(self.replay.begin(self.index, &metadata.message))
        } else {
            None
        };
        let decision = self
            .replay
            .part(&metadata, self.selection)
            .map_err(super::failure)?;
        Ok(Some(Record {
            position: record.position,
            logical: (self.index, metadata.part_index),
            info,
            metadata,
            decision,
        }))
    }
    async fn before(&mut self, target: Position) -> Result<Option<Record>, ModelError> {
        while let Some(record) = self.next().await? {
            if record.logical >= target {
                self.pending = Some(record);
                return Ok(None);
            }
            if record.decision.emit {
                return Ok(Some(record));
            }
        }
        Ok(None)
    }
}
struct Payload {
    cursor: Box<dyn WireCursor>,
    overlay: Overlay,
    ended: bool,
}
impl Payload {
    async fn next(&mut self) -> Result<Option<Vec<u8>>, ModelError> {
        if self.ended {
            return Ok(None);
        }
        let chunk = self.cursor.next().await?.ok_or_else(|| {
            ModelError::Adapter("Anthropic wire item ended before its boundary".into())
        })?;
        let bytes = self.overlay.push(&chunk.bytes);
        if chunk.item_end {
            self.overlay.finish().map_err(super::failure)?;
            self.ended = true;
        }
        Ok(Some(bytes))
    }
}
struct Group {
    key: usize,
    header: Value,
    enabled: bool,
    force_empty: bool,
    opened: bool,
    first: bool,
}
enum AfterDrain {
    Boundary(Record),
    Group(Record),
    End,
}
struct State {
    wire: PreparedWire,
    head: Option<std::iter::Peekable<JsonChunks>>,
    system: Option<Lane>,
    system_end: usize,
    system_first: bool,
    normal: Lane,
    deferred: Lane,
    group: Option<Group>,
    message_first: bool,
    drain: Option<(Position, AfterDrain)>,
    payload: Option<Payload>,
    queue: VecDeque<Vec<u8>>,
    finished: bool,
}
impl State {
    fn open_group(&mut self) {
        let Some(group) = &mut self.group else {
            return;
        };
        if group.opened || !group.enabled {
            return;
        }
        let mut header = serde_json::to_vec(&group.header).expect("small wire message header");
        assert_eq!(header.pop(), Some(b'}'));
        header.extend_from_slice(b",\"content\":[");
        if !self.message_first {
            self.queue.push_back(vec![b',']);
        }
        self.message_first = false;
        self.queue.push_back(header);
        group.opened = true;
    }
    fn close_group(&mut self) {
        if self.group.as_ref().is_some_and(|group| group.force_empty) {
            self.open_group();
        }
        if self.group.take().is_some_and(|group| group.opened) {
            self.queue.push_back(b"]}".to_vec());
        }
    }
    fn install_group(&mut self, record: &mut Record) {
        if let Some(info) = record.info.take() {
            self.group = Some(Group {
                key: info.group,
                force_empty: info.emit_message && info.header["role"] != "assistant",
                header: info.header,
                enabled: info.emit_message,
                opened: false,
                first: true,
            });
        }
    }
    fn emit(&mut self, record: Record, system: bool) -> Result<(), ModelError> {
        if !record.decision.emit {
            return Ok(());
        }
        if system {
            if !self.system_first {
                self.queue.push_back(vec![b',']);
            }
            self.system_first = false;
        } else {
            self.open_group();
            let group = self.group.as_mut().ok_or_else(|| {
                ModelError::Adapter("Anthropic wire block has no role group".into())
            })?;
            if !group.first {
                self.queue.push_back(vec![b',']);
            }
            group.first = false;
        }
        let cursor = self.wire.source.open_at(record.position).ok_or_else(|| {
            ModelError::Adapter("Anthropic prepared source lacks indexed item reads".into())
        })?;
        self.payload = Some(Payload {
            cursor,
            overlay: Overlay::new(&record.metadata, &record.decision),
            ended: false,
        });
        Ok(())
    }
    async fn next(&mut self) -> Result<Option<Vec<u8>>, ModelError> {
        loop {
            if let Some(bytes) = self.queue.pop_front() {
                return Ok(Some(bytes));
            }
            if let Some(payload) = &mut self.payload {
                if let Some(bytes) = payload.next().await? {
                    if !bytes.is_empty() {
                        return Ok(Some(bytes));
                    }
                    continue;
                }
                self.payload = None;
            }
            if self.finished {
                return Ok(None);
            }
            if let Some(head) = &mut self.head
                && let Some(mut bytes) = head.next()
            {
                if head.peek().is_none() {
                    assert_eq!(bytes.pop(), Some(b'}'));
                    if bytes != b"{" {
                        bytes.push(b',');
                    }
                    bytes.extend_from_slice(if self.system.is_some() {
                        b"\"system\":["
                    } else {
                        b"\"messages\":["
                    });
                    self.head = None;
                }
                return Ok(Some(bytes));
            }

            if let Some(system) = &mut self.system {
                let record = system.next().await?;
                match record {
                    Some(record) if record.logical.0 < self.system_end => {
                        self.emit(record, true)?;
                    }
                    _ => {
                        self.system = None;
                        self.queue.push_back(b"],\"messages\":[".to_vec());
                    }
                }
                continue;
            }
            if let Some((target, _)) = &self.drain {
                if let Some(record) = self.deferred.before(*target).await? {
                    self.emit(record, false)?;
                    continue;
                }
                let (_, after) = self.drain.take().expect("active deferred drain");
                match after {
                    AfterDrain::Boundary(record) => self.emit(record, false)?,
                    AfterDrain::Group(mut record) => {
                        self.close_group();
                        self.install_group(&mut record);
                        self.emit(record, false)?;
                    }
                    AfterDrain::End => {
                        self.close_group();
                        self.queue.push_back(b"]}".to_vec());
                        self.finished = true;
                    }
                }
                continue;
            }
            let Some(mut record) = self.normal.next().await? else {
                self.drain = Some(((usize::MAX, usize::MAX), AfterDrain::End));
                continue;
            };
            if let Some(info) = &record.info {
                if self
                    .group
                    .as_ref()
                    .is_some_and(|group| group.key != info.group)
                {
                    self.drain = Some((record.logical, AfterDrain::Group(record)));
                    continue;
                }
                if self.group.is_none() {
                    self.install_group(&mut record);
                }
            }
            if record.decision.boundary {
                self.drain = Some((record.logical, AfterDrain::Boundary(record)));
                continue;
            }
            self.emit(record, false)?;
        }
    }
}

pub(super) fn body(
    fields: Value,
    wire: PreparedWire,
    context: Arc<Context>,
) -> Result<http::RequestBody, ModelError> {
    let system = context
        .has_system()
        .then(|| Lane::new(&wire, context.clone(), Selection::System))
        .transpose()?;
    let state = State {
        head: Some(JsonChunks::new(fields).peekable()),
        system,
        system_end: context.top_system().map_or(0, |range| range.end),
        system_first: true,
        normal: Lane::new(&wire, context.clone(), Selection::Normal)?,
        deferred: Lane::new(&wire, context, Selection::Deferred)?,
        wire,
        group: None,
        message_first: true,
        drain: None,
        payload: None,
        queue: VecDeque::new(),
        finished: false,
    };
    Ok(http::RequestBody::stream(futures_util::stream::try_unfold(
        state,
        |mut state| async move {
            match state.next().await.map_err(super::upload_error)? {
                Some(bytes) => Ok(Some((http::Bytes::from(bytes), state))),
                None => Ok(None),
            }
        },
    )))
}
