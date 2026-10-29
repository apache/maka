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

//! Anthropic input cursors. Every lane reopens the same captured view.
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

use super::wire::source::{FragmentCursor, SourceFragment};
use crate::prompt::{PreparedWire, WireChunk, WireCursor, WireFormat, WireSource};
use bytes::Bytes;
use maka_agent_facts::model::prompt_source::{
    NextWire, NextWireMetadata, WireItemMetadata, WireMetadata, WireMetadataCursor, WirePosition,
    source::IdentifiedText,
};
use maka_capabilities::http;
use maka_provider_protocol::anthropic::prompt::{
    prepared::{
        CacheCandidate, Decision, FrozenCacheCandidate, MetadataPrepass, Overlay, PartMetadata,
        PreparedChunks, PreparedEncoder, PreparedPart, Replay, SourcePresence,
    },
    streaming::{Context, MessageInfo, Metadata, Selection, StreamOptions},
};
use maka_provider_protocol::json_stream::JsonChunks;
use serde_json::Value;
use std::sync::Arc;

type SourcePart = PartMetadata<IdentifiedText, FrozenCacheCandidate>;
type ReplayPart = PartMetadata<String, FrozenCacheCandidate>;
#[derive(Clone)]
enum Part {
    Source(Arc<SourcePart>),
    Generated(Arc<PartMetadata>),
}
impl Part {
    fn from_wire(metadata: WireItemMetadata) -> Result<Self, ModelError> {
        match metadata {
            WireItemMetadata::Anthropic(part) => Ok(Self::Source(part)),
            WireItemMetadata::GeneratedAnthropic(part) => Ok(Self::Generated(part)),
            WireItemMetadata::Message(_) => Err(ModelError::Adapter(
                "unexpected Anthropic message metadata".into(),
            )),
        }
    }
    fn projection(&self) -> ReplayPart {
        match self {
            Self::Source(part) => {
                let mut part = part.map_text(|text| hex_identity(text.identity));
                part.document = None;
                part
            }
            Self::Generated(part) => {
                part.map_sources(Clone::clone, |value| match value.directive() {
                    Ok(directive) => FrozenCacheCandidate::Valid(directive),
                    Err(_) => FrozenCacheCandidate::Invalid,
                })
            }
        }
    }
}
fn hex_identity(identity: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(identity.len() * 2);
    for byte in identity {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 15)] as char);
    }
    output
}

// Directory futures can be immediately ready; yield between bounded record batches.
const DIRECTORY_WORK_QUANTUM: usize = 64;

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
                    let part = self
                        .encoder
                        .part(message, *next)
                        .map_err(super::http::failure)?;
                    let part_index = *next;
                    *next += 1;
                    return Ok(Some((*index, part_index, part)));
                }
                self.active = None;
            }
            let Some(message) = self.messages.next().await? else {
                return Ok(None);
            };
            let count = self.encoder.begin(&message).map_err(super::http::failure)?;
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
                metadata: WireItemMetadata::GeneratedAnthropic(Arc::new(part.metadata)),
            }))
        })
    }
}
struct DirectCurrent {
    chunks: std::iter::Peekable<PreparedChunks>,
    metadata: Option<WireItemMetadata>,
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
                            bytes: bytes.into(),
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
                    metadata: Some(WireItemMetadata::GeneratedAnthropic(Arc::new(
                        part.metadata,
                    ))),
                    index,
                    first: true,
                });
            }
        })
    }
}

pub(super) async fn metadata(wire: &PreparedWire) -> Result<Metadata, ModelError> {
    let mut cursor = wire.source.open_metadata(0).ok_or_else(|| {
        ModelError::Adapter("Anthropic prepared metadata cursor is missing".into())
    })?;
    let indexed = wire.source.source_identities().is_some();
    let mut prepass = if indexed {
        MetadataPrepass::for_indexed_replay()
    } else {
        MetadataPrepass::for_replay()
    };
    let mut next_index = 0;
    let mut index = 0;
    let mut processed = 0usize;
    while let Some(record) = cursor.next().await? {
        let metadata = Part::from_wire(record.metadata)?;
        if !indexed && matches!(&metadata, Part::Source(_)) {
            return Err(ModelError::Adapter(
                "frozen Anthropic source is missing its membership index".into(),
            ));
        }
        let part = metadata.projection();
        if part.part_index == 0 {
            index = next_index;
            next_index += 1;
        }
        prepass.push(index, &part).map_err(super::http::failure)?;
        processed += 1;
        if processed.is_multiple_of(DIRECTORY_WORK_QUANTUM) {
            tokio::task::yield_now().await;
        }
    }
    Ok(prepass.finish())
}

struct Record {
    position: WirePosition,
    logical: Position,
    info: Option<MessageInfo>,
    metadata: Part,
    decision: Decision,
}
struct Lane {
    cursor: Box<dyn WireMetadataCursor>,
    replay: Replay,
    selection: Selection,
    next_index: usize,
    index: usize,
    pending: Option<Record>,
    source_identities:
        Option<Arc<dyn maka_agent_facts::model::prompt_source::SourceIdentityLookup>>,
    budgets: Option<Arc<dyn maka_agent_facts::model::prompt_source::source::SourceBudgetFactory>>,
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
            source_identities: wire.source.source_identities(),
            budgets: wire.source.budget_factory(),
        })
    }
    async fn next(&mut self) -> Result<Option<Record>, ModelError> {
        if let Some(record) = self.pending.take() {
            return Ok(Some(record));
        }
        let Some(record) = self.cursor.next().await? else {
            return Ok(None);
        };
        let metadata = Part::from_wire(record.metadata)?;
        let projection = metadata.projection();
        let info = if projection.part_index == 0 {
            self.index = self.next_index;
            self.next_index += 1;
            Some(self.replay.begin(self.index, &projection.message))
        } else {
            None
        };
        let decision = if let Some(identities) = &self.source_identities {
            let mut present = SourcePresence::Present;
            if self.replay.needs_caller_source(&projection, self.selection) {
                let Part::Source(part) = &metadata else {
                    return Err(ModelError::Adapter(
                        "indexed source membership received generated metadata".into(),
                    ));
                };
                let identity = part
                    .caller
                    .as_ref()
                    .and_then(|caller| caller.caller.source_id())
                    .expect("caller source requirement checked")
                    .identity;
                let budget = self
                    .budgets
                    .as_ref()
                    .ok_or_else(|| {
                        ModelError::Adapter("source membership has no preparation resources".into())
                    })?
                    .acquire()
                    .await
                    .map_err(|error| ModelError::Adapter(error.to_string()))?;
                present = if identities.contains(identity, budget).await? {
                    SourcePresence::Present
                } else {
                    SourcePresence::Missing
                };
            }
            self.replay
                .part_with_source_presence(&projection, self.selection, present)
        } else {
            self.replay.part(&projection, self.selection)
        }
        .map_err(super::http::failure)?;
        Ok(Some(Record {
            position: record.position,
            logical: (self.index, projection.part_index),
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
    transform: PayloadTransform,
    input: Option<Bytes>,
    input_end: bool,
    ended: bool,
}
enum PayloadTransform {
    Generated(Overlay),
    Source(SourceOverlay),
}
struct SourceOverlay {
    offset: u64,
    expected: u64,
    insertions: Vec<(u64, VecDeque<SourceFragment>)>,
    inserted: usize,
    active: Option<Box<FragmentCursor>>,
    deletes: Vec<std::ops::Range<u64>>,
}
impl SourceOverlay {
    fn new(metadata: &SourcePart, decision: &Decision) -> Self {
        fn literal(bytes: &'static [u8]) -> SourceFragment {
            SourceFragment::literal(bytes)
        }
        let mut insertions = Vec::new();
        let mut field = |slot: &maka_provider_protocol::anthropic::prompt::prepared::FieldSlot,
                         fields: Vec<SourceFragment>| {
            let mut fragments = VecDeque::new();
            if slot.comma_before {
                fragments.push_back(literal(b","));
            }
            fragments.extend(fields);
            if slot.comma_after {
                fragments.push_back(literal(b","));
            }
            insertions.push((slot.offset, fragments));
        };
        if let (Some(slot), Some(caller)) = (&metadata.caller_slot, &metadata.caller)
            && decision.caller.is_some()
        {
            use maka_provider_protocol::anthropic::prompt::Caller;
            let fields = match &caller.caller {
                Caller::Direct => vec![literal(b"\"caller\":{\"type\":\"direct\"}")],
                Caller::Code20250825 { tool_id } | Caller::Code20260120 { tool_id } => {
                    let kind = if matches!(&caller.caller, Caller::Code20250825 { .. }) {
                        b"\"caller\":{\"type\":\"code_execution_20250825\",\"tool_id\":\""
                            .as_slice()
                    } else {
                        b"\"caller\":{\"type\":\"code_execution_20260120\",\"tool_id\":\""
                            .as_slice()
                    };
                    vec![
                        literal(kind),
                        SourceFragment::Text(tool_id.text.clone()),
                        literal(b"\"}"),
                    ]
                }
            };
            field(slot, fields);
        }
        if let (Some(slot), Some(cache)) = (&metadata.cache_slot, decision.cache) {
            field(
                slot,
                vec![
                    literal(b"\"cache_control\":"),
                    SourceFragment::owned(
                        serde_json::to_vec(&cache).expect("cache directive JSON"),
                    ),
                ],
            );
        }
        insertions.sort_by_key(|(offset, _)| *offset);
        let deletes = if decision.trim {
            metadata
                .trim
                .as_ref()
                .map(|trim| vec![trim.leading.clone(), trim.trailing.clone()])
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Self {
            offset: 0,
            expected: metadata.base_bytes,
            insertions,
            inserted: 0,
            active: None,
            deletes,
        }
    }
}
impl Payload {
    fn new(cursor: Box<dyn WireCursor>, metadata: &Part, decision: &Decision) -> Self {
        let transform = match metadata {
            Part::Generated(metadata) => {
                PayloadTransform::Generated(Overlay::new(metadata, decision))
            }
            Part::Source(metadata) => {
                PayloadTransform::Source(SourceOverlay::new(metadata, decision))
            }
        };
        Self {
            cursor,
            transform,
            input: None,
            input_end: false,
            ended: false,
        }
    }
    async fn next(&mut self) -> Result<Option<Bytes>, ModelError> {
        loop {
            if self.ended {
                return Ok(None);
            }
            if self.input.is_none() && !self.input_end {
                let chunk = self.cursor.next().await?.ok_or_else(|| {
                    ModelError::Adapter("Anthropic wire item ended before its boundary".into())
                })?;
                self.input = Some(chunk.bytes);
                self.input_end = chunk.item_end;
            }
            match &mut self.transform {
                PayloadTransform::Generated(overlay) => {
                    let input = self.input.take().expect("generated payload input");
                    let bytes = overlay.push(&input);
                    if self.input_end {
                        overlay.finish().map_err(super::http::failure)?;
                        self.ended = true;
                    }
                    return Ok(Some(bytes.into()));
                }
                PayloadTransform::Source(overlay) => {
                    if let Some((at, fragments)) = overlay.insertions.get_mut(overlay.inserted)
                        && *at == overlay.offset
                    {
                        if overlay.active.is_none() {
                            overlay.active =
                                fragments.pop_front().map(FragmentCursor::new).map(Box::new);
                        }
                        if let Some(active) = &mut overlay.active {
                            let budget = self.cursor.budget().ok_or_else(|| {
                                ModelError::Adapter(
                                    "Anthropic source cursor has no preparation work envelope"
                                        .into(),
                                )
                            })?;
                            if let Some(bytes) = active
                                .next(budget)
                                .await
                                .map_err(|error| ModelError::Adapter(error.to_string()))?
                            {
                                if !bytes.is_empty() {
                                    return Ok(Some(bytes));
                                }
                                continue;
                            }
                            overlay.active = None;
                            continue;
                        }
                        overlay.inserted += 1;
                        continue;
                    }
                    let Some(input) = &mut self.input else {
                        if overlay.offset != overlay.expected
                            || overlay.inserted != overlay.insertions.len()
                        {
                            return Err(ModelError::Adapter(
                                "incomplete Anthropic source wire block".into(),
                            ));
                        }
                        self.ended = true;
                        continue;
                    };
                    if input.is_empty() {
                        self.input = None;
                        continue;
                    }
                    let mut end = overlay.offset + input.len() as u64;
                    if let Some((at, _)) = overlay.insertions.get(overlay.inserted) {
                        end = end.min(*at);
                    }
                    let mut deleted = false;
                    for range in &overlay.deletes {
                        if range.contains(&overlay.offset) {
                            deleted = true;
                            end = end.min(range.end);
                        } else if range.start > overlay.offset {
                            end = end.min(range.start);
                        }
                    }
                    let length = usize::try_from(end - overlay.offset)
                        .expect("slice length fits source chunk");
                    if length == 0 {
                        return Err(ModelError::Adapter(
                            "Anthropic source overlay made no progress".into(),
                        ));
                    }
                    let bytes = input.split_to(length);
                    overlay.offset = end;
                    if !deleted {
                        return Ok(Some(bytes));
                    }
                }
            }
        }
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
        self.payload = Some(Payload::new(cursor, &record.metadata, &record.decision));
        Ok(())
    }
    async fn next(&mut self) -> Result<Option<Bytes>, ModelError> {
        loop {
            if let Some(bytes) = self.queue.pop_front() {
                return Ok(Some(bytes.into()));
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
                return Ok(Some(bytes.into()));
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
            match state.next().await.map_err(super::http::upload_error)? {
                Some(bytes) => Ok(Some((bytes, state))),
                None => Ok(None),
            }
        },
    )))
}

#[cfg(test)]
mod tests;
